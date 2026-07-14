//! Alert evaluation for the claims service (M7 ops hardening).
//!
//! Turns a `MetricsSnapshot` into a list of firing alerts an on-call pipeline can
//! page on. The conditions are exactly the ones the pivot plan §6 calls out plus
//! the operational invariants from the M4/M6 carry-forward:
//!
//!   * float-low                — available hot float below the refill threshold
//!   * float-over-cap           — hot key holds MORE than the cap (operator error)
//!   * reconciliation-mismatch  — Σ dispatched ≠ Σ claimed (drift ≠ 0)
//!   * reserves-shortfall       — on-chain holdings < outstanding liability
//!   * dispatch-failure         — any claim in terminal `failed` (needs an operator)
//!   * anchor-failure           — audit head not anchored within the cadence window
//!   * big-claim-queue-growing  — review queue deep or its oldest item past SLA
//!   * dispatch-stalled         — a claim stuck `dispatching` beyond the stall window
//!   * audit-unsigned-backlog   — audit rows left without an Ed25519 signature
//!
//! Pure + synchronous: takes a snapshot, returns alerts. No I/O, so it unit-tests
//! deterministically and can be reused by the /metrics route, the ops CLI, and a
//! future push-alerter.

import type { MetricsSnapshot } from "./metrics.js";

export type AlertSeverity = "critical" | "warning" | "info";

export interface Alert {
  name: string;
  severity: AlertSeverity;
  message: string;
  /** The observed value that fired the alert (for the page body). */
  value: string | number;
  /** The threshold it crossed, when applicable. */
  threshold?: string | number;
}

export interface AlertThresholds {
  /** Review queue depth that warns (default 25). */
  reviewQueueWarn: number;
  /** Oldest un-approved review item age that warns — the published SLA (default 24h). */
  reviewSlaSeconds: number;
  /** A claim stuck `dispatching` longer than this is a worker stall (default 10 min). */
  dispatchStallSeconds: number;
  /** Anchor cadence: warn when the last audit-head anchor is older than 2× this
   *  (default cadence 24h ⇒ warn > 48h). */
  anchorCadenceSeconds: number;
  /** `failed` claims at/above this count escalate critical (default 1 → any failure). */
  dispatchFailureCritical: number;
}

export const DEFAULT_THRESHOLDS: AlertThresholds = {
  reviewQueueWarn: 25,
  reviewSlaSeconds: 24 * 3600,
  dispatchStallSeconds: 10 * 60,
  anchorCadenceSeconds: 24 * 3600,
  dispatchFailureCritical: 1,
};

export function loadAlertThresholds(env: NodeJS.ProcessEnv = process.env): AlertThresholds {
  const num = (k: string, d: number): number => {
    const v = env[k];
    if (v === undefined) return d;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  return {
    reviewQueueWarn: num("ALERT_REVIEW_QUEUE_WARN", DEFAULT_THRESHOLDS.reviewQueueWarn),
    reviewSlaSeconds: num("ALERT_REVIEW_SLA_SECONDS", DEFAULT_THRESHOLDS.reviewSlaSeconds),
    dispatchStallSeconds: num("ALERT_DISPATCH_STALL_SECONDS", DEFAULT_THRESHOLDS.dispatchStallSeconds),
    anchorCadenceSeconds: num("ALERT_ANCHOR_CADENCE_SECONDS", DEFAULT_THRESHOLDS.anchorCadenceSeconds),
    dispatchFailureCritical: num("ALERT_DISPATCH_FAILURE_CRITICAL", DEFAULT_THRESHOLDS.dispatchFailureCritical),
  };
}

/** Evaluate every alert condition against a snapshot. */
export function evaluateAlerts(s: MetricsSnapshot, t: AlertThresholds = DEFAULT_THRESHOLDS): Alert[] {
  const alerts: Alert[] = [];

  // --- reconciliation-mismatch (CRITICAL) — money conservation broke. ---
  if (s.dispatch.driftMario !== "0") {
    alerts.push({
      name: "reconciliation-mismatch",
      severity: "critical",
      message: `dispatched ≠ claimed: drift ${s.dispatch.driftMario} mARIO (Σ dispatched ${s.dispatch.dispatchedTotalMario} vs Σ claimed ${s.dispatch.claimedTotalMario}). Freeze dispatch + investigate before any further dispense.`,
      value: s.dispatch.driftMario,
      threshold: "0",
    });
  }

  // --- reserves-shortfall (CRITICAL) — holdings < liabilities. ---
  if (s.reserves && !s.reserves.tokenVaultCovered) {
    alerts.push({
      name: "reserves-shortfall",
      severity: "critical",
      message: `on-chain reserves do NOT cover the outstanding liability: surplus ${s.reserves.surplusMario} mARIO (reserve ${s.reserves.totalReserveMario} vs outstanding ${s.reserves.outstandingMario}). Top up from cold immediately.`,
      value: s.reserves.surplusMario,
      threshold: "0",
    });
  }

  // --- dispatch-needs-operator (CRITICAL) — a claim hit the re-sign cap. ---
  // Adversarial item A: a claim frozen `needs_operator` after repeated `expired`
  // classifications with no landed outflow (possible lagging/pooled confirm-RPC).
  // NEVER auto-retried; an operator must verify on-chain before any re-drive.
  const needsOperator = s.claims.byStatus.needs_operator ?? 0;
  if (needsOperator > 0) {
    alerts.push({
      name: "dispatch-needs-operator",
      severity: "critical",
      message: `${needsOperator} claim(s) are frozen 'needs_operator' after exceeding the dispatch re-sign cap — a possible lagging/pooled confirm-RPC. The worker will NOT auto-retry. Verify the dispenser's on-chain outflows before any manual re-drive.`,
      value: needsOperator,
    });
  }

  // --- vault-manual-delivery-queue (WARNING) — item V operator hand-offs. ---
  const manualVault = s.claims.byStatus.awaiting_manual_vault_delivery ?? 0;
  if (manualVault > 0) {
    alerts.push({
      name: "vault-manual-delivery-queue",
      severity: "warning",
      message: `${manualVault} still-locked vault claim(s) await MANUAL delivery — run 'yarn vault:manual-queue' and hand-deliver each with its correct absolute unlock date (or deliver liquid if already unlocked).`,
      value: manualVault,
    });
  }

  // --- dispatch-failure (CRITICAL when at/over the count) — needs an operator. ---
  if (s.dispatch.failed >= t.dispatchFailureCritical) {
    alerts.push({
      name: "dispatch-failure",
      severity: "critical",
      message: `${s.dispatch.failed} claim(s) are in terminal 'failed' — the on-chain tx failed and the asset is held for an operator (never auto-retried). Inspect and re-drive.`,
      value: s.dispatch.failed,
      threshold: t.dispatchFailureCritical,
    });
  }

  // --- float-low (WARNING) — top up the hot float from cold. ---
  if (s.float && s.float.refillNeeded) {
    alerts.push({
      name: "float-low",
      severity: "warning",
      message: `hot float available ${s.float.availableMario} mARIO is below the refill threshold — top up from the cold reserve (4-eyes runbook).`,
      value: s.float.availableMario,
    });
  }

  // --- float-over-cap (WARNING) — hot key holds more than policy allows. ---
  if (s.float && s.float.overCap) {
    alerts.push({
      name: "float-over-cap",
      severity: "warning",
      message: `hot float balance ${s.float.balanceMario} mARIO EXCEEDS the ${s.float.capMario} cap — the hot key must never hold more than the cap. Sweep the excess back to cold.`,
      value: s.float.balanceMario,
      threshold: s.float.capMario,
    });
  }

  // --- big-claim-queue-growing (WARNING) — depth or SLA breach. ---
  if (s.claims.reviewQueueDepth >= t.reviewQueueWarn) {
    alerts.push({
      name: "big-claim-queue-growing",
      severity: "warning",
      message: `${s.claims.reviewQueueDepth} claim(s) awaiting operator review (≥100k brake / ANT approvals). Work the queue.`,
      value: s.claims.reviewQueueDepth,
      threshold: t.reviewQueueWarn,
    });
  }
  if (s.claims.oldestReviewAgeSec !== null && s.claims.oldestReviewAgeSec > t.reviewSlaSeconds) {
    alerts.push({
      name: "big-claim-queue-sla-breach",
      severity: "warning",
      message: `oldest review item is ${s.claims.oldestReviewAgeSec}s old, past the ${t.reviewSlaSeconds}s SLA. Approve/reject it.`,
      value: s.claims.oldestReviewAgeSec,
      threshold: t.reviewSlaSeconds,
    });
  }

  // --- dispatch-stalled (WARNING) — a claim stuck mid-dispatch. ---
  if (s.claims.oldestDispatchingAgeSec !== null && s.claims.oldestDispatchingAgeSec > t.dispatchStallSeconds) {
    alerts.push({
      name: "dispatch-stalled",
      severity: "warning",
      message: `a claim has been 'dispatching' for ${s.claims.oldestDispatchingAgeSec}s (> ${t.dispatchStallSeconds}s). The worker may be down or the confirm-RPC lagging — check the worker + CONFIRM_RPC_URL.`,
      value: s.claims.oldestDispatchingAgeSec,
      threshold: t.dispatchStallSeconds,
    });
  }

  // --- anchor-failure (WARNING) — audit head not anchored in the window. ---
  const anchorWarnAt = t.anchorCadenceSeconds * 2;
  if (s.anchors.lastAuditHeadAnchorAgeSec === null) {
    // Only alert on a missing anchor once there IS an audit log to anchor.
    if (s.audit.headSeq !== null) {
      alerts.push({
        name: "anchor-failure",
        severity: "warning",
        message: `the audit log (head seq ${s.audit.headSeq}) has NEVER been anchored on-chain. Run the audit-anchor CLI.`,
        value: "none",
      });
    }
  } else if (s.anchors.lastAuditHeadAnchorAgeSec > anchorWarnAt) {
    alerts.push({
      name: "anchor-failure",
      severity: "warning",
      message: `last audit-head anchor is ${s.anchors.lastAuditHeadAnchorAgeSec}s old (> ${anchorWarnAt}s = 2× cadence). Anchor cadence has slipped.`,
      value: s.anchors.lastAuditHeadAnchorAgeSec,
      threshold: anchorWarnAt,
    });
  } else if (s.anchors.lastAuditHeadAnchorConfirmed === false) {
    alerts.push({
      name: "anchor-unconfirmed",
      severity: "warning",
      message: "the most recent audit-head anchor tx is not confirmed on-chain — verify it landed.",
      value: "unconfirmed",
    });
  }

  // --- audit-unsigned-backlog (WARNING) — signatures not backfilled. ---
  if (s.audit.unsignedRows > 0) {
    alerts.push({
      name: "audit-unsigned-backlog",
      severity: "warning",
      message: `${s.audit.unsignedRows} audit_log row(s) are unsigned — the sign-on-write hook or backfill isn't running. Third-party verification of those rows fails.`,
      value: s.audit.unsignedRows,
    });
  }

  return alerts;
}

/** The most severe alert level firing (for an exit code / overall status). */
export function worstSeverity(alerts: Alert[]): AlertSeverity | "ok" {
  if (alerts.some((a) => a.severity === "critical")) return "critical";
  if (alerts.some((a) => a.severity === "warning")) return "warning";
  if (alerts.some((a) => a.severity === "info")) return "info";
  return "ok";
}
