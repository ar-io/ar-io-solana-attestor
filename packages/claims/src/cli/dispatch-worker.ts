//! Dispatch worker runner (M4). Polls for verified dispatch-intents and
//! dispenses them on-chain exactly-once. Run as a single process (single-flight).
//!
//!   DATABASE_URL=... SOLANA_RPC_URL=... ARIO_MINT=... \
//!   TREASURY_KEY_SEALED_PATH=... TREASURY_KEY_PASSPHRASE=... \
//!   [ANT_SIGNER_KEY_SEALED_PATH=... ANT_SIGNER_KEY_PASSPHRASE=...] \
//!   tsx src/cli/dispatch-worker.ts [--once]

import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { createRpc } from "../solana.js";
import { SolanaChainGateway } from "../dispatch/chain.js";
import { FloatManager } from "../dispatch/float.js";
import { DispatchWorker } from "../dispatch/worker.js";
import { assertSingleConfirmRpc, loadDispatchConfig, loadSignerRegistry } from "../dispatch/dispatch-config.js";
import { assertVaultDurationsMatchChain, fetchArioConfigVaultDurations } from "../dispatch/ario-config.js";
import { assertBootConfig } from "../ops/config-validation.js";
import { collectMetrics } from "../ops/metrics.js";
import { evaluateAlerts, loadAlertThresholds } from "../ops/alerts.js";
import type { FloatStatus } from "../dispatch/float.js";

async function main(): Promise<void> {
  // Fail FAST on a worker misconfig (pooled CONFIRM RPC would break exactly-once;
  // key reuse; missing treasury signer / mint). Aborts the boot on any error.
  assertBootConfig(process.env, {
    role: "worker",
    log: (level, code, message) =>
      // eslint-disable-next-line no-console
      console[level === "error" ? "error" : "warn"](JSON.stringify({ msg: `boot ${level}`, code, detail: message })),
  });

  const config = loadConfig();
  const dispatch = loadDispatchConfig(config);
  const db = createDb(config.databaseUrl);
  // Exactly-once confirmation reads MUST go through a single consistent endpoint.
  assertSingleConfirmRpc(dispatch.confirmRpcUrl);
  const gateway = new SolanaChainGateway(createRpc(dispatch.confirmRpcUrl));

  // ITEM F — reconcile the configured vault durations against the LIVE on-chain
  // ArioConfig and FAIL FAST on mismatch (a stale env `min` could misclassify a
  // still-locked vault as liquid). Skippable on clusters without ario-core
  // deployed via VAULT_DURATION_RECONCILE=off (or by leaving ARIO_CORE_PROGRAM
  // unset — then we can't derive the ArioConfig PDA and only warn).
  if ((process.env.VAULT_DURATION_RECONCILE ?? "on") !== "off") {
    if (dispatch.arioCoreProgram) {
      const { config, durations } = await fetchArioConfigVaultDurations(
        createRpc(dispatch.confirmRpcUrl),
        dispatch.arioCoreProgram,
      );
      assertVaultDurationsMatchChain(dispatch.vaultDurations, durations); // throws => boot aborts
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({
        msg: "vault durations reconciled with on-chain ArioConfig",
        arioConfig: config,
        minVaultDuration: durations.minVaultDuration.toString(),
        maxVaultDuration: durations.maxVaultDuration.toString(),
      }));
    } else {
      // eslint-disable-next-line no-console
      console.warn(JSON.stringify({
        msg: "WARNING: ARIO_CORE_PROGRAM unset — cannot reconcile vault durations with on-chain ArioConfig; using env values UNVERIFIED",
        minVaultDuration: dispatch.vaultDurations.minVaultDuration.toString(),
        maxVaultDuration: dispatch.vaultDurations.maxVaultDuration.toString(),
      }));
    }
  }

  const signers = await loadSignerRegistry();
  const float = new FloatManager(dispatch.floatPolicy);
  const alertThresholds = loadAlertThresholds();

  /** Emit every firing alert as a severity-tagged structured log line. */
  async function emitAlerts(floatStatus: FloatStatus): Promise<void> {
    try {
      const snapshot = await collectMetrics(db.pool, { float: floatStatus });
      for (const a of evaluateAlerts(snapshot, alertThresholds)) {
        const line = JSON.stringify({ msg: "ALERT", alert: a.name, severity: a.severity, value: a.value, threshold: a.threshold, detail: a.message });
        // eslint-disable-next-line no-console
        if (a.severity === "critical") console.error(line);
        else console.warn(line);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ msg: "alert eval error", err: (e as Error).message }));
    }
  }

  const worker = new DispatchWorker({
    pool: db.pool,
    gateway,
    signers,
    float,
    config,
    mint: dispatch.mint,
    vaultDurations: dispatch.vaultDurations,
    arioCoreProgram: dispatch.arioCoreProgram,
    antRequiresApproval: dispatch.antRequiresApproval,
    // B1: in operator-wallet mode the automated worker must NOT touch ANT claims.
    antDispatchMode: config.antDispatchMode,
    log: (msg, extra) => console.log(JSON.stringify({ msg, ...extra })), // eslint-disable-line no-console
  });

  const hotAta = await worker.hotAta();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    msg: "dispatch worker start",
    tokenSigner: signers.token.address,
    antSigner: signers.ant?.address ?? "operator-supplied-per-batch (yarn dispatch:ants)",
    confirmRpc: dispatch.confirmRpcUrl,
    hotAta,
  }));

  const once = process.argv.includes("--once");
  let running = true;
  process.on("SIGINT", () => { running = false; });
  process.on("SIGTERM", () => { running = false; });

  do {
    try {
      const results = await worker.runOnce();
      if (results.length > 0) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({ msg: "tick", processed: results.length, outcomes: tally(results.map((r) => r.outcome)) }));
      }
      const status = await float.status(db.pool, gateway, hotAta);
      if (status.refillNeeded) {
        // eslint-disable-next-line no-console
        console.warn(JSON.stringify({ msg: "REFILL NEEDED", available: status.availableMario.toString(), cap: status.capMario.toString() }));
      }
      // Evaluate + emit ops alerts each tick (float-low, reconciliation drift,
      // dispatch-failure, big-claim-queue, anchor-failure, ...).
      await emitAlerts(status);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ msg: "tick error", err: (e as Error).message }));
    }
    if (!once && running) await sleep(dispatch.pollIntervalMs);
  } while (!once && running);

  await db.close();
}

function tally(xs: string[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const x of xs) m[x] = (m[x] ?? 0) + 1;
  return m;
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("dispatch worker failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
