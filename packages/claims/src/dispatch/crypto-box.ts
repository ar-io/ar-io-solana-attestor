//! Encrypted-at-rest secret box for the treasury dispensing key (M4).
//!
//! The hot dispenser keypair MUST NOT live on disk in the clear (pivot plan
//! §4.3: "dispenser secret in a cloud KMS/secrets-manager, never on disk
//! unencrypted"). This is the reference at-rest format used when the operator
//! runs the encrypted-hot-key signer (the default `DispenserSigner`): the 32-byte
//! Ed25519 seed is sealed with AES-256-GCM under a key derived from an operator
//! passphrase via scrypt. The sealed blob is what may be committed to a secrets
//! store / mounted as a file; the passphrase (the KEK) is injected separately at
//! runtime (env / KMS), so neither half alone yields the key.
//!
//! Format (all base64 in a small JSON envelope, versioned):
//!   { v:1, kdf:"scrypt", N,r,p, salt, iv, ct }  where ct = AES-256-GCM(seed)
//!   with the 16-byte GCM auth tag appended to the ciphertext.
//!
//! This deliberately mirrors the attestor's "load the seed from a secret store,
//! never persist anything but the seed" discipline (packages/canonical/attest.ts)
//! — same operational pattern, one extra at-rest encryption layer because this
//! key can MOVE MONEY (the attestor key only re-signs an already-verified claim).

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { Buffer } from "node:buffer";

/** scrypt cost params. N=2^15 is ~tens of ms — interactive, brute-force-hard. */
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32; // AES-256
const IV_LEN = 12; // GCM nonce
const SALT_LEN = 16;
const TAG_LEN = 16;

export interface SealedKey {
  v: 1;
  kdf: "scrypt";
  n: number;
  r: number;
  p: number;
  /** base64 KDF salt. */
  salt: string;
  /** base64 GCM IV/nonce. */
  iv: string;
  /** base64 ciphertext || 16-byte GCM tag. */
  ct: string;
}

function deriveKey(passphrase: string, salt: Buffer, n: number, r: number, p: number): Buffer {
  // maxmem must comfortably exceed 128*N*r or scrypt throws.
  return scryptSync(Buffer.from(passphrase, "utf8"), salt, KEY_LEN, {
    N: n,
    r,
    p,
    maxmem: 256 * n * r,
  });
}

/**
 * Seal a 32-byte Ed25519 seed under `passphrase`. Returns a JSON-serializable
 * envelope safe to persist (the plaintext seed never touches disk). A random
 * salt + IV make every seal unique even for the same seed+passphrase.
 */
export function sealSecret(seed: Uint8Array, passphrase: string): SealedKey {
  if (seed.length !== 32) {
    throw new Error(`treasury seed must be 32 bytes, got ${seed.length}`);
  }
  if (typeof passphrase !== "string" || passphrase.length < 8) {
    throw new Error("passphrase must be a string of at least 8 chars");
  }
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(seed)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    kdf: "scrypt",
    n: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    ct: Buffer.concat([ct, tag]).toString("base64"),
  };
}

/**
 * Open a sealed envelope with `passphrase`, returning the 32-byte seed. A wrong
 * passphrase (or any tampering with salt/iv/ct) fails the GCM auth-tag check and
 * throws — the seed is NEVER returned on a bad key. Fail-closed.
 */
export function openSecret(sealed: SealedKey, passphrase: string): Uint8Array {
  if (sealed.v !== 1 || sealed.kdf !== "scrypt") {
    throw new Error(`unsupported sealed-key format v=${sealed.v} kdf=${sealed.kdf}`);
  }
  const salt = Buffer.from(sealed.salt, "base64");
  const iv = Buffer.from(sealed.iv, "base64");
  const blob = Buffer.from(sealed.ct, "base64");
  if (blob.length < TAG_LEN + 1) throw new Error("sealed ciphertext too short");
  const ct = blob.subarray(0, blob.length - TAG_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const key = deriveKey(passphrase, salt, sealed.n, sealed.r, sealed.p);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  let seed: Buffer;
  try {
    seed = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    // Do not leak whether the passphrase or the payload was wrong.
    throw new Error("failed to open sealed treasury key (bad passphrase or corrupt blob)");
  }
  if (seed.length !== 32) {
    throw new Error(`decrypted treasury seed must be 32 bytes, got ${seed.length}`);
  }
  return new Uint8Array(seed);
}

/** Constant-time equality for two secrets (test/utility). */
export function secretsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
