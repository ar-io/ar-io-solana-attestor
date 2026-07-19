//! DEVNET STAGING seeder / re-seeder. Wipes the previously-seeded staging claimable
//! assets (marker source.staging_seed=true) from claims_staging and re-seeds a fresh
//! set of PERSISTENT `available` claimables (a few token / vault / ant) tied to AR/ETH
//! identities we control. Mints REAL MPL Core ANT assets under the staging ANT
//! authority. Writes seed-manifest.json (asset list + identity key material) for the
//! claim drivers + the test guide.
//!
//! SAFETY: refuses to run unless current_database() === 'claims_staging'.
//! DEVNET ONLY.
//!
//!   RPC_URL=... WS_URL=... DATABASE_URL=<claims_staging> SECURE_DIR=/opt/claims-secure/staging \
//!     node --import tsx scripts/staging/seed.ts

import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { Client } from "pg";
import { createKeyPairSignerFromBytes, type Address } from "@solana/kit";
import { makeArIdentity, makeEthIdentity, type ArIdentity, type EthIdentity } from "../../src/api/proof-testkit.js";
import { ONE_TOKEN, makeRpc, createCoreAsset } from "./onchain.js";

const RPC_URL = process.env.RPC_URL!;
const WS_URL = process.env.WS_URL!;
const DATABASE_URL = process.env.DATABASE_URL!;
const SECURE_DIR = process.env.SECURE_DIR ?? "/opt/claims-secure/staging";
const MANIFEST = `${SECURE_DIR}/manifest.json`;
const SEED_MANIFEST = `${SECURE_DIR}/seed-manifest.json`;

interface AssetRec {
  assetKey: string;
  type: "token" | "vault" | "ant";
  amountArio: string | null;
  amountMario: string | null;
  vaultEndTs: number | null;
  antMint: string | null;
  recipientId: string;
  protocol: "arweave" | "ethereum";
  expected: string; // human note: auto-dispensed | manual-queue
  label: string;
  status?: string;  // asset status when != 'available' (e.g. manual_review for AT-RISK)
  kind?: string;    // smoke-suite marker: bigclaim | atrisk
}
interface IdentityRec {
  recipientId: string;
  protocol: "arweave" | "ethereum";
  arPrivPkcs8Pem?: string;
  modulusBase64?: string;
  ethPrivHex?: string;
  addressLower?: string;
}

async function main(): Promise<void> {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const arioMint = manifest.arioMint as string;
  const { rpc, sendAndConfirm } = makeRpc(RPC_URL, WS_URL);
  const antAuthorityArr = new Uint8Array(JSON.parse(readFileSync(`${SECURE_DIR}/ant-authority-keypair.json`, "utf8")));
  const antAuthority = await createKeyPairSignerFromBytes(antAuthorityArr);

  const db = new Client({ connectionString: DATABASE_URL });
  await db.connect();
  const who = (await db.query("SELECT current_database() db")).rows[0].db;
  if (who !== "claims_staging") throw new Error(`REFUSING to seed: current_database()=${who}, expected claims_staging`);
  console.log("connected to", who);

  // ---- wipe previously-seeded staging rows (only staging_seed=true) ----
  await db.query("BEGIN");
  const oldAssets = (await db.query("SELECT asset_key, recipient_id FROM assets WHERE (source->>'staging_seed')::bool IS TRUE")).rows;
  const oldKeys = oldAssets.map((r) => r.asset_key);
  const oldRecips = [...new Set(oldAssets.map((r) => r.recipient_id))];
  await db.query("DELETE FROM claims WHERE asset_key = ANY($1)", [oldKeys]);
  await db.query("DELETE FROM assets WHERE asset_key = ANY($1)", [oldKeys]);
  // Delete the (now orphaned) staging recipients — only those with no remaining assets.
  await db.query(
    `DELETE FROM recipients r WHERE r.recipient_id = ANY($1)
       AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.recipient_id = r.recipient_id)`,
    [oldRecips],
  );
  await db.query("COMMIT");
  console.log(`wiped ${oldKeys.length} old staging assets, ${oldRecips.length} recipients`);

  const identities: Record<string, IdentityRec> = {};
  const assets: AssetRec[] = [];

  async function seedRecipientAr(id: ArIdentity): Promise<void> {
    await db.query(
      `INSERT INTO recipients (recipient_id, protocol, source_address, recipient_pubkey, status)
       VALUES ($1, 0, $1, $2, 'open') ON CONFLICT (recipient_id) DO NOTHING`,
      [id.recipientId, Buffer.from(id.modulus)],
    );
    identities[id.recipientId] = {
      recipientId: id.recipientId, protocol: "arweave",
      arPrivPkcs8Pem: id.privateKey.export({ type: "pkcs8", format: "pem" }) as string,
      modulusBase64: Buffer.from(id.modulus).toString("base64"),
    };
  }
  async function seedRecipientEth(id: EthIdentity): Promise<void> {
    await db.query(
      `INSERT INTO recipients (recipient_id, protocol, source_address, recipient_pubkey, status)
       VALUES ($1, 1, $2, $3, 'open') ON CONFLICT (recipient_id) DO NOTHING`,
      [id.recipientId, id.addressLower, Buffer.from(id.address)],
    );
    identities[id.recipientId] = {
      recipientId: id.recipientId, protocol: "ethereum",
      ethPrivHex: Buffer.from(id.priv).toString("hex"), addressLower: id.addressLower,
    };
  }
  async function seedAsset(recipientId: string, protocol: "arweave" | "ethereum", a: {
    assetKey: string; assetType: "token" | "vault" | "ant"; amount?: bigint; vaultEndTs?: number; antMint?: string;
    expected: string; label: string; status?: string; kind?: string;
  }): Promise<void> {
    const status = a.status ?? "available";
    await db.query(
      `INSERT INTO assets (asset_key, asset_type, recipient_id, ant_mint, amount, vault_end_ts, nonce, status, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [a.assetKey, a.assetType, recipientId, a.antMint ?? null,
        a.amount === undefined ? null : a.amount.toString(), a.vaultEndTs ?? null,
        randomBytes(32), status, JSON.stringify({ staging_seed: true, phase: a.assetType, kind: a.kind, onchainSeed: a.assetType === "ant" ? "escrow_ant" : "escrow_token" })],
    );
    assets.push({
      assetKey: a.assetKey, type: a.assetType,
      amountArio: a.amount === undefined ? null : (a.amount / ONE_TOKEN).toString(),
      amountMario: a.amount === undefined ? null : a.amount.toString(),
      vaultEndTs: a.vaultEndTs ?? null, antMint: a.antMint ?? null,
      recipientId, protocol, expected: a.expected, label: a.label,
      status, kind: a.kind,
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const rand = (): string => randomBytes(32).toString("hex");

  // ---- identities ----
  const arToken = makeArIdentity();
  const ethToken = makeEthIdentity();
  const arVault = makeArIdentity();       // holds both vault assets
  const arAnt = makeArIdentity();
  const ethAnt = makeEthIdentity();
  await seedRecipientAr(arToken);
  await seedRecipientEth(ethToken);
  await seedRecipientAr(arVault);
  await seedRecipientAr(arAnt);
  await seedRecipientEth(ethAnt);

  // ---- tokens (auto-dispensed by the worker) ----
  await seedAsset(arToken.recipientId, "arweave", { assetKey: rand(), assetType: "token", amount: 1234n * ONE_TOKEN, expected: "auto-dispensed (worker)", label: "AR token 1,234 ARIO" });
  await seedAsset(ethToken.recipientId, "ethereum", { assetKey: rand(), assetType: "token", amount: 2000n * ONE_TOKEN, expected: "auto-dispensed (worker)", label: "ETH token 2,000 ARIO" });

  // ---- vaults: expired -> liquid (auto), active -> manual queue (routed to review) ----
  await seedAsset(arVault.recipientId, "arweave", { assetKey: rand(), assetType: "vault", amount: 5000n * ONE_TOKEN, vaultEndTs: now - 86_400, expected: "auto-dispensed liquid (worker)", label: "AR vault 5,000 ARIO (EXPIRED->liquid)" });
  await seedAsset(arVault.recipientId, "arweave", { assetKey: rand(), assetType: "vault", amount: 3000n * ONE_TOKEN, vaultEndTs: now + 200 * 86_400, expected: "routed to operator manual-queue (still locked)", label: "AR vault 3,000 ARIO (ACTIVE->manual queue)" });

  // ---- ANTs: real MPL Core assets minted under the staging ANT authority ----
  const antMintAr = await createCoreAsset(rpc, sendAndConfirm, antAuthority, antAuthority, "stg-ar-ant");
  const antMintEth = await createCoreAsset(rpc, sendAndConfirm, antAuthority, antAuthority, "stg-eth-ant");
  console.log("minted ANT (AR)", antMintAr, "ANT (ETH)", antMintEth);
  await seedAsset(arAnt.recipientId, "arweave", { assetKey: antMintAr as string, assetType: "ant", antMint: antMintAr as string, expected: "operator-wallet ANT dispatch (ant-admin)", label: "AR ANT (MPL Core)" });
  await seedAsset(ethAnt.recipientId, "ethereum", { assetKey: antMintEth as string, assetType: "ant", antMint: antMintEth as string, expected: "operator-wallet ANT dispatch (ant-admin)", label: "ETH ANT (MPL Core)" });

  // ---- optional smoke-suite extras (SEED_SMOKE_EXTRAS=1): big-claim + AT-RISK ----
  if (process.env.SEED_SMOKE_EXTRAS === "1") {
    // >100k-ARIO token -> the whale brake routes complete to pending_review.
    const ethBig = makeEthIdentity();
    await seedRecipientEth(ethBig);
    await seedAsset(ethBig.recipientId, "ethereum", { assetKey: rand(), assetType: "token", amount: 150_000n * ONE_TOKEN, expected: "big-claim brake -> pending_review (needs approval)", label: "ETH token 150,000 ARIO (BIG-CLAIM)", kind: "bigclaim" });
    // AT-RISK: a manual_review asset that MUST be hidden as 404 (never self-serve).
    const arRisk = makeArIdentity();
    await seedRecipientAr(arRisk);
    await seedAsset(arRisk.recipientId, "arweave", { assetKey: rand(), assetType: "token", amount: 999n * ONE_TOKEN, status: "manual_review", expected: "AT-RISK: hidden as 404 ASSET_NOT_FOUND (never self-serve)", label: "AR token 999 ARIO (AT-RISK/manual_review)", kind: "atrisk" });
    console.log("seeded smoke extras: bigclaim + atrisk");
  }

  const seedManifest = { seededAt: new Date().toISOString(), arioMint, antAuthority: antAuthority.address, assets, identities };
  writeFileSync(SEED_MANIFEST, JSON.stringify(seedManifest, null, 2));
  chmodSync(SEED_MANIFEST, 0o600);
  await db.end();

  console.log(`\nseeded ${assets.length} claimable assets -> ${SEED_MANIFEST}`);
  for (const a of assets) console.log(`  [${a.type}] ${a.label}  assetKey=${a.assetKey.slice(0, 16)}...  recipient=${a.recipientId.slice(0, 12)}...  (${a.expected})`);
}

main().catch((e) => { console.error("seed failed:", e); process.exit(1); });
