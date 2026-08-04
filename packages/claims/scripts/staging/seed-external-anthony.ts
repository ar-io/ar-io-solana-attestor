//! Seed a SECOND external test user ("Anthony") into DEVNET STAGING, exactly like
//! seed-external.ts but parameterized (name-aware ANT + custom amounts). Keys the
//! recipient to Anthony's REAL RSA-4096 modulus so he can claim via his own Wander/
//! ArConnect wallet. Rows are source.external_seed=true so the smoke-suite reseed
//! does NOT wipe them; wipe/reseed is scoped to THIS recipient only (ysuonk et al.
//! untouched). DEVNET / claims_staging ONLY.
//!
//!   MODULUS_FILE=.../anthony-modulus.txt RPC_URL=... WS_URL=... \
//!   DATABASE_URL=<claims_staging> SECURE_DIR=/opt/claims-secure/staging \
//!   node --import tsx scripts/staging/seed-external-anthony.ts

import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { deriveRecipientIdB64Url } from "@ar.io/attestor-canonical";
import { ONE_TOKEN, makeRpc, createCoreAsset } from "./onchain.js";

const RPC_URL = process.env.RPC_URL!;
const WS_URL = process.env.WS_URL!;
const DATABASE_URL = process.env.DATABASE_URL!;
const SECURE_DIR = process.env.SECURE_DIR ?? "/opt/claims-secure/staging";
const MANIFEST = `${SECURE_DIR}/manifest.json`;

const ANT_NAME = process.env.ANT_NAME ?? "anthony";
const TOKEN_ARIO = BigInt(process.env.TOKEN_ARIO ?? "1500");
const VAULT_ARIO = BigInt(process.env.VAULT_ARIO ?? "2000");

function loadModulus(): Uint8Array {
  const b64 = (process.env.MODULUS_B64 ?? (process.env.MODULUS_FILE ? readFileSync(process.env.MODULUS_FILE, "utf8") : "")).trim();
  if (!b64) throw new Error("set MODULUS_FILE or MODULUS_B64 (base64url RSA modulus)");
  let mod = Buffer.from(b64, "base64url");
  if (mod.length === 513 && mod[0] === 0) mod = mod.subarray(1);
  if (mod.length !== 512) throw new Error(`expected 512-byte modulus, got ${mod.length}`);
  return new Uint8Array(mod);
}

async function main(): Promise<void> {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const arioMint = manifest.arioMint as string;
  const modulus = loadModulus();
  const recipientId = deriveRecipientIdB64Url(modulus);
  console.log("external recipientId (== Arweave address):", recipientId);

  const { rpc, sendAndConfirm } = makeRpc(RPC_URL, WS_URL);
  const antAuthority = await createKeyPairSignerFromBytes(
    new Uint8Array(JSON.parse(readFileSync(`${SECURE_DIR}/ant-authority-keypair.json`, "utf8"))),
  );

  const db = new Client({ connectionString: DATABASE_URL });
  await db.connect();
  const who = (await db.query("SELECT current_database() db")).rows[0].db;
  if (who !== "claims_staging") throw new Error(`REFUSING: current_database()=${who}, expected claims_staging`);
  console.log("connected to", who);

  // Idempotent: wipe prior external_seed rows for THIS recipient ONLY, then re-seed.
  await db.query("BEGIN");
  const old = (await db.query(
    "SELECT asset_key FROM assets WHERE recipient_id = $1 AND (source->>'external_seed')::bool IS TRUE",
    [recipientId],
  )).rows.map((r) => r.asset_key);
  await db.query("DELETE FROM claims WHERE asset_key = ANY($1)", [old]);
  await db.query("DELETE FROM assets WHERE asset_key = ANY($1)", [old]);
  await db.query("COMMIT");
  if (old.length) console.log(`wiped ${old.length} prior external assets for this recipient`);

  await db.query(
    `INSERT INTO recipients (recipient_id, protocol, source_address, recipient_pubkey, status)
     VALUES ($1, 0, $1, $2, 'open')
     ON CONFLICT (recipient_id) DO UPDATE SET recipient_pubkey = EXCLUDED.recipient_pubkey, status = 'open'`,
    [recipientId, Buffer.from(modulus)],
  );

  const now = Math.floor(Date.now() / 1000);
  const rand = (): string => randomBytes(32).toString("hex");
  const seeded: { assetKey: string; type: string; amountArio: string | null; onchainName: string | null }[] = [];

  async function seedAsset(a: { assetKey: string; type: "token" | "vault" | "ant"; amount?: bigint; vaultEndTs?: number; antMint?: string; onchainName?: string }): Promise<void> {
    await db.query(
      `INSERT INTO assets (asset_key, asset_type, recipient_id, ant_mint, amount, vault_end_ts, nonce, status, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'available',$8::jsonb)`,
      [a.assetKey, a.type, recipientId, a.antMint ?? null,
        a.amount === undefined ? null : a.amount.toString(), a.vaultEndTs ?? null,
        randomBytes(32), JSON.stringify({ external_seed: true, wallet: recipientId, phase: a.type, onchainSeed: a.type === "ant" ? "escrow_ant" : "escrow_token", ...(a.onchainName ? { arnsName: a.onchainName } : {}) })],
    );
    seeded.push({ assetKey: a.assetKey, type: a.type, amountArio: a.amount === undefined ? null : (a.amount / ONE_TOKEN).toString(), onchainName: a.onchainName ?? null });
  }

  await seedAsset({ assetKey: rand(), type: "token", amount: TOKEN_ARIO * ONE_TOKEN });
  await seedAsset({ assetKey: rand(), type: "vault", amount: VAULT_ARIO * ONE_TOKEN, vaultEndTs: now - 86_400 });
  // ant_name is left NULL at seed time; `backfill:ant-names` decodes it from the
  // on-chain MPL Core `name`. onchainName is recorded only as provenance.
  const antMint = await createCoreAsset(rpc, sendAndConfirm, antAuthority, antAuthority, ANT_NAME);
  await seedAsset({ assetKey: antMint as string, type: "ant", antMint: antMint as string, onchainName: ANT_NAME });
  console.log("minted ANT (MPL Core):", antMint, "on-chain name:", ANT_NAME);

  await db.end();
  console.log(`\nseeded ${seeded.length} external claimables for ${recipientId}:`);
  for (const a of seeded) console.log(`  [${a.type}] key=${a.assetKey} amountArio=${a.amountArio} onchainName=${a.onchainName}`);
}

main().catch((e) => { console.error("seed-external-anthony failed:", e); process.exit(1); });
