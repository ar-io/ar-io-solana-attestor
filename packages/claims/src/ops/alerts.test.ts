//! Alert evaluation — each condition fires on its trigger and is quiet otherwise.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { DEFAULT_THRESHOLDS, evaluateAlerts, loadAlertThresholds, worstSeverity } from "./alerts.js";
import type { MetricsSnapshot } from "./metrics.js";

/** A fully-healthy snapshot; each test perturbs exactly one field. */
function healthy(): MetricsSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    claims: {
      byStatus: { received: 0, verified: 0, pending_review: 0, dispatching: 0, confirmed: 10, rejected: 0, failed: 0 },
      total: 10, confirmed: 10, failed: 0, rejected: 0, dispatching: 0, verified: 0, pendingReview: 0,
      confirmedLastHour: 2, confirmedLast24h: 10, createdLastHour: 3,
      reviewQueueDepth: 0, oldestReviewAgeSec: null, dispatchingCount: 0, oldestDispatchingAgeSec: null,
    },
    assets: { byStatus: { claimed: 10 }, total: 10 },
    dispatch: { confirmed: 10, failed: 0, inFlight: 0, dispatchedTotalMario: "1000", claimedTotalMario: "1000", driftMario: "0" },
    liabilities: { outstandingMario: "500", claimedMario: "1000", outstandingAnts: 3, claimedAnts: 1 },
    audit: { headSeq: "42", unsignedRows: 0 },
    anchors: { lastAuditHeadAnchorAt: new Date().toISOString(), lastAuditHeadAnchorAgeSec: 100, lastAuditHeadAnchorConfirmed: true },
    float: { balanceMario: "300000000000", reservedMario: "0", availableMario: "300000000000", capMario: "500000000000", refillNeeded: false, overCap: false },
    reserves: { totalReserveMario: "1000", outstandingMario: "500", surplusMario: "500", tokenVaultCovered: true, antCovered: "sampled-only" },
  };
}

describe("evaluateAlerts — quiet when healthy", () => {
  it("a healthy snapshot fires NO alerts", () => {
    const alerts = evaluateAlerts(healthy());
    assert.deepEqual(alerts, []);
    assert.equal(worstSeverity(alerts), "ok");
  });
});

describe("evaluateAlerts — each condition fires", () => {
  it("reconciliation-mismatch (critical) on non-zero drift", () => {
    const s = healthy(); s.dispatch.driftMario = "-7";
    const a = evaluateAlerts(s);
    assert.ok(a.some((x) => x.name === "reconciliation-mismatch" && x.severity === "critical"));
    assert.equal(worstSeverity(a), "critical");
  });

  it("reserves-shortfall (critical) when not covered", () => {
    const s = healthy(); s.reserves!.tokenVaultCovered = false; s.reserves!.surplusMario = "-1";
    assert.ok(evaluateAlerts(s).some((x) => x.name === "reserves-shortfall" && x.severity === "critical"));
  });

  it("dispatch-failure (critical) on any failed claim", () => {
    const s = healthy(); s.dispatch.failed = 1;
    assert.ok(evaluateAlerts(s).some((x) => x.name === "dispatch-failure" && x.severity === "critical"));
  });

  it("float-low (warning) when refill needed", () => {
    const s = healthy(); s.float!.refillNeeded = true; s.float!.availableMario = "10";
    const a = evaluateAlerts(s);
    assert.ok(a.some((x) => x.name === "float-low" && x.severity === "warning"));
    assert.equal(worstSeverity(a), "warning");
  });

  it("float-over-cap (warning) when the hot key holds more than the cap", () => {
    const s = healthy(); s.float!.overCap = true; s.float!.balanceMario = "600000000000";
    assert.ok(evaluateAlerts(s).some((x) => x.name === "float-over-cap"));
  });

  it("big-claim-queue-growing (warning) at/over the depth threshold", () => {
    const s = healthy(); s.claims.reviewQueueDepth = DEFAULT_THRESHOLDS.reviewQueueWarn;
    assert.ok(evaluateAlerts(s).some((x) => x.name === "big-claim-queue-growing"));
  });

  it("big-claim-queue-sla-breach (warning) when the oldest item passes the SLA", () => {
    const s = healthy(); s.claims.reviewQueueDepth = 1; s.claims.oldestReviewAgeSec = DEFAULT_THRESHOLDS.reviewSlaSeconds + 1;
    assert.ok(evaluateAlerts(s).some((x) => x.name === "big-claim-queue-sla-breach"));
  });

  it("dispatch-stalled (warning) when a claim is dispatching beyond the stall window", () => {
    const s = healthy(); s.claims.oldestDispatchingAgeSec = DEFAULT_THRESHOLDS.dispatchStallSeconds + 1;
    assert.ok(evaluateAlerts(s).some((x) => x.name === "dispatch-stalled"));
  });

  it("anchor-failure (warning) when the head has never been anchored", () => {
    const s = healthy(); s.anchors = { lastAuditHeadAnchorAt: null, lastAuditHeadAnchorAgeSec: null, lastAuditHeadAnchorConfirmed: null };
    assert.ok(evaluateAlerts(s).some((x) => x.name === "anchor-failure"));
  });

  it("anchor-failure (warning) when the last anchor is older than 2x cadence", () => {
    const s = healthy(); s.anchors.lastAuditHeadAnchorAgeSec = DEFAULT_THRESHOLDS.anchorCadenceSeconds * 2 + 1;
    assert.ok(evaluateAlerts(s).some((x) => x.name === "anchor-failure"));
  });

  it("does NOT alert 'no anchor' when there is no audit log to anchor yet", () => {
    const s = healthy();
    s.audit.headSeq = null;
    s.anchors = { lastAuditHeadAnchorAt: null, lastAuditHeadAnchorAgeSec: null, lastAuditHeadAnchorConfirmed: null };
    assert.equal(evaluateAlerts(s).some((x) => x.name === "anchor-failure"), false);
  });

  it("audit-unsigned-backlog (warning) when rows are unsigned", () => {
    const s = healthy(); s.audit.unsignedRows = 5;
    assert.ok(evaluateAlerts(s).some((x) => x.name === "audit-unsigned-backlog"));
  });

  it("critical outranks warning in worstSeverity", () => {
    const s = healthy(); s.dispatch.driftMario = "1"; s.float!.refillNeeded = true;
    assert.equal(worstSeverity(evaluateAlerts(s)), "critical");
  });

  it("float/reserves alerts are skipped when those blocks are absent (DB-only snapshot)", () => {
    const s = healthy(); delete s.float; delete s.reserves;
    const a = evaluateAlerts(s);
    assert.equal(a.some((x) => x.name.startsWith("float") || x.name === "reserves-shortfall"), false);
  });
});

describe("loadAlertThresholds", () => {
  it("defaults when unset; overrides from env", () => {
    assert.deepEqual(loadAlertThresholds({}), DEFAULT_THRESHOLDS);
    const t = loadAlertThresholds({ ALERT_REVIEW_QUEUE_WARN: "3", ALERT_DISPATCH_STALL_SECONDS: "42" });
    assert.equal(t.reviewQueueWarn, 3);
    assert.equal(t.dispatchStallSeconds, 42);
  });
  it("ignores a garbage override (keeps the default)", () => {
    const t = loadAlertThresholds({ ALERT_REVIEW_QUEUE_WARN: "not-a-number" });
    assert.equal(t.reviewQueueWarn, DEFAULT_THRESHOLDS.reviewQueueWarn);
  });
});
