//! Expired-challenge reaper (DB-backed low/info hardening test): an un-completed
//! `claiming` claim whose challenge has expired is swept to `expired`; a
//! not-yet-expired one is left alone; the asset is never touched.

import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { after, before, beforeEach, describe, it } from "node:test";

import { createDb, type Db } from "../db.js";
import { insertAsset, insertRecipient, randomClaimant } from "./proof-testkit.js";
import { reapAllExpiredChallenges } from "./reaper.js";

const HAS_DB = !!process.env.DATABASE_URL;
const ONE_TOKEN = 1_000_000n;

let db: Db;
const seededAssets: string[] = [];
const seededRecipients: string[] = [];

async function seedClaiming(expiresAt: Date): Promise<{ claimId: string; assetKey: string }> {
  const recipientId = `reap_${randomBytes(8).toString("hex")}`;
  await insertRecipient(db.pool, { recipientId, protocol: 1, sourceAddress: recipientId, recipientPubkey: new Uint8Array(randomBytes(20)) });
  const assetKey = randomBytes(32).toString("hex");
  await insertAsset(db.pool, recipientId, { assetKey, assetType: "token", antMint: null, amount: 100n * ONE_TOKEN, status: "available" });
  const r = await db.pool.query<{ claim_id: string }>(
    `INSERT INTO claims (asset_key, claimant, canonical_message, recipient_id, protocol, status, challenge_nonce, challenge_expires_at, verified_at)
     VALUES ($1,$2,$3,$4,1,'claiming',$5,$6,NULL) RETURNING claim_id`,
    [assetKey, randomClaimant(), Buffer.from("c"), recipientId, Buffer.alloc(32, 7), expiresAt],
  );
  seededAssets.push(assetKey);
  seededRecipients.push(recipientId);
  return { claimId: r.rows[0].claim_id, assetKey };
}
async function statusOf(claimId: string): Promise<string> {
  return (await db.pool.query<{ status: string }>("SELECT status FROM claims WHERE claim_id=$1", [claimId])).rows[0].status;
}
async function assetStatusOf(assetKey: string): Promise<string> {
  return (await db.pool.query<{ status: string }>("SELECT status FROM assets WHERE asset_key=$1", [assetKey])).rows[0].status;
}

describe("expired-challenge reaper (DB)", { skip: !HAS_DB }, () => {
  before(() => { db = createDb(process.env.DATABASE_URL as string); });
  beforeEach(() => { seededAssets.length = 0; seededRecipients.length = 0; });
  after(async () => {
    if (seededAssets.length) {
      await db.pool.query("DELETE FROM audit_log WHERE entry->>'assetKey' = ANY($1)", [seededAssets]);
      await db.pool.query("DELETE FROM claims WHERE asset_key = ANY($1)", [seededAssets]);
      await db.pool.query("DELETE FROM assets WHERE asset_key = ANY($1)", [seededAssets]);
      await db.pool.query("DELETE FROM recipients WHERE recipient_id = ANY($1)", [seededRecipients]);
    }
    await db.close();
  });

  it("reaps an expired claiming challenge, leaves a fresh one, never touches the asset", async () => {
    const expired = await seedClaiming(new Date(Date.now() - 60_000)); // expired 1 min ago
    const fresh = await seedClaiming(new Date(Date.now() + 3_600_000)); // 1h in the future

    const reaped = await reapAllExpiredChallenges(db.pool, { now: new Date() });
    assert.ok(reaped >= 1, `at least the expired one reaped, got ${reaped}`);

    assert.equal(await statusOf(expired.claimId), "expired", "expired challenge swept to expired");
    assert.equal(await statusOf(fresh.claimId), "claiming", "fresh challenge left alone");
    // The asset a claiming claim never won is untouched (still available).
    assert.equal(await assetStatusOf(expired.assetKey), "available");

    // Idempotent: a second sweep of just-this-test's rows reaps nothing new here.
    assert.equal(await statusOf(expired.claimId), "expired");
  });
});
