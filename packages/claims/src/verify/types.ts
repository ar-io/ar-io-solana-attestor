//! Verification input/output types — the ledger-state view the verifier reads.
//!
//! These mirror the on-chain `EscrowAnt` / `EscrowToken` fields the contract's
//! `claim_*` handlers read (`recipient_protocol`, `recipient_pubkey_active()`,
//! `asset_type`, `asset_id`, `amount`, `nonce`, `vault_end_timestamp`). The
//! verifier NEVER trusts client-supplied message bytes; it rebuilds the
//! canonical message from THIS state, exactly as the contract rebuilds it from
//! escrow account state (`canonical.rs`).

import type { Protocol, AssetType } from "../ledger/types.js";

/** Contract constants (ario-ant-escrow `state.rs`). */
export const PROTOCOL_ARWEAVE = 0 as const;
export const PROTOCOL_ETHEREUM = 1 as const;
/** RSA-4096 modulus length — `ARWEAVE_PUBKEY_LEN`. */
export const ARWEAVE_PUBKEY_LEN = 512;
/** Keccak address length — `ETHEREUM_PUBKEY_LEN`. */
export const ETHEREUM_PUBKEY_LEN = 20;
/** `r || s || v` ECDSA signature length. */
export const ETHEREUM_SIG_LEN = 65;

/**
 * The frozen recipient identity being proven (one `recipients` row).
 * `recipientPubkey` is the bytes the contract stored at deposit time:
 * 512-byte RSA modulus (Arweave) or 20-byte address (Ethereum).
 */
export interface RecipientView {
  protocol: Protocol;
  /** 512B modulus (AR) or 20B address (ETH). Non-null for claimable recipients. */
  recipientPubkey: Uint8Array;
  /** b64url(sha256(recipientPubkey)); for AR this IS the Arweave source address. */
  recipientId: string;
  /** normalizeSourceAddress() form (AR 43-char b64url, ETH lowercase 0x-hex). */
  sourceAddress: string;
}

/**
 * The claimable asset being released (one `assets` row). `assetType` here is
 * ADVISORY for vault settlement (recomputed live at claim time); it is
 * authoritative for choosing the canonical-message SHAPE (ant vs token/vault).
 */
export interface AssetView {
  assetType: AssetType;
  /** ant-mint base58 (ant) or 64-hex asset_id (token/vault). */
  assetKey: string;
  /** ant-mint base58 (ant only). */
  antMint: string | null;
  /** mARIO; null for ANTs. Bound into the token/vault canonical message. */
  amount: bigint | null;
  /** 32-byte anti-replay nonce (rotated on recipient update). */
  nonce: Uint8Array;
  /** absolute unlock unix seconds; vault only. */
  vaultEndTs: number | null;
}

/**
 * The proof a claimant submits. `claimant` is the destination Solana wallet,
 * bound INSIDE the signed canonical bytes (front-run / redirect proof). The
 * caller pays nothing on-chain; the recipient-key signature is the sole
 * authorization, exactly as on-chain.
 */
export interface ClaimProof {
  /** Destination Solana wallet, base58 (32 bytes decoded). */
  claimant: string;
  /** RSA-PSS 512B (AR) or secp256k1 r||s||v 65B (ETH). */
  signature: Uint8Array;
  /** Arweave only: salt length used, 0 or 32. Defaults to 32. */
  saltLength?: number;
  /**
   * Optional client-echoed modulus (AR). When present it MUST byte-equal the
   * stored recipient modulus (F-1 defense-in-depth). Verification always uses
   * the STORED modulus regardless.
   */
  providedModulus?: Uint8Array;
  /**
   * Optional client-echoed nonce (32 bytes). When present it MUST equal the
   * asset's current nonce (`NonceMismatch`). The canonical is always built
   * from the asset's stored nonce.
   */
  nonce?: Uint8Array;
}

/** A successful verification result. */
export interface VerifiedProof {
  /** The exact bytes verified (rebuilt server-side; persist to `claims.canonical_message`). */
  canonicalMessage: Uint8Array;
  /** 0 = arweave, 1 = ethereum. */
  protocol: Protocol;
  /** The proven recipient identity. */
  recipientId: string;
  /** The destination wallet (echoed from the proof, now cryptographically bound). */
  claimant: string;
}
