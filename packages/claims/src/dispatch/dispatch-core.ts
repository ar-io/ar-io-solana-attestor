//! Shared exactly-once dispatch primitives (extracted from worker.ts).
//!
//! The DB state-transitions + the persist -> broadcast -> confirm CORE that anchors
//! the exactly-once guarantee (persist-the-signature-BEFORE-broadcast; re-sign
//! ONLY after the prior signature is PROVABLY dead) are factored out here so BOTH
//! the automated `DispatchWorker` (token/vault + break-glass cold ANT) AND the
//! operator-wallet ANT flow (`ant-operator.ts`) share ONE implementation of the
//! guard rather than each keeping their own copy. `worker.ts`'s private methods
//! delegate to these; the operator flow calls `persistDispatching` +
//! `dispatchSignedTx` directly with an operator-signed transaction.
//!
//! Nothing here is ANT- or token-specific: a caller hands in an already-SIGNED
//! `SignedDispatch` (however it was signed — hot key, cold key, or operator
//! wallet) and these functions persist it before broadcast under the claim-row +
//! asset-row `FOR UPDATE` re-check, then broadcast + confirm. All money stays
//! integer mARIO.

import type { Pool, PoolClient } from "pg";

import { appendAudit } from "../api/audit.js";
import type { ConfirmState, SignedDispatch } from "./chain.js";

/** Structured log sink (optional). */
export type LogFn = (msg: string, extra?: Record<string, unknown>) => void;

export interface ClaimRow {
  claim_id: string;
  asset_key: string;
  claimant: string;
  status: string;
  settlement: string | null;
  approved_at: Date | null;
  dispatch_signature: string | null;
  dispatch_blockhash: string | null;
  dispatch_last_valid_bh: string | null;
  settlement_amount: string | null;
  tx_signatures: string[] | null;
  dispatch_resign_count: number;
  /** Set iff this claim is reserved into an operator-wallet ANT batch. The
   *  automated worker MUST NOT touch such a claim (the operator flow owns its
   *  exactly-once lifecycle) — see the guards in worker.#recover + clearDeadSignature. */
  ant_batch_id: string | null;
}
export interface AssetRow {
  asset_key: string;
  asset_type: "ant" | "token" | "vault";
  ant_mint: string | null;
  amount: string | null;
  vault_end_ts: string | null;
  status: string;
  recipient_id: string;
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------
export async function loadClaim(db: Pool | PoolClient, claimId: string, forUpdate = false): Promise<ClaimRow | null> {
  const r = await db.query<ClaimRow>(
    `SELECT claim_id, asset_key, claimant, status, settlement, approved_at,
            dispatch_signature, dispatch_blockhash, dispatch_last_valid_bh::text AS dispatch_last_valid_bh,
            settlement_amount::text AS settlement_amount, tx_signatures,
            dispatch_resign_count, ant_batch_id::text AS ant_batch_id
       FROM claims WHERE claim_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
    [claimId],
  );
  return r.rows[0] ?? null;
}
export async function loadAsset(db: Pool | PoolClient, assetKey: string, forUpdate = false): Promise<AssetRow | null> {
  const r = await db.query<AssetRow>(
    `SELECT asset_key, asset_type, ant_mint, amount::text AS amount, vault_end_ts::text AS vault_end_ts, status, recipient_id
       FROM assets WHERE asset_key = $1${forUpdate ? " FOR UPDATE" : ""}`,
    [assetKey],
  );
  return r.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// The PERSIST step — verified/approved-pending_review -> dispatching, storing the
// signature BEFORE the broadcast, re-checking claim + asset under FOR UPDATE.
// ---------------------------------------------------------------------------
export interface PersistDispatchingArgs {
  claimId: string;
  assetKey: string;
  signed: SignedDispatch;
  settlementAmount: bigint | null;
  settlementLabel?: string;
  log?: LogFn;
}

/**
 * verified/approved-pending_review -> dispatching, persisting the signature. In
 * ONE committed txn: re-load the claim `FOR UPDATE`, confirm it is still
 * dispatch-eligible, re-load the ASSET `FOR UPDATE` and confirm it is still
 * `claiming`/`pending_review` (never `claimed`). If the state moved, ABORT and
 * return false — the caller MUST NOT broadcast its signed tx (it simply never
 * lands). Lock order is claim-row-then-asset-row (== service.completeClaim), so
 * no deadlock cycle can form. Returns true iff the claim is now `dispatching`.
 */
export async function persistDispatching(pool: Pool, args: PersistDispatchingArgs): Promise<boolean> {
  const { claimId, assetKey, signed, settlementAmount, settlementLabel, log } = args;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const c = await loadClaim(client, claimId, true);
    if (!c) {
      await client.query("ROLLBACK");
      return false;
    }
    const canDispatch = c.status === "verified" || (c.status === "pending_review" && c.approved_at);
    if (!canDispatch) {
      await client.query("ROLLBACK");
      return false;
    }
    const a = await loadAsset(client, assetKey, true);
    if (!a || (a.status !== "claiming" && a.status !== "pending_review")) {
      await client.query("ROLLBACK");
      log?.("persistDispatching: ABORT — asset not dispatch-eligible", {
        claimId, assetKey, assetStatus: a?.status ?? "missing", deadSig: signed.signature,
      });
      return false;
    }
    await client.query(
      `UPDATE claims
          SET status = 'dispatching',
              dispatch_signature = $2,
              dispatch_blockhash = $3,
              dispatch_last_valid_bh = $4,
              dispatch_started_at = now(),
              settlement_amount = $5,
              settlement = COALESCE($6, settlement),
              tx_signatures = array_append(COALESCE(tx_signatures, ARRAY[]::text[]), $2),
              error = NULL,
              updated_at = now()
        WHERE claim_id = $1`,
      [claimId, signed.signature, signed.blockhash, signed.lastValidBlockHeight.toString(),
        settlementAmount === null ? null : settlementAmount.toString(), settlementLabel ?? null],
    );
    await client.query(
      "UPDATE assets SET status = 'claiming', updated_at = now() WHERE asset_key = $1 AND status <> 'claimed'",
      [assetKey],
    );
    await appendAudit(client, {
      event: "claim.dispatching", claimId, assetKey, status: "dispatching",
      detail: { signature: signed.signature, blockhash: signed.blockhash, lastValidBlockHeight: signed.lastValidBlockHeight.toString(), settlement: settlementLabel, amount: settlementAmount?.toString() },
    });
    await client.query("COMMIT");
    return true;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// persist -> broadcast -> confirm CORE (exactly-once anchor). The caller has
// ALREADY signed `signed` (hot key, cold key, or operator wallet). This persists
// it before broadcasting, then broadcasts + confirms inline.
// ---------------------------------------------------------------------------
export type DispatchCoreOutcome = "confirmed" | "failed" | "awaiting_confirmation" | "skipped";

export interface DispatchGateway {
  broadcast(wireBase64: string): Promise<void>;
  confirmSignature(signature: string, lastValidBlockHeight: bigint): Promise<ConfirmState>;
}

export interface DispatchSignedResult {
  outcome: DispatchCoreOutcome;
  signature?: string;
  detail?: string;
}

export async function dispatchSignedTx(
  pool: Pool,
  gateway: DispatchGateway,
  args: PersistDispatchingArgs,
): Promise<DispatchSignedResult> {
  const { signed, log } = args;
  // PERSIST the signature + flip -> dispatching under the FOR UPDATE re-check.
  const persisted = await persistDispatching(pool, args);
  if (!persisted) return { outcome: "skipped", detail: "state changed before dispatch" };

  // BROADCAST (after the commit). Idempotent — same signature dedups.
  try {
    await gateway.broadcast(signed.wireBase64);
  } catch (e) {
    log?.("broadcast error (will recover)", { claimId: args.claimId, sig: signed.signature, err: (e as Error).message });
  }

  // CONFIRM inline. A crash here is fine — recovery finalizes.
  const state = await gateway.confirmSignature(signed.signature, signed.lastValidBlockHeight);
  if (state === "confirmed") {
    await finalizeConfirmed(pool, args.claimId, signed.signature);
    return { outcome: "confirmed", signature: signed.signature };
  }
  if (state === "failed") {
    await markFailed(pool, args.claimId, `on-chain tx ${signed.signature} failed`);
    return { outcome: "failed", signature: signed.signature };
  }
  return { outcome: "awaiting_confirmation", signature: signed.signature };
}

// ---------------------------------------------------------------------------
// Terminal / recovery DB transitions (each its own committed txn; re-check lock)
// ---------------------------------------------------------------------------
/** dispatching -> confirmed; asset -> claimed (terminal). Idempotent. */
export async function finalizeConfirmed(pool: Pool, claimId: string, signature: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const c = await loadClaim(client, claimId, true);
    if (!c) {
      await client.query("ROLLBACK");
      return;
    }
    if (c.status === "confirmed") {
      await client.query("ROLLBACK");
      return; // already finalized (idempotent)
    }
    await client.query(
      `UPDATE claims
          SET status = 'confirmed', confirmed_at = now(),
              tx_signatures = CASE WHEN $2 = ANY(COALESCE(tx_signatures, ARRAY[]::text[]))
                                   THEN tx_signatures
                                   ELSE array_append(COALESCE(tx_signatures, ARRAY[]::text[]), $2) END,
              error = NULL, updated_at = now()
        WHERE claim_id = $1`,
      [claimId, signature],
    );
    await client.query("UPDATE assets SET status = 'claimed', updated_at = now() WHERE asset_key = $1", [c.asset_key]);
    await appendAudit(client, {
      event: "claim.confirmed", claimId, assetKey: c.asset_key, status: "confirmed",
      detail: { signature, settlementAmount: c.settlement_amount ?? undefined },
    });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** dispatching -> failed. Asset stays `claiming` for operator (no auto-retry). */
export async function markFailed(pool: Pool, claimId: string, reason: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const c = await loadClaim(client, claimId, true);
    if (!c || c.status === "confirmed") {
      await client.query("ROLLBACK");
      return;
    }
    await client.query("UPDATE claims SET status = 'failed', error = $2, updated_at = now() WHERE claim_id = $1", [claimId, reason]);
    await appendAudit(client, { event: "claim.failed", claimId, assetKey: c.asset_key, status: "failed", reason });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Freeze a claim `needs_operator` (terminal-until-operator). DB-only — the caller
 * (worker / ant-operator) fires the critical alert. Used when the re-sign/re-build
 * cap is exceeded: the claim is NEVER auto-retried; an operator must verify
 * on-chain and re-drive. Asset stays `claiming` (not released) so no other claim
 * can win it. Returns true iff it flipped (false if already terminal).
 */
export async function markNeedsOperator(pool: Pool, claimId: string, reason: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const c = await loadClaim(client, claimId, true);
    if (!c || c.status === "confirmed" || c.status === "needs_operator") {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query("UPDATE claims SET status = 'needs_operator', error = $2, updated_at = now() WHERE claim_id = $1", [claimId, reason]);
    await appendAudit(client, { event: "claim.needs_operator", claimId, assetKey: c.asset_key, status: "needs_operator", reason, detail: { severity: "critical", deadSignature: c.dispatch_signature ?? undefined } });
    await client.query("COMMIT");
    return true;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Clear a provably-dead (expired) signature so a fresh dispatch can re-sign. */
export async function clearDeadSignature(pool: Pool, claimId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const c = await loadClaim(client, claimId, true);
    // DEFENSE (B1): never clear the signature of an operator-wallet ANT claim — its
    // exactly-once lifecycle is owned by ant-operator.releaseReservationForRebuild,
    // NOT the automated worker. Refuse any claim reserved into an ANT batch.
    if (!c || c.status !== "dispatching" || c.ant_batch_id) {
      await client.query("ROLLBACK");
      return;
    }
    const revertTo = c.approved_at ? "pending_review" : "verified";
    await client.query(
      `UPDATE claims SET status = $2, dispatch_signature = NULL, dispatch_blockhash = NULL,
           dispatch_last_valid_bh = NULL, dispatch_resign_count = dispatch_resign_count + 1,
           updated_at = now() WHERE claim_id = $1`,
      [claimId, revertTo],
    );
    await appendAudit(client, {
      event: "claim.dispatch_expired", claimId, assetKey: c.asset_key, status: revertTo,
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

/** verified/pending -> pending_review + asset pending_review (brake / ANT gate). */
export async function routeToReview(pool: Pool, claimId: string, assetKey: string, reason: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const c = await loadClaim(client, claimId, true);
    if (!c || c.status === "confirmed" || c.status === "dispatching") {
      await client.query("ROLLBACK");
      return;
    }
    await client.query("UPDATE claims SET status = 'pending_review', updated_at = now() WHERE claim_id = $1", [claimId]);
    await client.query(
      "UPDATE assets SET status = 'pending_review', updated_at = now() WHERE asset_key = $1 AND status NOT IN ('claimed')",
      [assetKey],
    );
    await appendAudit(client, { event: "claim.pending_review", claimId, assetKey, status: "pending_review", reason });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Route a still-locked vault claim to the MANUAL-delivery operator queue (item V).
 * Asset stays `pending_review` so no other claim can win it.
 */
export async function routeToManualVaultDelivery(
  pool: Pool,
  claimId: string,
  assetKey: string,
  unlockTs: bigint,
  lockDurationSeconds: bigint,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const c = await loadClaim(client, claimId, true);
    if (!c || c.status === "confirmed" || c.status === "dispatching") {
      await client.query("ROLLBACK");
      return;
    }
    await client.query(
      "UPDATE claims SET status = 'awaiting_manual_vault_delivery', settlement = 'manual_vault_relock', updated_at = now() WHERE claim_id = $1",
      [claimId],
    );
    await client.query(
      "UPDATE assets SET status = 'pending_review', updated_at = now() WHERE asset_key = $1 AND status NOT IN ('claimed')",
      [assetKey],
    );
    await appendAudit(client, {
      event: "claim.awaiting_manual_vault_delivery", claimId, assetKey, status: "awaiting_manual_vault_delivery",
      detail: { unlockTimestamp: unlockTs.toString(), lockDurationSeconds: lockDurationSeconds.toString() },
    });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
