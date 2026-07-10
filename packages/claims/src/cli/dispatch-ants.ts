//! Operator ANT-dispatch batch (M4). Custody decision: **cold authority, signed
//! per approval batch** — the operator loads the COLD ANT authority key at
//! runtime (NOT a persistent server key; NO bulk-move of the 2,269 ANTs), and
//! this dispatches every APPROVED ANT claim with it, then discards the signer.
//!
//!   DATABASE_URL=... SOLANA_RPC_URL=... ARIO_MINT=... \
//!   TREASURY_KEY_SEALED_PATH=... TREASURY_KEY_PASSPHRASE=... \
//!   ANT_COLD_KEYPAIR_PATH=/path/to/cold-authority.json \
//!     tsx src/cli/dispatch-ants.ts
//!
//! The cold ANT key never persists on the server: it is read from the operator-
//! provided path (or a sealed blob + passphrase) for THIS run only.

import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { createRpc } from "../solana.js";
import { SolanaChainGateway } from "../dispatch/chain.js";
import { FloatManager } from "../dispatch/float.js";
import { DispatchWorker } from "../dispatch/worker.js";
import { assertSingleConfirmRpc, loadColdAntSigner, loadDispatchConfig, loadSignerRegistry } from "../dispatch/dispatch-config.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const dispatch = loadDispatchConfig(config);
  assertSingleConfirmRpc(dispatch.confirmRpcUrl);
  const db = createDb(config.databaseUrl);
  const gateway = new SolanaChainGateway(createRpc(dispatch.confirmRpcUrl));
  const signers = await loadSignerRegistry();
  const float = new FloatManager(dispatch.floatPolicy);

  // Load the operator's COLD ANT authority for this batch only.
  const coldAnt = await loadColdAntSigner();

  const worker = new DispatchWorker({
    pool: db.pool, gateway, signers, float, config, mint: dispatch.mint,
    vaultDurations: dispatch.vaultDurations, arioCoreProgram: dispatch.arioCoreProgram,
    antRequiresApproval: dispatch.antRequiresApproval,
    log: (m, e) => console.log(JSON.stringify({ msg: m, ...e })), // eslint-disable-line no-console
  });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ msg: "ant batch start", coldAntSigner: coldAnt.address, tokenSigner: signers.token.address }));

  try {
    const results = await worker.runAntBatch(coldAnt);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ msg: "ant batch done", processed: results.length, results }, null, 2));
    const anyFailed = results.some((r) => r.outcome === "failed");
    process.exitCode = anyFailed ? 1 : 0;
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("dispatch-ants failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
