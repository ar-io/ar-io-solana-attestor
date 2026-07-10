//! Arweave RSA-PSS-4096 claim verification (protocol=0).
//!
//! Enforces the SAME rule the on-chain Arweave-attested claim path enforces —
//! an RSA-PSS-4096 / SHA-256 signature over the byte-pinned canonical claim
//! message, valid under the recipient's 512-byte modulus stored at deposit.
//! In the centralized model the service verifies the RSA-PSS signature DIRECTLY
//! (the attestor's role — verify RSA-PSS, then Ed25519 re-sign for on-chain
//! introspection — collapses; there is no on-chain sigverify to satisfy). A
//! valid signature IS the authorization to dispense.
//!
//! We REUSE the byte-pinned crypto from `@ar.io/attestor-canonical`:
//!   - `verifyRsaPss`            — Node/OpenSSL RSA-PSS verify (no custom bigint)
//!   - `deriveRecipientIdB64Url` — the F-1 recipient-id hash pinned to canonical.rs
//! No canonical format or RSA math is re-implemented here.
//!
//! Bindings enforced (pivot plan §4.2 / Appendix A):
//!   1. protocol == arweave (0)                          -> ProtocolMismatch
//!   2. modulus is the deposited one (F-1)               -> MODULUS_MISMATCH
//!      + b64url(sha256(modulus)) == recipient_id == AR source_address
//!   3. salt in {0, 32}                                  -> UNSUPPORTED_SALT_LENGTH
//!   4. RSA-PSS verifies over the ledger-rebuilt canonical -> RSA_SIGNATURE_INVALID

import { Buffer } from "node:buffer";
import {
  RSA_4096_BYTES,
  RsaPssError,
  deriveRecipientIdB64Url,
  verifyRsaPss,
} from "@ar.io/attestor-canonical";

import { VerificationError } from "./errors.js";
import {
  PROTOCOL_ARWEAVE,
  type AssetView,
  type ClaimProof,
  type RecipientView,
  type VerifiedProof,
} from "./types.js";
import { buildCanonicalFromLedger } from "./canonical-message.js";

const ALLOWED_SALT_LENGTHS = new Set([0, 32]);

/**
 * Verify an Arweave RSA-PSS claim (protocol=0). Rebuilds the canonical message
 * from ledger state, then verifies the claimant's signature against the STORED
 * 512-byte modulus. Throws `VerificationError` on any rule failure.
 */
export function verifyArweaveProof(args: {
  recipient: RecipientView;
  asset: AssetView;
  proof: ClaimProof;
  network: string;
}): VerifiedProof {
  const { recipient, asset, proof, network } = args;

  // 1. Protocol guard (EscrowError::ProtocolMismatch).
  if (recipient.protocol !== PROTOCOL_ARWEAVE) {
    throw new VerificationError(
      "PROTOCOL_MISMATCH",
      `recipient protocol ${recipient.protocol} != arweave (0)`,
    );
  }

  const modulus = recipient.recipientPubkey;
  if (modulus.length !== RSA_4096_BYTES) {
    // Protocol/length mismatch (e.g. a 20-byte ETH address routed as arweave).
    throw new VerificationError(
      "SIGNATURE_VERIFICATION_FAILED",
      `arweave recipient modulus must be ${RSA_4096_BYTES} bytes, got ${modulus.length}`,
    );
  }

  // 2. F-1 recipient binding. The derived id MUST equal both the stored
  //    recipient_id and the Arweave source_address (they are the same hash).
  const derivedId = deriveRecipientIdB64Url(modulus);
  if (derivedId !== recipient.recipientId || derivedId !== recipient.sourceAddress) {
    throw new VerificationError(
      "RECIPIENT_ID_MISMATCH",
      "b64url(sha256(modulus)) != stored recipient_id / source_address",
    );
  }
  // Defense-in-depth: if the client echoed a modulus, it must be byte-equal.
  if (proof.providedModulus && !bytesEqual(proof.providedModulus, modulus)) {
    throw new VerificationError(
      "MODULUS_MISMATCH",
      "client-supplied modulus != stored recipient modulus",
    );
  }

  // 3. Salt length must be 0 or 32 (Arweave wallet defaults).
  const saltLength = proof.saltLength ?? 32;
  if (!ALLOWED_SALT_LENGTHS.has(saltLength)) {
    throw new VerificationError(
      "UNSUPPORTED_SALT_LENGTH",
      `salt length must be 0 or 32, got ${saltLength}`,
    );
  }

  // Pre-check signature length so a wrong length is a clean rejection, not an
  // RsaPssError leaking through.
  if (proof.signature.length !== RSA_4096_BYTES) {
    throw new VerificationError(
      "SIGNATURE_VERIFICATION_FAILED",
      `signature must be ${RSA_4096_BYTES} bytes, got ${proof.signature.length}`,
    );
  }

  // Nonce anti-replay: if the client echoes a nonce it must match the current one.
  if (proof.nonce && !bytesEqual(proof.nonce, asset.nonce)) {
    throw new VerificationError("NONCE_MISMATCH", "supplied nonce != asset current nonce");
  }

  // 4. Rebuild canonical from ledger state and verify RSA-PSS over it.
  const canonicalMessage = buildCanonicalFromLedger({
    recipient,
    asset,
    claimant: proof.claimant,
    nonce: asset.nonce,
    network,
  });

  let valid: boolean;
  try {
    valid = verifyRsaPss(
      Buffer.from(canonicalMessage),
      Buffer.from(proof.signature),
      Buffer.from(modulus),
      saltLength,
    );
  } catch (err) {
    if (err instanceof RsaPssError) {
      // Map the library's parameter errors onto our taxonomy.
      if (err.code === "INVALID_SALT_LENGTH") {
        throw new VerificationError("UNSUPPORTED_SALT_LENGTH", err.message);
      }
      throw new VerificationError("SIGNATURE_VERIFICATION_FAILED", err.message);
    }
    throw err; // unexpected/infra fault — not a verification decision
  }
  if (!valid) {
    throw new VerificationError(
      "RSA_SIGNATURE_INVALID",
      "RSA-PSS signature does not verify under the recipient modulus",
    );
  }

  return {
    canonicalMessage,
    protocol: PROTOCOL_ARWEAVE,
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
