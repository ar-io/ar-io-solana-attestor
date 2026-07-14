//! Verification error taxonomy for the centralized claim service.
//!
//! Every rejection reason maps 1:1 to the on-chain `EscrowError` variant the
//! deployed `ario-ant-escrow` program would raise for the same input, so the
//! centralized service enforces the SAME rules the contract does (Appendix A
//! of the pivot plan). The centralized model verifies the RSA-PSS / secp256k1
//! proof DIRECTLY — there is no on-chain sigverify / attestor Ed25519 re-sign
//! step — but the *validity rules* are identical.
//!
//! A `VerificationError` is a DETERMINISTIC "this proof is not valid" — it is
//! never thrown for transient/infrastructure faults (those surface as plain
//! Errors). The dispatch layer (M4) treats a VerificationError as a hard,
//! terminal claim rejection.

/**
 * Stable machine codes. Names mirror the contract's `EscrowError` (and the
 * attestor's HTTP error codes) so an auditor can line the two up directly.
 */
export type VerificationErrorCode =
  // ---- guards (contract: require! at the top of each claim_* handler) ----
  /** `EscrowError::ProtocolMismatch` — proof protocol != recipient protocol. */
  | "PROTOCOL_MISMATCH"
  /** `EscrowError::AssetTypeMismatch` — claim asset_type != stored asset_type. */
  | "ASSET_TYPE_MISMATCH"
  /** `EscrowError::NonceMismatch` — supplied nonce != the asset's current nonce. */
  | "NONCE_MISMATCH"
  // ---- Arweave RSA-PSS (contract: verify_rsa_pss / attestor RSA path) ----
  /** RSA-PSS signature did not verify under the recipient modulus (attestor: RSA_SIGNATURE_INVALID). */
  | "RSA_SIGNATURE_INVALID"
  /** salt length not in {0, 32} (attestor: UNSUPPORTED_SALT_LENGTH). */
  | "UNSUPPORTED_SALT_LENGTH"
  /** F-1 binding: supplied modulus != the recipient modulus stored at deposit. */
  | "MODULUS_MISMATCH"
  /** b64url(sha256(modulus)) != stored recipient_id / Arweave source_address. */
  | "RECIPIENT_ID_MISMATCH"
  // ---- Ethereum secp256k1 (contract: verify/ethereum.rs) ----
  /** `EscrowError::InvalidRecoveryId` — v not in {0,1,27,28}. */
  | "INVALID_RECOVERY_ID"
  /** `EscrowError::EcdsaHighS` — s > secp256k1_n/2 (EIP-2 malleability). */
  | "ECDSA_HIGH_S"
  /** `EscrowError::EthereumAddressMismatch` — recovered address != stored 20 bytes. */
  | "ETHEREUM_ADDRESS_MISMATCH"
  /** `EscrowError::SignatureVerificationFailed` — wrong sig/addr length, unrecoverable sig. */
  | "SIGNATURE_VERIFICATION_FAILED"
  // ---- vault settlement (contract: claim_vault_* / ario-core vault bounds) ----
  /** `ArioError::LockDurationTooLong` — re-lock duration exceeds max_vault_duration. */
  | "LOCK_DURATION_TOO_LONG"
  // ---- input hygiene (reject before touching crypto) ----
  /** Empty, oversized, or structurally malformed input. */
  | "INVALID_INPUT";

export class VerificationError extends Error {
  readonly code: VerificationErrorCode;
  constructor(code: VerificationErrorCode, message: string) {
    super(message);
    this.name = "VerificationError";
    this.code = code;
  }
}

/** Narrow an unknown thrown value to a VerificationError. */
export function isVerificationError(e: unknown): e is VerificationError {
  return e instanceof VerificationError;
}
