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
import { collectMetrics, type MetricsExtras } from "../ops/metrics.js";
import { evaluateAlerts, loadAlertThresholds } from "../ops/alerts.js";
import { makeSlackNotifier } from "../ops/slack.js";
import { composeDispensedSlackMessage } from "../ops/claim-format.js";
import { SlackAlertRouter } from "../ops/alert-slack.js";
import { DEFAULT_SOL_LOW_THRESHOLD_LAMPORTS } from "../config.js";
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
  const solLowThresholdLamports = config.solLowThresholdLamports ?? DEFAULT_SOL_LOW_THRESHOLD_LAMPORTS;

  // Opt-in Slack routing (no-op when SLACK_WEBHOOK_URL is unset). ONE router for
  // the whole worker run so the in-memory de-dup spans ticks — a persistent
  // balance-low condition posts once, then at most once per ~30 min (see
  // alert-slack.ts). Fire-and-forget: a Slack problem can never touch dispatch.
  const slackNotify = makeSlackNotifier(
    config.slackWebhookUrl,
    // eslint-disable-next-line no-console
    (m, meta) => console.warn(JSON.stringify({ msg: m, meta })),
  );
  const slackRouter = new SlackAlertRouter({ notify: slackNotify });

  /** Emit every firing alert as a severity-tagged structured log line + (opt-in) Slack. */
  async function emitAlerts(floatStatus: FloatStatus): Promise<number> {
    try {
      const extras: MetricsExtras = { float: floatStatus };
      // Hot dispenser (fee-payer) native SOL. Guarded independently so a transient
      // RPC blip on this read never fires a false SOL-low critical and never drops
      // the other alerts — we simply skip the SOL check for this tick.
      try {
        const balanceLamports = await gateway.getSolBalance(signers.token.address);
        extras.dispenserSol = { balanceLamports, thresholdLamports: solLowThresholdLamports };
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(JSON.stringify({ msg: "sol balance read failed (skipping sol-low check)", err: (e as Error).message }));
      }
      const snapshot = await collectMetrics(db.pool, extras);
      const alerts = evaluateAlerts(snapshot, alertThresholds);
      for (const a of alerts) {
        const line = JSON.stringify({ msg: "ALERT", alert: a.name, severity: a.severity, value: a.value, threshold: a.threshold, detail: a.message });
        // eslint-disable-next-line no-console
        if (a.severity === "critical") console.error(line);
        else console.warn(line);
      }
      // ADDITIVE to journald: post warning+critical alerts to Slack (de-duped).
      return slackRouter.post(alerts).length;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ msg: "alert eval error", err: (e as Error).message }));
      return 0;
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
      // Dispense-success Slack: one per claim that FRESHLY confirmed this tick
      // (token/vault via the worker; ANT successes post from the /admin batch submit).
      // Distinct per claim (no de-dup — each is a unique event); "already_confirmed"
      // / "recovered_confirmed" are re-checks and never re-notify. Fire-and-forget.
      let dispensedPosts = 0;
      if (config.slackWebhookUrl) {
        for (const res of results) {
          if (res.outcome !== "confirmed" || !res.signature) continue;
          dispensedPosts++;
          const sig = res.signature;
          void (async () => {
            const r = await db.pool.query<{
              asset_type: string; amount: string | null; ant_name: string | null; ant_mint: string | null;
              claimant: string; protocol: number; source_address: string;
            }>(
              `SELECT a.asset_type, a.amount::text AS amount, a.ant_name, a.ant_mint,
                      c.claimant, rc.protocol, rc.source_address
                 FROM claims c JOIN assets a ON a.asset_key = c.asset_key
                 JOIN recipients rc ON rc.recipient_id = a.recipient_id
                WHERE c.claim_id = $1`,
              [res.claimId],
            );
            const row = r.rows[0];
            if (row) {
              slackNotify(
                composeDispensedSlackMessage(
                  res.claimId,
                  { assetType: row.asset_type, amountMario: row.amount, antName: row.ant_name, antMint: row.ant_mint, claimant: row.claimant, protocol: row.protocol, sourceAddress: row.source_address },
                  sig,
                  config.network,
                ),
              );
            }
            // eslint-disable-next-line no-console
          })().catch((e) => console.warn(JSON.stringify({ msg: "dispensed notify failed", err: (e as Error).message })));
        }
      }
      const status = await float.status(db.pool, gateway, hotAta);
      if (status.refillNeeded) {
        // eslint-disable-next-line no-console
        console.warn(JSON.stringify({ msg: "REFILL NEEDED", available: status.availableMario.toString(), cap: status.capMario.toString() }));
      }
      // Evaluate + emit ops alerts each tick (float-low, reconciliation drift,
      // dispatch-failure, big-claim-queue, anchor-failure, ...).
      const posted = await emitAlerts(status);
      // In `--once` mode this is a short-lived process: the Slack POSTs are
      // fire-and-forget, so give them a bounded moment to flush before the process
      // exits (the persistent-loop mode keeps running, so its POSTs flush naturally).
      // Mirrors the ops-metrics CLI drain.
      if (once && (posted > 0 || dispensedPosts > 0) && config.slackWebhookUrl) await sleep(6000);
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
