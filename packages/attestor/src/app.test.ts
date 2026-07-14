import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import bs58 from "bs58";

// `./app.js` reads the attestor config at module-init time. Populate the
// required envs here so the import doesn't throw — same pattern as
// integration.test.ts. The values are irrelevant to checkAnomaly itself.
process.env.ATTESTOR_SECRET_BASE58 ??= bs58.encode(randomBytes(32));
process.env.NETWORK ??= "localnet";
process.env.LOG_LEVEL ??= "silent";

const {
  _checkAnomalyForTest: checkAnomaly,
  _anomalyByKeyForTest: anomalyByKey,
  _ANOMALY_THRESHOLD_FOR_TEST: ANOMALY_THRESHOLD,
  _ANOMALY_GC_THRESHOLD_FOR_TEST: ANOMALY_GC_THRESHOLD,
  _ANOMALY_MAX_ENTRIES_FOR_TEST: ANOMALY_MAX_ENTRIES,
} = await import("./app.js");

describe("checkAnomaly", () => {
  beforeEach(() => {
    // The map is process-global; each test must start clean.
    anomalyByKey.clear();
  });

  it("returns false for a first hit and records the entry", () => {
    const result = checkAnomaly("arweave-addr-1", "escrow-1");
    assert.equal(result, false);
    assert.equal(anomalyByKey.size, 1);
  });

  it("counts repeated hits for the same tuple and trips at the threshold", () => {
    // Hits 1..(THRESHOLD-1) must return false; the THRESHOLD-th hit trips.
    let tripped = false;
    for (let i = 0; i < ANOMALY_THRESHOLD; i++) {
      tripped = checkAnomaly("addr", "escrow");
    }
    assert.equal(tripped, true);
    // Subsequent hits still trip.
    assert.equal(checkAnomaly("addr", "escrow"), true);
    assert.equal(anomalyByKey.size, 1);
  });

  it("treats different (arweave, escrow) tuples as independent", () => {
    for (let i = 0; i < ANOMALY_THRESHOLD; i++) {
      checkAnomaly("addr-A", "escrow-A");
    }
    // A different escrow on the same address must NOT inherit the trip
    // state — they are independent buckets.
    assert.equal(checkAnomaly("addr-A", "escrow-B"), false);
    // Different address, same escrow: also independent.
    assert.equal(checkAnomaly("addr-B", "escrow-A"), false);
  });

  // ===========================================================
  // Codex finding (regression guard): unique-key streams must NOT
  // grow the map unbounded. The pre-fix `checkAnomaly` only ran GC
  // on the "existing non-expired key" branch and returned `false`
  // before that branch for every new or expired key — exactly the
  // path an attacker takes by varying `assetIdHex` / `antMintBase58`
  // per request. The map grew indefinitely → Node heap OOM →
  // attestor offline. The hardened version runs GC + a FIFO hard
  // cap before the insert paths.
  // ===========================================================
  it("bounds the map size under a unique-key flood (Codex DoS)", () => {
    // Send ~1.2× the hard cap of unique requests. The GC walks the map
    // on every call once over ANOMALY_GC_THRESHOLD, so the constant
    // factor is high — keep the iteration count modest. The bug
    // pre-fix would have left `size == target`; the fix bounds it.
    const target = Math.floor(ANOMALY_MAX_ENTRIES * 1.2);
    for (let i = 0; i < target; i++) {
      checkAnomaly(`addr-${i}`, `escrow-${i}`);
    }
    assert.ok(
      anomalyByKey.size <= ANOMALY_MAX_ENTRIES,
      `map grew unbounded: size=${anomalyByKey.size}, cap=${ANOMALY_MAX_ENTRIES}`,
    );
    // Sanity: the configured cap actually exceeds the GC threshold,
    // otherwise the cap is unreachable and this test is a tautology.
    assert.ok(ANOMALY_MAX_ENTRIES >= ANOMALY_GC_THRESHOLD);
  });

  it("evicts oldest entries FIFO when expiry-based GC can't reclaim enough", () => {
    // Every entry in this loop is "fresh" (well under the 60s window),
    // so expiry-based GC alone would reclaim nothing. The hard-cap
    // FIFO path is what must keep the map bounded. Send just enough
    // beyond the cap to force a small handful of evictions.
    const target = ANOMALY_MAX_ENTRIES + 100;
    for (let i = 0; i < target; i++) {
      checkAnomaly(`addr-${i}`, `escrow-${i}`);
    }
    assert.ok(
      anomalyByKey.size <= ANOMALY_MAX_ENTRIES,
      `hard cap breached: size=${anomalyByKey.size}, cap=${ANOMALY_MAX_ENTRIES}`,
    );
    // The earliest keys MUST be the ones evicted (FIFO).
    assert.equal(anomalyByKey.has("addr-0:escrow-0"), false);
    // The latest key MUST still be present.
    assert.equal(
      anomalyByKey.has(`addr-${target - 1}:escrow-${target - 1}`),
      true,
    );
  });
});
