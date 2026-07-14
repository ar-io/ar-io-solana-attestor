//! CLI: build the claim ledger from the frozen mainnet inputs and persist it.
//!
//! Usage:
//!   FROZEN_INPUTS_DIR=/programs/ario-snapshot/output-mainnet-prod-remediation \
//!   ANT_MINT_SECRET="<base64>" \
//!   DATABASE_URL=postgres://claims:claims@localhost:5432/claims \
//!   [LEDGER_NOW_MS=1783641600000] \
//!   [ALLOW_LIVE_LEDGER_REBUILD=1] \
//!   node dist/cli/build-ledger.js         (or: tsx src/cli/build-ledger.ts)
//!
//! Runs the migrations first (`yarn migrate:up`), then this. Deterministic for a
//! PRE-LAUNCH ledger: same inputs + same LEDGER_NOW_MS -> same recipients/assets
//! (only nonces are random, and they are preserved across re-runs).
//!
//! NOT safe to re-run blindly against a LIVE ledger. A fresh plan marks every
//! asset `available`, so a rebuild would try to reset an already-`claiming` /
//! `pending_review` / `claimed` asset back to claimable → double payout.
//! `writeLedger` therefore HARD-REFUSES (throws) if any asset has left the
//! buildable set. Rebuild only against a ledger with no live claims. For a
//! deliberate, status-safe refresh of the buildable rows AFTER claims have begun,
//! set `ALLOW_LIVE_LEDGER_REBUILD=1`: the refuse is skipped but live/terminal rows
//! are still preserved untouched (only `available`/`manual_review` rows update).

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

  const allowLiveRebuild = process.env.ALLOW_LIVE_LEDGER_REBUILD === "1";
  if (allowLiveRebuild) {
    console.log(
      "[build-ledger] ALLOW_LIVE_LEDGER_REBUILD=1 — live-ledger refuse is SKIPPED " +
        "(live/terminal assets are still preserved; only buildable rows update).",
    );
  }

  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  try {
    const res = await writeLedger(db.pool, plan, { allowLiveRebuild });
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
