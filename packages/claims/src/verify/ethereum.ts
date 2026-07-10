//! Ethereum ECDSA secp256k1 + EIP-191 signature verification.
//!
//! A BYTE-FOR-BYTE TypeScript port of the on-chain
//! `ario-ant-escrow/src/verify/ethereum.rs::verify_personal_sign`. Matches the
//! wire format produced by `wallet.signMessage(canonical)` in every standard
//! EVM stack (MetaMask, viem, ethers.js — the escrow frontend signs with
//! ethers, see ClaimPage.tsx handleEthereumSign):
//!
//!   prefix   = "\x19Ethereum Signed Message:\n" + ascii(len(canonical))
//!   msg_hash = keccak256(prefix || canonical)
//!   v_norm   = (v - 27) if v >= 27 else v            // accepts {0,1,27,28}
//!   require    s <= secp256k1_n / 2                   // EIP-2 low-S (reject malleable)
//!   pubkey   = secp256k1_recover(msg_hash, v_norm, r||s)
//!   address  = keccak256(pubkey)[12..32]
//!   require    address == expected_address
//!
//! No web3.js. Uses `@noble/secp256k1` (recover + high-S check) and
//! `@noble/hashes/sha3` (keccak256) — the low-S guard is a raw-byte compare
//! against n/2 identical to the Rust `is_s_low`, so the malleability decision
//! never depends on a library's internal range validation.

import { keccak_256 } from "@noble/hashes/sha3";
import { Signature } from "@noble/secp256k1";

import { VerificationError } from "./errors.js";
import {
  ETHEREUM_PUBKEY_LEN,
  ETHEREUM_SIG_LEN,
  PROTOCOL_ETHEREUM,
  type AssetView,
  type ClaimProof,
  type RecipientView,
  type VerifiedProof,
} from "./types.js";
import { buildCanonicalFromLedger } from "./canonical-message.js";

/** EIP-191 personal-sign prefix (`verify/ethereum.rs::EIP191_PREFIX`). */
const EIP191_PREFIX = new TextEncoder().encode("\x19Ethereum Signed Message:\n");

/**
 * secp256k1_n / 2, big-endian (`verify/ethereum.rs::SECP256K1_N_HALF`).
 * s > this half-order is EIP-2 high-S (malleable) and rejected.
 */
const SECP256K1_N_HALF = Uint8Array.from([
  0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  0x5d, 0x57, 0x6e, 0x73, 0x57, 0xa4, 0x50, 0x1d, 0xdf, 0xe9, 0x2f, 0x46, 0x68, 0x1b, 0x20, 0xa0,
]);

/**
 * Returns true iff `s` (32 bytes, big-endian) is <= secp256k1_n / 2.
 * Full-width lexicographic compare — identical to numeric compare for
 * fixed-width big-endian values. Mirrors the Rust `is_s_low` (no early exit).
 */
function isSLow(s: Uint8Array): boolean {
  let decided = false;
  let answer = true;
  for (let i = 0; i < 32; i++) {
    if (!decided) {
      if (s[i] < SECP256K1_N_HALF[i]) {
        answer = true;
        decided = true;
      } else if (s[i] > SECP256K1_N_HALF[i]) {
        answer = false;
        decided = true;
      }
    }
  }
  return answer;
}

/** keccak256(prefix || ascii(len) || message) — the EIP-191 personal-sign hash. */
export function eip191Hash(message: Uint8Array): Uint8Array {
  const lenAscii = new TextEncoder().encode(String(message.length));
  const buf = new Uint8Array(EIP191_PREFIX.length + lenAscii.length + message.length);
  buf.set(EIP191_PREFIX, 0);
  buf.set(lenAscii, EIP191_PREFIX.length);
  buf.set(message, EIP191_PREFIX.length + lenAscii.length);
  return keccak_256(buf);
}

/** Derive the 20-byte Ethereum address from a 65-byte uncompressed pubkey (0x04||X||Y). */
export function deriveEthereumAddress(pubkey65: Uint8Array): Uint8Array {
  if (pubkey65.length !== 65 || pubkey65[0] !== 0x04) {
    throw new VerificationError("SIGNATURE_VERIFICATION_FAILED", "recovered pubkey malformed");
  }
  const hash = keccak_256(pubkey65.subarray(1)); // drop 0x04 prefix
  return hash.subarray(12, 32);
}

/** Constant-time-ish 20-byte compare (XOR accumulator, no early exit) — mirrors the Rust. */
function addressesEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = 0;
  for (let i = 0; i < ETHEREUM_PUBKEY_LEN; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Verify a `personal_sign`-style ECDSA signature against an expected 20-byte
 * Ethereum address. `canonicalMessage` is the raw bytes signed BEFORE EIP-191
 * wrapping; the wrapper is applied here. Throws `VerificationError` on any
 * failure; returns void on success. Faithful port of `verify_personal_sign`.
 */
export function verifyPersonalSign(
  canonicalMessage: Uint8Array,
  signature: Uint8Array,
  expectedAddress: Uint8Array,
): void {
  if (signature.length !== ETHEREUM_SIG_LEN) {
    throw new VerificationError(
      "SIGNATURE_VERIFICATION_FAILED",
      `signature must be ${ETHEREUM_SIG_LEN} bytes, got ${signature.length}`,
    );
  }
  if (expectedAddress.length !== ETHEREUM_PUBKEY_LEN) {
    throw new VerificationError(
      "SIGNATURE_VERIFICATION_FAILED",
      `expected address must be ${ETHEREUM_PUBKEY_LEN} bytes, got ${expectedAddress.length}`,
    );
  }

  const msgHash = eip191Hash(canonicalMessage);

  // Normalize recovery id: accept legacy {27,28} and modern {0,1}; reject else.
  const v = signature[64];
  let recoveryId: number;
  if (v === 0 || v === 1) recoveryId = v;
  else if (v === 27 || v === 28) recoveryId = v - 27;
  else throw new VerificationError("INVALID_RECOVERY_ID", `recovery id v=${v} not in {0,1,27,28}`);

  // EIP-2 low-S: raw-byte compare (matches Rust), BEFORE recovery.
  if (!isSLow(signature.subarray(32, 64))) {
    throw new VerificationError("ECDSA_HIGH_S", "signature s > secp256k1_n/2 (malleable)");
  }

  // Recover the public key. Invalid r/s (0, >= n) make this throw.
  let pubkey65: Uint8Array;
  try {
    const sig = Signature.fromCompact(signature.subarray(0, 64)).addRecoveryBit(recoveryId);
    pubkey65 = sig.recoverPublicKey(msgHash).toRawBytes(false); // 65: 0x04||X||Y
  } catch (err) {
    throw new VerificationError(
      "SIGNATURE_VERIFICATION_FAILED",
      `secp256k1 recover failed: ${(err as Error).message}`,
    );
  }

  const derived = deriveEthereumAddress(pubkey65);
  if (!addressesEqual(derived, expectedAddress)) {
    throw new VerificationError(
      "ETHEREUM_ADDRESS_MISMATCH",
      "recovered address does not match the stored recipient",
    );
  }
}

/**
 * High-level Ethereum claim verification (protocol=1). Rebuilds the canonical
 * message from ledger state and verifies the claimant's secp256k1 proof.
 * Mirrors `claim_ethereum.rs` / `claim_tokens_ethereum.rs` /
 * `claim_vault_ethereum.rs`: protocol guard, 20-byte address guard, canonical
 * rebuild, then `verify_personal_sign`.
 */
export function verifyEthereumProof(args: {
  recipient: RecipientView;
  asset: AssetView;
  proof: ClaimProof;
  network: string;
}): VerifiedProof {
  const { recipient, asset, proof, network } = args;

  // Protocol guard (EscrowError::ProtocolMismatch).
  if (recipient.protocol !== PROTOCOL_ETHEREUM) {
    throw new VerificationError(
      "PROTOCOL_MISMATCH",
      `recipient protocol ${recipient.protocol} != ethereum (1)`,
    );
  }

  // The stored recipient is exactly a 20-byte address (contract asserts this).
  const expectedAddress = recipient.recipientPubkey;
  if (expectedAddress.length !== ETHEREUM_PUBKEY_LEN) {
    throw new VerificationError(
      "SIGNATURE_VERIFICATION_FAILED",
      `stored ethereum recipient must be ${ETHEREUM_PUBKEY_LEN} bytes, got ${expectedAddress.length}`,
    );
  }

  // Nonce anti-replay: if the client echoes a nonce it must match the current one.
  if (proof.nonce && !bytesEqual(proof.nonce, asset.nonce)) {
    throw new VerificationError("NONCE_MISMATCH", "supplied nonce != asset current nonce");
  }

  const canonicalMessage = buildCanonicalFromLedger({
    recipient,
    asset,
    claimant: proof.claimant,
    nonce: asset.nonce,
    network,
  });

  verifyPersonalSign(canonicalMessage, proof.signature, expectedAddress);

  return {
    canonicalMessage,
    protocol: PROTOCOL_ETHEREUM,
    recipientId: recipient.recipientId,
    claimant: proof.claimant,
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
