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

import { timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
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
import {
  getAnchorList,
  getAuditLog,
  getLedgerProof,
  getPublishedLedger,
  getReserves,
} from "./transparency.js";
import { createRpc } from "../solana.js";
import { SolanaChainGateway } from "../dispatch/chain.js";
import { loadTransparencyConfig } from "../transparency/config.js";
import { getMetricsPrometheus, getMetricsResult } from "./metrics.js";
import { verifyAdminChallenge, type AntAdminContext } from "./ant-admin.js";
import {
  buildReservedBatch,
  getAntBatchStatus,
  getAntPending,
  releaseAntBatch,
  reserveAntBatch,
  submitAntBatch,
  type AntBatchStatus,
  type AntSubmitResult,
} from "../dispatch/ant-operator.js";
import type { Network } from "../config.js";
import { makeSlackNotifier } from "../ops/slack.js";
import { composePendingReviewSlackMessage } from "../ops/claim-format.js";

export interface ClaimsRoutesDeps {
  config: Config;
  db: Db;
  limiters: RateLimiters;
  /**
   * Operator wallet-signed ANT dispatch context. Present ONLY in a process that
   * holds the treasury signer (ops/worker). Absent => the /v1/admin/ant/* routes
   * return 503. (The public claim API boots without treasury key material.)
   */
  antAdmin?: AntAdminContext;
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

/** Constant-time string compare (equal-length only; length is not secret here). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Gate the ops `/metrics*` endpoints (they leak float / reserves / liabilities).
 * A real enforced boundary, not a comment (MEDIUM-4):
 *   - `METRICS_AUTH_TOKEN` set  -> require `Authorization: Bearer <token>` (401 otherwise).
 *   - unset + `localnet`        -> allowed (dev convenience).
 *   - unset + any real network  -> 403 (must set a token or bind ops separately).
 */
function enforceMetricsAccess(config: Config, req: FastifyRequest): void {
  const token = config.metricsAuthToken;
  if (token) {
    const auth = req.headers.authorization;
    if (typeof auth !== "string" || !safeEqual(auth, `Bearer ${token}`)) {
      throw new ApiError(401, "UNAUTHORIZED", "metrics require a valid bearer token");
    }
    return;
  }
  if (config.network === "localnet") return;
  throw new ApiError(
    403,
    "METRICS_FORBIDDEN",
    "metrics are ops-only: set METRICS_AUTH_TOKEN (bearer) or expose them on a separate ops listener",
  );
}

export function registerClaimsRoutes(app: FastifyInstance, deps: ClaimsRoutesDeps): void {
  const { config, db, limiters, antAdmin } = deps;
  const pool = db.pool;
  // Opt-in Slack: notify the operator the instant a claim lands in `pending_review`
  // (fully-manual posture needs this — otherwise claims wait unseen). No-op when
  // SLACK_WEBHOOK_URL is unset; fire-and-forget, never blocks/breaks the response.
  const claimSlackNotify = makeSlackNotifier(
    config.slackWebhookUrl,
    // eslint-disable-next-line no-console
    (m, meta) => console.warn(JSON.stringify({ msg: m, meta })),
  );

  // CORS — permissive like the attestor (public claim API). Preflight short-circuit.
  // The admin READ routes carry `x-ant-read-token`; expose it (and `authorization`)
  // in allow-headers on BOTH the normal responses and the OPTIONS preflight, or a
  // cross-origin GET carrying the token is blocked by preflight (B2).
  app.addHook("onRequest", async (req, reply) => {
    reply.header("access-control-allow-origin", config.corsOrigin);
    reply.header("access-control-allow-methods", "GET,POST,OPTIONS");
    reply.header("access-control-allow-headers", "content-type, authorization, x-ant-read-token");
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
      const q = req.query as {
        protocol?: string;
        address?: string;
        recipientId?: string;
        includeClaimed?: string;
        all?: string;
      };
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
      // Decoupled from the response: ping the operator when a claim needs manual
      // approval. Never awaited; the DB read + notifier swallow all errors (a Slack
      // outage / read error can't affect the claim). Only fires on pending_review.
      if (res.status === "pending_review") {
        void (async () => {
          const r = await pool.query<{
            asset_type: string; amount: string | null; ant_name: string | null;
            ant_mint: string | null; claimant: string; protocol: number; source_address: string;
          }>(
            `SELECT a.asset_type, a.amount::text AS amount, a.ant_name, a.ant_mint,
                    c.claimant, rc.protocol, rc.source_address
               FROM claims c
               JOIN assets a ON a.asset_key = c.asset_key
               JOIN recipients rc ON rc.recipient_id = a.recipient_id
              WHERE c.claim_id = $1`,
            [res.claimId],
          );
          const row = r.rows[0];
          if (!row) return;
          claimSlackNotify(
            composePendingReviewSlackMessage({
              claimId: res.claimId,
              assetType: row.asset_type,
              amountMario: row.amount,
              antName: row.ant_name,
              antMint: row.ant_mint,
              claimant: row.claimant,
              protocol: row.protocol,
              sourceAddress: row.source_address,
            }),
          );
        })().catch((err) => app.log.warn({ err }, "pending-review slack notify failed"));
      }
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

  // --- Transparency (M6, §6.5) — public read-only proofs of correct custody. ---
  const tconfig = loadTransparencyConfig();
  // Lazily-built RPC + gateway for the on-chain reserves reads (kit; no web3.js).
  let reservesRpc: ReturnType<typeof createRpc> | undefined;
  let reservesGateway: SolanaChainGateway | undefined;
  const ensureReservesChain = (): { rpc: ReturnType<typeof createRpc>; gateway: SolanaChainGateway } => {
    if (!reservesRpc) reservesRpc = createRpc(config.solanaRpcUrl);
    if (!reservesGateway) reservesGateway = new SolanaChainGateway(reservesRpc);
    return { rpc: reservesRpc, gateway: reservesGateway };
  };

  // GET /v1/transparency/ledger — signed manifest (+leaves when ?full=1; ?id= for a
  // specific historical publish, else the latest).
  app.get("/v1/transparency/ledger", async (req, reply) => {
    try {
      const q = req.query as { full?: string; id?: string };
      reply.send(await getPublishedLedger(pool, { full: q.full === "1" || q.full === "true", id: q.id }));
    } catch (e) {
      sendApiError(reply, e);
    }
  });

  // GET /v1/transparency/ledger/proof?assetKey=[&id=]
  app.get("/v1/transparency/ledger/proof", async (req, reply) => {
    try {
      const q = req.query as { assetKey?: string; id?: string };
      reply.send(await getLedgerProof(pool, q.assetKey ?? "", q.id));
    } catch (e) {
      sendApiError(reply, e);
    }
  });

  // GET /v1/transparency/log?sinceSeq=&limit=
  app.get("/v1/transparency/log", async (req, reply) => {
    try {
      const q = req.query as { sinceSeq?: string; limit?: string };
      reply.send(await getAuditLog(pool, { sinceSeq: q.sinceSeq, limit: q.limit ? parseInt(q.limit, 10) : undefined }));
    } catch (e) {
      sendApiError(reply, e);
    }
  });

  // GET /v1/transparency/anchors?kind=&limit=
  app.get("/v1/transparency/anchors", async (req, reply) => {
    try {
      const q = req.query as { kind?: "audit-head" | "ledger-root"; limit?: string };
      reply.send(await getAnchorList(pool, { kind: q.kind, limit: q.limit ? parseInt(q.limit, 10) : undefined }));
    } catch (e) {
      sendApiError(reply, e);
    }
  });

  // GET /v1/transparency/reserves — live on-chain holdings vs ledger liability.
  app.get("/v1/transparency/reserves", async (_req, reply) => {
    try {
      const { rpc, gateway } = ensureReservesChain();
      reply.send(await getReserves({ pool, gateway, rpc, tconfig, network: config.network }));
    } catch (e) {
      sendApiError(reply, e);
    }
  });

  // --- Ops metrics (M7) — NOT under /v1 (so it's not IP-rate-limited). These
  //     leak float / reserves / liabilities, so access is ENFORCED (bearer token
  //     on real networks), not merely "serve from the ops network" (MEDIUM-4).
  const metricsDeps = { pool, config, tconfig, ensureChain: ensureReservesChain };

  // GET /metrics — Prometheus text exposition.
  app.get("/metrics", async (req, reply) => {
    try {
      enforceMetricsAccess(config, req);
      reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
      reply.send(await getMetricsPrometheus(metricsDeps));
    } catch (e) {
      sendApiError(reply, e);
    }
  });

  // GET /metrics.json — full JSON snapshot + firing alerts + overall level.
  app.get("/metrics.json", async (req, reply) => {
    try {
      enforceMetricsAccess(config, req);
      const { snapshot, alerts, alertLevel } = await getMetricsResult(metricsDeps);
      reply.send({ ...snapshot, alertLevel, alerts });
    } catch (e) {
      sendApiError(reply, e);
    }
  });

  // --- Admin: operator wallet-signed ANT dispatch (ANT_OPERATOR_SIGNING_SPEC).
  //     Gated behind a fresh, single-use challenge nonce signed by the ANT
  //     authority (ANT_COLD_ADDRESS). Only active in a process holding the
  //     treasury signer (antAdmin present) — else 503.
  registerAntAdminRoutes(app, antAdmin);
}

/** Extract the { nonce, sig } challenge from a WRITE route's POST body. Credentials
 *  are NEVER read from the URL query string (they'd leak into logs/history). */
function readChallenge(req: FastifyRequest): { nonce?: string; sig?: string } {
  const body = (req.body ?? {}) as { nonce?: string; sig?: string };
  return { nonce: body.nonce, sig: body.sig };
}

/** The bearer READ token for status polling, from the `x-ant-read-token` header. */
function readReadToken(req: FastifyRequest): string | undefined {
  const h = req.headers["x-ant-read-token"];
  return typeof h === "string" ? h : undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** B4: reject a non-UUID :batchId with a 400 rather than letting the uuid cast 500. */
function assertUuid(batchId: string): string {
  if (typeof batchId !== "string" || !UUID_RE.test(batchId)) {
    throw new ApiError(400, "INVALID_REQUEST", "batchId must be a UUID");
  }
  return batchId;
}

/**
 * Register ONLY the operator wallet-signed ANT admin routes. Exported so the
 * DEDICATED admin server (cli/ant-admin-serve.ts) can serve them on its own port,
 * SEPARATE from the public claim API. Absent `antAdmin` => every route 503s.
 */
/** ANT submit outcomes that count as a landed transfer (for the header tally). */
const ANT_CONFIRMED_OUTCOMES = new Set(["confirmed", "already_confirmed", "recovered_confirmed"]);

/** Abbreviate a long base58 id (mint / asset key) for an operator-readable line. */
function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}

/**
 * Compose the operator-readable Slack message for an ANT batch submission. Pure +
 * total-failure-proof (used only from a fire-and-forget path): a header tally plus
 * one line per claim (ArNS name or short mint, outcome, and — for confirmed ones —
 * an explorer link, `?cluster=devnet` on devnet). Non-confirmed outcomes are flagged.
 */
export function composeAntSubmitSlackMessage(
  batchId: string,
  results: AntSubmitResult[],
  status: AntBatchStatus | null,
  network: Network | undefined,
): { text: string } {
  const confirmedCount = results.filter((r) => ANT_CONFIRMED_OUTCOMES.has(r.outcome)).length;
  const total = results.length;
  const clusterSuffix = network === "solana-devnet" ? "?cluster=devnet" : "";
  const byClaim = new Map<string, { antName: string | null; antMint: string | null }>();
  for (const c of status?.claims ?? []) byClaim.set(c.claimId, { antName: c.antName, antMint: c.antMint });

  const lines = results.map((r) => {
    const meta = r.claimId ? byClaim.get(r.claimId) : undefined;
    const label =
      meta?.antName ||
      (meta?.antMint ? shortId(meta.antMint) : r.assetKey ? shortId(r.assetKey) : "unknown");
    const confirmed = ANT_CONFIRMED_OUTCOMES.has(r.outcome);
    if (confirmed && r.signature) {
      return `• ${label} — ${r.outcome}  https://explorer.solana.com/tx/${r.signature}${clusterSuffix}`;
    }
    const detail = r.detail ? ` (${r.detail})` : "";
    return `• ⚠️ ${label} — ${r.outcome}${detail}`;
  });

  const header = `🅰️ ANT batch ${batchId.slice(0, 8)} submitted — ${confirmedCount}/${total} confirmed`;
  return { text: [header, ...lines].join("\n") };
}

export function registerAntAdminRoutes(app: FastifyInstance, antAdmin?: AntAdminContext): void {
  const requireAdmin = (): AntAdminContext => {
    if (!antAdmin) {
      throw new ApiError(503, "ANT_ADMIN_UNAVAILABLE", "operator ANT dispatch is not configured on this process");
    }
    return antAdmin;
  };
  const requireOperatorMode = (ctx: AntAdminContext): void => {
    if (ctx.mode !== "operator-wallet") {
      throw new ApiError(409, "ANT_MODE_DISABLED", `ANT_DISPATCH_MODE=${ctx.mode}; operator-wallet dispatch is disabled`);
    }
  };
  const requireReadSession = (ctx: AntAdminContext, req: FastifyRequest): void => {
    if (!ctx.challengeStore.verifyReadToken(readReadToken(req))) {
      throw new ApiError(401, "ADMIN_UNAUTHORIZED", "a valid read session token (x-ant-read-token) is required; POST /v1/admin/ant/session with a signed challenge to obtain one");
    }
  };

  // GET /v1/admin/ant/challenge — issue a single-use nonce (no auth needed to GET one).
  app.get("/v1/admin/ant/challenge", async (_req, reply) => {
    try {
      const ctx = requireAdmin();
      reply.send(ctx.challengeStore.issue());
    } catch (e) {
      sendApiError(reply, e);
    }
  });

  // POST /v1/admin/ant/session — exchange ONE signed challenge for a short-lived,
  // read-only bearer token so status polling doesn't prompt the wallet each call.
  app.post("/v1/admin/ant/session", async (req, reply) => {
    try {
      const ctx = requireAdmin();
      await verifyAdminChallenge(ctx.challengeStore, ctx.antColdAddress, readChallenge(req), "session");
      reply.send(ctx.challengeStore.issueReadToken());
    } catch (e) {
      sendApiError(reply, e);
    }
  });

  // POST /v1/admin/ant/batch — RESERVE eligible ANT claims for review (no txs built
  // yet). Returns review items; the operator inspects them, then commits via /build.
  app.post("/v1/admin/ant/batch", async (req, reply) => {
    try {
      const ctx = requireAdmin();
      requireOperatorMode(ctx);
      await verifyAdminChallenge(ctx.challengeStore, ctx.antColdAddress, readChallenge(req), "reserve");
      const body = (req.body ?? {}) as { max?: number };
      const max = Math.min(body.max && body.max > 0 ? body.max : ctx.batchMax, ctx.batchMax);
      const batch = await reserveAntBatch(ctx.pool, {
        antColdAddress: ctx.antColdAddress,
        max,
        reservationTtlMs: ctx.reservationTtlMs,
        requireApproval: ctx.requireApproval,
        log: ctx.log,
      });
      reply.code(201).send(batch);
    } catch (e) {
      sendApiError(reply, e);
    }
  });

  // POST /v1/admin/ant/batch/:batchId/build — build FRESH treasury-cosigned txs for an
  // already-reserved batch, the instant the operator commits to sign (fresh blockhash).
  app.post("/v1/admin/ant/batch/:batchId/build", async (req, reply) => {
    try {
      const ctx = requireAdmin();
      requireOperatorMode(ctx);
      await verifyAdminChallenge(ctx.challengeStore, ctx.antColdAddress, readChallenge(req), "build");
      const batchId = assertUuid((req.params as { batchId: string }).batchId);
      const batch = await buildReservedBatch(ctx.pool, ctx.treasurySigner, ctx.gateway, {
        batchId,
        antColdAddress: ctx.antColdAddress,
        includeMemo: ctx.includeMemo,
        log: ctx.log,
      });
      reply.code(201).send(batch);
    } catch (e) {
      sendApiError(reply, e);
    }
  });

  // POST /v1/admin/ant/batch/:batchId/cancel — explicit operator Cancel: release every
  // not-yet-submitted claim reserved to the batch (immediate, vs the reservation TTL).
  app.post("/v1/admin/ant/batch/:batchId/cancel", async (req, reply) => {
    try {
      const ctx = requireAdmin();
      requireOperatorMode(ctx);
      await verifyAdminChallenge(ctx.challengeStore, ctx.antColdAddress, readChallenge(req), "cancel");
      const batchId = assertUuid((req.params as { batchId: string }).batchId);
      const released = await releaseAntBatch(ctx.pool, batchId);
      reply.send(released);
    } catch (e) {
      sendApiError(reply, e);
    }
  });

  // POST /v1/admin/ant/batch/:batchId/submit — persist+broadcast+confirm signed txs.
  app.post("/v1/admin/ant/batch/:batchId/submit", async (req, reply) => {
    try {
      const ctx = requireAdmin();
      requireOperatorMode(ctx);
      await verifyAdminChallenge(ctx.challengeStore, ctx.antColdAddress, readChallenge(req), "submit");
      const batchId = assertUuid((req.params as { batchId: string }).batchId);
      const body = (req.body ?? {}) as { signedTxs?: unknown };
      if (!Array.isArray(body.signedTxs) || body.signedTxs.some((t) => typeof t !== "string")) {
        throw new ApiError(400, "INVALID_REQUEST", "signedTxs must be an array of base64 strings");
      }
      const results = await submitAntBatch(ctx.pool, ctx.gateway, {
        batchId,
        signedTxs: body.signedTxs as string[],
        antColdAddress: ctx.antColdAddress,
        treasuryAddress: ctx.treasuryAddress,
        log: ctx.log,
        alert: ctx.alert,
      });
      reply.send({ batchId, results });
      // Opt-in Slack notification — fully DECOUPLED from the response and the money
      // path: the reply is already sent, this is never awaited, and both the DB read
      // and the notifier swallow all errors. A Slack outage cannot block/break submit.
      if (ctx.slackNotify) {
        const notify = ctx.slackNotify;
        void (async () => {
          const status = await getAntBatchStatus(ctx.pool, batchId).catch(() => null);
          notify(composeAntSubmitSlackMessage(batchId, results, status, ctx.network));
        })().catch((err) => ctx.log?.("slack submit notify failed", { err }));
      }
    } catch (e) {
      sendApiError(reply, e);
    }
  });

  // GET /v1/admin/ant/batch/:batchId — batch status (per-claim state + signatures).
  // READ route: a short-lived read-session token (not a per-call wallet signature).
  app.get("/v1/admin/ant/batch/:batchId", async (req, reply) => {
    try {
      const ctx = requireAdmin();
      requireReadSession(ctx, req);
      const batchId = assertUuid((req.params as { batchId: string }).batchId);
      const status = await getAntBatchStatus(ctx.pool, batchId);
      if (!status) throw new ApiError(404, "ANT_BATCH_NOT_FOUND", "no such batch");
      reply.send(status);
    } catch (e) {
      sendApiError(reply, e);
    }
  });

  // GET /v1/admin/ant/pending — count/list of ANT claims awaiting dispatch.
  // READ route: a short-lived read-session token (not a per-call wallet signature).
  app.get("/v1/admin/ant/pending", async (req, reply) => {
    try {
      const ctx = requireAdmin();
      requireReadSession(ctx, req);
      reply.send(await getAntPending(ctx.pool, { requireApproval: ctx.requireApproval }));
    } catch (e) {
      sendApiError(reply, e);
    }
  });
}
