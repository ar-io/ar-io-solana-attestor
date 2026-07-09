//! Public surface of the shared, verification-pure crypto library.
//!
//! This package is the SINGLE source of the byte-pinned canonical claim
//! message format and the identity-proof primitives that BOTH the
//! attestor service and the (future) claims service verify against.
//! Nothing here is HTTP-, config-, or process-specific — it is pure
//! functions over bytes, cross-pinned to the on-chain Rust
//! implementation by `canonical.cross.test.ts`.
//!
//! Do NOT re-implement any of this downstream; import it.

export {
  buildAntEscrowClaimMessage,
  buildEscrowClaimMessage,
  deriveRecipientIdB64Url,
} from "./canonical.js";

export {
  RSA_4096_BYTES,
  DEFAULT_SALT_LEN,
  RsaPssError,
  deriveArweaveAddress,
  modulusToKeyObject,
  verifyRsaPss,
} from "./verify-rsa-pss.js";

export {
  type AttestorKeypair,
  loadAttestorKeypair,
  signAttestation,
} from "./attest.js";
