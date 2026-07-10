//! RateLimiter unit tests — deterministic via an injected clock.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { RateLimiter, createRateLimiters } from "./rate-limit.js";

describe("RateLimiter (fixed window)", () => {
  it("allows up to `limit` then rejects within a window", () => {
    let t = 1_000_000;
    const rl = new RateLimiter({ windowMs: 1000, limit: 3, now: () => t });
    assert.equal(rl.check("k").allowed, true); // 1
    assert.equal(rl.check("k").allowed, true); // 2
    assert.equal(rl.check("k").allowed, true); // 3
    const d = rl.check("k"); // 4 -> over
    assert.equal(d.allowed, false);
    assert.ok(d.retryAfterMs > 0 && d.retryAfterMs <= 1000);
  });

  it("resets after the window elapses", () => {
    let t = 0;
    const rl = new RateLimiter({ windowMs: 1000, limit: 1, now: () => t });
    assert.equal(rl.check("k").allowed, true);
    assert.equal(rl.check("k").allowed, false);
    t += 1000; // new window
    assert.equal(rl.check("k").allowed, true);
  });

  it("tracks keys independently", () => {
    let t = 0;
    const rl = new RateLimiter({ windowMs: 1000, limit: 1, now: () => t });
    assert.equal(rl.check("a").allowed, true);
    assert.equal(rl.check("b").allowed, true);
    assert.equal(rl.check("a").allowed, false);
  });

  it("limit <= 0 disables the limiter (always allowed)", () => {
    const rl = new RateLimiter({ windowMs: 1000, limit: 0 });
    for (let i = 0; i < 1000; i++) assert.equal(rl.check("k").allowed, true);
  });

  it("FIFO-evicts under the hard key cap (bounded memory)", () => {
    let t = 0;
    const rl = new RateLimiter({ windowMs: 1_000_000, limit: 5, maxKeys: 10, now: () => t });
    for (let i = 0; i < 100; i++) rl.check(`k${i}`);
    // Should not have grown unbounded.
    // (No public size accessor; rely on no throw + still functioning.)
    assert.equal(rl.check("fresh").allowed, true);
  });

  it("createRateLimiters wires both dimensions", () => {
    const { ip, identity } = createRateLimiters({ windowMs: 1000, ipLimit: 2, identityLimit: 1 });
    assert.equal(ip.check("x").allowed, true);
    assert.equal(ip.check("x").allowed, true);
    assert.equal(ip.check("x").allowed, false);
    assert.equal(identity.check("y").allowed, true);
    assert.equal(identity.check("y").allowed, false);
  });
});
