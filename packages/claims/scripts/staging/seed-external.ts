//! Seed DEVNET STAGING claimables for an EXTERNAL Arweave wallet (public key only).
//! Unlike seed.ts (which generates identities we control), this keys the recipient to
//! a REAL user's RSA-4096 modulus so they can claim via their own ArConnect wallet in
//! the browser. We store ONLY the modulus (public key) + verify signatures against it;
//! the user signs the claim in their wallet. The recipientId is derived EXACTLY as the
//! ledger + frontend do (deriveRecipientIdB64Url over the modulus), so the frontend's
//! GET /v1/claimable?recipientId=<from ArConnect getActivePublicKey> matches.
//!
//! These rows are marked source.external_seed=true (NOT staging_seed), so the
//! smoke-suite reseed does NOT wipe them. DEVNET ONLY; refuses non-claims_staging.
//!
//!   MODULUS_FILE=/path/to/user-modulus.txt   (base64url modulus)   OR MODULUS_B64=...
//!   RPC_URL=... WS_URL=... DATABASE_URL=<claims_staging> SECURE_DIR=/opt/claims-secure/staging \
//!     node --import tsx scripts/staging/seed-external.ts

import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { Client } from "pg";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { deriveRecipientIdB64Url } from "@ar.io/attestor-canonical";
import { ONE_TOKEN, makeRpc, createCoreAsset } from "./onchain.js";

const RPC_URL = process.env.RPC_URL!;
const WS_URL = process.env.WS_URL!;
const DATABASE_URL = process.env.DATABASE_URL!;
const SECURE_DIR = process.env.SECURE_DIR ?? "/opt/claims-secure/staging";
const MANIFEST = `${SECURE_DIR}/manifest.json`;
const OUT = `${SECURE_DIR}/external-seed-manifest.json`;

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

  // Idempotent: wipe prior external_seed rows for THIS recipient, then re-seed.
  await db.query("BEGIN");
  const old = (await db.query(
    "SELECT asset_key FROM assets WHERE recipient_id = $1 AND (source->>'external_seed')::bool IS TRUE",
    [recipientId],
  )).rows.map((r) => r.asset_key);
  await db.query("DELETE FROM claims WHERE asset_key = ANY($1)", [old]);
  await db.query("DELETE FROM assets WHERE asset_key = ANY($1)", [old]);
  await db.query("COMMIT");
  if (old.length) console.log(`wiped ${old.length} prior external assets for this recipient`);

  // Recipient keyed to the EXTERNAL modulus (protocol=0 arweave, public key only).
  await db.query(
    `INSERT INTO recipients (recipient_id, protocol, source_address, recipient_pubkey, status)
     VALUES ($1, 0, $1, $2, 'open')
     ON CONFLICT (recipient_id) DO UPDATE SET recipient_pubkey = EXCLUDED.recipient_pubkey, status = 'open'`,
    [recipientId, Buffer.from(modulus)],
  );

  const now = Math.floor(Date.now() / 1000);
  const rand = (): string => randomBytes(32).toString("hex");
  const assets: { assetKey: string; type: string; amountArio: string | null; antMint: string | null; label: string }[] = [];

  async function seedAsset(a: { assetKey: string; type: "token" | "vault" | "ant"; amount?: bigint; vaultEndTs?: number; antMint?: string; label: string }): Promise<void> {
    await db.query(
      `INSERT INTO assets (asset_key, asset_type, recipient_id, ant_mint, amount, vault_end_ts, nonce, status, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'available',$8::jsonb)`,
      [a.assetKey, a.type, recipientId, a.antMint ?? null,
        a.amount === undefined ? null : a.amount.toString(), a.vaultEndTs ?? null,
        randomBytes(32), JSON.stringify({ external_seed: true, wallet: recipientId, phase: a.type, onchainSeed: a.type === "ant" ? "escrow_ant" : "escrow_token" })],
    );
    assets.push({ assetKey: a.assetKey, type: a.type, amountArio: a.amount === undefined ? null : (a.amount / ONE_TOKEN).toString(), antMint: a.antMint ?? null, label: a.label });
  }

  // 1 token (auto-dispensed), 1 vault expired->liquid (auto-dispensed), 1 ANT (name).
  await seedAsset({ assetKey: rand(), type: "token", amount: 1000n * ONE_TOKEN, label: "token 1,000 ARIO (auto-dispensed)" });
  await seedAsset({ assetKey: rand(), type: "vault", amount: 3000n * ONE_TOKEN, vaultEndTs: now - 86_400, label: "vault 3,000 ARIO (EXPIRED->liquid, auto-dispensed)" });
  const antMint = await createCoreAsset(rpc, sendAndConfirm, antAuthority, antAuthority, "stg-user-ant");
  await seedAsset({ assetKey: antMint as string, type: "ant", antMint: antMint as string, label: "ANT / name (MPL Core, operator-signer dispatch)" });
  console.log("minted user ANT (MPL Core):", antMint);

  await db.end();
  const out = { seededAt: new Date().toISOString(), arioMint, recipientId, wallet: recipientId, assets };
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  chmodSync(OUT, 0o600);

  console.log(`\nseeded ${assets.length} external claimables -> ${OUT}`);
  for (const a of assets) console.log(`  [${a.type}] ${a.label}  assetKey=${a.assetKey}`);
}

main().catch((e) => { console.error("seed-external failed:", e); process.exit(1); });
