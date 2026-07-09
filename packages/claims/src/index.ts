//! HTTP entry point for the ar-io-claims service.
//!
//! Loads config, wires the Postgres pool and the Solana RPC client, then
//! starts Fastify. Kept thin so the app factory in `app.ts` stays
//! test-injectable.

import { loadConfig } from "./config.js";
import { createDb } from "./db.js";
import { createRpc } from "./solana.js";
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);

  // Build the RPC client up-front so a misconfigured URL fails fast at
  // boot rather than on the first (future) on-chain read. Not yet used.
  createRpc(config.solanaRpcUrl);

  const app = buildApp({ config, db });

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
