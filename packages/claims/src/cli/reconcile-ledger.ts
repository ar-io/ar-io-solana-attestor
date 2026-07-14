//! CLI: the M1 reconciliation gate. Proves the built ledger is bit-exact with
//! what batch-escrow would deposit on-chain, using an INDEPENDENT derivation
//! (src/reconcile/authoritative.ts imports the deployed solana-ar-io code).
//!
//! Usage:
//!   FROZEN_INPUTS_DIR=/programs/ario-snapshot/output-mainnet-prod-remediation \
//!   ANT_MINT_SECRET="<base64>" \
//!   SOLANA_AR_IO_IMPORT_SRC=/home/vilenarios/source/solana-ar-io/migration/import/src \
//!   [RECONCILE_SOURCE=db|plan]   (default db; db reads the persisted ledger) \
//!   [DATABASE_URL=...]           (required for RECONCILE_SOURCE=db) \
//!   [LEDGER_NOW_MS=1783641600000] \
//!   tsx src/cli/reconcile-ledger.ts
//!
//! Exit 0 = PASS (bit-exact + gate numbers). Exit 1 = FAIL (prints diffs).

import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { assertAntMintDerivation, loadAntMintSecret } from "../ledger/ant-mint.js";
import { loadFrozenInputs } from "../ledger/inputs.js";
import { buildLedgerPlan, DEFAULT_NOW_MS } from "../ledger/plan.js";
import { deriveAuthoritativeDeposits } from "../reconcile/authoritative.js";
import {
  builtSetFromDb,
  builtSetFromPlan,
  checkVaultStakeMarioGate,
  EXPECTED_GATE,
  gateAppliesAt,
  reconcile,
  type BuiltAsset,
} from "../reconcile/reconcile.js";

function checkGate(
  label: string,
  counters: {
    ant: number;
    tokenEscrowed: number;
    vaultEscrowed: number;
    stakeEscrowed: number;
  },
  // Absolute per-phase mARIO totals — pinned in EXPECTED_GATE (MED-C) so a
  // tampered vault/stake `amountMario` (which slips past the count-only pins
  // and the bit-exact diff, since both sides read the same poisoned file) is
  // caught here on whichever derivation supplies these totals.
  mario: { vaultMario: bigint; stakeMario: bigint },
): string[] {
  const fails: string[] = [];
  const g = EXPECTED_GATE;
  const cmp = (name: string, got: number, exp: number): void => {
    if (got !== exp) fails.push(`${label}.${name}: got ${got}, expected ${exp}`);
  };
  cmp("ant", counters.ant, g.ant);
  cmp("tokenEscrowed", counters.tokenEscrowed, g.tokenEscrowed);
  cmp("vaultEscrowed", counters.vaultEscrowed, g.vaultEscrowed);
  cmp("stakeEscrowed", counters.stakeEscrowed, g.stakeEscrowed);
  const total = counters.ant + counters.tokenEscrowed + counters.vaultEscrowed + counters.stakeEscrowed;
  cmp("total", total, g.total);
  fails.push(...checkVaultStakeMarioGate(label, mario.vaultMario, mario.stakeMario));
  return fails;
}

async function main(): Promise<void> {
  const dir = process.env.FROZEN_INPUTS_DIR;
  if (!dir) throw new Error("FROZEN_INPUTS_DIR is required");
  const nowMs = process.env.LEDGER_NOW_MS ? parseInt(process.env.LEDGER_NOW_MS, 10) : DEFAULT_NOW_MS;
  const source = (process.env.RECONCILE_SOURCE ?? "db").toLowerCase();

  assertAntMintDerivation();
  const secretU8 = loadAntMintSecret();
  const secret = Buffer.from(secretU8);

  const fails: string[] = [];
  const line = "=".repeat(70);
  console.log(line);
  console.log("M1 LEDGER RECONCILIATION GATE");
  console.log(line);
  console.log(`frozen inputs : ${dir}`);
  console.log(`reference now : ${nowMs} (${new Date(nowMs).toISOString()})`);
  console.log(`compare source: ${source}`);
  const gateApplies = gateAppliesAt(nowMs);
  if (!gateApplies) {
    console.log(
      `NOTE: nowMs != the published gate reference (${EXPECTED_GATE.nowMs}); the\n` +
        "      hardcoded oracle counts (2269/5374/111/2957) are time-dependent and\n" +
        "      will be SKIPPED. The bit-exact builder-vs-authoritative diff (nowMs-\n" +
        "      agnostic) remains the operative gate.",
    );
  }

  // --- Independent authoritative derivation (deployed solana-ar-io code) ----
  const authoritative = await deriveAuthoritativeDeposits({
    frozenDir: dir,
    antMintSecret: secret,
    nowMs,
  });
  console.log(`authoritative : imported from ${authoritative.importSrc}`);
  console.log(
    `authoritative counters: ant=${authoritative.counters.ant} ` +
      `tokenEscrowed=${authoritative.counters.tokenEscrowed} ` +
      `vaultEscrowed=${authoritative.counters.vaultEscrowed} ` +
      `stakeEscrowed=${authoritative.counters.stakeEscrowed}`,
  );
  console.log(
    `authoritative on-chain seed counts: ant=${authoritative.onchainSeedCounts.ant} ` +
      `token=${authoritative.onchainSeedCounts.token} vault=${authoritative.onchainSeedCounts.vault} ` +
      `total=${authoritative.deposits.size}`,
  );
  console.log(
    `authoritative phase mARIO: vault=${authoritative.phase3VaultMario} ` +
      `stake=${authoritative.phase4StakeMario}`,
  );
  if (gateApplies) {
    fails.push(
      ...checkGate("authoritative", authoritative.counters, {
        vaultMario: authoritative.phase3VaultMario,
        stakeMario: authoritative.phase4StakeMario,
      }),
    );
    if (authoritative.phase2TokenOutflowMario !== EXPECTED_GATE.phase2TokenOutflowMario) {
      fails.push(
        `authoritative.phase2TokenOutflow: got ${authoritative.phase2TokenOutflowMario}, ` +
          `expected ${EXPECTED_GATE.phase2TokenOutflowMario}`,
      );
    }
  }

  // --- MY builder's plan (for gate + optional in-memory compare) ------------
  const inputs = loadFrozenInputs(dir);
  const plan = buildLedgerPlan(inputs, { antMintSecret: secretU8, nowMs });
  console.log(
    `\nbuilt (plan) counters: ant=${plan.counters.ant} ` +
      `tokenEscrowed=${plan.counters.tokenEscrowed} vaultEscrowed=${plan.counters.vaultEscrowed} ` +
      `stakeEscrowed=${plan.counters.stakeEscrowed}`,
  );
  console.log(
    `built recipients=${plan.recipients.length} assets=${plan.assets.length} ` +
      `AT-RISK(manual_review)=${plan.atRiskRecipientCount}`,
  );
  console.log(
    `built phase mARIO: vault=${plan.phase3VaultMario} stake=${plan.phase4StakeMario}`,
  );
  // AT-RISK count is nowMs-independent — always checked.
  if (plan.atRiskRecipientCount !== EXPECTED_GATE.atRisk) {
    fails.push(`AT-RISK count: got ${plan.atRiskRecipientCount}, expected ${EXPECTED_GATE.atRisk}`);
  }
  if (gateApplies) {
    fails.push(
      ...checkGate("built", plan.counters, {
        vaultMario: plan.phase3VaultMario,
        stakeMario: plan.phase4StakeMario,
      }),
    );
    if (plan.phase2TokenOutflowMario !== EXPECTED_GATE.phase2TokenOutflowMario) {
      fails.push(
        `built.phase2TokenOutflow: got ${plan.phase2TokenOutflowMario}, ` +
          `expected ${EXPECTED_GATE.phase2TokenOutflowMario}`,
      );
    }
  }

  // --- The bit-exact diff ---------------------------------------------------
  let built: Map<string, BuiltAsset>;
  if (source === "db") {
    const config = loadConfig();
    const db = createDb(config.databaseUrl);
    try {
      built = await builtSetFromDb(db.pool);
    } finally {
      await db.close();
    }
    if (built.size === 0) {
      throw new Error(
        "RECONCILE_SOURCE=db but no available assets in the DB — run build-ledger first " +
          "(or use RECONCILE_SOURCE=plan for the in-memory derivation compare).",
      );
    }
  } else {
    built = builtSetFromPlan(plan);
  }

  const report = reconcile(built, authoritative);
  console.log(`\n${line}`);
  console.log("BIT-EXACT DIFF (built.available vs authoritative would-be deposits)");
  console.log(line);
  console.log(`built assets      : ${report.builtCount}`);
  console.log(`authoritative     : ${report.authoritativeCount}`);
  console.log(`matched           : ${report.matched}`);
  console.log(
    `built seed counts : ant=${report.builtSeedCounts.ant} token=${report.builtSeedCounts.token} vault=${report.builtSeedCounts.vault}`,
  );
  console.log(
    `auth  seed counts : ant=${report.authoritativeSeedCounts.ant} token=${report.authoritativeSeedCounts.token} vault=${report.authoritativeSeedCounts.vault}`,
  );
  console.log(
    `Σ mARIO built=${report.builtTotalMario} authoritative=${report.authoritativeTotalMario} ` +
      `(${(Number(report.builtTotalMario) / 1e6).toLocaleString()} ARIO)`,
  );
  if (report.diffs.length > 0) {
    console.log(`\nDIFFS (${report.diffs.length} shown, capped):`);
    for (const d of report.diffs) console.log(`  [${d.reason}] ${d.assetKey}: ${d.detail}`);
    fails.push(`${report.diffs.length} reconciliation diff(s)`);
  }
  if (report.builtTotalMario !== report.authoritativeTotalMario) {
    fails.push(
      `Σ mARIO mismatch: built ${report.builtTotalMario} != authoritative ${report.authoritativeTotalMario}`,
    );
  }
  if (!report.pass) fails.push("reconcile() reported non-PASS");

  console.log(`\n${line}`);
  if (fails.length === 0) {
    console.log("RESULT: PASS — ledger is bit-exact vs the would-be on-chain deposits.");
    console.log(line);
    process.exit(0);
  }
  console.log(`RESULT: FAIL — ${fails.length} problem(s):`);
  for (const f of fails) console.log(`  - ${f}`);
  console.log(line);
  process.exit(1);
}

main().catch((err) => {
  console.error("[reconcile-ledger] ERROR:", err);
  process.exit(1);
});
