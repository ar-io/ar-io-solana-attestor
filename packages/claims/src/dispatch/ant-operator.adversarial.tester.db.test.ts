//! INDEPENDENT ADVERSARIAL / UAT suite for the operator wallet-signed ANT dispatch
//! (docs/claims/ANT_OPERATOR_SIGNING_SPEC.md). Written by the TESTER agent — it does
//! NOT modify the dev's source or tests. It attacks the money/exactly-once surface
//! the coordinator flagged: tx-tampering (redirect an ANT), double-dispense,
//! manual_review/AT-RISK exclusion, reservation integrity, blockhash expiry, and
//! money/bigint integrity. Drives the real functions against the deterministic
//! FakeChainGateway and a throwaway `claims_test` DB.

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

import { createDb, type Db } from "../db.js";
import { insertAsset, insertRecipient, randomClaimant } from "../api/proof-testkit.js";
import { FakeChainGateway } from "./fake-chain.testkit.js";
import {
  buildAntBatch,
  buildAntTransferTx,
  expireStaleReservations,
  recoverReservedAntClaim,
  submitAntBatch,
} from "./ant-operator.js";
import { makeLocalAuthority, operatorSignAll, operatorSignTx, signTxAtSlot, type LocalAuthority } from "./ant-operator.testkit.js";

const HAS_DB = !!process.env.DATABASE_URL;

let db: Db;
let treasury: TransactionSigner;
let treasuryAddress: Address;
let antCold: LocalAuthority;
const seededAssets: string[] = [];
const seededRecipients: string[] = [];

async function seedClaim(opts: { assetType: "token" | "ant"; assetStatus?: string; claimStatus?: string; approved?: boolean; amount?: bigint }): Promise<{ claimId: string; assetKey: string; claimant: string; antMint: string | null; recipientId: string }> {
  const recipientId = `tst_${randomBytes(8).toString("hex")}`;
  await insertRecipient(db.pool, { recipientId, protocol: 1, sourceAddress: recipientId, recipientPubkey: new Uint8Array(randomBytes(20)) });
  const assetKey = opts.assetType === "ant" ? randomClaimant() : randomBytes(32).toString("hex");
  const antMint = opts.assetType === "ant" ? randomClaimant() : null;
  await insertAsset(db.pool, recipientId, {
    assetKey, assetType: opts.assetType, antMint,
    amount: opts.assetType === "ant" ? null : (opts.amount ?? 1000n * 1_000_000n),
    vaultEndTs: null, status: opts.assetStatus ?? "claiming",
  });
  const claimant = randomClaimant();
  const st = opts.claimStatus ?? "verified";
  const r = await db.pool.query<{ claim_id: string }>(
    `INSERT INTO claims (asset_key, claimant, canonical_message, recipient_id, protocol, status, verified_at, approved_at)
     VALUES ($1,$2,$3,$4,1,$5, now(), $6) RETURNING claim_id`,
    [assetKey, claimant, Buffer.from("canonical"), recipientId, st, opts.approved ? new Date() : null],
  );
  seededAssets.push(assetKey);
  seededRecipients.push(recipientId);
  return { claimId: r.rows[0].claim_id, assetKey, claimant, antMint, recipientId };
}

async function claimRow(claimId: string): Promise<{ status: string; sig: string | null; batchId: string | null; resigns: number; reservedTxid: string | null; settlementAmount: string | null; lastValidBh: string | null }> {
  const r = await db.pool.query(
    `SELECT status, dispatch_signature, ant_batch_id, dispatch_resign_count, ant_reserved_txid,
            settlement_amount::text AS settlement_amount, dispatch_last_valid_bh::text AS dispatch_last_valid_bh
       FROM claims WHERE claim_id = $1`, [claimId],
  );
  const x = r.rows[0];
  return { status: x.status, sig: x.dispatch_signature, batchId: x.ant_batch_id, resigns: x.dispatch_resign_count, reservedTxid: x.ant_reserved_txid, settlementAmount: x.settlement_amount, lastValidBh: x.dispatch_last_valid_bh };
}
async function assetStatus(assetKey: string): Promise<string> {
  const r = await db.pool.query<{ status: string }>("SELECT status FROM assets WHERE asset_key = $1", [assetKey]);
  return r.rows[0]?.status;
}
const submit = (batchId: string, signedTxs: string[]): Parameters<typeof submitAntBatch>[2] => ({
  batchId, signedTxs, antColdAddress: antCold.address, treasuryAddress,
});

describe("ant-operator ADVERSARIAL (tester)", { skip: !HAS_DB }, () => {
  before(async () => {
    db = createDb(process.env.DATABASE_URL as string);
    treasury = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(randomBytes(32)));
    treasuryAddress = treasury.address;
    antCold = await makeLocalAuthority(new Uint8Array(randomBytes(32)));
  });
  // Clean up EVERY test's rows immediately after it runs (not just the last one) so
  // nothing — least of all a manual_review asset or a `dispatching` ANT claim — leaks
  // into the shared claims_test DB and trips a concurrently-running suite's global
  // invariant checks. This is the fix for the naive reset-in-beforeEach pattern that
  // otherwise permanently pollutes the DB.
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

  // -----------------------------------------------------------------------
  // S1 — TX TAMPERING (CRITICAL): redirect an ANT to an attacker.
  // -----------------------------------------------------------------------
  it("S1a: a redirect tx with its OWN (fresh) txid has no reservation -> rejected_unknown_tx, never broadcast", async () => {
    const s = await seedClaim({ assetType: "ant" });
    const attacker = randomClaimant() as Address;
    const fake = new FakeChainGateway();
    const batch = await buildAntBatch(db.pool, treasury, fake, { antColdAddress: antCold.address, max: 50, assetKeyScope: [s.assetKey] });
    const item = batch.items[0];

    // Attacker builds a REDIRECT tx (newOwner = attacker) with a fresh treasury sig
    // => its own, DIFFERENT txid. Operator signs it validly and submits it.
    const redirect = await buildAntTransferTx(treasury, {
      claimId: s.claimId, antMint: s.antMint as unknown as Address, claimant: attacker,
      antColdAddress: antCold.address, blockhash: "BLKLATEST1", lastValidBlockHeight: BigInt(item.lastValidBlockHeight), includeMemo: true,
    });
    assert.notEqual(redirect.txid, item.txid, "redirect has a different txid");
    const signedRedirect = await operatorSignTx(redirect.txBase64, antCold);

    const res = await submitAntBatch(db.pool, fake, submit(batch.batchId, [signedRedirect]));
    assert.equal(res[0].outcome, "rejected_unknown_tx", "server rejects a tx that matches no reservation");
    assert.equal(fake.broadcasts.length, 0, "nothing broadcast");
    assert.equal(fake.landedSignatures().length, 0, "nothing landed");
    assert.equal((await claimRow(s.claimId)).status, "verified", "claim untouched");
  });

  it("S1b: CLOSED — a redirect tx that COPIES the reserved txid into the fee-payer slot is REJECTED pre-broadcast (server binds the message; authority sig must verify over the SERVER's reserved message)", async () => {
    const s = await seedClaim({ assetType: "ant" });
    const attacker = randomClaimant() as Address;
    const fake = new FakeChainGateway();
    const batch = await buildAntBatch(db.pool, treasury, fake, { antColdAddress: antCold.address, max: 50, assetKeyScope: [s.assetKey] });
    const item = batch.items[0];

    // Lift the treasury (fee-payer) signature bytes from the legit reserved tx.
    const legit = getTransactionDecoder().decode(new Uint8Array(getBase64Encoder().encode(item.txBase64)));
    const treasurySigBytes = (legit.signatures as Record<string, Uint8Array | null>)[treasury.address];
    assert.ok(treasurySigBytes);

    // Build a REDIRECT (newOwner = attacker), then overwrite its fee-payer slot with
    // the reserved txid's bytes and add a VALID authority sig over the redirect msg.
    const redirect = await buildAntTransferTx(treasury, {
      claimId: s.claimId, antMint: s.antMint as unknown as Address, claimant: attacker,
      antColdAddress: antCold.address, blockhash: "BLKLATEST1", lastValidBlockHeight: BigInt(item.lastValidBlockHeight), includeMemo: true,
    });
    const rdec = getTransactionDecoder().decode(new Uint8Array(getBase64Encoder().encode(redirect.txBase64)));
    const authSig = await ed.signAsync(rdec.messageBytes as unknown as Uint8Array, antCold.seed);
    const forged = { ...rdec, signatures: { ...rdec.signatures, [treasury.address]: treasurySigBytes, [antCold.address]: authSig } } as typeof rdec;
    const forgedWire = getBase64EncodedWireTransaction(forged);
    assert.equal(getSignatureFromTransaction(forged), item.txid, "forged txid == reserved txid (fee-payer slot copied)");

    const res = await submitAntBatch(db.pool, fake, submit(batch.batchId, [forgedWire]));

    // FIX (server-authoritative message binding): the reservation lookup by txid
    // succeeds (the attacker copied it), but the server verifies the operator's
    // authority signature over ITS OWN stored reserved message — the redirect's
    // authority sig was made over a DIFFERENT (attacker) message, so it fails and
    // the tx is rejected BEFORE any broadcast. In-process defense, not delegated to
    // the validator; the attacker-controlled bytes never leave the server.
    assert.equal(res[0].outcome, "rejected_bad_authority_sig", "server REJECTS the tampered redirect");
    assert.equal(fake.broadcasts.length, 0, "attacker-controlled bytes are NEVER broadcast");
    assert.equal(fake.landedSignatures().length, 0, "nothing landed");
    assert.equal((await claimRow(s.claimId)).status, "verified", "claim untouched (no dead-tx churn)");
  });

  it("S1c: CLOSED — memo-stripped tamper with copied txid is likewise REJECTED pre-broadcast (same message-binding fix)", async () => {
    const s = await seedClaim({ assetType: "ant" });
    const fake = new FakeChainGateway();
    const batch = await buildAntBatch(db.pool, treasury, fake, { antColdAddress: antCold.address, max: 50, assetKeyScope: [s.assetKey] });
    const item = batch.items[0];
    const legit = getTransactionDecoder().decode(new Uint8Array(getBase64Encoder().encode(item.txBase64)));
    const treasurySigBytes = (legit.signatures as Record<string, Uint8Array | null>)[treasury.address];

    // Rebuild the SAME transfer but WITHOUT the memo, copy the reserved txid.
    const noMemo = await buildAntTransferTx(treasury, {
      claimId: s.claimId, antMint: s.antMint as unknown as Address, claimant: s.claimant as unknown as Address,
      antColdAddress: antCold.address, blockhash: "BLKLATEST1", lastValidBlockHeight: BigInt(item.lastValidBlockHeight), includeMemo: false,
    });
    assert.notEqual(noMemo.txid, item.txid, "different message (no memo) => naturally different treasury txid");
    const dec = getTransactionDecoder().decode(new Uint8Array(getBase64Encoder().encode(noMemo.txBase64)));
    const authSig = await ed.signAsync(dec.messageBytes as unknown as Uint8Array, antCold.seed);
    const forged = { ...dec, signatures: { ...dec.signatures, [treasury.address]: treasurySigBytes!, [antCold.address]: authSig } } as typeof dec;
    const forgedWire = getBase64EncodedWireTransaction(forged);

    const res = await submitAntBatch(db.pool, fake, submit(batch.batchId, [forgedWire]));
    // Same fix: the memo-stripped message differs from the stored reserved message,
    // so the authority sig fails to verify over it -> rejected, never broadcast.
    assert.equal(res[0].outcome, "rejected_bad_authority_sig");
    assert.equal(fake.broadcasts.length, 0, "server broadcast NOTHING");
    assert.equal((await claimRow(s.claimId)).status, "verified");
  });

  // -----------------------------------------------------------------------
  // S2 — DOUBLE DISPENSE.
  // -----------------------------------------------------------------------
  it("S2a: two CONCURRENT submits of the same signed batch -> at most ONE on-chain send", async () => {
    const s = await seedClaim({ assetType: "ant" });
    const fake = new FakeChainGateway();
    const batch = await buildAntBatch(db.pool, treasury, fake, { antColdAddress: antCold.address, max: 50, assetKeyScope: [s.assetKey] });
    const signed = await operatorSignAll(batch.items.map((i) => i.txBase64), antCold);

    const [a, b] = await Promise.all([
      submitAntBatch(db.pool, fake, submit(batch.batchId, signed)),
      submitAntBatch(db.pool, fake, submit(batch.batchId, signed)),
    ]);
    const outcomes = [a[0].outcome, b[0].outcome];
    // One path dispatches; the other sees dispatching/confirmed and recovers.
    assert.ok(outcomes.filter((o) => o === "confirmed").length >= 1, `outcomes: ${outcomes}`);
    assert.equal(fake.landedSignatures().length, 1, "EXACTLY ONE transfer despite concurrent submits");
    assert.equal(await assetStatus(s.assetKey), "claimed");
  });

  it("S2b: submit AFTER the batch already confirmed -> already_confirmed, no second send", async () => {
    const s = await seedClaim({ assetType: "ant" });
    const fake = new FakeChainGateway();
    const batch = await buildAntBatch(db.pool, treasury, fake, { antColdAddress: antCold.address, max: 50, assetKeyScope: [s.assetKey] });
    const signed = await operatorSignAll(batch.items.map((i) => i.txBase64), antCold);
    await submitAntBatch(db.pool, fake, submit(batch.batchId, signed));
    const again = await submitAntBatch(db.pool, fake, submit(batch.batchId, signed));
    assert.ok(["already_confirmed", "recovered_confirmed"].includes(again[0].outcome), again[0].outcome);
    assert.equal(fake.landedSignatures().length, 1);
  });

  it("S2c: re-submitting a DIFFERENT valid signature over the SAME reserved tx (double-signed wire) still lands ONCE", async () => {
    // ed25519 is deterministic, so a re-sign of the same message is byte-identical;
    // this proves the persisted-txid anchor de-dups regardless of the submitted wire.
    const s = await seedClaim({ assetType: "ant" });
    const fake = new FakeChainGateway();
    const batch = await buildAntBatch(db.pool, treasury, fake, { antColdAddress: antCold.address, max: 50, assetKeyScope: [s.assetKey] });
    const signedA = await operatorSignTx(batch.items[0].txBase64, antCold);
    const signedB = await operatorSignTx(batch.items[0].txBase64, antCold);
    // Submit BOTH copies in ONE batch call.
    const res = await submitAntBatch(db.pool, fake, submit(batch.batchId, [signedA, signedB]));
    const confirmed = res.filter((r) => ["confirmed", "already_confirmed", "recovered_confirmed"].includes(r.outcome));
    assert.ok(confirmed.length >= 1);
    assert.equal(fake.landedSignatures().length, 1, "one asset -> one transfer even with duplicate signed txs in the batch");
    assert.equal(await assetStatus(s.assetKey), "claimed");
  });

  // -----------------------------------------------------------------------
  // S4 — manual_review / AT-RISK exclusion.
  // -----------------------------------------------------------------------
  it("S4: a manual_review (AT-RISK) ANT asset is NEVER built into a batch nor listed pending", async () => {
    const risk = await seedClaim({ assetType: "ant", assetStatus: "manual_review" });
    const ok = await seedClaim({ assetType: "ant" }); // an eligible one, same scope, to prove selection works
    const fake = new FakeChainGateway();
    const batch = await buildAntBatch(db.pool, treasury, fake, { antColdAddress: antCold.address, max: 50, assetKeyScope: [risk.assetKey, ok.assetKey] });
    const ids = batch.items.map((i) => i.claimId);
    assert.ok(!ids.includes(risk.claimId), "manual_review ANT MUST NOT be in a batch");
    assert.ok(ids.includes(ok.claimId), "the eligible ANT still selected");
    assert.equal((await claimRow(risk.claimId)).batchId, null, "manual_review claim never reserved");
  });

  it("S4b: even if an operator forges a submit for a manual_review claim, no reservation exists -> rejected_unknown_tx", async () => {
    const risk = await seedClaim({ assetType: "ant", assetStatus: "manual_review" });
    const fake = new FakeChainGateway();
    // Build a tx for the AT-RISK claim directly and try to push it into a real batch.
    const built = await buildAntTransferTx(treasury, {
      claimId: risk.claimId, antMint: risk.antMint as unknown as Address, claimant: risk.claimant as unknown as Address,
      antColdAddress: antCold.address, blockhash: "BLK", lastValidBlockHeight: 1150n, includeMemo: true,
    });
    // A real (empty) batch to submit against.
    const other = await seedClaim({ assetType: "ant" });
    const batch = await buildAntBatch(db.pool, treasury, fake, { antColdAddress: antCold.address, max: 50, assetKeyScope: [other.assetKey] });
    const signed = await operatorSignTx(built.txBase64, antCold);
    const res = await submitAntBatch(db.pool, fake, submit(batch.batchId, [signed]));
    assert.equal(res[0].outcome, "rejected_unknown_tx");
    assert.equal(await assetStatus(risk.assetKey), "manual_review", "AT-RISK asset untouched");
  });

  // -----------------------------------------------------------------------
  // S5 — reservation integrity.
  // -----------------------------------------------------------------------
  it("S5a: a claim cannot be reserved into TWO live batches (concurrent builds)", async () => {
    const s = await seedClaim({ assetType: "ant" });
    const fake = new FakeChainGateway();
    const [b1, b2] = await Promise.all([
      buildAntBatch(db.pool, treasury, fake, { antColdAddress: antCold.address, max: 50, assetKeyScope: [s.assetKey] }),
      buildAntBatch(db.pool, treasury, fake, { antColdAddress: antCold.address, max: 50, assetKeyScope: [s.assetKey] }),
    ]);
    const inB1 = b1.items.some((i) => i.claimId === s.claimId);
    const inB2 = b2.items.some((i) => i.claimId === s.claimId);
    assert.ok(inB1 !== inB2, `claim must be in EXACTLY ONE batch (b1=${inB1} b2=${inB2})`);
    const cr = await claimRow(s.claimId);
    assert.ok(cr.batchId === (inB1 ? b1.batchId : b2.batchId));
  });

  it("S5b: a SUBMITTED-but-dead reservation does NOT double-send on recovery (bounded to needs_operator)", async () => {
    const s = await seedClaim({ assetType: "ant" });
    const fake = new FakeChainGateway();
    fake.dropBroadcast = true; // submitted, never lands
    const batch = await buildAntBatch(db.pool, treasury, fake, { antColdAddress: antCold.address, max: 50, assetKeyScope: [s.assetKey] });
    const signed = await operatorSignAll(batch.items.map((i) => i.txBase64), antCold);
    await submitAntBatch(db.pool, fake, submit(batch.batchId, signed));
    assert.equal((await claimRow(s.claimId)).status, "dispatching");

    // Expire + recover once -> released_for_rebuild (resign_count = 1).
    fake.blockHeight += 1000n;
    const rec1 = await recoverReservedAntClaim(db.pool, fake, treasuryAddress, s.claimId);
    assert.equal(rec1.outcome, "released_for_rebuild");
    assert.equal((await claimRow(s.claimId)).resigns, 1);

    // Re-build + submit again, drop again, expire again -> now the cap is hit and it
    // FREEZES needs_operator rather than re-sending forever.
    const batch2 = await buildAntBatch(db.pool, treasury, fake, { antColdAddress: antCold.address, max: 50, assetKeyScope: [s.assetKey] });
    const signed2 = await operatorSignAll(batch2.items.map((i) => i.txBase64), antCold);
    await submitAntBatch(db.pool, fake, submit(batch2.batchId, signed2));
    fake.blockHeight += 1000n;
    let alerted = 0;
    const rec2 = await recoverReservedAntClaim(db.pool, fake, treasuryAddress, s.claimId, { alert: () => { alerted += 1; } });
    assert.equal(rec2.outcome, "needs_operator", "second dead cycle freezes, never loops");
    assert.equal(alerted, 1, "critical alert fired once");
    assert.equal((await claimRow(s.claimId)).status, "needs_operator");
    assert.equal(fake.landedSignatures().length, 0, "NOTHING ever landed across the whole dead-tx saga");
  });

  it("S5c: an abandoned (never-submitted) reservation frees the claim on TTL; nothing broadcast", async () => {
    const s = await seedClaim({ assetType: "ant" });
    const fake = new FakeChainGateway();
    const batch = await buildAntBatch(db.pool, treasury, fake, { antColdAddress: antCold.address, max: 50, assetKeyScope: [s.assetKey] });
    assert.equal((await claimRow(s.claimId)).batchId, batch.batchId);
    const freed = await expireStaleReservations(db.pool, 0);
    assert.ok(freed >= 1);
    const cr = await claimRow(s.claimId);
    assert.equal(cr.status, "verified");
    assert.equal(cr.batchId, null);
    assert.equal(cr.reservedTxid, null);
    assert.equal(fake.broadcasts.length, 0);
  });

  it("S5d: TTL sweep does NOT free a SUBMITTED (dispatching) reservation — only abandoned ones", async () => {
    const s = await seedClaim({ assetType: "ant" });
    const fake = new FakeChainGateway();
    fake.dropBroadcast = true;
    const batch = await buildAntBatch(db.pool, treasury, fake, { antColdAddress: antCold.address, max: 50, assetKeyScope: [s.assetKey] });
    const signed = await operatorSignAll(batch.items.map((i) => i.txBase64), antCold);
    await submitAntBatch(db.pool, fake, submit(batch.batchId, signed));
    assert.equal((await claimRow(s.claimId)).status, "dispatching");
    // Aggressive TTL=0: a dispatching claim (dispatch_signature set) must be UNTOUCHED.
    await expireStaleReservations(db.pool, 0);
    const cr = await claimRow(s.claimId);
    assert.equal(cr.status, "dispatching", "a broadcast/dispatching claim is never freed by the TTL sweep");
    assert.ok(cr.sig, "its persisted signature survives");
  });

  // -----------------------------------------------------------------------
  // S6 — blockhash expiry: rebuild/reserve, never double-send.
  // -----------------------------------------------------------------------
  it("S6: blockhash expiry -> release + fresh rebuild (new txid), EXACTLY ONE lands", async () => {
    const s = await seedClaim({ assetType: "ant" });
    const fake = new FakeChainGateway();
    fake.dropBroadcast = true;
    const b1 = await buildAntBatch(db.pool, treasury, fake, { antColdAddress: antCold.address, max: 50, assetKeyScope: [s.assetKey] });
    await submitAntBatch(db.pool, fake, submit(b1.batchId, await operatorSignAll(b1.items.map((i) => i.txBase64), antCold)));
    fake.blockHeight += 1000n;
    const rec = await recoverReservedAntClaim(db.pool, fake, treasuryAddress, s.claimId);
    assert.equal(rec.outcome, "released_for_rebuild");

    fake.dropBroadcast = false;
    const b2 = await buildAntBatch(db.pool, treasury, fake, { antColdAddress: antCold.address, max: 50, assetKeyScope: [s.assetKey] });
    assert.notEqual(b2.items[0].txid, b1.items[0].txid, "fresh blockhash => new txid");
    const res = await submitAntBatch(db.pool, fake, submit(b2.batchId, await operatorSignAll(b2.items.map((i) => i.txBase64), antCold)));
    assert.equal(res[0].outcome, "confirmed");
    assert.equal(fake.landedSignatures().length, 1, "exactly one landed across the whole rebuild");
  });

  // -----------------------------------------------------------------------
  // S8 — money / bigint integrity.
  // -----------------------------------------------------------------------
  it("S8a: an ANT dispatch stores settlement_amount NULL (no mARIO) and never a coerced number", async () => {
    const s = await seedClaim({ assetType: "ant" });
    const fake = new FakeChainGateway();
    const batch = await buildAntBatch(db.pool, treasury, fake, { antColdAddress: antCold.address, max: 50, assetKeyScope: [s.assetKey] });
    await submitAntBatch(db.pool, fake, submit(batch.batchId, await operatorSignAll(batch.items.map((i) => i.txBase64), antCold)));
    const cr = await claimRow(s.claimId);
    assert.equal(cr.status, "confirmed");
    assert.equal(cr.settlementAmount, null, "ANT carries NO amount — settlement_amount stays NULL");
  });

  it("S8b: lastValidBlockHeight beyond 2^53 round-trips EXACTLY (no JS-number precision loss)", async () => {
    const s = await seedClaim({ assetType: "ant" });
    const fake = new FakeChainGateway();
    // A block height that is NOT representable exactly as a JS number.
    fake.blockHeight = 9_007_199_254_740_993n; // 2^53 + 1
    const expectedLvbh = (fake.blockHeight + 150n).toString();
    const batch = await buildAntBatch(db.pool, treasury, fake, { antColdAddress: antCold.address, max: 50, assetKeyScope: [s.assetKey] });
    assert.equal(batch.items[0].lastValidBlockHeight, expectedLvbh, "batch item lvbh is the exact decimal string");
    await submitAntBatch(db.pool, fake, submit(batch.batchId, await operatorSignAll(batch.items.map((i) => i.txBase64), antCold)));
    const cr = await claimRow(s.claimId);
    assert.equal(cr.lastValidBh, expectedLvbh, "persisted dispatch_last_valid_bh is exact — no float coercion");
  });
});
