//! Transparency keys (M6) — SEPARATE from the treasury + attestor keys.
//!
//! Two Ed25519 keys, both distinct from the hot dispenser (treasury) and the
//! attestor signing key (BUILD.md non-negotiable — separable blast radii):
//!
//!   * AUDIT key      — signs each `audit_log.entry_hash` (schema §3.1: "Ed25519
//!                      over entry_hash by the AUDIT key (!= attestor, != treasury)").
//!   * PUBLISHER key  — signs the published-ledger manifest (the Merkle-root
//!                      commitment) AND is the fee-payer/signer of the on-chain
//!                      anchor memo tx. This is the "ledger-publisher / anchor"
//!                      key of the deliverable.
//!
//! Loading precedence per key (same discipline as the treasury key — sealed at
//! rest, passphrase injected separately; a bare seed is localnet/tests only):
//!   1. <PREFIX>_KEY_SEALED_PATH + <PREFIX>_KEY_PASSPHRASE  -> AES-256-GCM blob
//!   2. <PREFIX>_SEED_BASE64                                -> raw 32-byte seed
//! Prefixes: AUDIT (audit key), LEDGER_PUBLISHER (publisher/anchor key).
//!
//! NOTHING here is a secret at rest: `.env.example` carries placeholders only.

import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import bs58 from "bs58";
import * as ed25519 from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2";

import { openSecret, type SealedKey } from "../dispatch/crypto-box.js";

// @noble/ed25519 v2 needs sha512 wired for sync sign/verify (same as attest.ts).
ed25519.etc.sha512Sync = (...m) => sha512(ed25519.etc.concatBytes(...m));

export type TransparencyRole = "audit" | "publisher";

export interface TransparencyKeypair {
  readonly role: TransparencyRole;
  /** 32-byte Ed25519 seed (secret). */
  readonly secretKey: Uint8Array;
  /** 32-byte Ed25519 public key, derived once. */
  readonly publicKey: Uint8Array;
  /** Sign arbitrary bytes; returns the 64-byte Ed25519 signature. */
  sign(message: Uint8Array): Uint8Array;
}

export function keypairFromSeed(role: TransparencyRole, seed: Uint8Array): TransparencyKeypair {
  if (seed.length !== 32) throw new Error(`${role} seed must be 32 bytes, got ${seed.length}`);
  const publicKey = ed25519.getPublicKey(seed);
  return {
    role,
    secretKey: seed,
    publicKey,
    sign: (message: Uint8Array) => ed25519.sign(message, seed),
  };
}

/** Verify a detached Ed25519 signature (used by the standalone verifier). */
export function verifyEd25519(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

const ENV_PREFIX: Record<TransparencyRole, string> = {
  audit: "AUDIT",
  publisher: "LEDGER_PUBLISHER",
};

/** Load a transparency key seed from env (sealed blob preferred). */
export function loadTransparencySeed(
  role: TransparencyRole,
  env: NodeJS.ProcessEnv = process.env,
): Uint8Array | undefined {
  const prefix = ENV_PREFIX[role];
  const sealedPath = env[`${prefix}_KEY_SEALED_PATH`];
  const passphrase = env[`${prefix}_KEY_PASSPHRASE`];
  if (sealedPath && passphrase) {
    const sealed = JSON.parse(readFileSync(sealedPath, "utf8")) as SealedKey;
    return openSecret(sealed, passphrase);
  }
  const seedB64 = env[`${prefix}_SEED_BASE64`];
  if (seedB64) {
    const seed = new Uint8Array(Buffer.from(seedB64, "base64"));
    if (seed.length !== 32) throw new Error(`${prefix}_SEED_BASE64 must decode to 32 bytes, got ${seed.length}`);
    return seed;
  }
  return undefined;
}

export function loadTransparencyKeypair(
  role: TransparencyRole,
  env: NodeJS.ProcessEnv = process.env,
): TransparencyKeypair | undefined {
  const seed = loadTransparencySeed(role, env);
  return seed ? keypairFromSeed(role, seed) : undefined;
}

/**
 * The treasury + attestor addresses the transparency keys must NOT reuse, sourced
 * from whatever env exposes (best-effort; only PUBLIC data): TREASURY_ADDRESS and
 * the attestor pubkey (hex or base58). Used by `assertTransparencyKeysDistinct`.
 */
export function loadReservedAddresses(env: NodeJS.ProcessEnv = process.env): { label: string; address: string }[] {
  const out: { label: string; address: string }[] = [];
  if (env.TREASURY_ADDRESS) out.push({ label: "treasury", address: env.TREASURY_ADDRESS });
  if (env.ATTESTOR_PUBKEY_BASE58) out.push({ label: "attestor", address: env.ATTESTOR_PUBKEY_BASE58 });
  else if (env.ATTESTOR_PUBKEY_HEX) out.push({ label: "attestor", address: bs58.encode(Buffer.from(env.ATTESTOR_PUBKEY_HEX, "hex")) });
  return out;
}

/** base58 Solana address of a transparency key. */
export function transparencyAddress(kp: TransparencyKeypair): string {
  return bs58.encode(kp.publicKey);
}

/** Guard: the two transparency keys must be distinct from each other. */
export function assertTransparencyKeysSeparable(
  audit: TransparencyKeypair,
  publisher: TransparencyKeypair,
): void {
  if (Buffer.from(audit.publicKey).equals(Buffer.from(publisher.publicKey))) {
    throw new Error("audit key and publisher key must be different Ed25519 keys");
  }
}

/**
 * Guard: every transparency key MUST be distinct from each other AND from the
 * treasury + attestor keys (separable blast radii — BUILD.md). Today the
 * separation is env-prefix convention only; this enforces it by comparing the
 * derived Solana addresses. `reserved` carries the treasury dispenser + attestor
 * addresses (base58) when known (the CLIs pass what env exposes).
 */
export function assertTransparencyKeysDistinct(
  keys: TransparencyKeypair[],
  reserved: { label: string; address: string }[] = [],
): void {
  const seen = new Map<string, string>();
  for (const r of reserved) if (r.address) seen.set(r.address, r.label);
  for (const k of keys) {
    const addr = transparencyAddress(k);
    const clash = seen.get(addr);
    if (clash) {
      throw new Error(
        `transparency ${k.role} key reuses the ${clash} key (${addr}); the audit + publisher keys must be separate from the treasury and attestor keys`,
      );
    }
    seen.set(addr, `transparency:${k.role}`);
  }
}
