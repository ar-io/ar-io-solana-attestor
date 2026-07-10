//! Dispatch worker — ADVERSARIAL exactly-once / no-double-send suite (M4 tester).
//!
//! Independent of the dev's worker.db.test.ts. Attacks the seams that could
//! produce a SECOND on-chain transfer for one asset — the critical fund-loss
//! failure across ~48M ARIO + 2,269 ANTs. Everything drives the REAL
//! DispatchWorker against the deterministic FakeChainGateway so each crash /
//! race point is reproducible; the invariant asserted everywhere is
//! `landedSignatures().length <= 1` per asset.
//!
//! Gated on DATABASE_URL + the migrated M4 schema.

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

/**
 * A FakeChainGateway with an intentionally huge hot balance. The float
 * `reserved()` sums verified+dispatching token/vault claims across the WHOLE
 * shared test DB, so a concurrently-running test file's in-flight claims would
 * otherwise pressure this worker's available float and flake a dispatch into
 * `deferred_refill`. A balance far above any test's reserved keeps the float
 * check a no-op — these tests target exactly-once, not the float brake (SEAM 7
 * / the dev's suite cover the brake with a bounded balance).
 */
function newFake(): FakeChainGateway {
  const f = new FakeChainGateway();
  f.balance = 10n ** 15n;
  return f;
}

async function makeWorker(gateway: FakeChainGateway, thresholdMario = policy.bigClaimThresholdMario): Promise<DispatchWorker> {
  return new DispatchWorker({
    pool: db.pool, gateway, signers,
    float: new FloatManager({ ...policy, bigClaimThresholdMario: thresholdMario }),
    config: testConfig(),
    mint: MINT,
    vaultDurations: { minVaultDuration: BigInt(14 * 86_400), maxVaultDuration: BigInt(365 * 86_400) },
    antRequiresApproval: true,
  });
}

// A tiny per-claim brake so brake tests can use SMALL amounts. Large verified
// token/vault amounts would otherwise inflate the process-global float
// `reserved()` sum that concurrently-running test files read (shared DB),
// flaking THEM. Every seeded verified amount here stays <= a few thousand ARIO.
const SMALL_BRAKE = 1_000n * ONE_TOKEN;

async function seedVerifiedClaim(opts: {
  assetType: "token" | "vault" | "ant";
  amount?: bigint;
  vaultEndTs?: number;
}): Promise<{ claimId: string; assetKey: string; recipientId: string; claimant: string }> {
  const recipientId = `adv_${randomBytes(8).toString("hex")}`;
  await insertRecipient(db.pool, {
    recipientId, protocol: 1, sourceAddress: recipientId, recipientPubkey: new Uint8Array(randomBytes(20)),
  });
  const assetKey = opts.assetType === "ant" ? randomClaimant() : randomBytes(32).toString("hex");
  await insertAsset(db.pool, recipientId, {
    assetKey, assetType: opts.assetType,
    antMint: opts.assetType === "ant" ? randomClaimant() : null,
    amount: opts.assetType === "ant" ? null : (opts.amount ?? 1000n * ONE_TOKEN),
    vaultEndTs: opts.vaultEndTs ?? null,
    status: "claiming",
  });
  const claimant = randomClaimant();
  const r = await db.pool.query<{ claim_id: string }>(
    `INSERT INTO claims (asset_key, claimant, canonical_message, recipient_id, protocol, status, verified_at)
     VALUES ($1,$2,$3,$4,1,'verified', now()) RETURNING claim_id`,
    [assetKey, claimant, Buffer.from("adv-canonical"), recipientId],
  );
  return { claimId: r.rows[0].claim_id, assetKey, recipientId, claimant };
}

async function claimStatus(claimId: string): Promise<{ status: string; sig: string | null; txs: string[] }> {
  const r = await db.pool.query<{ status: string; dispatch_signature: string | null; tx_signatures: string[] | null }>(
    "SELECT status, dispatch_signature, tx_signatures FROM claims WHERE claim_id = $1", [claimId],
  );
  return { status: r.rows[0].status, sig: r.rows[0].dispatch_signature, txs: r.rows[0].tx_signatures ?? [] };
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

describe("dispatch worker — ADVERSARIAL no-double-send (DB)", { skip: !HAS_DB }, () => {
  before(async () => {
    db = createDb(process.env.DATABASE_URL as string);
    signers = {
      token: await InMemoryKeypairSigner.fromSeed("token", new Uint8Array(randomBytes(32))),
      ant: await InMemoryKeypairSigner.fromSeed("ant", new Uint8Array(randomBytes(32))),
    };
  });
  beforeEach(() => { seededRecipients.length = 0; seededAssets.length = 0; });
  after(async () => {
    if (seededAssets.length) {
      await db.pool.query("DELETE FROM audit_log WHERE entry->>'assetKey' = ANY($1)", [seededAssets]);
      await db.pool.query("DELETE FROM claims WHERE asset_key = ANY($1)", [seededAssets]);
      await db.pool.query("DELETE FROM assets WHERE asset_key = ANY($1)", [seededAssets]);
      await db.pool.query("DELETE FROM recipients WHERE recipient_id = ANY($1)", [seededRecipients]);
    }
    await db.close();
  });

  // -------------------------------------------------------------------------
  // SEAM 1 — recovery of a landed-but-unfinalized dispatch must NEVER re-send,
  // even when two recovery ticks race (concurrent finalize is idempotent).
  // -------------------------------------------------------------------------
  it("crash-after-land + TWO concurrent recovery ticks -> exactly one land, idempotent finalize", async () => {
    const seed = await seedVerifiedClaim({ assetType: "token", amount: 640n * ONE_TOKEN });
    track(seed);
    const fake = newFake();
    fake.forcePendingCount = 1; // first confirm reports pending though it landed
    const w = await makeWorker(fake);

    const t1 = await w.processClaim(seed.claimId);
    assert.equal(t1.outcome, "awaiting_confirmation");
    assert.equal((await claimStatus(seed.claimId)).status, "dispatching");
    assert.equal(fake.landedSignatures().length, 1);

    // Two workers recover the same in-flight claim at once.
    const w2 = await makeWorker(fake);
    const [r1, r2] = await Promise.all([w.processClaim(seed.claimId), w2.processClaim(seed.claimId)]);
    for (const r of [r1, r2]) assert.ok(["recovered_confirmed", "already_confirmed"].includes(r.outcome), `outcome ${r.outcome}`);
    assert.equal(fake.signCount, 1, "recovery MUST NOT sign a replacement");
    assert.equal(fake.landedSignatures().length, 1, "still exactly one on-chain transfer");
    assert.equal((await claimStatus(seed.claimId)).status, "confirmed");
    assert.equal(await assetStatus(seed.assetKey), "claimed");
  });

  // -------------------------------------------------------------------------
  // SEAM 2 — a broadcast that DROPPED (tx never lands) must NOT be re-signed
  // while its blockhash is still valid (the "provably dead before re-sign"
  // guard). A premature re-sign here is the classic double-send.
  // -------------------------------------------------------------------------
  it("dropped broadcast, blockhash STILL valid -> waits, never re-signs prematurely", async () => {
    const seed = await seedVerifiedClaim({ assetType: "token", amount: 333n * ONE_TOKEN });
    track(seed);
    const fake = newFake();
    fake.dropBroadcast = true; // broadcast returns but the tx never lands
    const w = await makeWorker(fake);

    const t1 = await w.processClaim(seed.claimId);
    assert.equal(t1.outcome, "awaiting_confirmation");
    assert.equal(fake.signCount, 1);
    assert.equal(fake.landedSignatures().length, 0);

    // Recover repeatedly while the blockhash is still valid: the worker must
    // keep WAITING, never re-sign (the original could still land).
    for (let i = 0; i < 3; i++) {
      const r = await w.processClaim(seed.claimId);
      assert.equal(r.outcome, "awaiting_confirmation", `tick ${i}`);
      assert.equal(fake.signCount, 1, "MUST NOT re-sign while the prior tx can still land");
    }
    assert.equal((await claimStatus(seed.claimId)).status, "dispatching");
  });

  // -------------------------------------------------------------------------
  // SEAM 3 — only AFTER the dropped tx is provably dead (blockhash expired) may
  // the worker re-sign; still exactly one lands.
  // -------------------------------------------------------------------------
  it("dropped broadcast THEN blockhash expiry -> re-sign, EXACTLY ONE lands", async () => {
    const seed = await seedVerifiedClaim({ assetType: "token", amount: 333n * ONE_TOKEN });
    track(seed);
    const fake = newFake();
    fake.dropBroadcast = true;
    const w = await makeWorker(fake);

    await w.processClaim(seed.claimId);
    assert.equal(fake.signCount, 1);
    assert.equal(fake.landedSignatures().length, 0);

    // The dead tx expires; broadcasting works again.
    fake.blockHeight += 1000n;
    fake.dropBroadcast = false;

    const r = await w.processClaim(seed.claimId);
    assert.equal(r.outcome, "confirmed");
    assert.equal(fake.signCount, 2, "re-signed only after the prior tx was provably dead");
    assert.equal(fake.landedSignatures().length, 1, "EXACTLY ONE on-chain transfer");
    const cs = await claimStatus(seed.claimId);
    assert.equal(cs.status, "confirmed");
    assert.equal(cs.txs.length, 2, "both attempted sigs recorded; only one landed");
    assert.equal(await assetStatus(seed.assetKey), "claimed");
  });

  // -------------------------------------------------------------------------
  // SEAM 4 — an approved ANT dispatched by two workers at once -> single land
  // via the SEPARATE ant signer (an NFT can't be handed out twice).
  // -------------------------------------------------------------------------
  it("approved ANT, two concurrent workers -> exactly one transfer", async () => {
    const seed = await seedVerifiedClaim({ assetType: "ant" });
    track(seed);
    const fake = newFake();
    const w = await makeWorker(fake);
    assert.equal((await w.processClaim(seed.claimId)).outcome, "awaiting_approval");
    assert.equal(fake.signCount, 0);

    await DispatchWorker.approveClaim(db.pool, seed.claimId, "op");
    const w2 = await makeWorker(fake);
    const [r1, r2] = await Promise.all([w.processClaim(seed.claimId), w2.processClaim(seed.claimId)]);
    const outs = [r1.outcome, r2.outcome].sort();
    assert.ok(outs.includes("confirmed"), `outcomes ${outs.join(",")}`);
    assert.equal(fake.landedSignatures().length, 1, "an ANT is dispensed exactly once under a race");
    assert.equal(await assetStatus(seed.assetKey), "claimed");
  });

  // -------------------------------------------------------------------------
  // SEAM 5 — a full mixed batch through runOnce: each asset dispensed at most
  // once; the brake + unapproved ANT are held back; reconcile balances.
  // -------------------------------------------------------------------------
  it("mixed batch runOnce: each asset at most once, brake/ANT held, reconcile balances", async () => {
    const a = await seedVerifiedClaim({ assetType: "token", amount: 100n * ONE_TOKEN });
    const b = await seedVerifiedClaim({ assetType: "token", amount: 250n * ONE_TOKEN });
    const c = await seedVerifiedClaim({ assetType: "token", amount: 400n * ONE_TOKEN });
    const brake = await seedVerifiedClaim({ assetType: "token", amount: SMALL_BRAKE + 1n });
    const ant = await seedVerifiedClaim({ assetType: "ant" });
    [a, b, c, brake, ant].forEach(track);

    const fake = newFake();
    const w = await makeWorker(fake, SMALL_BRAKE);
    // Drive MY claim ids explicitly (not the global runOnce sweep, which would
    // also pick up a concurrently-running test file's verified claims and flake
    // this assertion). This still exercises the full per-claim state machine +
    // idempotent re-processing that runOnce loops over.
    const ids = [a, b, c, brake, ant].map((x) => x.claimId);
    const byId = new Map<string, string>();
    for (const id of ids) byId.set(id, (await w.processClaim(id)).outcome);

    assert.equal(byId.get(a.claimId), "confirmed");
    assert.equal(byId.get(b.claimId), "confirmed");
    assert.equal(byId.get(c.claimId), "confirmed");
    assert.equal(byId.get(brake.claimId), "routed_to_review");
    assert.equal(byId.get(ant.claimId), "awaiting_approval");
    assert.equal(fake.landedSignatures().length, 3, "only the 3 in-policy token claims landed");

    // Re-process every id: nothing new lands (idempotent batch).
    for (const id of ids) await w.processClaim(id);
    assert.equal(fake.landedSignatures().length, 3);

    const rep = await reconcileDispatch(db.pool, { assetKeys: [a.assetKey, b.assetKey, c.assetKey] });
    assert.equal(rep.ok, true, rep.issues.join("; "));
    assert.equal(rep.dispatchedTotalMario, 750n * ONE_TOKEN);
    assert.equal(rep.dispatchedTotalMario, rep.claimedTotalMario);
    assert.equal(rep.confirmedClaims, 3);
  });

  // -------------------------------------------------------------------------
  // SEAM 6 — reconcile-after-dispatch is a TRUE backstop: it must FLAG a
  // second confirmed claim on one asset, a missing tx signature, and a
  // dispatched != claimed amount. (Tamper injected directly in the DB.)
  // -------------------------------------------------------------------------
  it("reconcile CATCHES a double-dispense, a missing signature, and an amount mismatch", async () => {
    const good = await seedVerifiedClaim({ assetType: "token", amount: 500n * ONE_TOKEN });
    track(good);
    const fake = newFake();
    const w = await makeWorker(fake);
    await w.processClaim(good.claimId);
    assert.equal(await assetStatus(good.assetKey), "claimed");

    // (a) Inject a SECOND confirmed claim for the same (now claimed) asset —
    //     the exact shape a double-dispense would leave. The live-claim unique
    //     index does NOT cover `confirmed`, so reconcile is the catch.
    await db.pool.query(
      `INSERT INTO claims (asset_key, claimant, canonical_message, recipient_id, protocol, status, verified_at, confirmed_at, dispatch_signature, settlement_amount, tx_signatures)
       VALUES ($1,$2,$3,$4,1,'confirmed', now(), now(), 'DUPSIG', $5, ARRAY['DUPSIG'])`,
      [good.assetKey, randomClaimant(), Buffer.from("dup"), good.recipientId, (500n * ONE_TOKEN).toString()],
    );
    let rep = await reconcileDispatch(db.pool, { assetKeys: [good.assetKey] });
    assert.equal(rep.ok, false);
    assert.ok(rep.issues.some((i) => i.includes("double-dispense")), `expected double-dispense flag, got: ${rep.issues.join("; ")}`);

    // Remove the dup so the next tampers are isolated.
    await db.pool.query("DELETE FROM claims WHERE asset_key = $1 AND dispatch_signature = 'DUPSIG'", [good.assetKey]);

    // (b) Missing signature on the real confirmed claim.
    await db.pool.query("UPDATE claims SET dispatch_signature = NULL WHERE claim_id = $1", [good.claimId]);
    rep = await reconcileDispatch(db.pool, { assetKeys: [good.assetKey] });
    assert.ok(rep.issues.some((i) => i.includes("no recorded tx signature")), `expected missing-sig flag, got: ${rep.issues.join("; ")}`);
    await db.pool.query("UPDATE claims SET dispatch_signature = 'RESTORED' WHERE claim_id = $1", [good.claimId]);

    // (c) Dispatched != claimed.
    await db.pool.query("UPDATE claims SET settlement_amount = $2 WHERE claim_id = $1", [good.claimId, (499n * ONE_TOKEN).toString()]);
    rep = await reconcileDispatch(db.pool, { assetKeys: [good.assetKey] });
    assert.ok(rep.issues.some((i) => i.includes("dispatched") && i.includes("!= claimed")), `expected amount-mismatch flag, got: ${rep.issues.join("; ")}`);
  });

  // -------------------------------------------------------------------------
  // SEAM 7 — the brake is honored at BOTH ends: unapproved over-threshold is
  // never signed; a token exactly AT the threshold is fine; over it is held.
  // -------------------------------------------------------------------------
  it("brake boundary: == threshold dispenses, > threshold is held unsigned", async () => {
    const atThreshold = await seedVerifiedClaim({ assetType: "token", amount: SMALL_BRAKE });
    const overByOne = await seedVerifiedClaim({ assetType: "token", amount: SMALL_BRAKE + 1n });
    track(atThreshold); track(overByOne);
    const fake = newFake();
    const w = await makeWorker(fake, SMALL_BRAKE);

    const rAt = await w.processClaim(atThreshold.claimId);
    assert.equal(rAt.outcome, "confirmed", "amount == threshold is NOT over the brake");
    const rOver = await w.processClaim(overByOne.claimId);
    assert.equal(rOver.outcome, "routed_to_review");
    assert.equal((await claimStatus(overByOne.claimId)).status, "pending_review");
    assert.equal(fake.landedSignatures().length, 1, "only the at-threshold claim landed");
  });
});
