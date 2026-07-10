//! Fastify route wiring for the claims API (pivot plan §4.1).
//!
//! Endpoints:
//!   GET  /v1/claimable?protocol=&address=  | ?recipientId=   — lookup (read-only)
//!   GET  /v1/assets/:assetKey                                — single asset
//!   POST /v1/claims/initiate                                 — issue challenge
//!   POST /v1/claims/complete                                 — verify + consume
//!   GET  /v1/claims/:claimId                                 — claim status
//!
//! Cross-cutting: per-IP rate limit (all /v1) + a per-identity rate limit on the
//! identity-bearing routes, CORS (attestor-compatible), and uniform ApiError ->
//! HTTP mapping. The business logic + concurrency defense live in `service.ts`;
//! this module is transport only.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { ApiError, toApiError } from "./errors.js";
import type { RateLimiters } from "./rate-limit.js";
import {
  completeClaim,
  getAsset,
  getClaim,
  getClaimable,
  initiateClaim,
  type CompleteInput,
  type InitiateInput,
} from "./service.js";

export interface ClaimsRoutesDeps {
  config: Config;
  db: Db;
  limiters: RateLimiters;
}

function sendApiError(reply: FastifyReply, e: unknown): void {
  const api = toApiError(e);
  if (api.status >= 500) {
    reply.log.error({ err: e }, "claims api internal error");
  }
  reply.code(api.status).send({ error: api.code, message: api.message });
}

/** Enforce the per-IP limit; throws ApiError(429) when exceeded. */
function enforceIp(limiters: RateLimiters, req: FastifyRequest): void {
  const d = limiters.ip.check(`ip:${req.ip}`);
  if (!d.allowed) {
    throw new ApiError(429, "RATE_LIMITED", `too many requests; retry in ${Math.ceil(d.retryAfterMs / 1000)}s`);
  }
}
/** Enforce the per-identity limit; throws ApiError(429) when exceeded. */
function enforceIdentity(limiters: RateLimiters, key: string): void {
  const d = limiters.identity.check(`id:${key}`);
  if (!d.allowed) {
    throw new ApiError(429, "RATE_LIMITED", `too many requests for this identity; retry in ${Math.ceil(d.retryAfterMs / 1000)}s`);
  }
}

export function registerClaimsRoutes(app: FastifyInstance, deps: ClaimsRoutesDeps): void {
  const { config, db, limiters } = deps;
  const pool = db.pool;

  // CORS — permissive like the attestor (public claim API). Preflight short-circuit.
  app.addHook("onRequest", async (req, reply) => {
    reply.header("access-control-allow-origin", config.corsOrigin);
    reply.header("access-control-allow-methods", "GET,POST,OPTIONS");
    reply.header("access-control-allow-headers", "content-type");
    if (req.method === "OPTIONS") {
      reply.code(204).send();
    }
  });

  // Per-IP rate limit on the whole /v1 surface.
  app.addHook("onRequest", async (req) => {
    if (req.url.startsWith("/v1/")) enforceIp(limiters, req);
  });

  // GET /v1/claimable
  app.get("/v1/claimable", async (req, reply) => {
    try {
      const q = req.query as { protocol?: string; address?: string; recipientId?: string };
      enforceIdentity(limiters, q.recipientId || q.address || "unknown");
      const res = await getClaimable(pool, q);
      reply.send(res);
    } catch (e) {
      sendApiError(reply, e);
    }
  });

  // GET /v1/assets/:assetKey
  app.get("/v1/assets/:assetKey", async (req, reply) => {
    try {
      const { assetKey } = req.params as { assetKey: string };
      const res = await getAsset(pool, assetKey);
      reply.send(res);
    } catch (e) {
      sendApiError(reply, e);
    }
  });

  // POST /v1/claims/initiate
  app.post("/v1/claims/initiate", async (req, reply) => {
    try {
      const body = (req.body ?? {}) as InitiateInput;
      enforceIdentity(limiters, `asset:${body.assetKey ?? "none"}`);
      const res = await initiateClaim(pool, config, body);
      reply.code(201).send(res);
    } catch (e) {
      sendApiError(reply, e);
    }
  });

  // POST /v1/claims/complete
  app.post("/v1/claims/complete", async (req, reply) => {
    try {
      const body = (req.body ?? {}) as CompleteInput;
      enforceIdentity(limiters, `claimant:${body.claimant ?? "none"}`);
      const res = await completeClaim(pool, config, body);
      // 202 Accepted: verified + queued for M4 dispatch (or pending_review).
      reply.code(202).send(res);
    } catch (e) {
      sendApiError(reply, e);
    }
  });

  // GET /v1/claims/:claimId
  app.get("/v1/claims/:claimId", async (req, reply) => {
    try {
      const { claimId } = req.params as { claimId: string };
      const res = await getClaim(pool, claimId);
      reply.send(res);
    } catch (e) {
      sendApiError(reply, e);
    }
  });
}
