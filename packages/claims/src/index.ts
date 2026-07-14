//! HTTP entry point for the ar-io-claims service.
//!
//! Loads config, wires the Postgres pool and the Solana RPC client, then
//! starts Fastify. Kept thin so the app factory in `app.ts` stays
//! test-injectable.

import { loadConfig } from "./config.js";
import { createDb } from "./db.js";
import { createRpc } from "./solana.js";
import { buildApp } from "./app.js";
import { assertBootConfig } from "./ops/config-validation.js";

async function main(): Promise<void> {
  // Fail FAST on a misconfig before binding a port or touching the DB: single-
  // consistent CONFIRM RPC, the five distinct keys, network sanity, required env.
  // Warnings are printed; errors throw here and abort the boot.
  assertBootConfig(process.env, {
    role: "api",
    // eslint-disable-next-line no-console
    log: (level, code, message) => console[level === "error" ? "error" : "warn"](`[boot ${level}] ${code}: ${message}`),
  });

  const config = loadConfig();
  const db = createDb(config.databaseUrl);

  // Build the RPC client up-front so a misconfigured URL fails fast at
  // boot rather than on the first (future) on-chain read. Not yet used.
  createRpc(config.solanaRpcUrl);

  const app = buildApp({ config, db });

  // Log the effective safety knobs at boot (bigint -> string; pino can't serialize
  // bigint). Makes the whale-brake threshold auditable and surfaces a misconfigured
  // trust-proxy / metrics-auth posture in the boot log (LOW-5, MEDIUM-3/4).
  app.log.info(
    {
      bigClaimThresholdMario: config.bigClaimThresholdMario.toString(),
      trustProxy: String(config.trustProxy ?? false),
      metricsAuth: config.metricsAuthToken
        ? "bearer"
        : config.network === "localnet"
          ? "open(localnet)"
          : "forbidden(no-token)",
    },
    "claims service effective safety config",
  );

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("claims service failed to start:", err);
  process.exit(1);
});
