//! Backfill `assets.ant_name` with the real ArNS name for every ANT asset, so
//! operator alerts, the /admin approval list, and the dispatch path show
//! `sacred-archives-chris-comish` instead of blank/`ANT`.
//!
//! `ant_name` is a DISPLAY column only — reconcile compares amounts + ANT counts,
//! never the name — so this never touches the money path or the reconcile gate.
//!
//! Mapping (fully derivable, exact parity with how the ledger was built):
//!   assets.ant_mint  <=  deriveAntMintBase58(processId, ANT_MINT_SECRET)  =>  processId
//!   processId  ->  ant-nft-metadata.json.arnsName
//!
//! DRY-RUN by default (reports, no writes). Pass --apply to write in one transaction.
//! Requires: DATABASE_URL, ANT_MINT_SECRET (base64), FROZEN_INPUTS_DIR.

import { readFileSync } from "node:fs";
import { Pool } from "pg";
import {
  deriveAntMintBase58,
  loadAntMintSecret,
  assertAntMintDerivation,
} from "../src/ledger/ant-mint.js";

interface NftMeta { processId: string; arnsName: string | null }
interface DeliveryEntry { processId?: string; mint?: string }

const APPLY = process.argv.includes("--apply");
const FI = process.env.FROZEN_INPUTS_DIR ?? "/opt/claims-secure/frozen-inputs/output-mainnet-prod-remediation";
const DB = process.env.DATABASE_URL;
if (!DB) throw new Error("DATABASE_URL required");

function loadJson<T>(f: string): T { return JSON.parse(readFileSync(`${FI}/${f}`, "utf8")) as T; }
function fail(msg: string): never { console.error(`\n❌ GATE FAILED: ${msg}`); process.exit(1); }

async function main(): Promise<void> {
  console.log(`ANT-name backfill — mode: ${APPLY ? "APPLY (will write)" : "DRY-RUN"}\n`);

  // --- GATE 1: derivation self-test (fixtures) ---
  assertAntMintDerivation();
  console.log("✅ gate 1: deriveAntMint fixture self-test passed");

  const secret = loadAntMintSecret(process.env);
  const meta = loadJson<NftMeta[]>("ant-nft-metadata.json");
  const deliveryRaw = loadJson<Record<string, DeliveryEntry> | DeliveryEntry[]>("ant-delivery-manifest.json");
  const delivery: DeliveryEntry[] = Array.isArray(deliveryRaw) ? deliveryRaw : Object.values(deliveryRaw);

  // processId -> arnsName (only entries that actually carry a name)
  const nameByPid = new Map<string, string>();
  for (const e of meta) if (e.processId && e.arnsName) nameByPid.set(e.processId, e.arnsName);

  // --- GATE 2: derivation vs independent ground truth (delivery manifest) ---
  const gt = delivery.filter((e) => e.processId && e.mint);
  let gtBad = 0;
  for (const e of gt) {
    if (deriveAntMintBase58(e.processId!, secret) !== e.mint) gtBad++;
  }
  if (gtBad > 0) fail(`derivation disagreed with ${gtBad}/${gt.length} ground-truth manifest mints`);
  console.log(`✅ gate 2: derivation == manifest mint for ALL ${gt.length} ground-truth pairs`);

  // Build derived mint -> arnsName for every processId that has a name.
  const nameByMint = new Map<string, string>();
  for (const [pid, name] of nameByPid) {
    const mint = deriveAntMintBase58(pid, secret);
    const prev = nameByMint.get(mint);
    if (prev && prev !== name) fail(`mint ${mint} maps to TWO names: "${prev}" and "${name}"`);
    nameByMint.set(mint, name);
  }
  console.log(`   derived name for ${nameByMint.size} unique mints (from ${nameByPid.size} named processIds)`);

  // --- GATE 3: coverage — every DB ANT mint resolves ---
  const pool = new Pool({ connectionString: DB });
  try {
    const rows = (await pool.query<{ ant_mint: string; ant_name: string | null }>(
      "SELECT ant_mint, ant_name FROM assets WHERE asset_type='ant' AND ant_mint IS NOT NULL",
    )).rows;
    const unmatched = rows.filter((r) => !nameByMint.has(r.ant_mint));
    console.log(`   DB ANT assets: ${rows.length} | resolved: ${rows.length - unmatched.length} | unmatched: ${unmatched.length}`);
    if (unmatched.length > 0) {
      console.error("   first few unmatched mints:", unmatched.slice(0, 5).map((r) => r.ant_mint));
      fail(`${unmatched.length} DB ANT assets have NO derived arnsName — refusing to apply a partial backfill`);
    }
    console.log(`✅ gate 3: coverage — ALL ${rows.length} DB ANT assets resolve to an arnsName`);

    // --- GATE 5: spot-check the known ANT ---
    const spotMint = "5xSFSvqfoFqvAF3T2HxXMsitcst16eE8D8psKaz51eEV";
    const spot = nameByMint.get(spotMint);
    if (rows.some((r) => r.ant_mint === spotMint)) {
      if (spot !== "sacred-archives-chris-comish") fail(`spot-check: ${spotMint} -> "${spot}", expected sacred-archives-chris-comish`);
      console.log(`✅ gate 5: spot-check ${spotMint.slice(0, 8)}… -> "${spot}"`);
    }

    // Diff: how many would change.
    const toChange = rows.filter((r) => (r.ant_name ?? "") !== nameByMint.get(r.ant_mint));
    console.log(`\n   ${toChange.length} of ${rows.length} rows would be updated (rest already correct).`);
    console.log(`   sample: ${toChange.slice(0, 3).map((r) => `${r.ant_mint.slice(0, 6)}…→${nameByMint.get(r.ant_mint)}`).join(", ")}`);

    if (!APPLY) {
      console.log("\nDRY-RUN complete — all gates passed. Re-run with --apply to write.");
      return;
    }

    // --- APPLY (one transaction) ---
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      let updated = 0;
      for (const r of toChange) {
        const res = await client.query(
          "UPDATE assets SET ant_name=$1, updated_at=now() WHERE ant_mint=$2 AND asset_type='ant'",
          [nameByMint.get(r.ant_mint), r.ant_mint],
        );
        updated += res.rowCount ?? 0;
      }
      // Post-apply invariant INSIDE the txn: zero named-blank ANTs remain.
      const blank = (await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM assets WHERE asset_type='ant' AND ant_mint IS NOT NULL AND (ant_name IS NULL OR ant_name='')",
      )).rows[0].n;
      if (blank !== "0") { await client.query("ROLLBACK"); fail(`post-apply check inside txn: ${blank} ANTs still blank — ROLLED BACK`); }
      await client.query("COMMIT");
      console.log(`\n✅ APPLIED: ${updated} rows updated, 0 ANTs left blank (committed).`);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
