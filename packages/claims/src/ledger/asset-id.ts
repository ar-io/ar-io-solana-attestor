//! Deterministic escrow asset_id derivation.
//!
//! SELF-CONTAINED reimplementation of the seed formulas used by the deployed
//! on-chain path (`solana-ar-io/migration/import/src/batch-escrow.ts`
//! `deriveTokenAssetId` / `deriveVaultAssetId`, and
//! `planning/escrow-extract.ts` `assetIdSeed`). Every id here must be
//! byte-identical to what a `deposit_tokens` / `deposit_vault` would have used,
//! so the frontend's paste-an-identifier and deep-link paths keep working. The
//! M1 reconciler independently re-derives these against the authoritative
//! source (and source-guards the seed literals) — a divergence FAILS the gate.

import { sha256 } from "@noble/hashes/sha2";
import { normalizeSourceAddress } from "./normalize.js";

/** Lowercase hex of raw bytes. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** sha256(utf8(seed)) -> 32 raw bytes. */
export function sha256Utf8(seed: string): Uint8Array {
  return sha256(new TextEncoder().encode(seed));
}

/**
 * Token escrow asset_id: sha256("token-escrow:" + normalized_address).
 * Address is normalized first (lowercase ETH) so the id is case-stable.
 */
export function deriveTokenAssetId(address: string): Uint8Array {
  return sha256Utf8("token-escrow:" + normalizeSourceAddress(address));
}

/**
 * Vault escrow asset_id: sha256("vault-escrow:" + normalized_address + ":" + vaultId).
 * Note: an EXPIRED or sub-min / short-lock vault deposits as a liquid TOKEN
 * escrow on-chain (escrow_token seed) but still keys off this vault-namespace
 * id — matching batch-escrow's Phase-3 expired/fallback handling.
 */
export function deriveVaultAssetId(address: string, vaultId: string): Uint8Array {
  return sha256Utf8(
    "vault-escrow:" + normalizeSourceAddress(address) + ":" + vaultId,
  );
}

/**
 * Stake / withdrawal escrow asset_id: sha256(assetIdSeed) where the seed is the
 * stable string minted by `planning/escrow-extract.ts` (e.g.
 * `stake-escrow:<normAddr>:<kind>`, `withdrawal-escrow:<addr>:<vaultKey>`,
 * `stake-escrow-liquid:...`, `withdrawal-escrow-liquid:...`).
 */
export function deriveStakeAssetId(assetIdSeed: string): Uint8Array {
  return sha256Utf8(assetIdSeed);
}
