//! Dispatch worker — DB-backed exactly-once + custody gate (M4 core gate).
//!
//! Gated on DATABASE_URL + the migrated M4 schema. Drives the worker against a
//! deterministic FakeChainGateway so every crash point is reproducible, and
//! PROVES the headline guarantee: a crash/retry mid-dispatch yields EXACTLY ONE
//! on-chain transfer (never a double-send). Also exercises the >100k brake, the
//! insufficient-float defer, and the operator-gated ANT path.

import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Address } from "@solana/kit";

import type { Config } from "../config.js";
import { createDb, type Db } from "../db.js";
import { insertAsset, insertRecipient, randomClaimant } from "../api/proof-testkit.js";
import { FloatManager, type FloatPolicy } from "./float.js";
import { InMemoryKeypairSigner, type SignerRegistry } from "./signer.js";
import { DispatchWorker } from "./worker.js";
import { reconcileDispatch } from "./reconcile-dispatch.js";
import { FakeChainGateway } from "./fake-chain.testkit.js";

const HAS_DB = !!process.env.DATABASE_URL;
const ONE_TOKEN = 1_000_000n;
const MINT = "DcNnMuFxwhgV4WY1HVSaSEgr92bv2b1vUvEKiNxWqHdF" as Address;

const policy: FloatPolicy = {
  capMario: 500_000n * ONE_TOKEN,
  bigClaimThresholdMario: 100_000n * ONE_TOKEN,
  refillThresholdMario: 100_000n * ONE_TOKEN,
};

function testConfig(): Config {
  return {
    port: 0, host: "127.0.0.1", logLevel: "silent", network: "solana-mainnet",
    databaseUrl: process.env.DATABASE_URL ?? "", solanaRpcUrl: "http://127.0.0.1:8899",
    challengeTtlMs: 900_000, bigClaimThresholdMario: policy.bigClaimThresholdMario,
    rateLimitPerMin: 1e6, rateLimitIdentityPerMin: 1e6, corsOrigin: "*",
  };
}

let db: Db;
let signers: SignerRegistry;

async function makeWorker(gateway: FakeChainGateway): Promise<DispatchWorker> {
  return new DispatchWorker({
    pool: db.pool, gateway, signers,
    // TEST ISOLATION: this file shares one Postgres with the other DB suites, so
    // the GLOBAL float `reserved()` sum would be poisoned by their in-flight
    // token/vault claims (flaking the `deferred_refill` refill assertion). Scope
    // the reserved sum to only THIS test's seeded assets — `seededAssets` is
    // reset per-test in beforeEach and tracked before makeWorker in every case.
    float: new FloatManager(policy, { reservedAssetScope: seededAssets }),
    config: testConfig(),
    mint: MINT,
    vaultDurations: { minVaultDuration: BigInt(14 * 86_400), maxVaultDuration: BigInt(365 * 86_400) },
    antRequiresApproval: true,
  });
}

/** Seed a recipient + asset + a `verified` claim (mirrors an M3-won claim). */
async function seedVerifiedClaim(opts: {
  assetType: "token" | "vault" | "ant";
  amount?: bigint;
  vaultEndTs?: number;
  antMint?: string;
}): Promise<{ claimId: string; assetKey: string; recipientId: string; claimant: string }> {
  const recipientId = `rid_${randomBytes(8).toString("hex")}`;
  const sourceAddress = recipientId;
  await insertRecipient(db.pool, {
    recipientId, protocol: 1, sourceAddress, recipientPubkey: new Uint8Array(randomBytes(20)),
  });
  const assetKey = opts.assetType === "ant"
    ? randomClaimant() // ant-mint base58 shape
    : randomBytes(32).toString("hex");
  await insertAsset(db.pool, recipientId, {
    assetKey, assetType: opts.assetType,
    antMint: opts.assetType === "ant" ? (opts.antMint ?? randomClaimant()) : null,
    amount: opts.assetType === "ant" ? null : (opts.amount ?? 1000n * ONE_TOKEN),
    vaultEndTs: opts.vaultEndTs ?? null,
    status: "claiming", // M3 flips it to claiming when the claim is verified
  });
  const claimant = randomClaimant();
  const r = await db.pool.query<{ claim_id: string }>(
    `INSERT INTO claims (asset_key, claimant, canonical_message, recipient_id, protocol, status, verified_at)
     VALUES ($1,$2,$3,$4,1,'verified', now()) RETURNING claim_id`,
    [assetKey, claimant, Buffer.from("canonical-placeholder"), recipientId],
  );
  return { claimId: r.rows[0].claim_id, assetKey, recipientId, claimant };
}

async function claimStatus(claimId: string): Promise<{ status: string; sig: string | null; txs: string[]; settlement: string | null }> {
  const r = await db.pool.query<{ status: string; dispatch_signature: string | null; tx_signatures: string[] | null; settlement_amount: string | null }>(
    "SELECT status, dispatch_signature, tx_signatures, settlement_amount FROM claims WHERE claim_id = $1", [claimId],
  );
  return { status: r.rows[0].status, sig: r.rows[0].dispatch_signature, txs: r.rows[0].tx_signatures ?? [], settlement: r.rows[0].settlement_amount };
}
async function assetStatus(assetKey: string): Promise<string> {
  const r = await db.pool.query<{ status: string }>("SELECT status FROM assets WHERE asset_key = $1", [assetKey]);
  return r.rows[0].status;
}

const seededRecipients: string[] = [];
const seededAssets: string[] = [];
function track(x: { assetKey: string; recipientId: string }): void {
  seededAssets.push(x.assetKey);
  seededRecipients.push(x.recipientId);
}

describe("dispatch worker — exactly-once + custody (DB)", { skip: !HAS_DB }, () => {
  before(async () => {
    db = createDb(process.env.DATABASE_URL as string);
    const tokenSeed = new Uint8Array(randomBytes(32));
    const antSeed = new Uint8Array(randomBytes(32));
    signers = {
      token: await InMemoryKeypairSigner.fromSeed("token", tokenSeed),
      ant: await InMemoryKeypairSigner.fromSeed("ant", antSeed),
    };
  });
  beforeEach(() => {
    seededRecipients.length = 0;
    seededAssets.length = 0;
  });
  after(async () => {
    if (seededAssets.length) {
      await db.pool.query("DELETE FROM audit_log WHERE entry->>'assetKey' = ANY($1)", [seededAssets]);
      await db.pool.query("DELETE FROM claims WHERE asset_key = ANY($1)", [seededAssets]);
      await db.pool.query("DELETE FROM assets WHERE asset_key = ANY($1)", [seededAssets]);
      await db.pool.query("DELETE FROM recipients WHERE recipient_id = ANY($1)", [seededRecipients]);
    }
    await db.close();
  });

  it("token happy path: verified -> confirmed, asset claimed, ONE signature", async () => {
    const seed = await seedVerifiedClaim({ assetType: "token", amount: 1234n * ONE_TOKEN });
    track(seed);
    const fake = new FakeChainGateway();
    const worker = await makeWorker(fake);

    const res = await worker.processClaim(seed.claimId);
    assert.equal(res.outcome, "confirmed");
    assert.equal(fake.signCount, 1);
    assert.equal(fake.landedSignatures().length, 1);

    const cs = await claimStatus(seed.claimId);
    assert.equal(cs.status, "confirmed");
    assert.equal(cs.settlement, (1234n * ONE_TOKEN).toString());
    assert.equal(await assetStatus(seed.assetKey), "claimed");

    // Re-run is a no-op (idempotent) — no second signature.
    const again = await worker.processClaim(seed.claimId);
    assert.equal(again.outcome, "already_confirmed");
    assert.equal(fake.signCount, 1);
  });

  it("EXACTLY-ONCE: crash AFTER land, before finalize -> recovery confirms, no re-send", async () => {
    const seed = await seedVerifiedClaim({ assetType: "token", amount: 500n * ONE_TOKEN });
    track(seed);
    const fake = new FakeChainGateway();
    // The tx lands, but the FIRST confirmSignature reports `pending` (== the
    // process crashed after broadcast, before it recorded confirmation).
    fake.forcePendingCount = 1;
    const worker = await makeWorker(fake);

    const tick1 = await worker.processClaim(seed.claimId);
    assert.equal(tick1.outcome, "awaiting_confirmation");
    assert.equal((await claimStatus(seed.claimId)).status, "dispatching");
    assert.equal(fake.signCount, 1);
    assert.equal(fake.landedSignatures().length, 1); // it DID land

    // Restart: recovery sees `dispatching` + a recorded sig, checks it -> confirmed.
    const tick2 = await worker.processClaim(seed.claimId);
    assert.equal(tick2.outcome, "recovered_confirmed");
    assert.equal(fake.signCount, 1, "MUST NOT sign a second tx after a crash");
    assert.equal(fake.landedSignatures().length, 1, "exactly one on-chain transfer");
    assert.equal((await claimStatus(seed.claimId)).status, "confirmed");
    assert.equal(await assetStatus(seed.assetKey), "claimed");
  });

  it("EXACTLY-ONCE: crash BEFORE broadcast + blockhash expiry -> re-sign, only ONE lands", async () => {
    const seed = await seedVerifiedClaim({ assetType: "token", amount: 777n * ONE_TOKEN });
    track(seed);
    const fake = new FakeChainGateway();
    fake.crashOnBroadcast = true; // tx1 signed + persisted, but never broadcast
    const worker = await makeWorker(fake);

    const tick1 = await worker.processClaim(seed.claimId);
    assert.equal(tick1.outcome, "awaiting_confirmation");
    const afterTick1 = await claimStatus(seed.claimId);
    assert.equal(afterTick1.status, "dispatching");
    assert.equal(fake.signCount, 1);
    assert.equal(fake.landedSignatures().length, 0); // nothing landed

    // The persisted tx's blockhash expires; broadcasting works again.
    fake.blockHeight += 1000n; // past lastValidBlockHeight
    fake.crashOnBroadcast = false;

    const tick2 = await worker.processClaim(seed.claimId);
    assert.equal(tick2.outcome, "confirmed");
    assert.equal(fake.signCount, 2, "re-signed after the first tx provably expired");
    assert.equal(fake.landedSignatures().length, 1, "EXACTLY ONE tx ever landed");

    const cs = await claimStatus(seed.claimId);
    assert.equal(cs.status, "confirmed");
    assert.equal(cs.txs.length, 2, "both attempted sigs recorded; only one landed");
    assert.equal(await assetStatus(seed.assetKey), "claimed");
  });

  it("EXACTLY-ONCE: two concurrent workers on one claim -> single dispatch", async () => {
    const seed = await seedVerifiedClaim({ assetType: "token", amount: 42n * ONE_TOKEN });
    track(seed);
    const fake = new FakeChainGateway();
    const w1 = await makeWorker(fake);
    const w2 = await makeWorker(fake);
    const [r1, r2] = await Promise.all([w1.processClaim(seed.claimId), w2.processClaim(seed.claimId)]);
    const outcomes = [r1.outcome, r2.outcome].sort();
    // One confirms; the other sees the state already moved and skips (never a 2nd send).
    assert.ok(outcomes.includes("confirmed"));
    assert.equal(fake.landedSignatures().length, 1, "exactly one on-chain transfer under a race");
    assert.equal((await claimStatus(seed.claimId)).status, "confirmed");
  });

  it(">100k big-claim brake: a verified over-threshold claim is NOT auto-dispensed", async () => {
    const seed = await seedVerifiedClaim({ assetType: "token", amount: 200_000n * ONE_TOKEN });
    track(seed);
    const fake = new FakeChainGateway();
    const worker = await makeWorker(fake);

    const res = await worker.processClaim(seed.claimId);
    assert.equal(res.outcome, "routed_to_review");
    assert.equal(fake.signCount, 0, "over-brake claim MUST NOT be signed/sent");
    assert.equal((await claimStatus(seed.claimId)).status, "pending_review");
    assert.equal(await assetStatus(seed.assetKey), "pending_review");

    // Operator approves -> now it dispatches.
    await DispatchWorker.approveClaim(db.pool, seed.claimId, "operator-1");
    const res2 = await worker.processClaim(seed.claimId);
    assert.equal(res2.outcome, "confirmed");
    assert.equal(fake.landedSignatures().length, 1);
    assert.equal(await assetStatus(seed.assetKey), "claimed");
  });

  it("insufficient float: claim stays queued (deferred_refill), nothing signed", async () => {
    const seed = await seedVerifiedClaim({ assetType: "token", amount: 10_000n * ONE_TOKEN });
    track(seed);
    const fake = new FakeChainGateway();
    fake.balance = 9_999n * ONE_TOKEN; // below the claim amount
    const worker = await makeWorker(fake);

    const res = await worker.processClaim(seed.claimId);
    assert.equal(res.outcome, "deferred_refill");
    assert.equal(fake.signCount, 0);
    assert.equal((await claimStatus(seed.claimId)).status, "verified"); // still queued

    // Refill -> next tick dispatches.
    fake.balance = 50_000n * ONE_TOKEN;
    const res2 = await worker.processClaim(seed.claimId);
    assert.equal(res2.outcome, "confirmed");
  });

  it("ANT is operator-gated: never auto-dispensed hot; approve -> dispatched via ant signer", async () => {
    assert.notEqual(signers.token.address, signers.ant?.address); // separable custody
    const seed = await seedVerifiedClaim({ assetType: "ant" });
    track(seed);
    const fake = new FakeChainGateway();
    const worker = await makeWorker(fake);

    const res = await worker.processClaim(seed.claimId);
    assert.equal(res.outcome, "awaiting_approval");
    assert.equal(fake.signCount, 0, "an NFT is NEVER auto-dispensed from a hot key");
    assert.equal(await assetStatus(seed.assetKey), "pending_review");

    await DispatchWorker.approveClaim(db.pool, seed.claimId, "operator-1");
    const res2 = await worker.processClaim(seed.claimId);
    assert.equal(res2.outcome, "confirmed");
    assert.equal(fake.landedSignatures().length, 1);
    const cs = await claimStatus(seed.claimId);
    assert.equal(cs.status, "confirmed");
    assert.equal(cs.settlement, null, "ANT dispatch carries no settlement_amount");
    assert.equal(await assetStatus(seed.assetKey), "claimed");
  });

  it("vault-liquid (expired) settles as an SPL transfer of the amount", async () => {
    const past = Math.floor(Date.now() / 1000) - 86_400; // unlocked yesterday
    const seed = await seedVerifiedClaim({ assetType: "vault", amount: 5000n * ONE_TOKEN, vaultEndTs: past });
    track(seed);
    const fake = new FakeChainGateway();
    const worker = await makeWorker(fake);
    const res = await worker.processClaim(seed.claimId);
    assert.equal(res.outcome, "confirmed");
    const cs = await claimStatus(seed.claimId);
    assert.equal(cs.settlement, (5000n * ONE_TOKEN).toString());
  });

  it("vault-relock (still locked, long remaining) routes to MANUAL delivery (never silently liquid, never loops) [item V]", async () => {
    const future = Math.floor(Date.now() / 1000) + 200 * 86_400; // 200 days out
    const seed = await seedVerifiedClaim({ assetType: "vault", amount: 5000n * ONE_TOKEN, vaultEndTs: future });
    track(seed);
    const fake = new FakeChainGateway();
    const worker = await makeWorker(fake);
    const res = await worker.processClaim(seed.claimId);
    // Item V: a still-locked vault is NOT auto-relocked and NOT looped in review —
    // it goes to the manual-delivery operator queue with its absolute unlock ts.
    assert.equal(res.outcome, "awaiting_manual_vault_delivery");
    assert.equal(fake.signCount, 0);
    assert.equal((await claimStatus(seed.claimId)).status, "awaiting_manual_vault_delivery");
    assert.equal(await assetStatus(seed.assetKey), "pending_review");
  });

  it("reconcile-after-dispatch is clean and balances dispatched == claimed", async () => {
    const a = await seedVerifiedClaim({ assetType: "token", amount: 111n * ONE_TOKEN });
    const b = await seedVerifiedClaim({ assetType: "token", amount: 222n * ONE_TOKEN });
    track(a);
    track(b);
    const fake = new FakeChainGateway();
    const worker = await makeWorker(fake);
    await worker.processClaim(a.claimId);
    await worker.processClaim(b.claimId);

    // Scope to just these two assets (other concurrent test files share the DB).
    const rep = await reconcileDispatch(db.pool, { assetKeys: [a.assetKey, b.assetKey] });
    assert.equal(rep.ok, true, `issues: ${rep.issues.join("; ")}`);
    assert.equal(rep.dispatchedTotalMario, 333n * ONE_TOKEN);
    assert.equal(rep.dispatchedTotalMario, rep.claimedTotalMario);
  });
});
