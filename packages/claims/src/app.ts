//! Fastify application factory for the claims service.
//!
//! Separated from index.ts so tests can build the app and use
//! `app.inject()` without binding a port. M0 exposes liveness/readiness
//! only — the `/v1/*` claim surface (pivot plan §4.1) is added in
//! M1-M5.

import Fastify, { type FastifyInstance } from "fastify";

import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { registerClaimsRoutes } from "./api/routes.js";
import { createRateLimiters, type RateLimiters } from "./api/rate-limit.js";

export interface BuildAppOptions {
  config: Config;
  /** Optional DB handle; when present, /health/ready round-trips it AND the
   *  /v1 claim surface (initiate/complete/lookup) is mounted. */
  db?: Db;
  /** Optional pre-built limiters (tests inject a fixed clock / tiny limits). */
  limiters?: RateLimiters;
}

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const { config, db } = opts;

  const app = Fastify({
    logger:
      config.logLevel === "silent"
        ? false
        : { level: config.logLevel },
    // Trust the reverse proxy (same posture as the attestor) so client
    // IPs / rate-limit keys are correct behind a load balancer.
    trustProxy: true,
  });

  // GET /health — liveness. ALWAYS 200 while the process is up, so an
  // orchestrator restarts the container only on a hard crash, not on a
  // transient DB blip. Readiness (below) is the DB-aware signal.
  app.get("/health", async () => {
    return {
      ok: true,
      service: "ar-io-claims",
      network: config.network,
    };
  });

  // GET /health/ready — readiness. 200 only when dependencies (Postgres)
  // are reachable; 503 otherwise. Load balancers gate traffic on this.
  app.get("/health/ready", async (_req, reply) => {
    if (!db) {
      // No DB wired (e.g. a bare unit test) — report ready so the
      // endpoint is still exercisable.
      return { ready: true, db: "not-configured" };
    }
    try {
      await db.ping();
      return { ready: true, db: "up" };
    } catch (err) {
      reply.code(503);
      return { ready: false, db: "down", detail: (err as Error).message };
    }
  });

  // Mount the /v1 claim surface only when a DB is wired (it is persistence-
  // backed). Bare unit tests that pass no `db` still get /health.
  if (db) {
    const limiters =
      opts.limiters ??
      createRateLimiters({
        windowMs: 60_000,
        ipLimit: config.rateLimitPerMin,
        identityLimit: config.rateLimitIdentityPerMin,
      });
    registerClaimsRoutes(app, { config, db, limiters });
  }

  return app;
}
