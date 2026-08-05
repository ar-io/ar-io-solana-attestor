//! CLI: reconcile an ANT's on-chain ACL / ownership after a raw-transfer
//! dispatch. Our dispatch hands the claimant the MPL Core asset but bypasses the
//! `ario-ant` ACL, so arns.app keeps showing the OLD owner. This heals it —
//! permissionless, treasury-paid, claimant does nothing. See
//! `dispatch/ant-acl-instructions.ts` for the full mechanism.
//!
//!   DATABASE_URL=... NETWORK=solana-mainnet CONFIRM_RPC_URL=<single endpoint> \
//!   ANT_COLD_ADDRESS=<old owner> TREASURY_ADDRESS=... \
//!   TREASURY_KEY_SEALED_PATH=... TREASURY_KEY_PASSPHRASE=... \
//!     tsx src/cli/reconcile-ant-acl.ts [<mint> ...] [--all] [--apply] [--plan-only]
//!
//! Default = DRY: plan + `simulateTransaction` (commits nothing, needs the
//! treasury key to sign the simulated tx). `--plan-only` skips simulation (no
//! key needed). `--apply` broadcasts + confirms + re-verifies. Idempotent: an
//! already-healed ANT is a no-op. Exit 0 unless a fatal setup error; per-mint
//! failures are reported and don't abort the batch.

import { address, type Address, type TransactionSigner } from "@solana/kit";
import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { createRpc } from "../solana.js";
import { SolanaChainGateway } from "../dispatch/chain.js";
import { loadDispatchConfig, assertSingleConfirmRpc, loadSigner } from "../dispatch/dispatch-config.js";
import { ARIO_ANT_PROGRAM_MAINNET, ARIO_ANT_PROGRAM_DEVNET } from "../dispatch/ant-acl-instructions.js";
import { readAclHealSnapshot, simulateHeal, applyHeal, verifyHealed, type HealParams } from "../dispatch/ant-acl-execute.js";
import { planAclHeal } from "../dispatch/ant-acl-reconcile.js";
import type { Pool } from "pg";

interface Args {
  mints: string[];
  all: boolean;
  apply: boolean;
  planOnly: boolean;
}
function parseArgs(argv: string[]): Args {
  const a: Args = { mints: [], all: false, apply: false, planOnly: false };
  for (const t of argv) {
    if (t === "--all") a.all = true;
    else if (t === "--apply") a.apply = true;
    else if (t === "--plan-only") a.planOnly = true;
    else if (!t.startsWith("--")) a.mints.push(t);
  }
  return a;
}

function antProgramFor(network: string): Address {
  if (network === "solana-mainnet") return ARIO_ANT_PROGRAM_MAINNET;
  if (network === "solana-devnet") return ARIO_ANT_PROGRAM_DEVNET;
  throw new Error(`reconcile:ant-acl supports solana-mainnet / solana-devnet only (got ${network})`);
}

/** Resolve claimant (destination) for a confirmed ANT claim by mint. */
async function claimantForMint(pool: Pool, mint: string): Promise<string | null> {
  const r = await pool.query<{ claimant: string }>(
    `SELECT c.claimant FROM claims c JOIN assets a ON a.asset_key=c.asset_key
      WHERE a.ant_mint=$1 AND a.asset_type='ant' AND c.status='confirmed' LIMIT 1`,
    [mint],
  );
  return r.rows[0]?.claimant ?? null;
}
async function allConfirmedAntMints(pool: Pool): Promise<Array<{ mint: string; claimant: string; name: string | null }>> {
  const r = await pool.query<{ ant_mint: string; claimant: string; ant_name: string | null }>(
    `SELECT a.ant_mint, c.claimant, a.ant_name FROM claims c JOIN assets a ON a.asset_key=c.asset_key
      WHERE a.asset_type='ant' AND c.status='confirmed' AND a.ant_mint IS NOT NULL ORDER BY a.ant_name`,
  );
  return r.rows.map((x) => ({ mint: x.ant_mint, claimant: x.claimant, name: x.ant_name }));
}

const log = (o: object): void => console.log(JSON.stringify(o)); // eslint-disable-line no-console

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const dispatch = loadDispatchConfig(config);
  assertSingleConfirmRpc(dispatch.confirmRpcUrl);
  const antProgram = antProgramFor(config.network);

  const oldOwner = config.antColdAddress;
  if (!oldOwner) throw new Error("ANT_COLD_ADDRESS (the old/escrow owner whose stale ACL entry to remove) is required");

  const db = createDb(config.databaseUrl);
  const rpc = createRpc(dispatch.confirmRpcUrl);
  const gateway = new SolanaChainGateway(createRpc(dispatch.confirmRpcUrl));

  // Treasury ADDRESS (public) is the fee-payer + permissionless caller; needed
  // for plan/simulate. The private KEY is loaded ONLY for --apply.
  const treasuryAddr = process.env.TREASURY_ADDRESS?.trim();
  if (!treasuryAddr) throw new Error("TREASURY_ADDRESS is required");
  const treasury = address(treasuryAddr);

  let kit: TransactionSigner | undefined;
  if (args.apply) {
    const signer = await loadSigner("token");
    if (!signer) throw new Error("no treasury signer: set TREASURY_KEY_SEALED_PATH + TREASURY_KEY_PASSPHRASE");
    if (signer.address !== treasuryAddr) throw new Error(`treasury signer ${signer.address} != TREASURY_ADDRESS ${treasuryAddr}`);
    kit = await signer.getSigner();
  }

  // Build worklist.
  let work: Array<{ mint: string; claimant: string; name: string | null }> = [];
  if (args.all) {
    work = await allConfirmedAntMints(db.pool);
  } else if (args.mints.length > 0) {
    for (const m of args.mints) {
      const claimant = await claimantForMint(db.pool, m);
      if (!claimant) { log({ mint: m, error: "no confirmed ANT claim found for this mint" }); continue; }
      work.push({ mint: m, claimant, name: null });
    }
  } else {
    throw new Error("pass one or more <mint> args, or --all");
  }

  const mode = args.planOnly ? "plan-only" : args.apply ? "apply" : "dry-simulate";
  log({ msg: "reconcile:ant-acl start", network: config.network, antProgram, oldOwner, treasury, mode, count: work.length });

  let healed = 0, skipped = 0, aborted = 0, failed = 0, wouldHeal = 0;
  for (const w of work) {
    const params: HealParams = { antProgram, mint: address(w.mint), oldOwner: address(oldOwner), claimant: address(w.claimant), treasury };
    try {
      const snapshot = await readAclHealSnapshot(rpc, params);
      const plan = planAclHeal(snapshot);
      const base = { mint: w.mint, name: w.name, claimant: w.claimant };
      if (plan.abortReason) { log({ ...base, result: "ABORT", reason: plan.abortReason }); aborted++; continue; }
      if (plan.alreadyHealed) { log({ ...base, result: "already-healed" }); skipped++; continue; }
      log({ ...base, plan: plan.actions });

      if (args.planOnly) { wouldHeal++; continue; }

      if (!args.apply) {
        const sim = await simulateHeal(rpc, treasury, plan);
        if (sim.err) { log({ ...base, result: "SIMULATE-FAIL", err: sim.err, logs: sim.logs }); failed++; }
        else { log({ ...base, result: "simulate-ok", unitsConsumed: sim.unitsConsumed?.toString() ?? null }); wouldHeal++; }
        continue;
      }

      const applied = await applyHeal(gateway, kit!, plan);
      const v = await verifyHealed(rpc, params);
      if (v.fullyHealed) { log({ ...base, result: "HEALED", signature: applied.signature, state: applied.state }); healed++; }
      else { log({ ...base, result: "APPLIED-BUT-UNVERIFIED", signature: applied.signature, state: applied.state, verification: v }); failed++; }
    } catch (e) {
      log({ mint: w.mint, name: w.name, result: "ERROR", error: (e as Error).message }); failed++;
    }
  }

  log({ msg: "reconcile:ant-acl done", mode, healed, wouldHeal, skipped, aborted, failed });
  await db.pool.end();
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); }); // eslint-disable-line no-console
