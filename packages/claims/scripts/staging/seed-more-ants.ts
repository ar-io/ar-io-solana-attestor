//! One-off DEVNET STAGING helper: ADD extra named ANTs to an existing external
//! recipient WITHOUT wiping the current external_seed rows. Mints MPL Core assets
//! under the staging ANT authority with realistic ArNS-style names and inserts
//! `available` ant asset rows (source.external_seed=true). DEVNET / claims_staging
//! ONLY. Reuses createCoreAsset + makeRpc from onchain.ts.
//!
//!   RPC_URL=... WS_URL=... DATABASE_URL=<claims_staging> SECURE_DIR=/opt/claims-secure/staging \
//!   NAMES=ardrive,permaweb RECIPIENT_ID=ysuonk5... node --import tsx scripts/staging/seed-more-ants.ts

import { readFileSync } from "node:fs";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { Client } from "pg";
import { randomBytes } from "node:crypto";
import { makeRpc, createCoreAsset } from "./onchain.js";

const RPC_URL = process.env.RPC_URL!;
const WS_URL = process.env.WS_URL!;
const DATABASE_URL = process.env.DATABASE_URL!;
const SECURE_DIR = process.env.SECURE_DIR ?? "/opt/claims-secure/staging";
const RECIPIENT_ID = process.env.RECIPIENT_ID ?? "ysuonk5asXwMweCjbKBWIjMLlvhgZP94sDlHDxGDzJo";
const NAMES = (process.env.NAMES ?? "ardrive,permaweb").split(",").map((s) => s.trim()).filter(Boolean);

async function main(): Promise<void> {
  const { rpc, sendAndConfirm } = makeRpc(RPC_URL, WS_URL);
  const antAuthority = await createKeyPairSignerFromBytes(
    new Uint8Array(JSON.parse(readFileSync(`${SECURE_DIR}/ant-authority-keypair.json`, "utf8"))),
  );

  const db = new Client({ connectionString: DATABASE_URL });
  await db.connect();
  const who = (await db.query("SELECT current_database() db")).rows[0].db;
  if (who !== "claims_staging") throw new Error(`REFUSING: current_database()=${who}, expected claims_staging`);

  const recip = await db.query("SELECT 1 FROM recipients WHERE recipient_id = $1", [RECIPIENT_ID]);
  if (!recip.rowCount) throw new Error(`recipient ${RECIPIENT_ID} not found in claims_staging`);
  console.log("connected to", who, "recipient", RECIPIENT_ID);

  for (const name of NAMES) {
    const mint = await createCoreAsset(rpc, sendAndConfirm, antAuthority, antAuthority, name);
    await db.query(
      `INSERT INTO assets (asset_key, asset_type, recipient_id, ant_mint, amount, vault_end_ts, nonce, status, source)
       VALUES ($1,'ant',$2,$1,NULL,NULL,$3,'available',$4::jsonb)
       ON CONFLICT (asset_key) DO NOTHING`,
      [mint as string, RECIPIENT_ID, randomBytes(32),
        JSON.stringify({ external_seed: true, wallet: RECIPIENT_ID, phase: "ant", onchainSeed: "escrow_ant", arnsName: name })],
    );
    console.log(`  minted ANT "${name}" mint=${mint}`);
  }

  await db.end();
  console.log(`\nseeded ${NAMES.length} extra named ANTs for ${RECIPIENT_ID}`);
}

main().catch((e) => { console.error("seed-more-ants failed:", e); process.exit(1); });
