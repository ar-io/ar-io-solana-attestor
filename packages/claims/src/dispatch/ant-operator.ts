//! Operator wallet-signed ANT dispatch (docs/claims/ANT_OPERATOR_SIGNING_SPEC.md).
//!
//! Instead of a server-held cold ANT key, the OPERATOR signs pre-built ANT
//! transfer batches with their own wallet (Phantom/Ledger = the ANT authority).
//! The TREASURY is the fee payer, so the server signs the fee-payer slot and
//! therefore knows + persists the final txid BEFORE the operator ever co-signs —
//! and a Solana txid is its fee-payer signature, invariant to the other signers.
//! That keeps the EXISTING exactly-once anchor (persist-signature-before-broadcast)
//! unchanged; the only thing that moved off the server is the AUTHORITY signature.
//!
//!   buildAntBatch  — select eligible ANT claims, build 1 tx/claim
//!                    ([TransferV1, UpdateV1, memo], feePayer=treasury), treasury
//!                    co-signs (=> txid known now), reserve the claims into a batch
//!                    (FOR UPDATE SKIP LOCKED). Returns partially-signed txs.
//!   submitAntBatch — per operator-signed tx: assert the authority signature is
//!                    present AND == ANT_COLD_ADDRESS, match it back to its
//!                    reservation by txid, then run the SHARED persist-dispatching
//!                    re-check (dispatch-core) -> broadcast -> confirm. Per-tx
//!                    independent; one tx failing never aborts the others.
//!
//! The wallet MUST sign-only (never signAndSend): the SERVER controls broadcast so
//! persist-before-broadcast holds. Reservations auto-expire (TTL) so an abandoned
//! batch frees its claims back to eligible with nothing broadcast.

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import * as ed from "@noble/ed25519";
import bs58 from "bs58";
import {
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionDecoder,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type IInstruction,
  type TransactionSigner,
} from "@solana/kit";

import { appendAudit } from "../api/audit.js";
import type { AntChainGateway } from "./chain.js";
import {
  dispatchSignedTx,
  finalizeConfirmed,
  loadClaim,
  markFailed,
  markNeedsOperator,
  type LogFn,
} from "./dispatch-core.js";
import { claimMemoIx, mplCoreTransferV1Ix, mplCoreUpdateAuthorityIx } from "./instructions.js";

/** HARD CAP on ANT re-builds per claim after a provably-dead submitted tx. Mirrors
 *  the worker's MAX_RESIGN_ATTEMPTS: the server cannot re-sign an ANT tx (no
 *  authority key), so a "re-build" frees the reservation for the operator's next
 *  batch; beyond the cap the claim freezes `needs_operator` (never loops). */
const MAX_ANT_REBUILD_ATTEMPTS = 1;

export type { AntChainGateway };

export interface AntBatchItem {
  claimId: string;
  assetKey: string;
  antMint: string;
  claimant: string;
  /** base64 wire tx: treasury-signed (fee-payer slot), authority slot EMPTY. */
  txBase64: string;
  /** the tx id (== the treasury fee-payer signature) — known + persisted now. */
  txid: string;
  /** decimal string (bigint-safe over JSON). */
  lastValidBlockHeight: string;
}

export interface AntBatchResult {
  batchId: string;
  items: AntBatchItem[];
}

// ---------------------------------------------------------------------------
// tx assembly — one MPL Core ANT hand-off, fee payer = treasury.
// ---------------------------------------------------------------------------
export interface BuildAntTxArgs {
  claimId: string;
  antMint: Address;
  claimant: Address;
  antColdAddress: Address;
  blockhash: string;
  lastValidBlockHeight: bigint;
  includeMemo: boolean;
}

export interface BuiltAntTx {
  txid: string;
  txBase64: string;
  blockhash: string;
  lastValidBlockHeight: bigint;
}

/**
 * Build + treasury-co-sign ONE ANT transfer tx. Instructions: TransferV1 (Owner ->
 * claimant) + UpdateV1 (UpdateAuthority -> claimant) + optional memo. The fee payer
 * is the TREASURY (it signs the fee-payer slot here, fixing the txid); the ANT
 * `authority` (== ANT_COLD_ADDRESS, the current owner/UA) is a REQUIRED signer that
 * is left UNSIGNED for the operator's wallet to fill later. `payer` on the MPL Core
 * ixs is also the treasury (it funds any reallocation) — the operator wallet needs
 * zero SOL. The returned txid is invariant to the operator's later signature.
 */
export async function buildAntTransferTx(treasury: TransactionSigner, args: BuildAntTxArgs): Promise<BuiltAntTx> {
  const ixs: IInstruction[] = [
    mplCoreTransferV1Ix({ asset: args.antMint, payer: treasury.address, authority: args.antColdAddress, newOwner: args.claimant }),
    mplCoreUpdateAuthorityIx({ asset: args.antMint, payer: treasury.address, authority: args.antColdAddress, newAuthority: args.claimant }),
  ];
  if (args.includeMemo) ixs.push(claimMemoIx(args.claimId));

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(treasury, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: args.blockhash as Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0]["blockhash"], lastValidBlockHeight: args.lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );

  // Treasury is the only attached signer -> the authority slot stays empty (null).
  const partial = await partiallySignTransactionMessageWithSigners(message);
  const txid = getSignatureFromTransaction(partial);
  const txBase64 = getBase64EncodedWireTransaction(partial);
  return { txid, txBase64, blockhash: args.blockhash, lastValidBlockHeight: args.lastValidBlockHeight };
}

// ---------------------------------------------------------------------------
// buildAntBatch — select + reserve + build a batch of partially-signed txs.
// ---------------------------------------------------------------------------
export interface BuildAntBatchOpts {
  antColdAddress: Address;
  /** max txs offered per session (ANT_BATCH_MAX). */
  max: number;
  /** include the `ar.io-claim:<id>` memo ix (default true). */
  includeMemo?: boolean;
  /** reservation TTL (ms). Abandoned reservations older than this are freed first. */
  reservationTtlMs?: number;
  /** when true, only APPROVED pending_review ANT claims are eligible (default:
   *  false — verified ANT claims flow straight into the batch; the signing session
   *  IS the human gate, ANT_REQUIRES_APPROVAL=false). */
  requireApproval?: boolean;
  /** TEST ISOLATION: restrict eligibility to these asset keys (this file shares one
   *  Postgres with the other DB suites). Undefined => all eligible ANT claims. */
  assetKeyScope?: string[];
  log?: LogFn;
}

export async function buildAntBatch(
  pool: Pool,
  treasury: TransactionSigner,
  gateway: AntChainGateway,
  opts: BuildAntBatchOpts,
): Promise<AntBatchResult> {
  const includeMemo = opts.includeMemo ?? true;
  const ttlMs = opts.reservationTtlMs ?? 600_000;
  // Free abandoned reservations first so their claims are eligible again.
  await expireStaleReservations(pool, ttlMs);

  // Fetch a fresh blockhash BEFORE opening the txn (no network I/O under lock).
  const { blockhash, lastValidBlockHeight } = await gateway.latestBlockhash();
  const batchId = randomUUID();

  const statusPredicate = opts.requireApproval
    ? "(c.status = 'pending_review' AND c.approved_at IS NOT NULL)"
    : "(c.status = 'verified' OR (c.status = 'pending_review' AND c.approved_at IS NOT NULL))";

  const items: AntBatchItem[] = [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Eligible ANT claims: asset is an ANT that is still dispatch-eligible
    // (`claiming` | `pending_review` — NEVER manual_review/AT-RISK, claimed,
    // cancelled or frozen), not already in flight (no dispatch_signature) and not
    // reserved by a live batch. FOR UPDATE ... SKIP LOCKED so two concurrent build
    // sessions never grab the same claim.
    const scope = opts.assetKeyScope ?? null;
    const sel = await client.query<{ claim_id: string; claimant: string; asset_key: string; ant_mint: string | null }>(
      `SELECT c.claim_id, c.claimant, c.asset_key, a.ant_mint
         FROM claims c
         JOIN assets a ON a.asset_key = c.asset_key
        WHERE a.asset_type = 'ant'
          AND a.status IN ('claiming', 'pending_review')
          AND c.dispatch_signature IS NULL
          AND c.ant_batch_id IS NULL
          AND ($2::text[] IS NULL OR c.asset_key = ANY($2))
          AND ${statusPredicate}
        ORDER BY c.approved_at NULLS FIRST, c.created_at
        LIMIT $1
        FOR UPDATE OF c SKIP LOCKED`,
      [opts.max, scope],
    );

    for (const row of sel.rows) {
      if (!row.ant_mint) continue; // an ANT with no mint can't be built; skip (stays eligible? no — skip and leave unreserved)
      const built = await buildAntTransferTx(treasury, {
        claimId: row.claim_id,
        antMint: address(row.ant_mint),
        claimant: address(row.claimant),
        antColdAddress: opts.antColdAddress,
        blockhash,
        lastValidBlockHeight,
        includeMemo,
      });
      await client.query(
        `UPDATE claims
            SET ant_batch_id = $2, ant_reserved_at = now(),
                ant_reserved_txid = $3, ant_reserved_blockhash = $4, ant_reserved_last_valid_bh = $5,
                ant_reserved_wire = $6,
                updated_at = now()
          WHERE claim_id = $1`,
        [row.claim_id, batchId, built.txid, built.blockhash, built.lastValidBlockHeight.toString(), built.txBase64],
      );
      items.push({
        claimId: row.claim_id,
        assetKey: row.asset_key,
        antMint: row.ant_mint,
        claimant: row.claimant,
        txBase64: built.txBase64,
        txid: built.txid,
        lastValidBlockHeight: built.lastValidBlockHeight.toString(),
      });
    }

    await client.query(
      `INSERT INTO ant_batches (batch_id, created_by_pubkey, claim_count, status)
       VALUES ($1, $2, $3, 'open')`,
      [batchId, opts.antColdAddress, items.length],
    );
    await appendAudit(client, {
      event: "ant.batch.build",
      status: "open",
      detail: {
        batchId,
        createdBy: opts.antColdAddress,
        claimCount: items.length,
        claimIds: items.map((i) => i.claimId),
        txids: items.map((i) => i.txid),
      },
    });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  opts.log?.("ant batch built", { batchId, claimCount: items.length });
  return { batchId, items };
}

// ---------------------------------------------------------------------------
// submitAntBatch — verify + persist + broadcast + confirm each operator-signed tx.
// ---------------------------------------------------------------------------
export type AntSubmitOutcome =
  | "confirmed"
  | "already_confirmed"
  | "recovered_confirmed"
  | "failed"
  | "awaiting_confirmation"
  | "skipped"
  | "needs_operator"
  | "released_for_rebuild"
  | "rejected_no_authority_sig"
  | "rejected_bad_authority_sig"
  | "rejected_unknown_tx"
  | "rejected_undecodable";

export interface AntSubmitResult {
  txid?: string;
  claimId?: string;
  assetKey?: string;
  outcome: AntSubmitOutcome;
  signature?: string;
  detail?: string;
}

export interface SubmitAntBatchOpts {
  batchId: string;
  signedTxs: string[];
  antColdAddress: Address;
  treasuryAddress: Address;
  log?: LogFn;
  /** critical-alert sink when a claim freezes needs_operator. */
  alert?: (a: { name: string; severity: "critical" | "warning"; message: string; claimId: string }) => void;
}

const ZERO64 = new Uint8Array(64);
function isPresentSig(sig: Uint8Array | null): sig is Uint8Array {
  if (!sig) return false;
  return !sig.every((b, i) => b === ZERO64[i]);
}

export async function submitAntBatch(
  pool: Pool,
  gateway: AntChainGateway,
  opts: SubmitAntBatchOpts,
): Promise<AntSubmitResult[]> {
  const results: AntSubmitResult[] = [];
  const authPubkey = bs58.decode(opts.antColdAddress);

  for (const wire of opts.signedTxs) {
    // Each tx is INDEPENDENT — a failure of one must not abort the others.
    try {
      results.push(await submitOneAntTx(pool, gateway, wire, opts, authPubkey));
    } catch (e) {
      opts.log?.("ant submit: tx errored (isolated)", { err: (e as Error).message });
      results.push({ outcome: "skipped", detail: `error: ${(e as Error).message}` });
    }
  }

  // Advance the batch header. `completed` iff every reserved claim confirmed.
  await finalizeBatchStatus(pool, opts.batchId);

  await writeSubmitAudit(pool, opts.batchId, opts.antColdAddress, results);
  return results;
}

async function submitOneAntTx(
  pool: Pool,
  gateway: AntChainGateway,
  wire: string,
  opts: SubmitAntBatchOpts,
  authPubkey: Uint8Array,
): Promise<AntSubmitResult> {
  // 1. Decode the SUBMITTED wire ONLY to extract two client-supplied values: the
  //    fee-payer signature (used solely to LOOK UP the reservation — it is
  //    attacker-settable, so it is never trusted for the broadcast bytes) and the
  //    operator's AUTHORITY signature (the one thing the server genuinely needs
  //    from the client). Everything else about the submitted wire is discarded.
  let submittedTxid: string;
  let authoritySig: Uint8Array | null;
  try {
    const decoded = getTransactionDecoder().decode(new Uint8Array(getBase64Encoder().encode(wire)));
    submittedTxid = getSignatureFromTransaction(decoded);
    authoritySig = (decoded.signatures[opts.antColdAddress] ?? null) as Uint8Array | null;
  } catch (e) {
    return { outcome: "rejected_undecodable", detail: (e as Error).message };
  }
  if (!isPresentSig(authoritySig)) {
    return { txid: submittedTxid, outcome: "rejected_no_authority_sig", detail: "authority slot empty" };
  }

  // 2. Match the tx back to its reservation by txid. A tx not reserved by THIS live
  //    batch (a replay of a stale or foreign tx, or a fresh-txid redirect) has no
  //    matching reservation -> rejected, never broadcast.
  const resv = await pool.query<{ claim_id: string; asset_key: string; wire: string | null; blockhash: string | null; lvbh: string | null }>(
    `SELECT claim_id, asset_key, ant_reserved_wire AS wire, ant_reserved_blockhash AS blockhash,
            ant_reserved_last_valid_bh::text AS lvbh
       FROM claims WHERE ant_reserved_txid = $1 AND ant_batch_id = $2`,
    [submittedTxid, opts.batchId],
  );
  const match = resv.rows[0];
  if (!match || !match.wire) {
    return { txid: submittedTxid, outcome: "rejected_unknown_tx", detail: "no live reservation matches this txid+batch" };
  }
  const { claim_id: claimId, asset_key: assetKey } = match;

  // 3. SERVER-AUTHORITATIVE message binding (anti-redirect). Reconstruct the
  //    broadcast wire from the STORED, treasury-cosigned partial (the server's own
  //    message + treasury signature) plus the operator's authority signature — the
  //    client's message bytes are NEVER used. Verify the authority signature over
  //    the STORED message: a redirected/memo-stripped tamper signs a DIFFERENT
  //    message, so its authority sig fails here and is rejected BEFORE any
  //    broadcast (enforced in-process, not left to the validator).
  const storedDecoded = getTransactionDecoder().decode(new Uint8Array(getBase64Encoder().encode(match.wire)));
  const storedMessage = storedDecoded.messageBytes as unknown as Uint8Array;
  const authOk = await ed.verifyAsync(authoritySig, storedMessage, authPubkey);
  if (!authOk) {
    return { txid: submittedTxid, claimId, assetKey, outcome: "rejected_bad_authority_sig", detail: "authority signature does not verify over the server's reserved message (tampered/redirected)" };
  }
  const authoritativeWire = getBase64EncodedWireTransaction(
    { ...storedDecoded, signatures: { ...storedDecoded.signatures, [opts.antColdAddress]: authoritySig } } as typeof storedDecoded,
  );
  // The txid is the treasury (fee-payer) signature of the STORED wire (== the
  // reserved txid), invariant to the authority signature just inserted.
  const txid = getSignatureFromTransaction(storedDecoded);

  // 4. Re-check the claim state under lock and dispatch. A double-submit / straggler
  //    lands in the recovery branch (never a second broadcast).
  const claim = await loadClaim(pool, claimId);
  if (!claim) return { txid, claimId, assetKey, outcome: "skipped", detail: "claim vanished" };
  if (claim.status === "confirmed") {
    return { txid, claimId, assetKey, outcome: "already_confirmed", signature: claim.dispatch_signature ?? txid };
  }
  if (claim.status === "dispatching" && claim.dispatch_signature) {
    // Already persisted (a prior submit) — recover, do not re-broadcast a new sig.
    return { ...(await recoverReservedAntClaim(pool, gateway, opts.treasuryAddress, claimId, opts)), txid };
  }

  // FRESH: persist the txid BEFORE broadcast, under the FOR UPDATE re-check
  // (verified/approved + asset available). Reuses the SHARED core. The blockhash +
  // lastValidBlockHeight persisted as dispatch_* come from the RESERVATION
  // (server-set at build), and the broadcast bytes are the SERVER-reconstructed
  // wire — never client-supplied values.
  const signed = {
    signature: txid,
    blockhash: match.blockhash ?? "",
    lastValidBlockHeight: BigInt(match.lvbh ?? "0"),
    wireBase64: authoritativeWire,
  };
  const core = await dispatchSignedTx(pool, gateway, {
    claimId,
    assetKey,
    signed,
    settlementAmount: null,
    settlementLabel: "ant-operator",
    log: opts.log,
  });
  return { txid, claimId, assetKey, outcome: core.outcome, signature: core.signature, detail: core.detail };
}

// ---------------------------------------------------------------------------
// Recovery of a SUBMITTED-but-unconfirmed ANT claim (stragglers / double-submit).
// Reuses the worker's #recover SEMANTICS: confirmed -> finalize; failed -> failed;
// expired -> outflow-scan (confirm if it actually landed), else free the
// reservation for a fresh operator re-build (bounded once) or freeze needs_operator.
// ---------------------------------------------------------------------------
export interface AntRecoverOpts {
  log?: LogFn;
  alert?: (a: { name: string; severity: "critical" | "warning"; message: string; claimId: string }) => void;
}

export async function recoverReservedAntClaim(
  pool: Pool,
  gateway: AntChainGateway,
  treasuryAddress: Address,
  claimId: string,
  opts: AntRecoverOpts = {},
): Promise<AntSubmitResult> {
  const claim = await loadClaim(pool, claimId);
  if (!claim) return { claimId, outcome: "skipped", detail: "claim vanished" };
  if (claim.status === "confirmed") {
    return { claimId, assetKey: claim.asset_key, outcome: "already_confirmed", signature: claim.dispatch_signature ?? undefined };
  }
  if (claim.status !== "dispatching" || !claim.dispatch_signature) {
    return { claimId, assetKey: claim.asset_key, outcome: "skipped", detail: `not dispatching (${claim.status})` };
  }
  const sig = claim.dispatch_signature;
  const lastValid = BigInt(claim.dispatch_last_valid_bh ?? "0");
  const state = await gateway.confirmSignature(sig, lastValid);
  opts.log?.("ant recover: signature status", { claimId, sig, state });

  if (state === "confirmed") {
    await finalizeConfirmed(pool, claimId, sig);
    return { claimId, assetKey: claim.asset_key, outcome: "recovered_confirmed", signature: sig };
  }
  if (state === "failed") {
    await markFailed(pool, claimId, `on-chain tx ${sig} failed`);
    return { claimId, assetKey: claim.asset_key, outcome: "failed", signature: sig, detail: "tx failed" };
  }
  if (state === "expired") {
    // Decoy-proof: before freeing, scan the treasury + claimant history for a
    // CONFIRMED tx that is one of THIS claim's own recorded signatures. If found,
    // the transfer already landed (the status read merely lagged) -> confirm.
    const known = [sig, ...(claim.tx_signatures ?? [])].filter(Boolean) as string[];
    const outflow = await gateway.findConfirmedOutflow({
      addresses: [treasuryAddress, address(claim.claimant)],
      knownSignatures: known,
      memo: `ar.io-claim:${claimId}`,
    });
    if (outflow) {
      opts.log?.("ant recover: outflow scan found a landed tx despite `expired` — confirming, NOT re-building", { claimId, deadSig: sig, landedSig: outflow.signature });
      await finalizeConfirmed(pool, claimId, outflow.signature);
      return { claimId, assetKey: claim.asset_key, outcome: "recovered_confirmed", signature: outflow.signature };
    }
    if ((claim.dispatch_resign_count ?? 0) >= MAX_ANT_REBUILD_ATTEMPTS) {
      const reason = `ANT re-build cap (${MAX_ANT_REBUILD_ATTEMPTS}) exceeded after repeated \`expired\` with no landed outflow — possible lagging/pooled confirm-RPC. Frozen for an operator; verify on-chain before any manual re-drive.`;
      const flipped = await markNeedsOperator(pool, claimId, reason);
      if (flipped) {
        opts.log?.("CRITICAL: ant claim frozen needs_operator", { claimId, reason });
        opts.alert?.({ name: "ant-dispatch-needs-operator", severity: "critical", message: reason, claimId });
      }
      return { claimId, assetKey: claim.asset_key, outcome: "needs_operator", signature: sig, detail: "rebuild cap exceeded" };
    }
    // Provably dead AND never landed: FREE the reservation so the operator's next
    // build re-includes it (the server can NOT re-sign an ANT — no authority key).
    await releaseReservationForRebuild(pool, claimId);
    opts.log?.("ant recover: prior tx expired (no landed outflow), released for operator re-build", { claimId, deadSig: sig });
    return { claimId, assetKey: claim.asset_key, outcome: "released_for_rebuild", signature: sig };
  }
  // pending + still valid: a prior broadcast may yet land; leave it.
  return { claimId, assetKey: claim.asset_key, outcome: "awaiting_confirmation", signature: sig };
}

// ---------------------------------------------------------------------------
// Reservation lifecycle helpers.
// ---------------------------------------------------------------------------
/**
 * Free reservations abandoned longer than `ttlMs` (never submitted — no persisted
 * dispatch_signature). Their claims return to `verified`/`pending_review` eligible;
 * nothing was ever broadcast. Batches with no remaining reserved claims are marked
 * `expired`. Returns the number of claims freed. The cutoff is computed in JS so a
 * test can pass ttlMs=0 to expire immediately (deterministic).
 */
export async function expireStaleReservations(pool: Pool, ttlMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - ttlMs);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const freed = await client.query<{ claim_id: string; ant_batch_id: string }>(
      `UPDATE claims
          SET ant_batch_id = NULL, ant_reserved_at = NULL, ant_reserved_txid = NULL,
              ant_reserved_blockhash = NULL, ant_reserved_last_valid_bh = NULL,
              ant_reserved_wire = NULL, updated_at = now()
        WHERE ant_reserved_at IS NOT NULL
          AND ant_reserved_at < $1
          AND dispatch_signature IS NULL
          AND status IN ('verified', 'pending_review')
        RETURNING claim_id, ant_batch_id`,
      [cutoff],
    );
    // Mark any now-empty `open` batch expired (best-effort housekeeping).
    await client.query(
      `UPDATE ant_batches b
          SET status = 'expired'
        WHERE b.status = 'open'
          AND b.created_at < $1
          AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.ant_batch_id = b.batch_id)`,
      [cutoff],
    );
    await client.query("COMMIT");
    return freed.rowCount ?? 0;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Free a SUBMITTED-but-provably-dead ANT reservation so the operator's next batch
 * re-builds it: revert to `verified`/`pending_review`, clear the persisted
 * signature + all reservation fields, and bump dispatch_resign_count so the hard
 * cap (-> needs_operator) is enforced. Only acts on a `dispatching` claim.
 */
export async function releaseReservationForRebuild(pool: Pool, claimId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const c = await loadClaim(client, claimId, true);
    if (!c || c.status !== "dispatching") {
      await client.query("ROLLBACK");
      return;
    }
    const revertTo = c.approved_at ? "pending_review" : "verified";
    await client.query(
      `UPDATE claims
          SET status = $2, dispatch_signature = NULL, dispatch_blockhash = NULL, dispatch_last_valid_bh = NULL,
              dispatch_resign_count = dispatch_resign_count + 1,
              ant_batch_id = NULL, ant_reserved_at = NULL, ant_reserved_txid = NULL,
              ant_reserved_blockhash = NULL, ant_reserved_last_valid_bh = NULL,
              ant_reserved_wire = NULL, updated_at = now()
        WHERE claim_id = $1`,
      [claimId, revertTo],
    );
    await appendAudit(client, {
      event: "ant.reservation_released", claimId, assetKey: c.asset_key, status: revertTo,
      detail: { deadSignature: c.dispatch_signature ?? undefined },
    });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function finalizeBatchStatus(pool: Pool, batchId: string): Promise<void> {
  // completed iff every claim ever reserved into this batch is confirmed AND none
  // remain reserved/unconfirmed; else submitted.
  const remaining = await pool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM claims WHERE ant_batch_id = $1 AND status <> 'confirmed'",
    [batchId],
  );
  const stillOpen = BigInt(remaining.rows[0]?.n ?? "0") > 0n;
  await pool.query(
    `UPDATE ant_batches
        SET status = $2, submitted_at = COALESCE(submitted_at, now())
      WHERE batch_id = $1 AND status IN ('open', 'submitted')`,
    [batchId, stillOpen ? "submitted" : "completed"],
  );
}

async function writeSubmitAudit(
  pool: Pool,
  batchId: string,
  antColdAddress: string,
  results: AntSubmitResult[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await appendAudit(client, {
      event: "ant.batch.submit",
      status: "submitted",
      detail: {
        batchId,
        submittedBy: antColdAddress,
        results: results.map((r) => ({ claimId: r.claimId, txid: r.txid, outcome: r.outcome, signature: r.signature })),
      },
    });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Read models for the admin dashboard.
// ---------------------------------------------------------------------------
export interface AntPending {
  count: number;
  reserved: number;
  oldestAgeSeconds: number | null;
  claims: { claimId: string; assetKey: string; antMint: string | null; status: string; reserved: boolean; ageSeconds: number }[];
}

/** Count + sample of ANT claims awaiting dispatch (verified / approved). */
export async function getAntPending(pool: Pool, opts: { requireApproval?: boolean; limit?: number } = {}): Promise<AntPending> {
  const statusPredicate = opts.requireApproval
    ? "(c.status = 'pending_review' AND c.approved_at IS NOT NULL)"
    : "(c.status = 'verified' OR (c.status = 'pending_review' AND c.approved_at IS NOT NULL))";
  const r = await pool.query<{ claim_id: string; asset_key: string; ant_mint: string | null; status: string; reserved: boolean; age: string }>(
    `SELECT c.claim_id, c.asset_key, a.ant_mint, c.status,
            (c.ant_batch_id IS NOT NULL) AS reserved,
            EXTRACT(EPOCH FROM (now() - COALESCE(c.verified_at, c.created_at)))::bigint::text AS age
       FROM claims c JOIN assets a ON a.asset_key = c.asset_key
      WHERE a.asset_type = 'ant'
        AND a.status IN ('claiming', 'pending_review')
        AND c.dispatch_signature IS NULL
        AND ${statusPredicate}
      ORDER BY c.verified_at NULLS FIRST, c.created_at
      LIMIT $1`,
    [opts.limit ?? 200],
  );
  const claims = r.rows.map((x) => ({
    claimId: x.claim_id,
    assetKey: x.asset_key,
    antMint: x.ant_mint,
    status: x.status,
    reserved: x.reserved,
    ageSeconds: Number(x.age),
  }));
  return {
    count: claims.length,
    reserved: claims.filter((c) => c.reserved).length,
    oldestAgeSeconds: claims.length ? Math.max(...claims.map((c) => c.ageSeconds)) : null,
    claims,
  };
}

export interface AntBatchStatus {
  batchId: string;
  status: string;
  createdBy: string;
  createdAt: string;
  submittedAt: string | null;
  claimCount: number;
  claims: { claimId: string; assetKey: string; status: string; dispatchSignature: string | null; reservedTxid: string | null }[];
}

/** Per-batch status for polling: header + per-claim state + signatures. */
export async function getAntBatchStatus(pool: Pool, batchId: string): Promise<AntBatchStatus | null> {
  const b = await pool.query<{ batch_id: string; status: string; created_by_pubkey: string; created_at: Date; submitted_at: Date | null; claim_count: number }>(
    "SELECT batch_id, status, created_by_pubkey, created_at, submitted_at, claim_count FROM ant_batches WHERE batch_id = $1",
    [batchId],
  );
  const hdr = b.rows[0];
  if (!hdr) return null;
  // Claims currently reserved to this batch, plus any that were reserved by it and
  // have since dispatched/confirmed (dispatch_signature carries the batch's txid or
  // its confirmed successor). We report by the persisted reservation txid.
  const c = await pool.query<{ claim_id: string; asset_key: string; status: string; dispatch_signature: string | null; ant_reserved_txid: string | null }>(
    `SELECT claim_id, asset_key, status, dispatch_signature, ant_reserved_txid
       FROM claims WHERE ant_batch_id = $1 ORDER BY claim_id`,
    [batchId],
  );
  return {
    batchId: hdr.batch_id,
    status: hdr.status,
    createdBy: hdr.created_by_pubkey,
    createdAt: hdr.created_at.toISOString(),
    submittedAt: hdr.submitted_at ? hdr.submitted_at.toISOString() : null,
    claimCount: hdr.claim_count,
    claims: c.rows.map((x) => ({
      claimId: x.claim_id,
      assetKey: x.asset_key,
      status: x.status,
      dispatchSignature: x.dispatch_signature,
      reservedTxid: x.ant_reserved_txid,
    })),
  };
}
