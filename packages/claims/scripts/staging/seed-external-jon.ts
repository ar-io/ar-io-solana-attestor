//! Seed a THIRD external test user ("Jon") into DEVNET STAGING with BOTH an
//! Ethereum (MetaMask, secp256k1) AND an Arweave (Wander, RSA-PSS) identity.
//! Same shape as seed-external.ts but two recipients. ETH recipients are keyed to
//! the ADDRESS (20 bytes) exactly as the ledger/frontend do:
//!   recipientId    = deriveRecipientIdB64Url(addressBytes)
//!   source_address = lowercase 0x-hex (normalizeSourceAddress)
//!   recipient_pubkey = the 20 address bytes (protocol=1)
//! Rows are source.external_seed=true; wipe/reseed is scoped to THESE two
//! recipients only. DEVNET / claims_staging ONLY.
//!
//!   ETH_ADDRESS=0x.. AR_MODULUS_FILE=.../jon-modulus.txt RPC_URL=.. WS_URL=.. \
//!   DATABASE_URL=<claims_staging> SECURE_DIR=/opt/claims-secure/staging \
//!   node --import tsx scripts/staging/seed-external-jon.ts

import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";
import { deriveRecipientIdB64Url } from "@ar.io/attestor-canonical";
import { normalizeSourceAddress } from "../../src/ledger/normalize.js";
import { ONE_TOKEN, makeRpc, createCoreAsset } from "./onchain.js";

const RPC_URL = process.env.RPC_URL!;
const WS_URL = process.env.WS_URL!;
const DATABASE_URL = process.env.DATABASE_URL!;
const SECURE_DIR = process.env.SECURE_DIR ?? "/opt/claims-secure/staging";
const MANIFEST = `${SECURE_DIR}/manifest.json`;

const ETH_ADDRESS = process.env.ETH_ADDRESS!;
const AR_MODULUS_FILE = process.env.AR_MODULUS_FILE!;

function loadModulus(file: string): Uint8Array {
  let mod = Buffer.from(readFileSync(file, "utf8").trim(), "base64url");
  if (mod.length === 513 && mod[0] === 0) mod = mod.subarray(1);
  if (mod.length !== 512) throw new Error(`expected 512-byte modulus, got ${mod.length}`);
  return new Uint8Array(mod);
}
function ethAddressBytes(addr: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error(`bad ETH address: ${addr}`);
  return new Uint8Array(Buffer.from(addr.slice(2), "hex"));
}

interface SeededRow { recipientId: string; assetKey: string; type: string; amountArio: string | null; onchainName: string | null }

async function main(): Promise<void> {
  JSON.parse(readFileSync(MANIFEST, "utf8")); // asserts secure dir wiring

  // ---- derive both identities ----
  const ethBytes = ethAddressBytes(ETH_ADDRESS);
  const ethRecipientId = deriveRecipientIdB64Url(ethBytes);
  const ethSource = normalizeSourceAddress(ETH_ADDRESS);

  const arModulus = loadModulus(AR_MODULUS_FILE);
  const arRecipientId = deriveRecipientIdB64Url(arModulus);

  console.log("ETH recipientId:", ethRecipientId, " source:", ethSource);
  console.log("AR  recipientId:", arRecipientId);

  const { rpc, sendAndConfirm } = makeRpc(RPC_URL, WS_URL);
  const antAuthority = await createKeyPairSignerFromBytes(
    new Uint8Array(JSON.parse(readFileSync(`${SECURE_DIR}/ant-authority-keypair.json`, "utf8"))),
  );

  const db = new Client({ connectionString: DATABASE_URL });
  await db.connect();
  const who = (await db.query("SELECT current_database() db")).rows[0].db;
  if (who !== "claims_staging") throw new Error(`REFUSING: current_database()=${who}, expected claims_staging`);
  console.log("connected to", who);

  // Idempotent: wipe prior external_seed rows for THESE TWO recipients only.
  await db.query("BEGIN");
  const old = (await db.query(
    "SELECT asset_key FROM assets WHERE recipient_id = ANY($1) AND (source->>'external_seed')::bool IS TRUE",
    [[ethRecipientId, arRecipientId]],
  )).rows.map((r) => r.asset_key);
  await db.query("DELETE FROM claims WHERE asset_key = ANY($1)", [old]);
  await db.query("DELETE FROM assets WHERE asset_key = ANY($1)", [old]);
  await db.query("COMMIT");
  if (old.length) console.log(`wiped ${old.length} prior external assets for Jon`);

  // recipients: ETH (protocol=1, pubkey=address) + AR (protocol=0, pubkey=modulus).
  await db.query(
    `INSERT INTO recipients (recipient_id, protocol, source_address, recipient_pubkey, status)
     VALUES ($1, 1, $2, $3, 'open')
     ON CONFLICT (recipient_id) DO UPDATE SET recipient_pubkey = EXCLUDED.recipient_pubkey, source_address = EXCLUDED.source_address, status = 'open'`,
    [ethRecipientId, ethSource, Buffer.from(ethBytes)],
  );
  await db.query(
    `INSERT INTO recipients (recipient_id, protocol, source_address, recipient_pubkey, status)
     VALUES ($1, 0, $1, $2, 'open')
     ON CONFLICT (recipient_id) DO UPDATE SET recipient_pubkey = EXCLUDED.recipient_pubkey, status = 'open'`,
    [arRecipientId, Buffer.from(arModulus)],
  );

  const now = Math.floor(Date.now() / 1000);
  const rand = (): string => randomBytes(32).toString("hex");
  const seeded: SeededRow[] = [];

  async function seedAsset(recipientId: string, a: { assetKey: string; type: "token" | "vault" | "ant"; amount?: bigint; vaultEndTs?: number; antMint?: string; onchainName?: string }): Promise<void> {
    await db.query(
      `INSERT INTO assets (asset_key, asset_type, recipient_id, ant_mint, amount, vault_end_ts, nonce, status, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'available',$8::jsonb)`,
      [a.assetKey, a.type, recipientId, a.antMint ?? null,
        a.amount === undefined ? null : a.amount.toString(), a.vaultEndTs ?? null,
        randomBytes(32), JSON.stringify({ external_seed: true, wallet: recipientId, phase: a.type, onchainSeed: a.type === "ant" ? "escrow_ant" : "escrow_token", ...(a.onchainName ? { arnsName: a.onchainName } : {}) })],
    );
    seeded.push({ recipientId, assetKey: a.assetKey, type: a.type, amountArio: a.amount === undefined ? null : (a.amount / ONE_TOKEN).toString(), onchainName: a.onchainName ?? null });
  }
  async function seedTriple(recipientId: string, tokenArio: bigint, vaultArio: bigint, antName: string, auth: KeyPairSigner): Promise<void> {
    await seedAsset(recipientId, { assetKey: rand(), type: "token", amount: tokenArio * ONE_TOKEN });
    await seedAsset(recipientId, { assetKey: rand(), type: "vault", amount: vaultArio * ONE_TOKEN, vaultEndTs: now - 86_400 });
    const mint = await createCoreAsset(rpc, sendAndConfirm, auth, auth, antName);
    await seedAsset(recipientId, { assetKey: mint as string, type: "ant", antMint: mint as string, onchainName: antName });
    console.log(`  minted ANT "${antName}" mint=${mint} for ${recipientId.slice(0, 10)}…`);
  }

  // ETH is the priority (old ARIO-AO assets): 2,500 token, 1,000 vault, ANT "jon".
  await seedTriple(ethRecipientId, 2500n, 1000n, "jon", antAuthority);
  // AR: 1,000 token, 1,000 vault, ANT "jon-ar".
  await seedTriple(arRecipientId, 1000n, 1000n, "jon-ar", antAuthority);

  await db.end();
  console.log(`\nseeded ${seeded.length} external claimables for Jon (ETH + AR):`);
  for (const a of seeded) console.log(`  [${a.type}] recip=${a.recipientId.slice(0, 10)}… key=${a.assetKey} amountArio=${a.amountArio} onchainName=${a.onchainName}`);
}

main().catch((e) => { console.error("seed-external-jon failed:", e); process.exit(1); });
