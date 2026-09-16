//! The monitoring cadence that decoupled the ops balance reads from the
//! dispatch poll.
//!
//! Context: the worker loop polls every `pollIntervalMs` (5s by default) so a
//! queued claim is picked up promptly. Two RPC reads used to ride on every one
//! of those ticks — the hot-float token balance and the dispenser's SOL
//! balance — which on an idle worker was the ONLY RPC it made: ~34,500 calls a
//! day to watch numbers that move slowly.
//!
//! Those reads do not gate dispatch. The money path reads the live hot balance
//! itself immediately before deciding (see worker.ts `getTokenBalance` +
//! `float.check`), so a stale monitoring reading cannot let a dispatch exceed
//! the float. Throttling costs alert latency and nothing else.
//!
//! Pure — no DB, no network, no clock.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { loadDispatchConfig, shouldMonitor } from "./dispatch-config.js";

// `loadDispatchConfig(base, env)` takes the app config plus an env bag; the
// env is what carries the cadence knobs.
const appConfig = loadConfig({ NETWORK: "localnet" } as NodeJS.ProcessEnv);
const base = {
  ARIO_MINT: "11111111111111111111111111111111",
} as NodeJS.ProcessEnv;

describe("loadDispatchConfig — monitorIntervalMs", () => {
  it("defaults to 60s, not the 5s dispatch poll", () => {
    const c = loadDispatchConfig(appConfig, { ...base });
    assert.equal(c.pollIntervalMs, 5000, "dispatch stays responsive");
    assert.equal(c.monitorIntervalMs, 60_000, "monitoring does not");
  });

  it("is overridable", () => {
    const c = loadDispatchConfig(appConfig, {
      ...base,
      DISPATCH_MONITOR_INTERVAL_MS: "300000",
    });
    assert.equal(c.monitorIntervalMs, 300_000);
  });

  it("never drops below the poll interval", () => {
    // A monitor cadence faster than the loop that runs it is just the old
    // every-tick behaviour with extra arithmetic.
    const c = loadDispatchConfig(appConfig, {
      ...base,
      DISPATCH_POLL_INTERVAL_MS: "30000",
      DISPATCH_MONITOR_INTERVAL_MS: "1000",
    });
    assert.equal(c.monitorIntervalMs, 30_000);
  });

  it("a slower poll than the default monitor interval wins", () => {
    const c = loadDispatchConfig(appConfig, {
      ...base,
      DISPATCH_POLL_INTERVAL_MS: "120000",
    });
    assert.equal(c.monitorIntervalMs, 120_000);
  });
});

describe("shouldMonitor", () => {
  it("always fires on the worker's first tick", () => {
    // The worker seeds lastMonitorAt with -Infinity precisely so a process
    // starting into a low float alerts now, not one interval from now.
    assert.equal(shouldMonitor(0, Number.NEGATIVE_INFINITY, 60_000), true);
    assert.equal(shouldMonitor(1e12, Number.NEGATIVE_INFINITY, 60_000), true);
  });

  it("suppresses ticks inside the interval", () => {
    assert.equal(shouldMonitor(1_000, 0, 60_000), false);
    assert.equal(shouldMonitor(59_999, 0, 60_000), false);
  });

  it("fires exactly at the boundary and after", () => {
    assert.equal(shouldMonitor(60_000, 0, 60_000), true);
    assert.equal(shouldMonitor(60_001, 0, 60_000), true);
  });

  it("always fires in --once mode, whatever the clock says", () => {
    // A single-shot run exists to report; skipping its read would make
    // `dispatch-worker --once` silently useless.
    assert.equal(shouldMonitor(1, 0, 60_000, true), true);
  });

  it("does not wedge if the clock jumps backwards", () => {
    // NTP step or a suspended VM. A negative delta must not park monitoring
    // forever; the next forward tick past the interval resumes it.
    assert.equal(shouldMonitor(0, 10_000, 60_000), false);
    assert.equal(shouldMonitor(70_001, 10_000, 60_000), true);
  });

  it("monitors every tick when the two cadences are equal", () => {
    // What an operator gets by setting the monitor interval to the poll
    // interval: the old behaviour, deliberately.
    assert.equal(shouldMonitor(5_000, 0, 5_000), true);
  });
});
