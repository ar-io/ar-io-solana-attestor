//! Identity-proof verification for the centralized claim service (M2).
//!
//! Public surface. `verifyClaim` is the single entry point M3 (claims API) calls
//! after loading the frozen `recipients` + `assets` rows and locking the asset
//! FOR UPDATE. It dispatches by the recipient's protocol, rebuilds the canonical
//! message from ledger state, and verifies the claimant's RSA-PSS (Arweave) or
//! secp256k1 (Ethereum) proof — the SAME validity rules the deployed
//! `ario-ant-escrow` `claim_*` instructions enforce (Appendix A). A valid proof
//! means "authorized to dispense"; the vault settlement decision (for vault
//! assets) is computed separately by `computeVaultSettlement` at dispatch time.

import { VerificationError } from "./errors.js";
import {
  PROTOCOL_ARWEAVE,
  PROTOCOL_ETHEREUM,
  type AssetView,
  type ClaimProof,
  type RecipientView,
  type VerifiedProof,
} from "./types.js";
import { verifyArweaveProof } from "./arweave.js";
import { verifyEthereumProof } from "./ethereum.js";

export {
  VerificationError,
  isVerificationError,
  type VerificationErrorCode,
} from "./errors.js";
export {
  PROTOCOL_ARWEAVE,
  PROTOCOL_ETHEREUM,
  ARWEAVE_PUBKEY_LEN,
  ETHEREUM_PUBKEY_LEN,
  ETHEREUM_SIG_LEN,
  type RecipientView,
  type AssetView,
  type ClaimProof,
  type VerifiedProof,
} from "./types.js";
export { buildCanonicalFromLedger } from "./canonical-message.js";
export { verifyArweaveProof } from "./arweave.js";
export {
  verifyEthereumProof,
  verifyPersonalSign,
  eip191Hash,
  deriveEthereumAddress,
} from "./ethereum.js";
export {
  computeVaultSettlement,
  type VaultSettlement,
} from "./vault-settlement.js";

/**
 * Verify a claim end-to-end. Dispatches on the recipient's frozen protocol
 * (authoritative — the deposit's `recipient_protocol` fixes which claim path is
 * valid; the wrong protocol raises `ProtocolMismatch` inside the verifier).
 */
export function verifyClaim(args: {
  recipient: RecipientView;
  asset: AssetView;
  proof: ClaimProof;
  network: string;
}): VerifiedProof {
  switch (args.recipient.protocol) {
    case PROTOCOL_ARWEAVE:
      return verifyArweaveProof(args);
    case PROTOCOL_ETHEREUM:
      return verifyEthereumProof(args);
    default:
      throw new VerificationError(
        "PROTOCOL_MISMATCH",
        `unknown recipient protocol ${(args.recipient as RecipientView).protocol}`,
      );
  }
}
