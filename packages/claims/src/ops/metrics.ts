//! Operational metrics for the claims service (M7 ops hardening).
//!
//! Collects a point-in-time snapshot of the health signals an operator/on-call
//! needs to run the custodial dispenser safely (pivot plan §6.1–§6.5):
//!
//!   * dispatch success / failure / in-flight counts
//!   * hot-float level (balance / reserved / available / cap) — chain, optional
//!   * reconciliation drift (Σ dispatched vs Σ claimed over confirmed claims)
//!   * reserves coverage (holdings ≥ liabilities) — chain, optional
//!   * claim rate (created / confirmed over the last hour + 24h)
//!   * error rates (rejected / failed claims)
//!   * anchor status (last audit-head anchor + age) + audit-log head
//!   * the >100k / ANT operator review queue depth + oldest-item age
//!
//! DB-derived metrics need only the pool (always available); the two chain-derived
//! blocks (float, reserves) are folded in by the caller when the treasury address
//! + mint + an RPC are configured (see `collectMetrics`). Money stays integer
//! mARIO internally, serialized as decimal strings at the edge (never JS numbers).

import type { Pool } from "pg";

import type { FloatStatus } from "../dispatch/float.js";
import type { ReservesReport } from "../transparency/reserves.js";

export interface DbMetrics {
  claims: {
    byStatus: Record<string, number>;
    total: number;
    confirmed: number;
    failed: number;
    rejected: number;
    dispatching: number;
    verified: number;
    pendingReview: number;
    /** confirmed dispenses in the trailing hour / 24h (the claim rate). */
    confirmedLastHour: number;
    confirmedLast24h: number;
    createdLastHour: number;
    /** operator review queue (>100k brake + ANT approvals). */
    reviewQueueDepth: number;
    /** age of the oldest un-approved pending_review claim (seconds); null if empty. */
    oldestReviewAgeSec: number | null;
    /** claims stuck `dispatching` longer than this is a worker-stall signal. */
    dispatchingCount: number;
    oldestDispatchingAgeSec: number | null;
  };
  assets: { byStatus: Record<string, number>; total: number };
  dispatch: {
    confirmed: number;
    failed: number;
    inFlight: number;
    dispatchedTotalMario: string;
    claimedTotalMario: string;
    /** dispatched − claimed over confirmed token/vault claims; MUST be 0. */
    driftMario: string;
  };
  liabilities: {
    outstandingMario: string;
    claimedMario: string;
    outstandingAnts: number;
    claimedAnts: number;
  };
  audit: {
    headSeq: string | null;
    /** rows whose Ed25519 signature is still the placeholder (un-backfilled). */
    unsignedRows: number;
  };
  anchors: {
    lastAuditHeadAnchorAt: string | null;
    lastAuditHeadAnchorAgeSec: number | null;
    lastAuditHeadAnchorConfirmed: boolean | null;
  };
}

export interface MetricsSnapshot extends DbMetrics {
  generatedAt: string;
  /** hot dispenser float (chain-read); present when the caller computed it. */
  float?: {
    balanceMario: string;
    reservedMario: string;
    availableMario: string;
    capMario: string;
    refillNeeded: boolean;
    overCap: boolean;
  };
  /** reserves-vs-liabilities coverage (chain-read); present when computed. */
  reserves?: {
    totalReserveMario: string;
    outstandingMario: string;
    surplusMario: string;
    tokenVaultCovered: boolean;
    antCovered: boolean | "sampled-only" | null;
  };
}

/** The claim statuses we always surface (so a metric reads 0, not absent). */
const CLAIM_STATUSES = [
  "received",
  "verified",
  "pending_review",
  "dispatching",
  "confirmed",
  "rejected",
  "failed",
] as const;

/** Collect every DB-derived metric (no chain access needed). */
export async function collectDbMetrics(pool: Pool): Promise<DbMetrics> {
  const [claimsByStatus, claimRates, review, dispatching, assetsByStatus, drift, liab, audit, anchor] =
    await Promise.all([
      pool.query<{ status: string; n: string }>("SELECT status, count(*)::text AS n FROM claims GROUP BY status"),
      pool.query<{ confirmed_1h: string; confirmed_24h: string; created_1h: string }>(
        `SELECT
           count(*) FILTER (WHERE status='confirmed' AND confirmed_at > now() - interval '1 hour')::text  AS confirmed_1h,
           count(*) FILTER (WHERE status='confirmed' AND confirmed_at > now() - interval '24 hours')::text AS confirmed_24h,
           count(*) FILTER (WHERE created_at   > now() - interval '1 hour')::text                          AS created_1h
         FROM claims`,
      ),
      pool.query<{ depth: string; oldest_age: string | null }>(
        `SELECT count(*)::text AS depth,
                EXTRACT(EPOCH FROM (now() - min(created_at)))::bigint::text AS oldest_age
           FROM claims WHERE status='pending_review' AND approved_at IS NULL`,
      ),
      pool.query<{ depth: string; oldest_age: string | null }>(
        `SELECT count(*)::text AS depth,
                EXTRACT(EPOCH FROM (now() - min(dispatch_started_at)))::bigint::text AS oldest_age
           FROM claims WHERE status='dispatching'`,
      ),
      pool.query<{ status: string; n: string }>("SELECT status, count(*)::text AS n FROM assets GROUP BY status"),
      pool.query<{ dispatched: string; claimed: string; failed: string }>(
        `SELECT
           COALESCE(SUM(c.settlement_amount) FILTER (WHERE c.status='confirmed' AND a.asset_type IN ('token','vault')),0)::text AS dispatched,
           COALESCE(SUM(a.amount)            FILTER (WHERE c.status='confirmed' AND a.asset_type IN ('token','vault')),0)::text AS claimed,
           count(*) FILTER (WHERE c.status='failed')::text AS failed
         FROM claims c JOIN assets a ON a.asset_key = c.asset_key`,
      ),
      pool.query<{
        outstanding_mario: string; claimed_mario: string; outstanding_ants: string; claimed_ants: string;
      }>(
        `SELECT
           COALESCE(SUM(amount) FILTER (WHERE asset_type IN ('token','vault') AND status NOT IN ('claimed','cancelled')),0)::text AS outstanding_mario,
           COALESCE(SUM(amount) FILTER (WHERE asset_type IN ('token','vault') AND status='claimed'),0)::text AS claimed_mario,
           count(*) FILTER (WHERE asset_type='ant' AND status NOT IN ('claimed','cancelled'))::text AS outstanding_ants,
           count(*) FILTER (WHERE asset_type='ant' AND status='claimed')::text AS claimed_ants
         FROM assets`,
      ),
      pool.query<{ head_seq: string | null; unsigned: string }>(
        `SELECT (SELECT max(seq)::text FROM audit_log) AS head_seq,
                (SELECT count(*)::text FROM audit_log WHERE octet_length(signature)=0 OR signature IS NULL) AS unsigned`,
      ),
      pool.query<{ created_at: string | null; age: string | null; confirmed: boolean | null }>(
        `SELECT created_at::text AS created_at,
                EXTRACT(EPOCH FROM (now() - created_at))::bigint::text AS age,
                confirmed
           FROM audit_anchors WHERE kind='audit-head' ORDER BY created_at DESC LIMIT 1`,
      ),
    ]);

  const byStatus: Record<string, number> = {};
  for (const s of CLAIM_STATUSES) byStatus[s] = 0;
  for (const r of claimsByStatus.rows) byStatus[r.status] = Number(r.n);
  const claimTotal = Object.values(byStatus).reduce((a, b) => a + b, 0);

  const assetStatus: Record<string, number> = {};
  for (const r of assetsByStatus.rows) assetStatus[r.status] = Number(r.n);
  const assetTotal = Object.values(assetStatus).reduce((a, b) => a + b, 0);

  const rate = claimRates.rows[0];
  const rv = review.rows[0];
  const dp = dispatching.rows[0];
  const dr = drift.rows[0];
  const lb = liab.rows[0];
  const ad = audit.rows[0];
  const an = anchor.rows[0];

  const dispatched = BigInt(dr.dispatched);
  const claimed = BigInt(dr.claimed);

  return {
    claims: {
      byStatus,
      total: claimTotal,
      confirmed: byStatus.confirmed,
      failed: byStatus.failed,
      rejected: byStatus.rejected,
      dispatching: byStatus.dispatching,
      verified: byStatus.verified,
      pendingReview: byStatus.pending_review,
      confirmedLastHour: Number(rate.confirmed_1h),
      confirmedLast24h: Number(rate.confirmed_24h),
      createdLastHour: Number(rate.created_1h),
      reviewQueueDepth: Number(rv.depth),
      oldestReviewAgeSec: rv.oldest_age === null ? null : Number(rv.oldest_age),
      dispatchingCount: byStatus.dispatching,
      oldestDispatchingAgeSec: dp.oldest_age === null ? null : Number(dp.oldest_age),
    },
    assets: { byStatus: assetStatus, total: assetTotal },
    dispatch: {
      confirmed: byStatus.confirmed,
      failed: Number(dr.failed),
      inFlight: byStatus.dispatching,
      dispatchedTotalMario: dispatched.toString(),
      claimedTotalMario: claimed.toString(),
      driftMario: (dispatched - claimed).toString(),
    },
    liabilities: {
      outstandingMario: lb.outstanding_mario,
      claimedMario: lb.claimed_mario,
      outstandingAnts: Number(lb.outstanding_ants),
      claimedAnts: Number(lb.claimed_ants),
    },
    audit: { headSeq: ad.head_seq, unsignedRows: Number(ad.unsigned) },
    anchors: {
      lastAuditHeadAnchorAt: an?.created_at ?? null,
      lastAuditHeadAnchorAgeSec: an?.age == null ? null : Number(an.age),
      lastAuditHeadAnchorConfirmed: an?.confirmed ?? null,
    },
  };
}

export interface MetricsExtras {
  float?: FloatStatus;
  reserves?: ReservesReport;
}

/** DB metrics + optional chain-derived float/reserves blocks. */
export async function collectMetrics(pool: Pool, extras: MetricsExtras = {}): Promise<MetricsSnapshot> {
  const db = await collectDbMetrics(pool);
  const snapshot: MetricsSnapshot = { generatedAt: new Date().toISOString(), ...db };
  if (extras.float) {
    snapshot.float = {
      balanceMario: extras.float.balanceMario.toString(),
      reservedMario: extras.float.reservedMario.toString(),
      availableMario: extras.float.availableMario.toString(),
      capMario: extras.float.capMario.toString(),
      refillNeeded: extras.float.refillNeeded,
      overCap: extras.float.overCap,
    };
  }
  if (extras.reserves) {
    snapshot.reserves = {
      totalReserveMario: extras.reserves.reserves.totalReserveMario,
      outstandingMario: extras.reserves.liabilities.outstandingMario,
      surplusMario: extras.reserves.coverage.surplusMario,
      tokenVaultCovered: extras.reserves.coverage.tokenVaultCovered,
      antCovered: extras.reserves.coverage.antCovered,
    };
  }
  return snapshot;
}

// ---------------------------------------------------------------------------
// Prometheus text exposition (a scrape-friendly surface alongside the JSON one).
// ---------------------------------------------------------------------------
function line(name: string, value: number | string, labels?: Record<string, string>): string {
  const lbl = labels
    ? "{" + Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(",") + "}"
    : "";
  return `claims_${name}${lbl} ${value}`;
}

/**
 * Render a snapshot as Prometheus exposition text. Money is emitted in whole
 * ARIO (float) — mARIO overflows a float64 at scale; the exact mARIO is in the
 * JSON `/metrics.json` surface for reconciliation.
 */
export function renderPrometheus(s: MetricsSnapshot): string {
  const arioNum = (mario: string): number => Number(BigInt(mario) / 1_000_000n);
  const out: string[] = [];
  out.push("# HELP claims_up 1 when the metrics collector ran.");
  out.push("# TYPE claims_up gauge");
  out.push(line("up", 1));

  out.push("# TYPE claims_by_status gauge");
  for (const [status, n] of Object.entries(s.claims.byStatus)) out.push(line("by_status", n, { status }));

  out.push("# TYPE claims_assets_by_status gauge");
  for (const [status, n] of Object.entries(s.assets.byStatus)) out.push(line("assets_by_status", n, { status }));

  out.push("# TYPE claims_dispatch_total counter");
  out.push(line("dispatch_confirmed_total", s.dispatch.confirmed));
  out.push(line("dispatch_failed_total", s.dispatch.failed));
  out.push(line("dispatch_in_flight", s.dispatch.inFlight));
  out.push(line("dispatch_drift_mario", s.dispatch.driftMario));

  out.push("# TYPE claims_rate gauge");
  out.push(line("confirmed_last_hour", s.claims.confirmedLastHour));
  out.push(line("confirmed_last_24h", s.claims.confirmedLast24h));
  out.push(line("created_last_hour", s.claims.createdLastHour));

  out.push("# TYPE claims_review_queue gauge");
  out.push(line("review_queue_depth", s.claims.reviewQueueDepth));
  out.push(line("review_oldest_age_seconds", s.claims.oldestReviewAgeSec ?? 0));
  out.push(line("dispatching_oldest_age_seconds", s.claims.oldestDispatchingAgeSec ?? 0));

  out.push("# TYPE claims_liabilities gauge");
  out.push(line("outstanding_ario", arioNum(s.liabilities.outstandingMario)));
  out.push(line("outstanding_ants", s.liabilities.outstandingAnts));

  out.push("# TYPE claims_audit gauge");
  out.push(line("audit_head_seq", s.audit.headSeq ?? 0));
  out.push(line("audit_unsigned_rows", s.audit.unsignedRows));
  out.push(line("anchor_age_seconds", s.anchors.lastAuditHeadAnchorAgeSec ?? -1));

  if (s.float) {
    out.push("# TYPE claims_float gauge");
    out.push(line("float_balance_ario", arioNum(s.float.balanceMario)));
    out.push(line("float_available_ario", arioNum(s.float.availableMario)));
    out.push(line("float_cap_ario", arioNum(s.float.capMario)));
    out.push(line("float_refill_needed", s.float.refillNeeded ? 1 : 0));
    out.push(line("float_over_cap", s.float.overCap ? 1 : 0));
  }
  if (s.reserves) {
    out.push("# TYPE claims_reserves gauge");
    out.push(line("reserve_total_ario", arioNum(s.reserves.totalReserveMario)));
    out.push(line("reserve_surplus_ario", Number(BigInt(s.reserves.surplusMario) / 1_000_000n)));
    out.push(line("reserve_token_vault_covered", s.reserves.tokenVaultCovered ? 1 : 0));
  }
  return out.join("\n") + "\n";
}
