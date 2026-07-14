//! Canonical claim-message reconstruction from LEDGER STATE.
//!
//! This is the anti-replay carrier (pivot plan §4.2 / M2 item 4). The service
//! rebuilds the exact bytes the recipient signed FROM the frozen ledger row —
//! NEVER from client-supplied message bytes — using the byte-pinned builders in
//! `@ar.io/attestor-canonical` (cross-pinned to the Rust `canonical.rs` by
//! `canonical.cross.golden.json`). We do not re-implement the format here.
//!
//! The rebuilt message binds (recipient identity, asset id/key, amount, nonce,
//! claimant). A signature over it therefore cannot be replayed against a
//! different asset, recipient, amount, or destination wallet — swapping any of
//! those changes the bytes, so the signature no longer verifies. M3 additionally
//! enforces nonce single-use in the DB; this module defines & validates the
//! binding itself.
//!
//! Shape selection mirrors which on-chain claim instruction the deposit maps to:
//! - `ant`   -> `build_ant_escrow_claim_message` (header `ar.io ant-escrow claim`)
//! - `token` -> `build_escrow_claim_message` with `type: token` (claim_tokens_*)
//! - `vault` -> `build_escrow_claim_message` with `type: vault`  (claim_vault_*)
//!
//! The `type:` field is the STORED asset_type (what the frontend claims
//! against), independent of the live liquid-vs-relock settlement decision — the
//! settlement is computed AFTER verification and never alters the signed bytes,
//! exactly as `claim_vault_*` always builds `type: vault` then settles.

import bs58 from "bs58";
import {
  buildAntEscrowClaimMessage,
  buildEscrowClaimMessage,
} from "@ar.io/attestor-canonical";

import { VerificationError } from "./errors.js";
import type { AssetView, RecipientView } from "./types.js";

/** Max u64 — the contract's amount domain. */
const U64_MAX = 0xffff_ffff_ffff_ffffn;

function decodeBase58Checked(s: string, label: string, expectedLen: number): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(s);
  } catch {
    throw new VerificationError("INVALID_INPUT", `${label} is not valid base58`);
  }
  if (bytes.length !== expectedLen) {
    throw new VerificationError(
      "INVALID_INPUT",
      `${label} must decode to ${expectedLen} bytes, got ${bytes.length}`,
    );
  }
  return bytes;
}

function decodeHexChecked(s: string, label: string, expectedLen: number): Uint8Array {
  if (s.length !== expectedLen * 2 || !/^[0-9a-fA-F]*$/.test(s)) {
    throw new VerificationError(
      "INVALID_INPUT",
      `${label} must be ${expectedLen * 2} lowercase hex chars`,
    );
  }
  const out = new Uint8Array(expectedLen);
  for (let i = 0; i < expectedLen; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Rebuild the canonical claim message for `(recipient, asset, claimant, nonce)`.
 *
 * `claimant` is the base58 destination wallet. `nonce` is the asset's current
 * 32-byte nonce (authoritative — the caller passes the ledger value, never a
 * client value). The recipient's raw identity bytes are hashed into the
 * `recipient:` field (F-1 binding) by the underlying builder.
 */
export function buildCanonicalFromLedger(args: {
  recipient: RecipientView;
  asset: AssetView;
  claimant: string;
  nonce: Uint8Array;
  network: string;
}): Uint8Array {
  const { recipient, asset, claimant, nonce, network } = args;

  if (nonce.length !== 32) {
    throw new VerificationError("INVALID_INPUT", `nonce must be 32 bytes, got ${nonce.length}`);
  }
  if (recipient.recipientPubkey.length === 0) {
    throw new VerificationError("INVALID_INPUT", "recipient pubkey must be non-empty");
  }
  const claimantBytes = decodeBase58Checked(claimant, "claimant", 32);

  if (asset.assetType === "ant") {
    if (!asset.antMint) {
      throw new VerificationError("INVALID_INPUT", "ant asset missing antMint");
    }
    const antMint = decodeBase58Checked(asset.antMint, "antMint", 32);
    return buildAntEscrowClaimMessage({
      antMint,
      claimant: claimantBytes,
      nonce,
      network,
      recipientPubkey: recipient.recipientPubkey,
    });
  }

  // token | vault: 64-hex asset_id + u64 amount bound into the message.
  const assetId = decodeHexChecked(asset.assetKey, "assetKey", 32);
  if (asset.amount === null || asset.amount === undefined) {
    throw new VerificationError("INVALID_INPUT", `${asset.assetType} asset missing amount`);
  }
  if (asset.amount < 0n || asset.amount > U64_MAX) {
    throw new VerificationError("INVALID_INPUT", `amount out of u64 range: ${asset.amount}`);
  }
  return buildEscrowClaimMessage({
    assetType: asset.assetType, // "token" | "vault" — the stored type
    assetId,
    amount: asset.amount,
    claimant: claimantBytes,
    nonce,
    network,
    recipientPubkey: recipient.recipientPubkey,
  });
}
