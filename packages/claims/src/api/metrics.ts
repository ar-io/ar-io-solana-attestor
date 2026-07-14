//! Metrics HTTP handlers (M7 ops hardening).
//!
//!   GET /metrics       — Prometheus text exposition (scrape-friendly)
//!   GET /metrics.json  — the full JSON snapshot + firing alerts + overall level
//!
//! DB-derived metrics always return; the float + reserves blocks are folded in
//! only when TREASURY_ADDRESS + ARIO_MINT are configured and the chain is
//! reachable (a chain blip never fails the endpoint — DB metrics still serve).
//! These surfaces expose only PUBLIC aggregate data; scrape them from the ops
//! network / behind the reverse proxy, not the public claim listener.

import type { Pool } from "pg";
import type { Rpc, SolanaRpcApi } from "@solana/kit";

import type { Config } from "../config.js";
import type { ChainGateway } from "../dispatch/chain.js";
import { FloatManager } from "../dispatch/float.js";
import { floatPolicyFromEnv } from "../dispatch/dispatch-config.js";
import { getAssociatedTokenAddress } from "../dispatch/instructions.js";
import { computeReserves } from "../transparency/reserves.js";
import type { TransparencyConfig } from "../transparency/config.js";
import {
  collectMetrics,
  renderPrometheus,
  type MetricsExtras,
  type MetricsSnapshot,
} from "../ops/metrics.js";
import { evaluateAlerts, loadAlertThresholds, worstSeverity, type Alert } from "../ops/alerts.js";

export interface MetricsDeps {
  pool: Pool;
  config: Config;
  tconfig: TransparencyConfig;
  /** Lazily builds the kit RPC + gateway for the (optional) chain reads. */
  ensureChain: () => { rpc: Rpc<SolanaRpcApi>; gateway: ChainGateway };
}

/** Optional chain-read blocks (float + reserves); {} when not configured/reachable. */
async function chainExtras(deps: MetricsDeps): Promise<MetricsExtras> {
  const { pool, config, tconfig } = deps;
  if (!tconfig.mint || !tconfig.hotDispenser) return {};
  const extras: MetricsExtras = {};
  try {
    const { rpc, gateway } = deps.ensureChain();
    const fm = new FloatManager(floatPolicyFromEnv(config.bigClaimThresholdMario));
    const hotAta = await getAssociatedTokenAddress(tconfig.hotDispenser, tconfig.mint);
    extras.float = await fm.status(pool, gateway, hotAta);
    extras.reserves = await computeReserves({
      pool,
      gateway,
      rpc,
      network: config.network,
      mint: tconfig.mint,
      hotDispenser: tconfig.hotDispenser,
      coldReserve: tconfig.coldReserve,
      antAuthority: tconfig.antAuthority,
      antCheck: tconfig.antCheck,
    });
  } catch {
    // Chain unreachable / reserves misconfig — DB metrics still serve.
  }
  return extras;
}

export interface MetricsResult {
  snapshot: MetricsSnapshot;
  alerts: Alert[];
  alertLevel: ReturnType<typeof worstSeverity>;
}

export async function getMetricsResult(deps: MetricsDeps): Promise<MetricsResult> {
  const extras = await chainExtras(deps);
  const snapshot = await collectMetrics(deps.pool, extras);
  const alerts = evaluateAlerts(snapshot, loadAlertThresholds());
  return { snapshot, alerts, alertLevel: worstSeverity(alerts) };
}

export async function getMetricsPrometheus(deps: MetricsDeps): Promise<string> {
  const extras = await chainExtras(deps);
  const snapshot = await collectMetrics(deps.pool, extras);
  return renderPrometheus(snapshot);
}
