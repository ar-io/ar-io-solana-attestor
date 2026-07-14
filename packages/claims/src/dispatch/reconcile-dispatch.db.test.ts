//! reconcile-dispatch: proves it CATCHES divergence (not just reports clean).

import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { after, before, describe, it } from "node:test";

import { createDb, type Db } from "../db.js";
import { insertAsset, insertRecipient, randomClaimant } from "../api/proof-testkit.js";
import { reconcileDispatch } from "./reconcile-dispatch.js";

const HAS_DB = !!process.env.DATABASE_URL;
const ONE_TOKEN = 1_000_000n;

let db: Db;
const assetKeys: string[] = [];
const recipientIds: string[] = [];

/** Seed a recipient + a `claimed` asset + a `confirmed` claim, fully consistent. */
async function seedConfirmed(amount: bigint, opts?: { settlementAmount?: bigint | null; withSig?: boolean; withAudit?: boolean }): Promise<string> {
  const recipientId = `rrid_${randomBytes(8).toString("hex")}`;
  await insertRecipient(db.pool, { recipientId, protocol: 1, sourceAddress: recipientId, recipientPubkey: new Uint8Array(randomBytes(20)) });
  const assetKey = randomBytes(32).toString("hex");
  await insertAsset(db.pool, recipientId, { assetKey, assetType: "token", amount, status: "claimed" });
  const settlement = opts?.settlementAmount === undefined ? amount : opts.settlementAmount;
  const sig = opts?.withSig === false ? null : `SIG_${randomBytes(4).toString("hex")}`;
  const r = await db.pool.query<{ claim_id: string }>(
    `INSERT INTO claims (asset_key, claimant, canonical_message, recipient_id, protocol, status, verified_at, confirmed_at, dispatch_signature, settlement_amount, tx_signatures)
     VALUES ($1,$2,$3,$4,1,'confirmed', now(), now(), $5::text, $6, CASE WHEN $5::text IS NULL THEN NULL ELSE ARRAY[$5::text] END) RETURNING claim_id`,
    [assetKey, randomClaimant(), Buffer.from("x"), recipientId, sig, settlement === null ? null : settlement.toString()],
  );
  const claimId = r.rows[0].claim_id;
  if (opts?.withAudit !== false) {
    for (const event of ["claim.dispatching", "claim.confirmed"]) {
      await db.pool.query(
        "INSERT INTO audit_log (prev_hash, entry, entry_hash, signature) VALUES ($1,$2::jsonb,$3,$4)",
        [Buffer.alloc(32), JSON.stringify({ event, claimId, assetKey }), Buffer.alloc(32), Buffer.alloc(64)],
      );
    }
  }
  assetKeys.push(assetKey);
  recipientIds.push(recipientId);
  return assetKey;
}

describe("reconcile-dispatch — catches divergence (DB)", { skip: !HAS_DB }, () => {
  before(() => { db = createDb(process.env.DATABASE_URL as string); });
  after(async () => {
    await db.pool.query("DELETE FROM audit_log WHERE entry->>'assetKey' = ANY($1)", [assetKeys]);
    await db.pool.query("DELETE FROM claims WHERE asset_key = ANY($1)", [assetKeys]);
    await db.pool.query("DELETE FROM assets WHERE asset_key = ANY($1)", [assetKeys]);
    await db.pool.query("DELETE FROM recipients WHERE recipient_id = ANY($1)", [recipientIds]);
    await db.close();
  });

  it("clean when dispatched == claimed with sig + audit present", async () => {
    const k = await seedConfirmed(100n * ONE_TOKEN);
    const rep = await reconcileDispatch(db.pool, { assetKeys: [k] });
    assert.equal(rep.ok, true, rep.issues.join("; "));
    assert.equal(rep.dispatchedTotalMario, 100n * ONE_TOKEN);
  });

  it("catches dispatched != claimed (settlement_amount tampered)", async () => {
    const k = await seedConfirmed(100n * ONE_TOKEN, { settlementAmount: 100n * ONE_TOKEN + 1n });
    const rep = await reconcileDispatch(db.pool, { assetKeys: [k] });
    assert.equal(rep.ok, false);
    // The tampered claim yields a "dispatched X != claimed Y" issue.
    assert.ok(rep.issues.some((i) => i.includes("!= claimed")), rep.issues.join("; "));
  });

  it("catches a confirmed claim with no recorded tx signature", async () => {
    const k = await seedConfirmed(50n * ONE_TOKEN, { withSig: false });
    const rep = await reconcileDispatch(db.pool, { assetKeys: [k] });
    assert.equal(rep.ok, false);
    assert.ok(rep.issues.some((i) => i.includes("no recorded tx signature")));
  });

  it("catches a double-dispense (two confirmed claims on one asset)", async () => {
    const k = await seedConfirmed(70n * ONE_TOKEN);
    // Inject a SECOND confirmed claim on the same asset.
    await db.pool.query(
      `INSERT INTO claims (asset_key, claimant, canonical_message, recipient_id, protocol, status, verified_at, confirmed_at, dispatch_signature, settlement_amount, tx_signatures)
       SELECT asset_key, $2, $3, recipient_id, 1, 'confirmed', now(), now(), 'SIG_DUP', settlement_amount, ARRAY['SIG_DUP']
         FROM claims WHERE asset_key = $1 LIMIT 1`,
      [k, randomClaimant(), Buffer.from("x")],
    );
    const rep = await reconcileDispatch(db.pool, { assetKeys: [k] });
    assert.equal(rep.ok, false);
    assert.ok(rep.issues.some((i) => i.includes(k) && i.includes("double-dispense")));
  });

  it("catches a confirmed claim missing its audit rows", async () => {
    const k = await seedConfirmed(30n * ONE_TOKEN, { withAudit: false });
    const rep = await reconcileDispatch(db.pool, { assetKeys: [k] });
    assert.equal(rep.ok, false);
    assert.ok(rep.issues.some((i) => i.includes("missing a claim.")));
  });
});
