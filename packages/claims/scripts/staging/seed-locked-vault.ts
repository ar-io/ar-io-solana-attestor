//! Seed a single DEVNET STAGING **time-locked** vault claimable for an EXISTING
//! external recipient (default: tester `ysuonk`), so the locked-vault claimant UX
//! can be eyeballed in the browser.
//!
//! A vault with a FUTURE `vault_end_ts` is time-locked: claiming it does NOT
//! dispense — the service queues it for automatic delivery at unlock. Unlike an
//! ANT, a vault asset needs no on-chain mint, so this is a pure (guarded) DB
//! insert. The row is marked source.external_seed=true AND source.seed=
//! 'locked-vault-demo', so the smoke-suite reseed does NOT wipe it and this
//! script can idempotently replace only its own row.
//!
//! DEVNET / claims_staging ONLY; refuses any other database. The recipient must
//! already exist (we do not have its RSA modulus here) — seed it first via
//! seed-external.ts if missing.
//!
//!   DATABASE_URL=<claims_staging> \
//!   [RECIPIENT=ysuonk5asXwMweCjbKBWIjMLlvhgZP94sDlHDxGDzJo] \
//!   [AMOUNT_ARIO=5000] [UNLOCK_ISO=2027-02-06T12:00:00Z] \
//!     node --import tsx scripts/staging/seed-locked-vault.ts

import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { ONE_TOKEN } from "./onchain.js";

const DATABASE_URL = process.env.DATABASE_URL!;
const RECIPIENT = process.env.RECIPIENT ?? "ysuonk5asXwMweCjbKBWIjMLlvhgZP94sDlHDxGDzJo";
const AMOUNT_ARIO = BigInt(process.env.AMOUNT_ARIO ?? "5000");
const UNLOCK_ISO = process.env.UNLOCK_ISO ?? "2027-02-06T12:00:00Z";
const SEED_MARKER = "locked-vault-demo";

async function main(): Promise<void> {
  const unlockMs = Date.parse(UNLOCK_ISO);
  if (Number.isNaN(unlockMs)) throw new Error(`bad UNLOCK_ISO: ${UNLOCK_ISO}`);
  const vaultEndTs = Math.floor(unlockMs / 1000); // wire + storage unit is SECONDS
  if (vaultEndTs <= Math.floor(Date.now() / 1000)) {
    throw new Error(`UNLOCK_ISO ${UNLOCK_ISO} is not in the future — a locked vault needs a future unlock`);
  }
  const amountMario = AMOUNT_ARIO * ONE_TOKEN;

  const db = new Client({ connectionString: DATABASE_URL });
  await db.connect();
  const who = (await db.query("SELECT current_database() db")).rows[0].db;
  if (who !== "claims_staging") throw new Error(`REFUSING: current_database()=${who}, expected claims_staging`);
  console.log("connected to", who);

  const rcpt = await db.query("SELECT 1 FROM recipients WHERE recipient_id = $1", [RECIPIENT]);
  if (rcpt.rowCount === 0) {
    throw new Error(`recipient ${RECIPIENT} does not exist — seed it first (seed-external.ts)`);
  }

  await db.query("BEGIN");
  // Idempotent: replace only OUR prior locked-vault-demo row for this recipient.
  const old = (await db.query(
    "SELECT asset_key FROM assets WHERE recipient_id = $1 AND source->>'seed' = $2",
    [RECIPIENT, SEED_MARKER],
  )).rows.map((r) => r.asset_key);
  if (old.length) {
    await db.query("DELETE FROM claims WHERE asset_key = ANY($1)", [old]);
    await db.query("DELETE FROM assets WHERE asset_key = ANY($1)", [old]);
    console.log(`wiped ${old.length} prior locked-vault-demo asset(s) for ${RECIPIENT}`);
  }

  const assetKey = randomBytes(32).toString("hex");
  await db.query(
    `INSERT INTO assets (asset_key, asset_type, recipient_id, ant_mint, amount, vault_end_ts, nonce, status, source)
     VALUES ($1,'vault',$2,NULL,$3,$4,$5,'available',$6::jsonb)`,
    [
      assetKey,
      RECIPIENT,
      amountMario.toString(),
      vaultEndTs,
      randomBytes(32),
      JSON.stringify({ external_seed: true, seed: SEED_MARKER, wallet: RECIPIENT, phase: "vault", onchainSeed: "escrow_token" }),
    ],
  );
  await db.query("COMMIT");
  await db.end();

  console.log("\nseeded 1 TIME-LOCKED vault (available):");
  console.log(`  recipient   ${RECIPIENT}`);
  console.log(`  assetKey    ${assetKey}`);
  console.log(`  amount      ${AMOUNT_ARIO} ARIO (${amountMario} mARIO)`);
  console.log(`  vault_end_ts ${vaultEndTs}  (${new Date(vaultEndTs * 1000).toISOString()})`);
}

main().catch((e) => { console.error("seed-locked-vault failed:", e); process.exit(1); });
