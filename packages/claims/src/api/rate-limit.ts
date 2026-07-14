//! In-memory fixed-window rate limiter for the claims API (M3).
//!
//! Mirrors the attestor's `express-rate-limit` posture (per-IP, per-minute
//! cap) but as a dependency-free Fastify-friendly primitive, and adds a
//! second dimension: per-IDENTITY (recipient/source address). A single
//! recipient hammering `initiate`/`complete` from many IPs is throttled by
//! the identity limiter; a single IP fanning across identities is throttled
//! by the IP limiter. Both must pass.
//!
//! Fixed-window (not sliding) is deliberate: O(1) per check, no per-request
//! timestamp arrays, and the burst-at-window-edge weakness is irrelevant at
//! these human-scale claim rates. Bounded memory via lazy GC + a hard cap
//! (FIFO evict), same defense the attestor's anomaly map uses.

export interface RateLimitDecision {
  allowed: boolean;
  /** Milliseconds until the current window resets (for Retry-After). */
  retryAfterMs: number;
  /** Remaining allowance in the current window (>= 0). */
  remaining: number;
}

interface Bucket {
  count: number;
  windowStart: number;
}

export interface RateLimiterOptions {
  windowMs: number;
  limit: number;
  /** Hard cap on tracked keys before FIFO eviction (memory bound). */
  maxKeys?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export class RateLimiter {
  private readonly windowMs: number;
  private readonly limit: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(opts: RateLimiterOptions) {
    this.windowMs = opts.windowMs;
    this.limit = opts.limit;
    this.maxKeys = opts.maxKeys ?? 100_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Record one hit for `key` and decide. A `limit <= 0` disables the limiter
   * (always allowed) so an operator can turn a dimension off via config.
   */
  check(key: string): RateLimitDecision {
    if (this.limit <= 0) {
      return { allowed: true, retryAfterMs: 0, remaining: Number.MAX_SAFE_INTEGER };
    }
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b || t - b.windowStart >= this.windowMs) {
      b = { count: 0, windowStart: t };
      this.buckets.set(key, b);
      this.gc(t);
    }
    b.count += 1;
    const retryAfterMs = this.windowMs - (t - b.windowStart);
    if (b.count > this.limit) {
      return { allowed: false, retryAfterMs, remaining: 0 };
    }
    return { allowed: true, retryAfterMs, remaining: this.limit - b.count };
  }

  /** Test/ops helper: drop all state. */
  reset(): void {
    this.buckets.clear();
  }

  private gc(t: number): void {
    if (this.buckets.size <= this.maxKeys) {
      // Cheap opportunistic expiry only when we're getting large.
      if (this.buckets.size > this.maxKeys / 2) {
        for (const [k, b] of this.buckets) {
          if (t - b.windowStart >= this.windowMs) this.buckets.delete(k);
        }
      }
      return;
    }
    // Still over the cap after expiry — FIFO-evict oldest insertions.
    const overflow = this.buckets.size - this.maxKeys;
    let i = 0;
    for (const k of this.buckets.keys()) {
      if (i++ >= overflow) break;
      this.buckets.delete(k);
    }
  }
}

/** The pair of limiters the API applies to a request. */
export interface RateLimiters {
  ip: RateLimiter;
  identity: RateLimiter;
}

export function createRateLimiters(opts: {
  windowMs: number;
  ipLimit: number;
  identityLimit: number;
  now?: () => number;
}): RateLimiters {
  return {
    ip: new RateLimiter({ windowMs: opts.windowMs, limit: opts.ipLimit, now: opts.now }),
    identity: new RateLimiter({
      windowMs: opts.windowMs,
      limit: opts.identityLimit,
      now: opts.now,
    }),
  };
}
