//! Ops metrics + alert check (M7). One-shot: prints the current metrics snapshot
//! and any firing alerts as structured JSON (pino-compatible), and EXITS NON-ZERO
//! when a critical alert is firing — so a cron / monitoring hook can page on it.
//!
//!   DATABASE_URL=... [ARIO_MINT=... TREASURY_ADDRESS=... SOLANA_RPC_URL=...] \
//!   tsx src/cli/ops-metrics.ts [--prometheus]
//!
//! With ARIO_MINT + TREASURY_ADDRESS set it also folds in the live float +
//! reserves gauges; without them it reports DB-derived metrics only.

import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { createRpc } from "../solana.js";
import { SolanaChainGateway } from "../dispatch/chain.js";
import { loadTransparencyConfig } from "../transparency/config.js";
import { getMetricsPrometheus, getMetricsResult, type MetricsDeps } from "../api/metrics.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const tconfig = loadTransparencyConfig();

  let rpc: ReturnType<typeof createRpc> | undefined;
  let gateway: SolanaChainGateway | undefined;
  const ensureChain = (): { rpc: ReturnType<typeof createRpc>; gateway: SolanaChainGateway } => {
    if (!rpc) rpc = createRpc(config.solanaRpcUrl);
    if (!gateway) gateway = new SolanaChainGateway(rpc);
    return { rpc, gateway };
  };
  const deps: MetricsDeps = { pool: db.pool, config, tconfig, ensureChain };

  try {
    if (process.argv.includes("--prometheus")) {
      // eslint-disable-next-line no-console
      console.log(await getMetricsPrometheus(deps));
      return;
    }
    const { snapshot, alerts, alertLevel } = await getMetricsResult(deps);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ msg: "metrics", alertLevel, alerts, snapshot }, null, 2));
    for (const a of alerts) {
      const line = JSON.stringify({ msg: "ALERT", alert: a.name, severity: a.severity, value: a.value, threshold: a.threshold, detail: a.message });
      // eslint-disable-next-line no-console
      if (a.severity === "critical") console.error(line);
      else console.warn(line);
    }
    if (alertLevel === "critical") process.exitCode = 2;
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("ops-metrics failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
