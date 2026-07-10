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
import { loadDispatchConfig, loadSignerRegistry } from "../dispatch/dispatch-config.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const dispatch = loadDispatchConfig(config);
  const db = createDb(config.databaseUrl);
  const gateway = new SolanaChainGateway(createRpc(config.solanaRpcUrl));
  const signers = await loadSignerRegistry();
  const float = new FloatManager(dispatch.floatPolicy);

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
    log: (msg, extra) => console.log(JSON.stringify({ msg, ...extra })), // eslint-disable-line no-console
  });

  const hotAta = await worker.hotAta();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ msg: "dispatch worker start", tokenSigner: signers.token.address, antSigner: signers.ant?.address ?? null, hotAta }));

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
