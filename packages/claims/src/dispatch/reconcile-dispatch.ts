//! Reconciliation-after-dispatch (M4, pivot plan §4.3 / §6 transparency seed).
//!
//! Proves the dispatched set is internally consistent and matches what was
//! claimed:
//!   1. dispatched total == claimed total  (Σ settlement_amount over confirmed
//!      token/vault claims == Σ asset.amount for the `claimed` assets they map
//!      to). No value created or lost in dispatch.
//!   2. every confirmed claim recorded an on-chain tx signature.
//!   3. exactly one confirmed claim per claimed asset (no double-dispense), and
//!      every `claimed` asset has its confirmed claim (no orphan settle).
//!   4. an audit_log row exists per dispatch transition (claim.dispatching +
//!      claim.confirmed) for every confirmed claim.
//!
//! Read-only. Money as bigint mARIO.

import type { Pool } from "pg";

export interface DispatchReconcileReport {
  ok: boolean;
  confirmedClaims: number;
  claimedAssets: number;
  dispatchedTotalMario: bigint;
  claimedTotalMario: bigint;
  antConfirmed: number;
  issues: string[];
}

export async function reconcileDispatch(
  pool: Pool,
  opts: { assetKeys?: string[] } = {},
): Promise<DispatchReconcileReport> {
  const issues: string[] = [];
  // Optional scope to a batch of assets (per-batch ops reconcile + test isolation).
  const scope = opts.assetKeys ?? null;

  // 1. Confirmed claims + their dispatched value (settlement_amount).
  const confirmed = await pool.query<{
    claim_id: string;
    asset_key: string;
    asset_type: string;
    settlement_amount: string | null;
    amount: string | null;
    dispatch_signature: string | null;
    asset_status: string;
  }>(
    `SELECT c.claim_id, c.asset_key, a.asset_type,
            c.settlement_amount::text AS settlement_amount, a.amount::text AS amount,
            c.dispatch_signature, a.status AS asset_status
       FROM claims c JOIN assets a ON a.asset_key = c.asset_key
      WHERE c.status = 'confirmed'
        AND ($1::text[] IS NULL OR c.asset_key = ANY($1::text[]))`,
    [scope],
  );

  let dispatchedTotal = 0n;
  let claimedTotal = 0n;
  let antConfirmed = 0;
  const assetKeysSeen = new Map<string, number>();

  for (const row of confirmed.rows) {
    assetKeysSeen.set(row.asset_key, (assetKeysSeen.get(row.asset_key) ?? 0) + 1);

    // 2. tx signature recorded for every confirmed claim.
    if (!row.dispatch_signature) {
      issues.push(`confirmed claim ${row.claim_id} has no recorded tx signature`);
    }
    // asset must be terminal `claimed`.
    if (row.asset_status !== "claimed") {
      issues.push(`confirmed claim ${row.claim_id} but asset ${row.asset_key} status=${row.asset_status} (expected claimed)`);
    }

    if (row.asset_type === "ant") {
      antConfirmed += 1;
      if (row.settlement_amount !== null && row.settlement_amount !== "0") {
        issues.push(`ANT claim ${row.claim_id} carries a settlement_amount (${row.settlement_amount}); expected none`);
      }
      continue;
    }

    // 1. dispatched (settlement_amount) must equal claimed (asset.amount).
    const dispatched = row.settlement_amount === null ? null : BigInt(row.settlement_amount);
    const claimed = row.amount === null ? 0n : BigInt(row.amount);
    if (dispatched === null) {
      issues.push(`confirmed token/vault claim ${row.claim_id} has no settlement_amount`);
    } else {
      dispatchedTotal += dispatched;
      claimedTotal += claimed;
      if (dispatched !== claimed) {
        issues.push(`claim ${row.claim_id}: dispatched ${dispatched} != claimed ${claimed}`);
      }
    }
  }

  // 3a. no double-dispense: at most one confirmed claim per asset.
  for (const [assetKey, n] of assetKeysSeen) {
    if (n > 1) issues.push(`asset ${assetKey} has ${n} confirmed claims (double-dispense!)`);
  }

  // 3b. every `claimed` asset has a confirmed claim (no orphan settle).
  const claimedAssets = await pool.query<{ asset_key: string }>(
    "SELECT asset_key FROM assets WHERE status = 'claimed' AND ($1::text[] IS NULL OR asset_key = ANY($1::text[]))",
    [scope],
  );
  for (const a of claimedAssets.rows) {
    if (!assetKeysSeen.has(a.asset_key)) {
      issues.push(`asset ${a.asset_key} is claimed but has no confirmed claim (orphan)`);
    }
  }

  // 4. an audit row per dispatch transition for every confirmed claim.
  const auditCounts = await pool.query<{ claim_id: string; dispatching: string; confirmed: string }>(
    `SELECT c.claim_id,
            count(*) FILTER (WHERE al.entry->>'event' = 'claim.dispatching')::text AS dispatching,
            count(*) FILTER (WHERE al.entry->>'event' = 'claim.confirmed')::text AS confirmed
       FROM claims c
       LEFT JOIN audit_log al ON al.entry->>'claimId' = c.claim_id::text
      WHERE c.status = 'confirmed'
        AND ($1::text[] IS NULL OR c.asset_key = ANY($1::text[]))
      GROUP BY c.claim_id`,
    [scope],
  );
  for (const row of auditCounts.rows) {
    if (Number(row.dispatching) < 1) issues.push(`confirmed claim ${row.claim_id} missing a claim.dispatching audit row`);
    if (Number(row.confirmed) < 1) issues.push(`confirmed claim ${row.claim_id} missing a claim.confirmed audit row`);
  }

  return {
    ok: issues.length === 0,
    confirmedClaims: confirmed.rows.length,
    claimedAssets: claimedAssets.rows.length,
    dispatchedTotalMario: dispatchedTotal,
    claimedTotalMario: claimedTotal,
    antConfirmed,
    issues,
  };
}
