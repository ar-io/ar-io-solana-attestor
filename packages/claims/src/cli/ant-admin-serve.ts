//! Dedicated admin HTTP server for the operator wallet-signed ANT dispatch flow
//! (ANT_OPERATOR_SIGNING_SPEC.md). Runs SEPARATELY from the public claim API on its
//! OWN port — the admin surface is deliberately kept off the public origin, and the
//! public `app.ts` is NEVER wired with `antAdmin`.
//!
//! It comes alive ONLY when `ANT_DISPATCH_MODE=operator-wallet` (default `cli-cold`
//! => inert: the process logs "disabled" and exits). When enabled it:
//!   * runs WORKER-GRADE boot validation (single-endpoint confirm-RPC is a HARD
//!     error, key separation, treasury signer required, no server-held ANT key),
//!   * loads the sealed TREASURY signer (fee-payer co-sign at build time),
//!   * builds the `AntAdminContext` and serves only the `/v1/admin/ant/*` routes.
//!
//!   ANT_DISPATCH_MODE=operator-wallet ANT_COLD_ADDRESS=... \
//!   DATABASE_URL=... CONFIRM_RPC_URL=<single endpoint> ARIO_MINT=... \
//!   TREASURY_KEY_SEALED_PATH=... TREASURY_KEY_PASSPHRASE=... \
//!   ADMIN_PORT=3050 ADMIN_CORS_ORIGIN=https://admin.internal \
//!     tsx src/cli/ant-admin-serve.ts

import Fastify, { type FastifyInstance } from "fastify";
import { address } from "@solana/kit";

import { loadConfig, type Config } from "../config.js";
import { createDb, type Db } from "../db.js";
import { createRpc } from "../solana.js";
import { SolanaChainGateway } from "../dispatch/chain.js";
import { assertSingleConfirmRpc, loadDispatchConfig, loadSignerRegistry } from "../dispatch/dispatch-config.js";
import { assertBootConfig, BootConfigError } from "../ops/config-validation.js";
import { AntChallengeStore, type AntAdminContext } from "../api/ant-admin.js";
import { registerAntAdminRoutes } from "../api/routes.js";
import { RateLimiter } from "../api/rate-limit.js";

export type AntAdminBoot =
  | { enabled: false; reason: string }
  | { enabled: true; config: Config };

/**
 * Decide whether the ANT admin surface should come up, and FAIL FAST on a misconfig
 * if it should. `cli-cold` (default) => disabled (no validation, inert). Otherwise
 * run worker-grade boot validation — a pooled `CONFIRM_RPC_URL` is a HARD error
 * (submit/confirm/recover rely on single-endpoint reads). Pure over `env` so it's
 * unit-testable without opening a port or a DB.
 */
export function assertAntAdminBoot(env: NodeJS.ProcessEnv = process.env): AntAdminBoot {
  const mode = env.ANT_DISPATCH_MODE ?? "cli-cold";
  if (mode !== "operator-wallet") {
    return { enabled: false, reason: `ANT_DISPATCH_MODE=${mode} (operator-wallet admin dispatch disabled)` };
  }
  // Worker-grade: pooled confirm-RPC => error, key separation, treasury signer
  // required, ANT_COLD_ADDRESS required, no persistent server-held ANT key.
  assertBootConfig(env, { role: "worker" }); // throws BootConfigError on any problem

  // L2 — the admin surface serves a browser origin, so on a REAL network the admin
  // CORS origin MUST be pinned (never unset / "*"), mirroring the public API's
  // CORS_WILDCARD boot check. Kept local to the admin host (the worker doesn't
  // serve admin routes, so it isn't burdened with ADMIN_CORS_ORIGIN).
  const network = env.NETWORK ?? "localnet";
  const adminCors = env.ADMIN_CORS_ORIGIN;
  if (network !== "localnet" && (!adminCors || adminCors === "*")) {
    throw new BootConfigError([{
      level: "error", code: "ADMIN_CORS_WILDCARD",
      message: `ADMIN_CORS_ORIGIN is ${adminCors ? '"*"' : "unset"} with ANT_DISPATCH_MODE=operator-wallet on NETWORK=${network} — the admin origin MUST be pinned to a trusted operator origin (never "*"). Set ADMIN_CORS_ORIGIN.`,
    }]);
  }
  return { enabled: true, config: loadConfig(env) };
}

/**
 * Build the `AntAdminContext` for a running process (loads the sealed treasury
 * signer + a single-endpoint confirm gateway). Returns `undefined` when disabled
 * (cli-cold), so the caller serves nothing.
 */
export async function buildAntAdminContext(db: Db, env: NodeJS.ProcessEnv = process.env): Promise<AntAdminContext | undefined> {
  const boot = assertAntAdminBoot(env);
  if (!boot.enabled) return undefined;
  const config = boot.config;
  if (!config.antColdAddress) throw new Error("ANT_COLD_ADDRESS is required in operator-wallet mode"); // (assertBootConfig already enforced)

  const dispatch = loadDispatchConfig(config, env);
  assertSingleConfirmRpc(dispatch.confirmRpcUrl);
  const gateway = new SolanaChainGateway(createRpc(dispatch.confirmRpcUrl));

  const signers = await loadSignerRegistry(env); // token == treasury (fee payer)
  const treasurySigner = await signers.token.getSigner();
  const treasuryAddress = signers.token.address;
  const antColdAddress = address(config.antColdAddress);
  if (treasuryAddress === antColdAddress) {
    throw new Error("treasury (fee-payer) address must NOT equal ANT_COLD_ADDRESS (separable blast radii)");
  }

  return {
    pool: db.pool,
    gateway,
    treasurySigner,
    treasuryAddress,
    antColdAddress,
    mode: "operator-wallet",
    batchMax: config.antBatchMax ?? 50,
    reservationTtlMs: config.antReservationTtlMs ?? 600_000,
    requireApproval: config.antRequiresApproval ?? false,
    includeMemo: (env.ANT_INCLUDE_MEMO ?? "true") !== "false",
    challengeStore: new AntChallengeStore(),
    log: (msg, extra) => console.log(JSON.stringify({ msg, ...extra })), // eslint-disable-line no-console
    alert: (a) => console.error(JSON.stringify({ msg: "ALERT", ...a })), // eslint-disable-line no-console
  };
}

/**
 * Build the dedicated admin Fastify app (own CORS + a coarse per-IP rate limiter +
 * only the admin routes). `opts.limiter` overrides the default (tests inject a tiny
 * budget); the default is `ADMIN_RATE_LIMIT_PER_MIN` (60/min).
 */
export function buildAntAdminApp(
  config: Config,
  antAdmin: AntAdminContext | undefined,
  opts: { limiter?: RateLimiter } = {},
): FastifyInstance {
  const app = Fastify({ logger: config.logLevel === "silent" ? false : { level: config.logLevel }, trustProxy: config.trustProxy });
  const corsOrigin = process.env.ADMIN_CORS_ORIGIN ?? config.corsOrigin;
  // L3 — coarse per-IP limiter. `GET /challenge` is unauthenticated (it only mints a
  // nonce), so without this a flood churns the nonce store. Applied to the whole
  // /v1/admin/ant/* surface (defense in depth); the writes are also challenge-gated.
  const limiter = opts.limiter ?? new RateLimiter({ windowMs: 60_000, limit: parseInt(process.env.ADMIN_RATE_LIMIT_PER_MIN ?? "60", 10) });

  app.addHook("onRequest", async (req, reply) => {
    reply.header("access-control-allow-origin", corsOrigin);
    reply.header("access-control-allow-methods", "GET,POST,OPTIONS");
    reply.header("access-control-allow-headers", "content-type, authorization, x-ant-read-token");
    if (req.method === "OPTIONS") { reply.code(204).send(); return; }
    // Rate-limit the admin surface per IP (skip the health probe).
    if (req.url.startsWith("/v1/admin/ant/")) {
      const d = limiter.check(`ip:${req.ip}`);
      if (!d.allowed) {
        reply.code(429).send({ error: "RATE_LIMITED", message: `too many requests; retry in ${Math.ceil(d.retryAfterMs / 1000)}s` });
      }
    }
  });
  app.get("/health", async () => ({ ok: true, service: "ar-io-claims-admin" }));
  registerAntAdminRoutes(app, antAdmin);
  return app;
}

async function main(): Promise<void> {
  const boot = assertAntAdminBoot(process.env); // throws on a misconfig in operator-wallet mode
  if (!boot.enabled) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ msg: "ant-admin server not started", reason: boot.reason }));
    return;
  }
  const config = boot.config;
  const db = createDb(config.databaseUrl);
  const antAdmin = await buildAntAdminContext(db, process.env);
  const app = buildAntAdminApp(config, antAdmin);

  const port = parseInt(process.env.ADMIN_PORT ?? "3050", 10);
  const host = process.env.ADMIN_HOST ?? "127.0.0.1"; // bind to loopback/ops net by default
  await app.listen({ port, host });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    msg: "ant-admin server listening",
    port, host,
    antColdAddress: antAdmin?.antColdAddress,
    treasuryAddress: antAdmin?.treasuryAddress,
    confirmRpc: loadDispatchConfig(config).confirmRpcUrl,
  }));

  const shutdown = async (): Promise<void> => { await app.close(); await db.close(); };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

// Only run when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("ant-admin server failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
