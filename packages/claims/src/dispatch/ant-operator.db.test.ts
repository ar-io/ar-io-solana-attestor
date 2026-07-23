//! Operator wallet-signed ANT dispatch — DB-backed exactly-once (mirrors the
//! worker.*.db.test.ts patterns). Drives reserve+build -> operator-sign (LOCAL
//! keypair standing in for ANT_COLD_ADDRESS) -> submitAntBatch against a
//! deterministic FakeChainGateway, and PROVES:
//!   * happy path build->sign->submit->confirm (asset claimed, ONE transfer)
//!   * double-submit -> exactly ONE dispatch
//!   * replayed / foreign signed tx -> rejected (never broadcast)
//!   * wrong-authority signature -> rejected
//!   * blockhash-expiry -> released + re-built once, only ONE lands (no double)
//!   * concurrent with the ARIO token worker -> never collide on an asset
//!   * abandoned batch -> reservation released back to eligible (nothing broadcast)

import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { after, afterEach, before, describe, it } from "node:test";
import {
  createKeyPairSignerFromPrivateKeyBytes,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type Address,
  type TransactionSigner,
} from "@solana/kit";
import * as ed from "@noble/ed25519";

import type { Config } from "../config.js";
import { createDb, type Db } from "../db.js";
import { insertAsset, insertRecipient, randomClaimant } from "../api/proof-testkit.js";
import { FloatManager, type FloatPolicy } from "./float.js";
import { InMemoryKeypairSigner, type SignerRegistry } from "./signer.js";
import { DispatchWorker } from "./worker.js";
import { FakeChainGateway } from "./fake-chain.testkit.js";
import {
  buildAntTransferTx,
  expireStaleReservations,
  recoverReservedAntClaim,
  submitAntBatch,
} from "./ant-operator.js";
import { makeLocalAuthority, operatorSignAll, operatorSignTx, reserveAndBuild, signTxAtSlot, type LocalAuthority } from "./ant-operator.testkit.js";

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
let treasury: TransactionSigner;
let treasuryAddress: Address;
let antCold: LocalAuthority;
const seededAssets: string[] = [];
const seededRecipients: string[] = [];

/** Seed a recipient + asset + a `verified` claim (an M3-won claim). */
async function seedVerifiedClaim(opts: { assetType: "token" | "ant"; amount?: bigint; antMint?: string }): Promise<{ claimId: string; assetKey: string; claimant: string; antMint: string | null }> {
  const recipientId = `ant_${randomBytes(8).toString("hex")}`;
  await insertRecipient(db.pool, { recipientId, protocol: 1, sourceAddress: recipientId, recipientPubkey: new Uint8Array(randomBytes(20)) });
  const assetKey = opts.assetType === "ant" ? randomClaimant() : randomBytes(32).toString("hex");
  const antMint = opts.assetType === "ant" ? (opts.antMint ?? randomClaimant()) : null;
  await insertAsset(db.pool, recipientId, {
    assetKey, assetType: opts.assetType, antMint,
    amount: opts.assetType === "ant" ? null : (opts.amount ?? 1000n * ONE_TOKEN),
    vaultEndTs: null, status: "claiming",
  });
  const claimant = randomClaimant();
  const r = await db.pool.query<{ claim_id: string }>(
    `INSERT INTO claims (asset_key, claimant, canonical_message, recipient_id, protocol, status, verified_at)
     VALUES ($1,$2,$3,$4,1,'verified', now()) RETURNING claim_id`,
    [assetKey, claimant, Buffer.from("canonical-placeholder"), recipientId],
  );
  seededAssets.push(assetKey);
  seededRecipients.push(recipientId);
  return { claimId: r.rows[0].claim_id, assetKey, claimant, antMint };
}

async function claimRow(claimId: string): Promise<{ status: string; sig: string | null; batchId: string | null; resigns: number; reservedTxid: string | null }> {
  const r = await db.pool.query<{ status: string; dispatch_signature: string | null; ant_batch_id: string | null; dispatch_resign_count: number; ant_reserved_txid: string | null }>(
    "SELECT status, dispatch_signature, ant_batch_id, dispatch_resign_count, ant_reserved_txid FROM claims WHERE claim_id = $1", [claimId],
  );
  const x = r.rows[0];
  return { status: x.status, sig: x.dispatch_signature, batchId: x.ant_batch_id, resigns: x.dispatch_resign_count, reservedTxid: x.ant_reserved_txid };
}
async function assetStatus(assetKey: string): Promise<string> {
  const r = await db.pool.query<{ status: string }>("SELECT status FROM assets WHERE asset_key = $1", [assetKey]);
  return r.rows[0].status;
}

const submitOpts = (batchId: string): { batchId: string; signedTxs: string[]; antColdAddress: Address; treasuryAddress: Address } => ({
  batchId, signedTxs: [], antColdAddress: antCold.address, treasuryAddress,
});

describe("ant-operator — operator wallet-signed exactly-once (DB)", { skip: !HAS_DB }, () => {
  before(async () => {
    db = createDb(process.env.DATABASE_URL as string);
    const tseed = new Uint8Array(randomBytes(32));
    treasury = await createKeyPairSignerFromPrivateKeyBytes(tseed);
    treasuryAddress = treasury.address;
    antCold = await makeLocalAuthority(new Uint8Array(randomBytes(32)));
  });
  // Clean up EVERY test's rows immediately (afterEach, not just once) so a lingering
  // `dispatching` ANT claim can't collide with a concurrently-running suite's GLOBAL
  // ANT query (e.g. worker.fixes runAntBatch) in the shared claims_test DB.
  afterEach(async () => {
    if (seededAssets.length) {
      await db.pool.query("DELETE FROM audit_log WHERE entry->>'assetKey' = ANY($1)", [seededAssets]).catch(() => {});
      await db.pool.query("DELETE FROM claims WHERE asset_key = ANY($1)", [seededAssets]);
      await db.pool.query("DELETE FROM assets WHERE asset_key = ANY($1)", [seededAssets]);
      await db.pool.query("DELETE FROM recipients WHERE recipient_id = ANY($1)", [seededRecipients]);
    }
    await db.pool.query("DELETE FROM ant_batches WHERE created_by_pubkey = $1", [antCold.address]).catch(() => {});
    seededAssets.length = 0;
    seededRecipients.length = 0;
  });
  after(async () => { await db.close(); });

  it("happy path: build -> operator-sign -> submit -> confirmed, asset claimed, ONE transfer", async () => {
    const seed = await seedVerifiedClaim({ assetType: "ant" });
    const fake = new FakeChainGateway();

    const batch = await reserveAndBuild(db.pool, treasury, fake, { antColdAddress: antCold.address, max: 50, assetKeyScope: [seed.assetKey] });
    assert.equal(batch.items.length, 1);
    const item = batch.items[0];
    assert.equal(item.claimId, seed.claimId);
    assert.equal(item.antMint, seed.antMint);
    // Reserved but NOT yet dispatched (nothing signed by the server as dispatch).
    let cr = await claimRow(seed.claimId);
    assert.equal(cr.status, "verified");
    assert.equal(cr.batchId, batch.batchId);
    assert.equal(cr.reservedTxid, item.txid);
    assert.equal(fake.broadcasts.length, 0, "nothing broadcast at build time");

    const signed = await operatorSignAll(batch.items.map((i) => i.txBase64), antCold);
    const results = await submitAntBatch(db.pool, fake, { ...submitOpts(batch.batchId), signedTxs: signed });
    assert.equal(results.length, 1);
    assert.equal(results[0].outcome, "confirmed");
    assert.equal(results[0].txid, item.txid);

    cr = await claimRow(seed.claimId);
    assert.equal(cr.status, "confirmed");
    assert.equal(cr.sig, item.txid, "the persisted dispatch signature == the pre-known txid");
    assert.equal(await assetStatus(seed.assetKey), "claimed");
    assert.equal(fake.landedSignatures().length, 1, "exactly one on-chain transfer");
  });

  it("double-submit of the same batch -> exactly ONE dispatch", async () => {
    const seed = await seedVerifiedClaim({ assetType: "ant" });
    const fake = new FakeChainGateway();
    const batch = await reserveAndBuild(db.pool, treasury, fake, { antColdAddress: antCold.address, max: 50, assetKeyScope: [seed.assetKey] });
    const signed = await operatorSignAll(batch.items.map((i) => i.txBase64), antCold);

    const first = await submitAntBatch(db.pool, fake, { ...submitOpts(batch.batchId), signedTxs: signed });
    assert.equal(first[0].outcome, "confirmed");
    // Replay the WHOLE signed batch again.
    const second = await submitAntBatch(db.pool, fake, { ...submitOpts(batch.batchId), signedTxs: signed });
    assert.ok(["already_confirmed", "recovered_confirmed"].includes(second[0].outcome), `got ${second[0].outcome}`);
    assert.equal(fake.landedSignatures().length, 1, "still exactly one transfer after a double-submit");
    assert.equal(await assetStatus(seed.assetKey), "claimed");
  });

  it("replayed / foreign signed tx (no live reservation) -> rejected, never broadcast", async () => {
    const seed = await seedVerifiedClaim({ assetType: "ant" });
    const fake = new FakeChainGateway();
    const batch = await reserveAndBuild(db.pool, treasury, fake, { antColdAddress: antCold.address, max: 50, assetKeyScope: [seed.assetKey] });
    const signed = await operatorSignAll(batch.items.map((i) => i.txBase64), antCold);

    // Submit the (valid) signed tx to a DIFFERENT batch id — no reservation matches.
    const bogusBatch = "00000000-0000-0000-0000-000000000000";
    const res = await submitAntBatch(db.pool, fake, { ...submitOpts(bogusBatch), signedTxs: signed });
    assert.equal(res[0].outcome, "rejected_unknown_tx");
    assert.equal(fake.broadcasts.length, 0, "a foreign/replayed tx is NEVER broadcast");
    assert.equal((await claimRow(seed.claimId)).status, "verified", "claim untouched");
  });

  it("wrong-authority signature -> rejected (present at the ANT_COLD slot but invalid)", async () => {
    const seed = await seedVerifiedClaim({ assetType: "ant" });
    const fake = new FakeChainGateway();
    const attacker = await makeLocalAuthority(new Uint8Array(randomBytes(32)));
    const batch = await reserveAndBuild(db.pool, treasury, fake, { antColdAddress: antCold.address, max: 50, assetKeyScope: [seed.assetKey] });

    // Forge a signature at the REAL ANT_COLD slot but made by the attacker's key.
    const forged = await signTxAtSlot(batch.items[0].txBase64, antCold.address, attacker.seed);
    const res = await submitAntBatch(db.pool, fake, { ...submitOpts(batch.batchId), signedTxs: [forged] });
    assert.equal(res[0].outcome, "rejected_bad_authority_sig");
    assert.equal(fake.broadcasts.length, 0);
    assert.equal((await claimRow(seed.claimId)).status, "verified");

    // An empty authority slot (never signed) is also rejected.
    const res2 = await submitAntBatch(db.pool, fake, { ...submitOpts(batch.batchId), signedTxs: [batch.items[0].txBase64] });
    assert.equal(res2[0].outcome, "rejected_no_authority_sig");
    assert.equal(fake.broadcasts.length, 0);
  });

  it("server-authoritative message binding: a redirect / memo-strip with the copied txid is REJECTED pre-broadcast", async () => {
    // The server must NEVER broadcast client-supplied message bytes. It reconstructs
    // the wire from its OWN stored reserved message + treasury sig, and verifies the
    // operator's authority signature over THAT stored message. A tamper (redirect
    // recipient / strip memo) that copies the reserved txid into the fee-payer slot
    // therefore fails the authority-over-stored-message check -> rejected, no send.
    const decodeWire = (b64: string) => getTransactionDecoder().decode(new Uint8Array(getBase64Encoder().encode(b64)));

    for (const variant of ["redirect", "memo-strip"] as const) {
      const seed = await seedVerifiedClaim({ assetType: "ant" });
      const fake = new FakeChainGateway();
      const batch = await reserveAndBuild(db.pool, treasury, fake, { antColdAddress: antCold.address, max: 50, assetKeyScope: [seed.assetKey] });
      const item = batch.items[0];
      const treasurySig = (decodeWire(item.txBase64).signatures as Record<string, Uint8Array | null>)[treasuryAddress];

      const tampered = await buildAntTransferTx(treasury, {
        claimId: seed.claimId,
        antMint: seed.antMint as unknown as Address,
        claimant: (variant === "redirect" ? (randomClaimant() as Address) : (seed.claimant as unknown as Address)),
        antColdAddress: antCold.address,
        blockhash: "BLKLATEST1",
        lastValidBlockHeight: BigInt(item.lastValidBlockHeight),
        includeMemo: variant === "redirect", // memo-strip => omit memo
      });
      const tdec = decodeWire(tampered.txBase64);
      const authSig = await ed.signAsync(tdec.messageBytes as unknown as Uint8Array, antCold.seed);
      // Copy the reserved txid into the fee-payer slot so the reservation lookup hits.
      const forged = { ...tdec, signatures: { ...tdec.signatures, [treasuryAddress]: treasurySig!, [antCold.address]: authSig } } as typeof tdec;
      assert.equal(getSignatureFromTransaction(forged), item.txid, `${variant}: forged fee-payer sig == reserved txid`);

      const res = await submitAntBatch(db.pool, fake, { ...submitOpts(batch.batchId), signedTxs: [getBase64EncodedWireTransaction(forged)] });
      assert.equal(res[0].outcome, "rejected_bad_authority_sig", `${variant}: rejected (authority sig not over the reserved message)`);
      assert.equal(fake.broadcasts.length, 0, `${variant}: nothing broadcast`);
      assert.equal((await claimRow(seed.claimId)).status, "verified", `${variant}: claim untouched`);
    }
  });

  it("blockhash-expiry: submitted tx never lands -> released + re-built once, only ONE lands", async () => {
    const seed = await seedVerifiedClaim({ assetType: "ant" });
    const fake = new FakeChainGateway();
    fake.dropBroadcast = true; // the submitted tx is "broadcast" but never lands

    const batch1 = await reserveAndBuild(db.pool, treasury, fake, { antColdAddress: antCold.address, max: 50, assetKeyScope: [seed.assetKey] });
    const signed1 = await operatorSignAll(batch1.items.map((i) => i.txBase64), antCold);
    const submit1 = await submitAntBatch(db.pool, fake, { ...submitOpts(batch1.batchId), signedTxs: signed1 });
    assert.equal(submit1[0].outcome, "awaiting_confirmation");
    assert.equal((await claimRow(seed.claimId)).status, "dispatching");
    assert.equal(fake.landedSignatures().length, 0, "nothing landed (dropped)");

    // Its blockhash expires; the recovery sweep sees it provably-dead + no outflow.
    fake.blockHeight += 1000n;
    const rec = await recoverReservedAntClaim(db.pool, fake, treasuryAddress, seed.claimId);
    assert.equal(rec.outcome, "released_for_rebuild");
    const afterRelease = await claimRow(seed.claimId);
    assert.equal(afterRelease.status, "verified");
    assert.equal(afterRelease.batchId, null, "reservation cleared");
    assert.equal(afterRelease.resigns, 1, "re-build counter bumped (hard cap = 1)");

    // Re-build (fresh blockhash) + submit; this time it lands.
    fake.dropBroadcast = false;
    const batch2 = await reserveAndBuild(db.pool, treasury, fake, { antColdAddress: antCold.address, max: 50, assetKeyScope: [seed.assetKey] });
    assert.equal(batch2.items.length, 1);
    assert.notEqual(batch2.items[0].txid, batch1.items[0].txid, "a fresh tx (new blockhash) => new txid");
    const signed2 = await operatorSignAll(batch2.items.map((i) => i.txBase64), antCold);
    const submit2 = await submitAntBatch(db.pool, fake, { ...submitOpts(batch2.batchId), signedTxs: signed2 });
    assert.equal(submit2[0].outcome, "confirmed");
    assert.equal(fake.landedSignatures().length, 1, "EXACTLY ONE tx ever landed across the re-build");
    assert.equal(await assetStatus(seed.assetKey), "claimed");
  });

  it("expiry BUT the tx actually landed (lagging RPC) -> outflow scan confirms, NO re-build, no double", async () => {
    const seed = await seedVerifiedClaim({ assetType: "ant" });
    const fake = new FakeChainGateway();
    const batch = await reserveAndBuild(db.pool, treasury, fake, { antColdAddress: antCold.address, max: 50, assetKeyScope: [seed.assetKey] });
    const signed = await operatorSignAll(batch.items.map((i) => i.txBase64), antCold);
    // It lands, but the confirm read lags and misreports `expired` once.
    fake.expiredDespiteLandedCount = 1;
    const res = await submitAntBatch(db.pool, fake, { ...submitOpts(batch.batchId), signedTxs: signed });
    // The submit-time confirm classified expired -> recovery/outflow inside submit is
    // NOT run (submit dispatches fresh then confirms once); it leaves it awaiting.
    // Drive the recovery sweep, which runs the outflow scan.
    if (res[0].outcome !== "confirmed") {
      const rec = await recoverReservedAntClaim(db.pool, fake, treasuryAddress, seed.claimId);
      assert.equal(rec.outcome, "recovered_confirmed");
    }
    assert.equal(fake.landedSignatures().length, 1, "the already-landed tx is confirmed, never re-sent");
    assert.equal(await assetStatus(seed.assetKey), "claimed");
    assert.equal((await claimRow(seed.claimId)).status, "confirmed");
  });

  it("concurrent ARIO token worker + operator ANT flow -> never collide on an asset", async () => {
    const tokenClaim = await seedVerifiedClaim({ assetType: "token", amount: 321n * ONE_TOKEN });
    const antClaim = await seedVerifiedClaim({ assetType: "ant" });
    const fake = new FakeChainGateway(); // ONE shared chain view

    // Worker with NO ant signer (== operator-wallet mode: no server ANT key).
    const signers: SignerRegistry = { token: await InMemoryKeypairSigner.fromSeed("token", new Uint8Array(randomBytes(32))) };
    const worker = new DispatchWorker({
      pool: db.pool, gateway: fake, signers, float: new FloatManager(policy, { reservedAssetScope: seededAssets }),
      config: testConfig(), mint: MINT,
      vaultDurations: { minVaultDuration: BigInt(14 * 86_400), maxVaultDuration: BigInt(365 * 86_400) },
      antRequiresApproval: false,
    });

    // Reserve the ANT first, then race the token worker with the ANT submit.
    const batch = await reserveAndBuild(db.pool, treasury, fake, { antColdAddress: antCold.address, max: 50, assetKeyScope: [antClaim.assetKey] });
    const signed = await operatorSignAll(batch.items.map((i) => i.txBase64), antCold);

    // The worker MUST NOT dispatch the reserved ANT — with the L1/B1 guard it
    // refuses any operator-reserved claim (ant_batch_id set) outright as `skipped`.
    const workerOnAnt = await worker.processClaim(antClaim.claimId);
    assert.equal(workerOnAnt.outcome, "skipped", "worker refuses an operator-reserved ANT claim");

    const [tokenRes, antRes] = await Promise.all([
      worker.processClaim(tokenClaim.claimId),
      submitAntBatch(db.pool, fake, { ...submitOpts(batch.batchId), signedTxs: signed }),
    ]);
    assert.equal(tokenRes.outcome, "confirmed");
    assert.equal(antRes[0].outcome, "confirmed");
    assert.equal(await assetStatus(tokenClaim.assetKey), "claimed");
    assert.equal(await assetStatus(antClaim.assetKey), "claimed");
    // Each asset moved via exactly one transfer; the two paths never touched the
    // other's asset.
    assert.equal(fake.landedSignatures().length, 2, "one token transfer + one ANT transfer, no extras");
  });

  it("L1: a cli-cold worker WITH a server ANT key refuses an operator-RESERVED verified ANT claim (fresh-dispatch guard)", async () => {
    const seed = await seedVerifiedClaim({ assetType: "ant" });
    const opFake = new FakeChainGateway();
    // Reserve into an operator batch: status stays `verified`, ant_batch_id set, and
    // NO dispatch_signature yet (so #recover would not fire — this exercises the
    // FRESH path guard specifically).
    const batch = await reserveAndBuild(db.pool, treasury, opFake, { antColdAddress: antCold.address, max: 50, assetKeyScope: [seed.assetKey] });
    assert.equal(batch.items.length, 1);
    const before = await claimRow(seed.claimId);
    assert.equal(before.status, "verified");
    assert.ok(before.batchId, "reserved");
    assert.equal(before.sig, null, "not yet dispatched (fresh path)");

    // A cli-cold ARIO worker that DOES hold a server ANT signer (the break-glass
    // fallback posture). Without the fresh-path guard it would dispatch this verified
    // ANT with its own key and strand the operator's reservation.
    const wFake = new FakeChainGateway();
    const worker = new DispatchWorker({
      pool: db.pool, gateway: wFake,
      signers: {
        token: await InMemoryKeypairSigner.fromSeed("token", new Uint8Array(randomBytes(32))),
        ant: await InMemoryKeypairSigner.fromSeed("ant", new Uint8Array(randomBytes(32))),
      },
      float: new FloatManager(policy, { reservedAssetScope: seededAssets }),
      config: testConfig(), mint: MINT,
      vaultDurations: { minVaultDuration: BigInt(14 * 86_400), maxVaultDuration: BigInt(365 * 86_400) },
      antRequiresApproval: false,
      antDispatchMode: "cli-cold",
    });

    const res = await worker.processClaim(seed.claimId);
    assert.equal(res.outcome, "skipped", "fresh dispatch refused for an operator-reserved claim");
    assert.equal(wFake.signCount, 0, "nothing signed");
    assert.equal(wFake.broadcasts.length, 0, "nothing broadcast");
    const after = await claimRow(seed.claimId);
    assert.equal(after.status, "verified", "claim still verified");
    assert.equal(after.batchId, before.batchId, "reservation intact");
    assert.equal(after.sig, null, "no dispatch signature persisted");
  });

  it("B1: the ARIO worker (operator-wallet mode) NEVER touches an operator-owned dispatching ANT claim", async () => {
    const seed = await seedVerifiedClaim({ assetType: "ant" });
    const fake = new FakeChainGateway();
    fake.dropBroadcast = true; // submit persists `dispatching` but nothing lands
    const batch = await reserveAndBuild(db.pool, treasury, fake, { antColdAddress: antCold.address, max: 50, assetKeyScope: [seed.assetKey] });
    const signed = await operatorSignAll(batch.items.map((i) => i.txBase64), antCold);
    await submitAntBatch(db.pool, fake, { ...submitOpts(batch.batchId), signedTxs: signed });
    const before = await claimRow(seed.claimId);
    assert.equal(before.status, "dispatching");
    assert.ok(before.sig && before.batchId, "reserved + persisted");

    // A separate ARIO worker in operator-wallet mode with its OWN gateway. If it
    // (wrongly) ran #recover on the ANT claim it would clear the sig, bump
    // resign_count, strand the batch, and scan the wrong fee payer.
    const wFake = new FakeChainGateway();
    wFake.blockHeight += 5000n; // would classify the ANT tx `expired` if recovered
    const worker = new DispatchWorker({
      pool: db.pool, gateway: wFake,
      signers: { token: await InMemoryKeypairSigner.fromSeed("token", new Uint8Array(randomBytes(32))) },
      float: new FloatManager(policy, { reservedAssetScope: seededAssets }),
      config: testConfig(), mint: MINT,
      vaultDurations: { minVaultDuration: BigInt(14 * 86_400), maxVaultDuration: BigInt(365 * 86_400) },
      antRequiresApproval: false,
      antDispatchMode: "operator-wallet",
    });

    // (a) The operator-wallet pickup queue EXCLUDES ANT assets. Asserted directly
    // against the eligibility predicate (a hermetic query — calling runOnce() here
    // would globally dispatch OTHER concurrently-running suites' claims via this
    // test's gateway). A control non-ANT claim proves the filter still selects.
    const control = await seedVerifiedClaim({ assetType: "token", amount: 5n * ONE_TOKEN });
    const eligible = await db.pool.query<{ claim_id: string }>(
      `SELECT c.claim_id FROM claims c JOIN assets a ON a.asset_key = c.asset_key
        WHERE a.asset_type <> 'ant'
          AND (c.status IN ('verified','dispatching') OR (c.status='pending_review' AND c.approved_at IS NOT NULL))
          AND c.asset_key = ANY($1)`,
      [[seed.assetKey, control.assetKey]],
    );
    const ids = eligible.rows.map((r) => r.claim_id);
    assert.ok(!ids.includes(seed.claimId), "ANT claim excluded from the operator-wallet pickup queue");
    assert.ok(ids.includes(control.claimId), "a non-ANT claim is still selected");
    // (b) even a DIRECT processClaim is refused defensively (ant_batch_id set).
    const direct = await worker.processClaim(seed.claimId);
    assert.equal(direct.outcome, "skipped");

    const after = await claimRow(seed.claimId);
    assert.equal(after.status, "dispatching", "status preserved");
    assert.equal(after.sig, before.sig, "signature preserved (worker did not clear it)");
    assert.equal(after.resigns, before.resigns, "rebuild budget preserved");
    assert.equal(after.batchId, before.batchId, "batch reservation preserved");
    assert.equal(wFake.broadcasts.length, 0, "worker broadcast nothing for the ANT claim");

    // The operator's own recovery still owns it (releases for rebuild on expiry).
    fake.blockHeight += 5000n;
    const rec = await recoverReservedAntClaim(db.pool, fake, treasuryAddress, seed.claimId);
    assert.equal(rec.outcome, "released_for_rebuild");
  });

  it("abandoned batch: reservation released back to eligible after the TTL, nothing broadcast", async () => {
    const seed = await seedVerifiedClaim({ assetType: "ant" });
    const fake = new FakeChainGateway();
    const batch = await reserveAndBuild(db.pool, treasury, fake, { antColdAddress: antCold.address, max: 50, assetKeyScope: [seed.assetKey] });
    assert.equal((await claimRow(seed.claimId)).batchId, batch.batchId);

    // Operator never submits. A TTL sweep (ttl=0 => expire immediately) frees it.
    const freed = await expireStaleReservations(db.pool, 0);
    assert.ok(freed >= 1);
    const cr = await claimRow(seed.claimId);
    assert.equal(cr.status, "verified", "claim is eligible again");
    assert.equal(cr.batchId, null, "reservation cleared");
    assert.equal(cr.reservedTxid, null);
    assert.equal(fake.broadcasts.length, 0, "nothing was ever broadcast");

    // And it can be re-built into a NEW batch.
    const batch2 = await reserveAndBuild(db.pool, treasury, fake, { antColdAddress: antCold.address, max: 50, assetKeyScope: [seed.assetKey] });
    assert.equal(batch2.items.length, 1);
    assert.equal(batch2.items[0].claimId, seed.claimId);
    // Clean up: sign+submit so nothing dangles.
    const signed = await operatorSignTx(batch2.items[0].txBase64, antCold);
    const res = await submitAntBatch(db.pool, fake, { ...submitOpts(batch2.batchId), signedTxs: [signed] });
    assert.equal(res[0].outcome, "confirmed");
  });
});
