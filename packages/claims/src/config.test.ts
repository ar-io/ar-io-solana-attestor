//! Unit tests for config parsing: the whale-brake floor (LOW-5) and the
//! trust-proxy posture (MEDIUM-3). Pure — no DB / network.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { loadConfig, parseTrustProxy } from "./config.js";

const base: NodeJS.ProcessEnv = { NETWORK: "localnet" };

describe("loadConfig — big-claim brake floor (LOW-5)", () => {
  it("rejects BIG_CLAIM_THRESHOLD_MARIO=0 (would disable the whale brake)", () => {
    assert.throws(
      () => loadConfig({ ...base, BIG_CLAIM_THRESHOLD_MARIO: "0" }),
      /must be a positive integer/i,
    );
  });

  it("rejects a negative threshold", () => {
    assert.throws(() => loadConfig({ ...base, BIG_CLAIM_THRESHOLD_MARIO: "-1" }), /positive integer/i);
  });

  it("accepts 1 (route everything to manual review)", () => {
    assert.equal(loadConfig({ ...base, BIG_CLAIM_THRESHOLD_MARIO: "1" }).bigClaimThresholdMario, 1n);
  });

  it("defaults to 100k ARIO", () => {
    assert.equal(loadConfig(base).bigClaimThresholdMario, 100_000_000_000n);
  });
});

describe("parseTrustProxy (MEDIUM-3)", () => {
  it("defaults to false (do not trust XFF)", () => {
    assert.equal(parseTrustProxy(undefined), false);
    assert.equal(parseTrustProxy(""), false);
    assert.equal(parseTrustProxy("false"), false);
    assert.equal(parseTrustProxy("0"), false);
  });

  it("parses a hop count", () => {
    assert.equal(parseTrustProxy("2"), 2);
  });

  it("passes through an IP / CIDR / keyword", () => {
    assert.equal(parseTrustProxy("loopback"), "loopback");
    assert.equal(parseTrustProxy("10.0.0.1/8"), "10.0.0.1/8");
    assert.equal(parseTrustProxy("10.0.0.1, 192.168.0.0/16"), "10.0.0.1, 192.168.0.0/16");
  });

  it("honors an explicit blanket true (discouraged but allowed)", () => {
    assert.equal(parseTrustProxy("true"), true);
  });
});

describe("loadConfig — ANT operator dispatch settings", () => {
  it("defaults: cli-cold mode, approval off, batch max 50, ttl 10 min", () => {
    const c = loadConfig(base);
    assert.equal(c.antDispatchMode, "cli-cold");
    assert.equal(c.antRequiresApproval, false);
    assert.equal(c.antBatchMax, 50);
    assert.equal(c.antReservationTtlMs, 600000);
    assert.equal(c.antColdAddress, undefined);
  });
  it("parses operator-wallet mode + overrides", () => {
    const c = loadConfig({ ...base, ANT_DISPATCH_MODE: "operator-wallet", ANT_REQUIRES_APPROVAL: "true", ANT_BATCH_MAX: "25", ANT_RESERVATION_TTL_MS: "1000", ANT_COLD_ADDRESS: "AntCoLdAddr1111111111111111111111111111111" });
    assert.equal(c.antDispatchMode, "operator-wallet");
    assert.equal(c.antRequiresApproval, true);
    assert.equal(c.antBatchMax, 25);
    assert.equal(c.antReservationTtlMs, 1000);
    assert.equal(c.antColdAddress, "AntCoLdAddr1111111111111111111111111111111");
  });
  it("rejects an invalid mode / non-positive batch max / ttl", () => {
    assert.throws(() => loadConfig({ ...base, ANT_DISPATCH_MODE: "nope" }), /ANT_DISPATCH_MODE/);
    assert.throws(() => loadConfig({ ...base, ANT_BATCH_MAX: "0" }), /ANT_BATCH_MAX/);
    assert.throws(() => loadConfig({ ...base, ANT_RESERVATION_TTL_MS: "-1" }), /ANT_RESERVATION_TTL_MS/);
  });
});

describe("loadConfig — metrics auth token (MEDIUM-4)", () => {
  it("is undefined when unset or empty", () => {
    assert.equal(loadConfig(base).metricsAuthToken, undefined);
    assert.equal(loadConfig({ ...base, METRICS_AUTH_TOKEN: "" }).metricsAuthToken, undefined);
  });
  it("is carried through when set", () => {
    assert.equal(loadConfig({ ...base, METRICS_AUTH_TOKEN: "s3cret" }).metricsAuthToken, "s3cret");
  });
});
