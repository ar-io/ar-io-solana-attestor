//! CLI: build the claim ledger from the frozen mainnet inputs and persist it.
//!
//! Usage:
//!   FROZEN_INPUTS_DIR=/programs/ario-snapshot/output-mainnet-prod-remediation \
//!   ANT_MINT_SECRET="<base64>" \
//!   DATABASE_URL=postgres://claims:claims@localhost:5432/claims \
//!   [LEDGER_NOW_MS=1783641600000] \
//!   node dist/cli/build-ledger.js         (or: tsx src/cli/build-ledger.ts)
//!
//! Runs the migrations first (`yarn migrate:up`), then this. Deterministic:
//! same inputs + same LEDGER_NOW_MS -> same recipients/assets (only nonces are
//! random, and they are preserved across re-runs).

import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { assertAntMintDerivation, loadAntMintSecret } from "../ledger/ant-mint.js";
import { writeLedger } from "../ledger/build.js";
import { loadFrozenInputs } from "../ledger/inputs.js";
import { buildLedgerPlan, DEFAULT_NOW_MS } from "../ledger/plan.js";

async function main(): Promise<void> {
  const dir = process.env.FROZEN_INPUTS_DIR;
  if (!dir) {
    throw new Error(
      "FROZEN_INPUTS_DIR is required (e.g. /programs/ario-snapshot/output-mainnet-prod-remediation)",
    );
  }
  const nowMs = process.env.LEDGER_NOW_MS
    ? parseInt(process.env.LEDGER_NOW_MS, 10)
    : DEFAULT_NOW_MS;

  // Fail fast if the ANT-mint derivation drifts from the frozen golden vectors.
  assertAntMintDerivation();
  const antMintSecret = loadAntMintSecret();

  console.log(`[build-ledger] inputs: ${dir}`);
  console.log(`[build-ledger] nowMs:  ${nowMs} (${new Date(nowMs).toISOString()})`);

  const inputs = loadFrozenInputs(dir);
  const plan = buildLedgerPlan(inputs, { antMintSecret, nowMs });

  const c = plan.counters;
  console.log("[build-ledger] manifest phase counters (claimable set):");
  console.log(
    `  ant=${c.ant} tokenEscrowed=${c.tokenEscrowed} vaultEscrowed=${c.vaultEscrowed} ` +
      `stakeEscrowed=${c.stakeEscrowed} total=${c.ant + c.tokenEscrowed + c.vaultEscrowed + c.stakeEscrowed}`,
  );
  console.log(
    `  phase-2 token-escrow outflow = ${plan.phase2TokenOutflowMario} mARIO ` +
      `(${(Number(plan.phase2TokenOutflowMario) / 1e6).toLocaleString()} ARIO)`,
  );
  console.log(
    `  recipients=${plan.recipients.length} assets=${plan.assets.length} ` +
      `AT-RISK(manual_review)=${plan.atRiskRecipientCount}`,
  );

  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  try {
    const res = await writeLedger(db.pool, plan);
    console.log(
      `[build-ledger] persisted: recipients=${res.recipientsWritten} ` +
        `assets=${res.assetsWritten} (available=${res.availableAssets}, ` +
        `manual_review=${res.manualReviewAssets})`,
    );
  } finally {
    await db.close();
  }
  console.log("[build-ledger] done.");
}

main().catch((err) => {
  console.error("[build-ledger] FAILED:", err);
  process.exit(1);
});
