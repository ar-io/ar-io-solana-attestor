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

describe("loadConfig — metrics auth token (MEDIUM-4)", () => {
  it("is undefined when unset or empty", () => {
    assert.equal(loadConfig(base).metricsAuthToken, undefined);
    assert.equal(loadConfig({ ...base, METRICS_AUTH_TOKEN: "" }).metricsAuthToken, undefined);
  });
  it("is carried through when set", () => {
    assert.equal(loadConfig({ ...base, METRICS_AUTH_TOKEN: "s3cret" }).metricsAuthToken, "s3cret");
  });
});
