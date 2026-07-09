//! Ed25519 attestation: sign the canonical claim message with the
//! attestor's keypair after off-chain RSA-PSS verification has passed.
//!
//! Crucially, the bytes signed by Ed25519 are the SAME canonical message
//! the user originally signed with their RSA wallet. This means the
//! on-chain program never needs to know about the RSA flow — it just
//! reconstructs the canonical message from escrow state (as it does
//! today) and verifies the Ed25519 signature against the attestor's
//! pubkey via Solana's native Ed25519Program sigverify.
//!
//! No metadata or wrapping is added. No domain separator beyond what's
//! already inside the canonical message header (`ar.io ant-escrow claim
//! v1`). Keep it dumb: same bytes in, Ed25519 sig out.

import * as ed25519 from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2";

// @noble/ed25519 v2 needs sha512 wired in for sync ops; do it once.
ed25519.etc.sha512Sync = (...m) => sha512(ed25519.etc.concatBytes(...m));

export interface AttestorKeypair {
  /// 32-byte Ed25519 secret key (the seed; @noble derives the public key).
  readonly secretKey: Uint8Array;
  /// 32-byte Ed25519 public key, derived once at startup.
  readonly publicKey: Uint8Array;
}

/**
 * Initialize an attestor keypair from a 32-byte secret seed.
 *
 * The seed should be loaded from a secret store (env var, KMS, file).
 * NEVER persist anything other than the seed; the public key is derived.
 */
export function loadAttestorKeypair(secretSeed: Uint8Array): AttestorKeypair {
  if (secretSeed.length !== 32) {
    throw new Error(
      `attestor secret seed must be 32 bytes, got ${secretSeed.length}`,
    );
  }
  const publicKey = ed25519.getPublicKey(secretSeed);
  return { secretKey: secretSeed, publicKey };
}

/**
 * Sign the canonical claim message with the attestor's Ed25519 key.
 *
 * Returns the 64-byte signature. The on-chain Solana program will:
 * 1. Reconstruct the same canonical message bytes from escrow state.
 * 2. Use Solana's native Ed25519Program ix to verify (signer pubkey,
 *    message bytes, signature). The Ed25519Program ix is added to the
 *    same transaction as the claim ix.
 * 3. Use sysvar::instructions introspection to confirm the signature
 *    pubkey matches the program's hardcoded ATTESTOR_PUBKEY constant
 *    and the signed message matches the reconstructed canonical message.
 */
export function signAttestation(
  keypair: AttestorKeypair,
  antEscrowClaimMessage: Uint8Array,
): Uint8Array {
  return ed25519.sign(antEscrowClaimMessage, keypair.secretKey);
}
