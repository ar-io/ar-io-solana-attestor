//! Regression tests for the M4 tester round-1 defects (DB-backed):
//!   #1  worker never re-checked the asset before signing -> a lone `verified`
//!       claim on an already-`claimed` asset could dispense a SECOND transfer.
//!       Fixed: pre-sign guard + authoritative asset `FOR UPDATE` re-check in
//!       #persistDispatching. Proven here: 0 transfers in both the already-claimed
//!       case AND the race where the asset flips to `claimed` mid-sign.
//!   ANT custody decision: cold authority, OPERATOR-SUPPLIED per approval batch
//!       (no persistent server ant key). Proven: a token-only worker holds an
//!       approved ANT until `runAntBatch(coldSigner)` dispenses it.

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
import { FakeChainGateway } from "./fake-chain.testkit.js";

const HAS_DB = !!process.env.DATABASE_URL;
const ONE_TOKEN = 1_000_000n;
const MINT = "DcNnMuFxwhgV4WY1HVSaSEgr92bv2b1vUvEKiNxWqHdF" as Address;
const policy: FloatPolicy = { capMario: 500_000n * ONE_TOKEN, bigClaimThresholdMario: 100_000n * ONE_TOKEN, refillThresholdMario: 100_000n * ONE_TOKEN };

function testConfig(): Config {
  return {
    port: 0, host: "127.0.0.1", logLevel: "silent", network: "solana-mainnet",
    databaseUrl: process.env.DATABASE_URL ?? "", solanaRpcUrl: "http://127.0.0.1:8899",
    challengeTtlMs: 900_000, bigClaimThresholdMario: policy.bigClaimThresholdMario,
    rateLimitPerMin: 1e6, rateLimitIdentityPerMin: 1e6, corsOrigin: "*",
  };
}

let db: Db;
let tokenSigner: InMemoryKeypairSigner;
let coldAnt: InMemoryKeypairSigner;
const seededAssets: string[] = [];
const seededRecipients: string[] = [];

function makeWorker(gateway: FakeChainGateway, signers: SignerRegistry): DispatchWorker {
  return new DispatchWorker({
    pool: db.pool, gateway, signers, float: new FloatManager(policy), config: testConfig(), mint: MINT,
    vaultDurations: { minVaultDuration: BigInt(14 * 86_400), maxVaultDuration: BigInt(365 * 86_400) },
    antRequiresApproval: true,
  });
}

async function seedClaim(opts: { assetType: "token" | "ant"; amount?: bigint; assetStatus?: string; antMint?: string }): Promise<{ claimId: string; assetKey: string }> {
  const recipientId = `fix_${randomBytes(8).toString("hex")}`;
  await insertRecipient(db.pool, { recipientId, protocol: 1, sourceAddress: recipientId, recipientPubkey: new Uint8Array(randomBytes(20)) });
  const assetKey = opts.assetType === "ant" ? (opts.antMint ?? randomClaimant()) : randomBytes(32).toString("hex");
  await insertAsset(db.pool, recipientId, {
    assetKey, assetType: opts.assetType, antMint: opts.assetType === "ant" ? (opts.antMint ?? randomClaimant()) : null,
    amount: opts.assetType === "ant" ? null : (opts.amount ?? 1000n * ONE_TOKEN),
    status: opts.assetStatus ?? "claiming",
  });
  const r = await db.pool.query<{ claim_id: string }>(
    `INSERT INTO claims (asset_key, claimant, canonical_message, recipient_id, protocol, status, verified_at)
     VALUES ($1,$2,$3,$4,1,'verified', now()) RETURNING claim_id`,
    [assetKey, randomClaimant(), Buffer.from("x"), recipientId],
  );
  seededAssets.push(assetKey);
  seededRecipients.push(recipientId);
  return { claimId: r.rows[0].claim_id, assetKey };
}
async function assetStatus(assetKey: string): Promise<string> {
  return (await db.pool.query<{ status: string }>("SELECT status FROM assets WHERE asset_key=$1", [assetKey])).rows[0].status;
}
async function claimStatus(claimId: string): Promise<string> {
  return (await db.pool.query<{ status: string }>("SELECT status FROM claims WHERE claim_id=$1", [claimId])).rows[0].status;
}

describe("M4 tester round-1 fixes (DB)", { skip: !HAS_DB }, () => {
  before(async () => {
    db = createDb(process.env.DATABASE_URL as string);
    tokenSigner = await InMemoryKeypairSigner.fromSeed("token", new Uint8Array(randomBytes(32)));
    coldAnt = await InMemoryKeypairSigner.fromSeed("ant", new Uint8Array(randomBytes(32)));
  });
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

  // ---- Defect #1: worker must not dispense against an already-claimed asset ----
  it("(a) lone verified claim on an ALREADY-CLAIMED asset -> ABORT, 0 transfers", async () => {
    const { claimId, assetKey } = await seedClaim({ assetType: "token", amount: 500n * ONE_TOKEN, assetStatus: "claimed" });
    const fake = new FakeChainGateway();
    const worker = makeWorker(fake, { token: tokenSigner });

    const res = await worker.processClaim(claimId);
    assert.equal(res.outcome, "skipped");
    assert.equal(fake.signCount, 0, "must not even sign for an already-claimed asset");
    assert.equal(fake.landedSignatures().length, 0, "ZERO on-chain transfers");
    assert.equal(await assetStatus(assetKey), "claimed"); // untouched
  });

  it("(a') asset flips to claimed DURING sign -> persist FOR UPDATE guard ABORTS (0 transfers)", async () => {
    const { claimId, assetKey } = await seedClaim({ assetType: "token", amount: 500n * ONE_TOKEN, assetStatus: "claiming" });
    const fake = new FakeChainGateway();
    // Between the pre-sign asset read and the persist, the asset becomes claimed
    // (simulating a concurrent settle). The authoritative FOR UPDATE re-check in
    // #persistDispatching must abort so the signed tx is NEVER broadcast.
    fake.onSign = async () => {
      await db.pool.query("UPDATE assets SET status='claimed' WHERE asset_key=$1", [assetKey]);
    };
    const worker = makeWorker(fake, { token: tokenSigner });

    const res = await worker.processClaim(claimId);
    assert.equal(res.outcome, "skipped", "persist guard aborts after the mid-sign claim");
    assert.equal(fake.signCount, 1, "it signed (raced), but...");
    assert.equal(fake.landedSignatures().length, 0, "...the signed tx was NEVER broadcast -> 0 transfers");
    assert.equal(await claimStatus(claimId), "verified", "claim left un-dispatched (no dispatch_signature persisted)");
    const sig = (await db.pool.query<{ s: string | null }>("SELECT dispatch_signature s FROM claims WHERE claim_id=$1", [claimId])).rows[0].s;
    assert.equal(sig, null, "no dispatch signature persisted");
  });

  // ---- ANT custody: cold authority, operator-supplied per batch ----
  it("token-only worker holds an approved ANT until runAntBatch supplies the cold signer", async () => {
    assert.notEqual(tokenSigner.address, coldAnt.address);
    const { claimId, assetKey } = await seedClaim({ assetType: "ant", antMint: randomClaimant() });
    const fake = new FakeChainGateway();
    // NO persistent ant signer in the registry (production posture).
    const worker = makeWorker(fake, { token: tokenSigner });

    // Not approved -> awaiting_approval (routed to review).
    assert.equal((await worker.processClaim(claimId)).outcome, "awaiting_approval");
    await DispatchWorker.approveClaim(db.pool, claimId, "op");
    // Approved but no cold signer loaded in this invocation -> held, NOT dispensed.
    const held = await worker.processClaim(claimId);
    assert.equal(held.outcome, "awaiting_ant_signer");
    assert.equal(fake.signCount, 0, "an NFT is NEVER dispensed without the operator-supplied cold signer");

    // Operator runs the ANT batch with the cold authority loaded for THIS batch.
    const results = await worker.runAntBatch(coldAnt);
    assert.equal(results.length, 1);
    assert.equal(results[0].outcome, "confirmed");
    assert.equal(fake.landedSignatures().length, 1);
    assert.equal(await assetStatus(assetKey), "claimed");
  });

  it("runAntBatch rejects a non-ant signer and one equal to the hot dispenser", async () => {
    const fake = new FakeChainGateway();
    const worker = makeWorker(fake, { token: tokenSigner });
    const wrongRole = await InMemoryKeypairSigner.fromSeed("token", new Uint8Array(randomBytes(32)));
    await assert.rejects(worker.runAntBatch(wrongRole), /requires an 'ant'-role signer/);
    // An ant-role signer whose address equals the hot dispenser is refused too.
    const clash = await InMemoryKeypairSigner.fromSeed("ant", new Uint8Array(randomBytes(32)));
    Object.defineProperty(clash, "address", { value: tokenSigner.address });
    await assert.rejects(worker.runAntBatch(clash), /must NOT be the hot token dispenser/);
  });
});
