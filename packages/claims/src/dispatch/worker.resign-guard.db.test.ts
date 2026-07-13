//! Adversarial-pass regression tests (DB-backed):
//!
//!   ITEM A — a lagging/pooled confirm-RPC that MISREPORTS a landed tx as
//!     `expired` must NOT cause a double-send. The recovery path's outflow scan
//!     catches the landed tx and marks the claim confirmed with EXACTLY ONE
//!     on-chain transfer. A persistently misbehaving RPC (also hiding history) is
//!     bounded by the HARD re-sign cap -> terminal `needs_operator` + alert.
//!
//!   ITEM V — a still-locked vault claim routes to the MANUAL delivery queue
//!     (`awaiting_manual_vault_delivery`) with the CORRECT ABSOLUTE unlock ts, and
//!     does NOT loop in pending_review. The queue report re-evaluates at read time:
//!     an active lock -> relock-to-absolute-ts; an already-passed lock -> liquid.

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
import { vaultManualDeliveryQueue } from "./vault-manual-queue.js";

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
let signers: SignerRegistry;
const seededAssets: string[] = [];
const seededRecipients: string[] = [];
const alerts: { name: string; severity: string; claimId: string }[] = [];

function makeWorker(gateway: FakeChainGateway): DispatchWorker {
  return new DispatchWorker({
    pool: db.pool, gateway, signers, float: new FloatManager(policy, { reservedAssetScope: seededAssets }),
    config: testConfig(), mint: MINT,
    vaultDurations: { minVaultDuration: BigInt(14 * 86_400), maxVaultDuration: BigInt(365 * 86_400) },
    antRequiresApproval: true,
    alert: (a) => alerts.push({ name: a.name, severity: a.severity, claimId: a.claimId }),
  });
}

async function seedVerifiedClaim(opts: { assetType: "token" | "vault"; amount?: bigint; vaultEndTs?: number }): Promise<{ claimId: string; assetKey: string; claimant: string }> {
  const recipientId = `adv_${randomBytes(8).toString("hex")}`;
  await insertRecipient(db.pool, { recipientId, protocol: 1, sourceAddress: recipientId, recipientPubkey: new Uint8Array(randomBytes(20)) });
  const assetKey = randomBytes(32).toString("hex");
  await insertAsset(db.pool, recipientId, {
    assetKey, assetType: opts.assetType, antMint: null,
    amount: opts.amount ?? 1000n * ONE_TOKEN, vaultEndTs: opts.vaultEndTs ?? null, status: "claiming",
  });
  const claimant = randomClaimant();
  const r = await db.pool.query<{ claim_id: string }>(
    `INSERT INTO claims (asset_key, claimant, canonical_message, recipient_id, protocol, status, verified_at)
     VALUES ($1,$2,$3,$4,1,'verified', now()) RETURNING claim_id`,
    [assetKey, claimant, Buffer.from("x"), recipientId],
  );
  seededAssets.push(assetKey);
  seededRecipients.push(recipientId);
  return { claimId: r.rows[0].claim_id, assetKey, claimant };
}

async function claim(claimId: string): Promise<{ status: string; sig: string | null; txs: string[]; resign: number }> {
  const r = await db.pool.query<{ status: string; dispatch_signature: string | null; tx_signatures: string[] | null; dispatch_resign_count: number }>(
    "SELECT status, dispatch_signature, tx_signatures, dispatch_resign_count FROM claims WHERE claim_id=$1", [claimId],
  );
  return { status: r.rows[0].status, sig: r.rows[0].dispatch_signature, txs: r.rows[0].tx_signatures ?? [], resign: r.rows[0].dispatch_resign_count };
}
async function assetStatus(assetKey: string): Promise<string> {
  return (await db.pool.query<{ status: string }>("SELECT status FROM assets WHERE asset_key=$1", [assetKey])).rows[0].status;
}

describe("adversarial A + V (DB)", { skip: !HAS_DB }, () => {
  before(async () => {
    db = createDb(process.env.DATABASE_URL as string);
    signers = {
      token: await InMemoryKeypairSigner.fromSeed("token", new Uint8Array(randomBytes(32))),
      ant: await InMemoryKeypairSigner.fromSeed("ant", new Uint8Array(randomBytes(32))),
    };
  });
  beforeEach(() => { seededAssets.length = 0; seededRecipients.length = 0; alerts.length = 0; });
  after(async () => {
    if (seededAssets.length) {
      await db.pool.query("DELETE FROM audit_log WHERE entry->>'assetKey' = ANY($1)", [seededAssets]);
      await db.pool.query("DELETE FROM claims WHERE asset_key = ANY($1)", [seededAssets]);
      await db.pool.query("DELETE FROM assets WHERE asset_key = ANY($1)", [seededAssets]);
      await db.pool.query("DELETE FROM recipients WHERE recipient_id = ANY($1)", [seededRecipients]);
    }
    await db.close();
  });

  // ---- ITEM A: the exploit shape — a LANDED tx reported as `expired` ----
  it("A: lagging-RPC misreports a LANDED tx as expired -> outflow scan confirms, EXACTLY ONE transfer", async () => {
    const seed = await seedVerifiedClaim({ assetType: "token", amount: 500n * ONE_TOKEN });
    const fake = new FakeChainGateway();
    // The confirm-RPC lags: the NEXT TWO confirmSignature calls (the inline confirm
    // after broadcast AND the recovery-tick confirm) misreport the landed tx as
    // provably-dead `expired`. Without the outflow scan this drives a re-sign.
    fake.expiredDespiteLandedCount = 2;
    const worker = makeWorker(fake);

    // Tick 1: tx1 signs, persists, broadcasts (LANDS), inline confirm -> expired
    // (misreport) -> claim left dispatching.
    const t1 = await worker.processClaim(seed.claimId);
    assert.equal(t1.outcome, "awaiting_confirmation");
    assert.equal(fake.signCount, 1);
    assert.equal(fake.landedSignatures().length, 1, "tx1 DID land on-chain");
    assert.equal((await claim(seed.claimId)).status, "dispatching");

    // Tick 2 (recovery): confirmSignature -> expired (misreport again), BUT the
    // outflow scan finds tx1 landed -> confirm, NO re-send.
    const t2 = await worker.processClaim(seed.claimId);
    assert.equal(t2.outcome, "recovered_confirmed");
    assert.equal(fake.signCount, 1, "MUST NOT re-sign — the outflow scan caught the landed tx");
    assert.equal(fake.landedSignatures().length, 1, "EXACTLY ONE on-chain transfer");
    const cs = await claim(seed.claimId);
    assert.equal(cs.status, "confirmed");
    assert.equal(await assetStatus(seed.assetKey), "claimed");
  });

  // ---- ITEM A: bound the blast radius when history is ALSO hidden ----
  it("A: hard cap — persistently dead/hidden RPC re-signs at most ONCE, then needs_operator + critical alert", async () => {
    const seed = await seedVerifiedClaim({ assetType: "token", amount: 500n * ONE_TOKEN });
    const fake = new FakeChainGateway();
    fake.dropBroadcast = true;   // txs never land
    fake.hideOutflows = true;    // fully-adversarial RPC also hides history
    const worker = makeWorker(fake);

    // Tick 1: sign tx1, broadcast dropped (never lands), inline confirm pending.
    await worker.processClaim(seed.claimId);
    assert.equal(fake.signCount, 1);
    // Blockhash expires.
    fake.blockHeight += 1000n;
    // Tick 2 (recovery): expired, no outflow -> re-sign #1 (tx2).
    await worker.processClaim(seed.claimId);
    assert.equal(fake.signCount, 2, "re-signed exactly once");
    assert.equal((await claim(seed.claimId)).resign, 1);
    fake.blockHeight += 1000n;
    // Tick 3 (recovery): expired again, no outflow, cap hit -> needs_operator.
    const t3 = await worker.processClaim(seed.claimId);
    assert.equal(t3.outcome, "needs_operator");
    assert.equal(fake.signCount, 2, "MUST NOT sign a 3rd tx — cap bounds the blast radius");
    assert.equal(fake.landedSignatures().length, 0, "nothing ever landed");
    assert.equal((await claim(seed.claimId)).status, "needs_operator");
    assert.equal(await assetStatus(seed.assetKey), "claiming", "asset held (not released) for the operator");
    assert.ok(alerts.some((a) => a.name === "dispatch-needs-operator" && a.severity === "critical"), "critical alert emitted");
    // Idempotent: another tick does not sign again.
    const t4 = await worker.processClaim(seed.claimId);
    assert.equal(t4.outcome, "skipped");
    assert.equal(fake.signCount, 2);
  });

  // ---- ITEM A: honest case unchanged — genuinely-dead tx re-signs once ----
  it("A: honest genuinely-dead tx (no land, no outflow) still re-signs once and confirms", async () => {
    const seed = await seedVerifiedClaim({ assetType: "token", amount: 777n * ONE_TOKEN });
    const fake = new FakeChainGateway();
    fake.crashOnBroadcast = true; // tx1 signed+persisted, never broadcast
    const worker = makeWorker(fake);
    await worker.processClaim(seed.claimId);
    assert.equal(fake.landedSignatures().length, 0);
    fake.blockHeight += 1000n;
    fake.crashOnBroadcast = false;
    const t2 = await worker.processClaim(seed.claimId);
    assert.equal(t2.outcome, "confirmed");
    assert.equal(fake.signCount, 2, "re-signed once after provable death, no outflow");
    assert.equal(fake.landedSignatures().length, 1, "exactly one landed");
    assert.equal((await claim(seed.claimId)).status, "confirmed");
  });

  // ---- ITEM V: still-locked vault -> manual delivery queue, correct unlock ----
  it("V: still-locked vault routes to manual delivery with the correct ABSOLUTE unlock ts (never loops)", async () => {
    const unlock = Math.floor(Date.now() / 1000) + 200 * 86_400; // 200 days out
    const seed = await seedVerifiedClaim({ assetType: "vault", amount: 5000n * ONE_TOKEN, vaultEndTs: unlock });
    const fake = new FakeChainGateway();
    const worker = makeWorker(fake);

    const res = await worker.processClaim(seed.claimId);
    assert.equal(res.outcome, "awaiting_manual_vault_delivery");
    assert.equal(fake.signCount, 0, "no auto CPI / no hot dispense for a still-locked vault");
    assert.equal((await claim(seed.claimId)).status, "awaiting_manual_vault_delivery");
    assert.equal(await assetStatus(seed.assetKey), "pending_review");

    // It does NOT loop: re-running is inert (the worker never re-picks the status).
    const again = await worker.processClaim(seed.claimId);
    assert.equal(again.outcome, "skipped");
    assert.equal(fake.signCount, 0);

    // The queue report gives the operator the correct absolute unlock (relock).
    const q = await vaultManualDeliveryQueue(db.pool, { assetKeys: [seed.assetKey] });
    assert.equal(q.items.length, 1);
    const item = q.items[0];
    assert.equal(item.deliverKind, "relock");
    assert.equal(item.unlockTimestamp, BigInt(unlock), "unlock == original vault_end_timestamp (absolute)");
    assert.equal(item.amountMario, 5000n * ONE_TOKEN);
    assert.equal(item.claimant, seed.claimant);
    assert.ok(item.lockDurationSeconds > 0n && item.lockDurationSeconds <= BigInt(200 * 86_400));
  });

  it("V: a queued vault whose unlock has SINCE passed is flagged deliver-UNLOCKED (liquid) at report time", async () => {
    // Seed as still-locked so the worker routes it to manual delivery...
    const unlock = Math.floor(Date.now() / 1000) + 200 * 86_400;
    const seed = await seedVerifiedClaim({ assetType: "vault", amount: 5000n * ONE_TOKEN, vaultEndTs: unlock });
    const worker = makeWorker(new FakeChainGateway());
    assert.equal((await worker.processClaim(seed.claimId)).outcome, "awaiting_manual_vault_delivery");

    // ...then the report is generated LATER, after the unlock has passed.
    const laterNow = BigInt(unlock + 86_400); // one day past unlock
    const q = await vaultManualDeliveryQueue(db.pool, { assetKeys: [seed.assetKey], now: laterNow });
    assert.equal(q.items.length, 1);
    assert.equal(q.items[0].deliverKind, "liquid_unlocked", "already-passed unlock -> deliver liquid, not re-lock into the past");
    assert.equal(q.items[0].lockDurationSeconds, 0n);
    assert.equal(q.liquidUnlockedCount, 1);
  });
});
