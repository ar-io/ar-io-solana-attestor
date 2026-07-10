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

/** Guard: the two transparency keys must be distinct from each other. */
export function assertTransparencyKeysSeparable(
  audit: TransparencyKeypair,
  publisher: TransparencyKeypair,
): void {
  if (Buffer.from(audit.publicKey).equals(Buffer.from(publisher.publicKey))) {
    throw new Error("audit key and publisher key must be different Ed25519 keys");
  }
}
