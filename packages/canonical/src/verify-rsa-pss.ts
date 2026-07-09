//! RSA-PSS-4096 signature verification matching Arweave wallet output.
//!
//! Arweave wallets (Wander, ArConnect, arweave-js) sign messages with:
//!
//! - Modulus:    4096 bits
//! - Exponent:   65537
//! - Hash:       SHA-256
//! - MGF:        MGF1-SHA-256
//! - Salt:       32 bytes (default in arweave-js)
//!
//! This file delegates to Node's built-in `crypto.verify`, which is
//! backed by OpenSSL — hardware-accelerated, battle-tested, FIPS-validated
//! in many distributions. There is zero custom big-int math here. The
//! attestor's job is to be a thin wrapper that turns a (slow on-chain)
//! RSA-PSS verify into an off-chain operation, then re-attest the result
//! with Ed25519 (cheap on-chain).

import {
  createPublicKey,
  verify,
  constants as cryptoConstants,
  type KeyObject,
} from "node:crypto";
import { createHash } from "node:crypto";

/// RSA-4096 modulus / signature length in bytes.
export const RSA_4096_BYTES = 512;

/// Default salt length per arweave-js / Wander / ArConnect.
export const DEFAULT_SALT_LEN = 32;

/// Public exponent — Arweave hardcodes this; we reject anything else.
const EXPECTED_E_BASE64URL = "AQAB"; // 0x010001 = 65537

/**
 * Convert a raw RSA modulus (512 big-endian bytes) into a Node KeyObject
 * by constructing the JWK form and importing it.
 *
 * We accept the modulus as raw bytes (matching how Arweave keys are
 * stored on-chain in the escrow PDA) rather than DER/PEM, to keep the
 * client-side encoding simple.
 */
export function modulusToKeyObject(modulus: Buffer): KeyObject {
  if (modulus.length !== RSA_4096_BYTES) {
    throw new RsaPssError(
      "MODULUS_WRONG_LENGTH",
      `expected ${RSA_4096_BYTES} bytes, got ${modulus.length}`,
    );
  }

  // JWK requires base64url-encoded big-endian bytes with no leading zeros
  // stripped. arweave-js produces raw 512-byte moduli with the top bit
  // set, so leading zeros never apply here.
  const jwk = {
    kty: "RSA",
    n: modulus.toString("base64url"),
    e: EXPECTED_E_BASE64URL,
  };

  try {
    return createPublicKey({ key: jwk, format: "jwk" });
  } catch (err) {
    throw new RsaPssError(
      "INVALID_MODULUS",
      `JWK import failed: ${(err as Error).message}`,
    );
  }
}

/**
 * Verify an RSA-PSS-4096 signature over `message`.
 *
 * Returns `true` on success, throws `RsaPssError` on parameter problems
 * (NOT on verification failures — those return `false`).
 *
 * `saltLength` defaults to 32 (Arweave's default). The attestor accepts
 * an explicit value because some older arweave-js versions used 0.
 */
export function verifyRsaPss(
  message: Buffer,
  signature: Buffer,
  modulus: Buffer,
  saltLength: number = DEFAULT_SALT_LEN,
): boolean {
  if (signature.length !== RSA_4096_BYTES) {
    throw new RsaPssError(
      "SIGNATURE_WRONG_LENGTH",
      `expected ${RSA_4096_BYTES} bytes, got ${signature.length}`,
    );
  }
  if (saltLength < 0 || saltLength > 32) {
    throw new RsaPssError(
      "INVALID_SALT_LENGTH",
      `salt must be 0..=32, got ${saltLength}`,
    );
  }

  const key = modulusToKeyObject(modulus);

  return verify(
    "sha256",
    message,
    {
      key,
      padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
      saltLength,
    },
    signature,
  );
}

/**
 * Derive the Arweave wallet address (43-char base64url) from an RSA
 * public modulus. Arweave addresses are SHA-256 of the raw modulus,
 * encoded as URL-safe base64 without padding.
 *
 * Used to bind a (modulus, sig) pair to the Arweave address recorded
 * in the escrow's `recipient_pubkey_active`.
 */
export function deriveArweaveAddress(modulus: Buffer): string {
  if (modulus.length !== RSA_4096_BYTES) {
    throw new RsaPssError(
      "MODULUS_WRONG_LENGTH",
      `expected ${RSA_4096_BYTES} bytes, got ${modulus.length}`,
    );
  }
  return createHash("sha256").update(modulus).digest("base64url");
}

export class RsaPssError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RsaPssError";
    this.code = code;
  }
}
