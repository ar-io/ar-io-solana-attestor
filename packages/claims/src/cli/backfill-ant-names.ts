//! CLI: backfill `assets.ant_name` — the ANT's on-chain ArNS name (MPL Core
//! `name`) — for display in the API + frontend. DISPLAY-ONLY: this touches no
//! money column and never influences custody, settlement, verification, or
//! reconciliation. Idempotent + gentle on the RPC (small batches, brief delay).
//!
//!   DATABASE_URL=<claims db> SOLANA_RPC_URL=<rpc> tsx src/cli/backfill-ant-names.ts
//!
//! By default only fills ANTs where ant_name IS NULL. Pass --all to re-decode
//! every ANT (e.g. after a name change). --batch <n> / --delay-ms <n> tune the
//! RPC pacing; --dry-run decodes + reports without writing.
//!
//! Exit 0 on success (even if some mints could not be read — they are reported
//! and skipped so one bad account never fails the whole run); exit 1 on a fatal
//! setup error (bad DB, etc.).

import { address } from "@solana/kit";

import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { createRpc } from "../solana.js";
import { decodeMplCoreNameFromBase64 } from "../dispatch/mpl-core-name.js";

interface Args {
  all: boolean;
  dryRun: boolean;
  batch: number;
  delayMs: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { all: false, dryRun: false, batch: 10, delayMs: 250 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") args.all = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--batch") args.batch = Math.max(1, parseInt(argv[++i], 10) || args.batch);
    else if (a === "--delay-ms") args.delayMs = Math.max(0, parseInt(argv[++i], 10) || 0);
  }
  return args;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const rpc = createRpc(config.solanaRpcUrl);

  let scanned = 0;
  let updated = 0;
  let unchanged = 0;
  let failed = 0;

  try {
    const where = args.all
      ? "asset_type = 'ant' AND ant_mint IS NOT NULL"
      : "asset_type = 'ant' AND ant_mint IS NOT NULL AND ant_name IS NULL";
    const rows = (
      await db.pool.query<{ asset_key: string; ant_mint: string; ant_name: string | null }>(
        `SELECT asset_key, ant_mint, ant_name FROM assets WHERE ${where} ORDER BY asset_key`,
      )
    ).rows;

    console.log(
      JSON.stringify({ msg: "backfill:ant-names start", candidates: rows.length, mode: args.all ? "all" : "null-only", dryRun: args.dryRun }),
    );

    for (let i = 0; i < rows.length; i += args.batch) {
      const batch = rows.slice(i, i + args.batch);
      for (const row of batch) {
        scanned++;
        try {
          const info = await rpc.getAccountInfo(address(row.ant_mint), { encoding: "base64" }).send();
          const data = info.value?.data;
          if (!data || !Array.isArray(data) || typeof data[0] !== "string") {
            failed++;
            console.error(`  SKIP ${row.ant_mint}: account not found or no data`);
            continue;
          }
          const name = decodeMplCoreNameFromBase64(data[0]);
          if (name === row.ant_name) {
            unchanged++;
            continue;
          }
          if (!args.dryRun) {
            await db.pool.query("UPDATE assets SET ant_name = $2, updated_at = now() WHERE asset_key = $1", [
              row.asset_key,
              name,
            ]);
          }
          updated++;
          console.log(`  ${args.dryRun ? "WOULD SET" : "SET"} ${row.ant_mint} -> "${name}"`);
        } catch (e) {
          failed++;
          console.error(`  FAIL ${row.ant_mint}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (i + args.batch < rows.length && args.delayMs > 0) await sleep(args.delayMs);
    }

    console.log(JSON.stringify({ msg: "backfill:ant-names done", scanned, updated, unchanged, failed }));
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error("backfill-ant-names failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
