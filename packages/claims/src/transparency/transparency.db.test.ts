//! DB-backed M6 transparency tests. Gated on DATABASE_URL + the migrated schema.
//!
//! CONCURRENCY NOTE: `node --test` runs test files in parallel processes against
//! the SAME Postgres. `audit_log` + `published_ledger` are GLOBAL and audit_log is
//! APPEND-ONLY, so these tests are READ-ONLY over the shared chain and assert only
//! on rows they own (read BY ID; own published_ledger + audit_anchors, cleaned up).
//! They never append to / sign / delete from the audit chain. The full sign ->
//! verify -> anchor -> extends flow over a real chain is proven, deterministically,
//! by the standalone live proof (scripts/m6-devnet-proof.ts), and the sign-on-write
//! hook by src/api/audit.signer.test.ts.

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { generateKeyPairSigner, type Address } from "@solana/kit";

import { createDb, type Db } from "../db.js";
import type { ChainGateway } from "../dispatch/chain.js";
import { getAssociatedTokenAddress } from "../dispatch/instructions.js";
import { keypairFromSeed } from "./keys.js";
import { getAnchors, getPublishedLedgerById, persistPublishedLedger, recordAnchor } from "./store.js";
import { buildLedgerArtifact, proveMembership, verifyLedgerArtifact, verifyMembership, type LedgerLeaf } from "./ledger-artifact.js";
import { getAuditHead, loadAuditRows, verifyAuditChain } from "./audit-chain.js";
import { computeReserves, readLiabilities } from "./reserves.js";

const HAS_DB = !!process.env.DATABASE_URL;
const PUBLISHER = keypairFromSeed("publisher", new Uint8Array(32).fill(43));

const SAMPLE_LEAVES: LedgerLeaf[] = [
  { recipientId: "dbRecA", protocol: 0, assetKey: "db-token-x", assetType: "token", amount: "777", antMint: null, vaultEndTs: null, status: "available" },
  { recipientId: "dbRecA", protocol: 0, assetKey: "db-ant-x", assetType: "ant", amount: null, antMint: "db-ant-x", vaultEndTs: null, status: "available" },
  { recipientId: "dbRecB", protocol: 1, assetKey: "db-vault-x", assetType: "vault", amount: "5000", antMint: null, vaultEndTs: 1795000000, status: "manual_review" },
];

/** ChainGateway whose token balances come from a fixed address->balance map. */
class MapGateway implements ChainGateway {
  constructor(private readonly balances: Map<string, bigint>) {}
  async getTokenBalance(ata: Address): Promise<bigint> {
    return this.balances.get(ata as string) ?? 0n;
  }
  async accountExists(): Promise<boolean> {
    return true;
  }
  async getBlockHeight(): Promise<bigint> {
    return 1n;
  }
  async signTransaction(): Promise<never> {
    throw new Error("unused");
  }
  async broadcast(): Promise<void> {}
  async confirmSignature(): Promise<"confirmed"> {
    return "confirmed";
  }
  async findConfirmedOutflow(): Promise<null> {
    return null;
  }
}

describe("M6 transparency (DB)", { skip: !HAS_DB }, () => {
  let db: Db;
  const publishedIds: string[] = [];
  const anchorIds: string[] = [];

  before(() => {
    db = createDb(process.env.DATABASE_URL as string);
  });
  after(async () => {
    try {
      // Only our own records; the shared audit_log is never touched.
      if (publishedIds.length) await db.pool.query("DELETE FROM published_ledger WHERE id = ANY($1::bigint[])", [publishedIds]);
      if (anchorIds.length) await db.pool.query("DELETE FROM audit_anchors WHERE id = ANY($1::bigint[])", [anchorIds]);
    } finally {
      await db.close();
    }
  });

  it("persists a signed ledger + proves membership (read back by id)", async () => {
    const artifact = buildLedgerArtifact({ leaves: SAMPLE_LEAVES, network: "solana-mainnet", ledgerVersion: `db-${Date.now()}`, publisher: PUBLISHER });
    assert.ok(verifyLedgerArtifact(artifact, artifact.publisherPubkeyHex).ok);

    const id = await persistPublishedLedger(db.pool, artifact);
    publishedIds.push(id);

    const stored = await getPublishedLedgerById(db.pool, id);
    assert.ok(stored);
    assert.equal(stored.rootHex, artifact.manifest.rootHex);
    assert.equal(stored.artifact.leaves.length, 3);

    const m = proveMembership(stored.artifact, "db-vault-x");
    assert.ok(verifyMembership(m, stored.artifact.manifest.rootHex));
    // Tamper the claimed leaf -> fails against the committed root.
    assert.equal(verifyMembership({ ...m, leaf: { ...m.leaf, amount: "999999" } }, stored.artifact.manifest.rootHex), false);
  });

  it("builds leaves from the real ledger (if present) and commits deterministically", async () => {
    const { buildLeavesFromDb } = await import("./store.js");
    const leaves = await buildLeavesFromDb(db.pool);
    if (leaves.length === 0) return; // no ledger built in this DB — skip
    const a1 = buildLedgerArtifact({ leaves, network: "solana-mainnet", ledgerVersion: "v", generatedAt: "2026-07-10T00:00:00.000Z", publisher: PUBLISHER });
    const a2 = buildLedgerArtifact({ leaves, network: "solana-mainnet", ledgerVersion: "v", generatedAt: "2026-07-10T00:00:00.000Z", publisher: PUBLISHER });
    assert.equal(a1.manifest.rootHex, a2.manifest.rootHex, "same ledger => same root");
    assert.ok(verifyLedgerArtifact(a1, a1.publisherPubkeyHex).ok);
  });

  it("reserves: coverage math is internally consistent + flips at the boundary", async () => {
    const mint = (await generateKeyPairSigner()).address;
    const hotOwner = await generateKeyPairSigner();
    const coldOwner = await generateKeyPairSigner();
    const hotAta = await getAssociatedTokenAddress(hotOwner.address, mint);
    const coldAta = await getAssociatedTokenAddress(coldOwner.address, mint);

    // HUGE reserves -> covered, regardless of the (concurrently-changing) liability.
    const big = 10n ** 30n;
    const rBig = await computeReserves({
      pool: db.pool,
      gateway: new MapGateway(new Map([[hotAta as string, big], [coldAta as string, 0n]])),
      network: "solana-mainnet", mint, hotDispenser: hotOwner.address, coldReserve: coldOwner.address, antCheck: { mode: "off" },
    });
    // Internal consistency: coverage == (reserve >= outstanding), surplus == reserve - outstanding.
    const reserveBig = BigInt(rBig.reserves.totalReserveMario);
    const outBig = BigInt(rBig.liabilities.outstandingMario);
    assert.equal(rBig.coverage.tokenVaultCovered, reserveBig >= outBig);
    assert.equal(rBig.coverage.surplusMario, (reserveBig - outBig).toString());
    assert.equal(rBig.coverage.tokenVaultCovered, true);

    // ZERO reserves -> covered iff outstanding == 0 (proves the check is real).
    const rZero = await computeReserves({
      pool: db.pool,
      gateway: new MapGateway(new Map()),
      network: "solana-mainnet", mint, hotDispenser: hotOwner.address, antCheck: { mode: "off" },
    });
    assert.equal(rZero.reserves.totalReserveMario, "0");
    assert.equal(rZero.coverage.tokenVaultCovered, BigInt(rZero.liabilities.outstandingMario) === 0n);
  });

  it("liabilities read straight from the ledger tables (non-negative snapshot)", async () => {
    const liab = await readLiabilities(db.pool);
    assert.ok(liab.outstandingMario >= 0n);
    assert.ok(liab.totalMario >= liab.outstandingMario);
    assert.ok(liab.totalAnts >= liab.outstandingAnts);
  });

  it("verifier surfaces the real chain state without throwing; anchors round-trip", async () => {
    const rows = await loadAuditRows(db.pool, { limit: 5000 });
    const v = verifyAuditChain(rows);
    // The shared dev chain may have deletion gaps (append-only is a prod
    // invariant); either way verification returns a head and does not throw.
    assert.ok(rows.length === 0 || v.head !== null);
    if (!v.ok) assert.ok(v.firstBadSeq !== null);

    const head = await getAuditHead(db.pool);
    const seq = head?.seq ?? "0";
    const hashHex = head?.entryHashHex ?? "00".repeat(32);
    const id = await recordAnchor(db.pool, {
      kind: "audit-head", anchoredRef: seq, headHashHex: hashHex, target: "solana-memo",
      network: "solana-devnet", txid: `DBTEST_${Date.now()}`, slot: 1n, memo: `ar.io-audit-anchor:v1:solana-devnet:${seq}:${hashHex}`, confirmed: true,
    });
    anchorIds.push(id);

    const anchors = await getAnchors(db.pool, { kind: "audit-head", limit: 500 });
    const found = anchors.find((a) => a.id === id);
    assert.ok(found);
    assert.equal(found.headHashHex, hashHex);
  });
});
