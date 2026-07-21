//! Test-only helpers: mint synthetic recipient identities we control the keys
//! for, sign the SERVER-issued canonical message, and seed/clean the ledger.
//!
//! Excluded from the build (`*.testkit.ts` in tsconfig exclude) — never shipped.
//! Real recipients' keys are theirs alone; to exercise `complete` end-to-end we
//! stand up throwaway AR (RSA-4096) and ETH (secp256k1) identities, insert them
//! as `recipients` rows, and sign whatever canonical the API hands back. This is
//! the same technique the M2 golden vectors use — the canonical bytes are
//! server-built from ledger state, so a self-signed proof is a faithful drive.

import { createPublicKey, generateKeyPairSync, randomBytes, sign as nodeSign, type KeyObject } from "node:crypto";
import { Buffer } from "node:buffer";
import { constants as cryptoConstants } from "node:crypto";
import { getPublicKey, signAsync } from "@noble/secp256k1";
import { deriveRecipientIdB64Url } from "@ar.io/attestor-canonical";
import type { Pool } from "pg";

import { deriveEthereumAddress, eip191Hash } from "../verify/ethereum.js";

// --------------------------- Ethereum identity -----------------------------
export interface EthIdentity {
  priv: Uint8Array;
  address: Uint8Array; // 20 bytes
  addressLower: string; // 0x-hex lowercase
  recipientId: string;
}

export function makeEthIdentity(): EthIdentity {
  const priv = randomBytes(32);
  const pub65 = getPublicKey(priv, false); // uncompressed 0x04||X||Y
  const address = deriveEthereumAddress(pub65);
  const addressLower = "0x" + Buffer.from(address).toString("hex");
  return { priv, address, addressLower, recipientId: deriveRecipientIdB64Url(address) };
}

/** personal_sign over `canonical`: r||s||v (v = 27 + recovery), low-S (noble default). */
export async function signEthCanonical(priv: Uint8Array, canonical: Uint8Array): Promise<Uint8Array> {
  const hash = eip191Hash(canonical);
  const sig = await signAsync(hash, priv); // lowS enforced by default
  const compact = sig.toCompactRawBytes(); // 64 bytes r||s
  const out = new Uint8Array(65);
  out.set(compact, 0);
  out[64] = 27 + sig.recovery;
  return out;
}

// --------------------------- Arweave identity ------------------------------
export interface ArIdentity {
  privateKey: KeyObject;
  modulus: Uint8Array; // 512 bytes big-endian
  recipientId: string; // == arweave address == b64url(sha256(modulus))
}

export function makeArIdentity(): ArIdentity {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 4096 });
  const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as { n: string };
  let modulus = Buffer.from(jwk.n, "base64url");
  // Normalize to exactly 512 bytes big-endian (strip a leading 0x00 or left-pad).
  if (modulus.length === 513 && modulus[0] === 0) modulus = modulus.subarray(1);
  if (modulus.length < 512) modulus = Buffer.concat([Buffer.alloc(512 - modulus.length), modulus]);
  if (modulus.length !== 512) throw new Error(`unexpected modulus length ${modulus.length}`);
  const mod = new Uint8Array(modulus);
  return { privateKey, modulus: mod, recipientId: deriveRecipientIdB64Url(mod) };
}

/** RSA-PSS/SHA-256 over `canonical`, returning the 512-byte signature. */
export function signArCanonical(privateKey: KeyObject, canonical: Uint8Array, saltLength: number): Uint8Array {
  const sig = nodeSign("sha256", Buffer.from(canonical), {
    key: privateKey,
    padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
    saltLength,
  });
  return new Uint8Array(sig);
}

// ------------------------------ ledger seeding -----------------------------
export interface SeedAsset {
  assetKey: string;
  assetType: "ant" | "token" | "vault";
  antMint?: string | null;
  antName?: string | null;
  amount?: bigint | null;
  vaultEndTs?: number | null;
  status?: string;
}

export async function insertRecipient(
  pool: Pool,
  r: { recipientId: string; protocol: 0 | 1; sourceAddress: string; recipientPubkey: Uint8Array; status?: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO recipients (recipient_id, protocol, source_address, recipient_pubkey, status)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (recipient_id) DO UPDATE SET recipient_pubkey = EXCLUDED.recipient_pubkey`,
    [r.recipientId, r.protocol, r.sourceAddress, Buffer.from(r.recipientPubkey), r.status ?? "open"],
  );
}

export async function insertAsset(
  pool: Pool,
  recipientId: string,
  a: SeedAsset,
): Promise<void> {
  await pool.query(
    `INSERT INTO assets (asset_key, asset_type, recipient_id, ant_mint, ant_name, amount, vault_end_ts, nonce, status, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
     ON CONFLICT (asset_key) DO UPDATE SET status = EXCLUDED.status, amount = EXCLUDED.amount, ant_name = EXCLUDED.ant_name`,
    [
      a.assetKey,
      a.assetType,
      recipientId,
      a.antMint ?? null,
      a.antName ?? null,
      a.amount === undefined || a.amount === null ? null : a.amount.toString(),
      a.vaultEndTs ?? null,
      randomBytes(32),
      a.status ?? "available",
      JSON.stringify({ phase: a.assetType === "ant" ? "ant" : "token", onchainSeed: a.assetType === "ant" ? "escrow_ant" : "escrow_token", test: true }),
    ],
  );
}

/** Remove all claims/assets/recipients created for a set of asset+recipient keys. */
export async function cleanup(pool: Pool, assetKeys: string[], recipientIds: string[]): Promise<void> {
  await pool.query("DELETE FROM claims WHERE asset_key = ANY($1)", [assetKeys]);
  await pool.query("DELETE FROM assets WHERE asset_key = ANY($1)", [assetKeys]);
  await pool.query("DELETE FROM recipients WHERE recipient_id = ANY($1)", [recipientIds]);
}

/** A short, unique, base58-looking claimant for tests. */
export function randomClaimant(): string {
  // 32 random bytes -> base58 is 43-44 chars; but we only need something that
  // passes the base58 regex + decodes to 32 bytes. Reuse a fixed valid one with
  // a random suffix is unsafe (length), so derive from a secp pubkey (32B x-coord not guaranteed);
  // simplest: use a known-good 32-byte base58 by encoding random bytes.
  return base58Encode(randomBytes(32));
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(bytes: Uint8Array): string {
  let x = 0n;
  for (const b of bytes) x = x * 256n + BigInt(b);
  let out = "";
  while (x > 0n) {
    const r = Number(x % 58n);
    x = x / 58n;
    out = B58[r] + out;
  }
  for (const b of bytes) {
    if (b === 0) out = "1" + out;
    else break;
  }
  return out;
}
