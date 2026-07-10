//! DB round-trip for writeLedger -> builtSetFromDb. Gated on DATABASE_URL and a
//! migrated schema (CI runs `migrate:up` before `test`). Uses distinctive
//! synthetic keys and cleans up, so it is safe against a populated ledger.

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { deriveRecipientIdB64Url } from "@ar.io/attestor-canonical";
import { createDb, type Db } from "../db.js";
import { builtSetFromDb } from "../reconcile/reconcile.js";
import { writeLedger } from "./build.js";
import type { LedgerPlan, PlannedAsset, PlannedRecipient } from "./types.js";

const HAS_DB = !!process.env.DATABASE_URL;

const MOD = new Uint8Array(512).fill(9);
const AR_ADDR = deriveRecipientIdB64Url(MOD);
const ETH_SRC = "0xabcabcabcabcabcabcabcabcabcabcabcabcabca";
const ETH_BYTES = new Uint8Array(Buffer.from(ETH_SRC.slice(2), "hex"));
const ETH_ID = deriveRecipientIdB64Url(ETH_BYTES);

const K_ANT = "TEST_M1_ANTMINT_ROUNDTRIP_000000000000000000";
const K_TOK = "test_m1_token_" + "00".repeat(24); // distinctive, not a real 64-hex id
const K_VLT = "test_m1_vault_" + "11".repeat(24);
const K_MR = "test_m1_review_" + "22".repeat(23);

function plan(): LedgerPlan {
  const recipients: PlannedRecipient[] = [
    { sourceAddress: AR_ADDR, protocol: 0, recipientPubkey: MOD, recipientId: AR_ADDR, status: "open" },
    { sourceAddress: ETH_SRC, protocol: 1, recipientPubkey: ETH_BYTES, recipientId: ETH_ID, status: "open" },
    {
      sourceAddress: "test_m1_atrisk_owner",
      protocol: 0,
      recipientPubkey: null,
      recipientId: "test_m1_atrisk_owner",
      status: "manual_review",
    },
  ];
  const assets: PlannedAsset[] = [
    {
      assetKey: K_ANT, assetType: "ant", recipientSource: AR_ADDR, antMint: K_ANT,
      amount: null, vaultEndTs: null, status: "available",
      source: { phase: "ant", aoProcessId: "p", onchainSeed: "escrow_ant" },
    },
    {
      assetKey: K_TOK, assetType: "token", recipientSource: ETH_SRC, antMint: null,
      amount: 123_456_789n, vaultEndTs: null, status: "available",
      source: { phase: "token", arweaveAddress: ETH_SRC, onchainSeed: "escrow_token" },
    },
    {
      assetKey: K_VLT, assetType: "vault", recipientSource: AR_ADDR, antMint: null,
      amount: 5_000_000_000n, vaultEndTs: 1_795_000_000, status: "available",
      source: { phase: "vault", arweaveAddress: AR_ADDR, vaultId: "v", onchainSeed: "escrow_vault" },
    },
    {
      assetKey: K_MR, assetType: "token", recipientSource: "test_m1_atrisk_owner", antMint: null,
      amount: 777n, vaultEndTs: null, status: "manual_review",
      source: { phase: "token", arweaveAddress: "test_m1_atrisk_owner", onchainSeed: "escrow_token" },
    },
  ];
  return {
    recipients, assets,
    counters: { ant: 1, tokenEscrowed: 1, vaultEscrowed: 1, stakeEscrowed: 0 },
    phase2TokenOutflowMario: 123_456_789n,
    atRiskRecipientCount: 1,
    inputFingerprints: {},
    nowMs: 1783641600000,
  };
}

describe("writeLedger <-> builtSetFromDb round-trip", { skip: HAS_DB ? false : "DATABASE_URL not set" }, () => {
  let db: Db;
  let usable = false;

  before(async () => {
    db = createDb(process.env.DATABASE_URL!);
    try {
      const r = await db.pool.query(
        "SELECT to_regclass('public.assets') a, to_regclass('public.recipients') rc",
      );
      usable = !!r.rows[0].a && !!r.rows[0].rc;
    } catch {
      usable = false;
    }
  });

  after(async () => {
    if (db) {
      try {
        await db.pool.query("DELETE FROM assets WHERE asset_key = ANY($1)", [[K_ANT, K_TOK, K_VLT, K_MR]]);
        await db.pool.query("DELETE FROM recipients WHERE recipient_id = ANY($1)", [
          [AR_ADDR, ETH_ID, "test_m1_atrisk_owner"],
        ]);
      } catch {
        /* best-effort cleanup */
      }
      await db.close();
    }
  });

  it("persists recipients + assets and reads back the available set exactly", async (t) => {
    if (!usable) {
      t.skip("schema not migrated (run yarn migrate:up)");
      return;
    }
    const res = await writeLedger(db.pool, plan());
    assert.equal(res.recipientsWritten, 3);
    assert.equal(res.assetsWritten, 4);
    assert.equal(res.availableAssets, 3);
    assert.equal(res.manualReviewAssets, 1);

    const set = await builtSetFromDb(db.pool);
    // available only — the manual_review asset must NOT surface.
    assert.equal(set.has(K_MR), false);
    const tok = set.get(K_TOK);
    assert.equal(tok?.assetType, "token");
    assert.equal(tok?.amount, 123_456_789n); // bigint preserved through NUMERIC
    assert.equal(tok?.recipientHex, Buffer.from(ETH_BYTES).toString("hex"));
    const vlt = set.get(K_VLT);
    assert.equal(vlt?.amount, 5_000_000_000n);
    assert.equal(vlt?.recipientHex.length, 1024); // 512-byte modulus
    const ant = set.get(K_ANT);
    assert.equal(ant?.amount, null);
  });

  it("re-run is idempotent and preserves the minted nonce", async (t) => {
    if (!usable) {
      t.skip("schema not migrated");
      return;
    }
    const before = await db.pool.query<{ nonce: Buffer }>(
      "SELECT nonce FROM assets WHERE asset_key = $1",
      [K_TOK],
    );
    await writeLedger(db.pool, plan());
    const afterQ = await db.pool.query<{ nonce: Buffer }>(
      "SELECT nonce FROM assets WHERE asset_key = $1",
      [K_TOK],
    );
    assert.equal(before.rows[0].nonce.equals(afterQ.rows[0].nonce), true);
  });
});
