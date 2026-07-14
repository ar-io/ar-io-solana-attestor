//! Transparency configuration (M6) — endpoint + anchor settings.
//!
//! Kept separate from the API `loadConfig` and the dispatch config: the HTTP
//! service exposes the transparency READ endpoints (ledger / log / anchors /
//! reserves) with only public data + on-chain reads, while the publish/anchor
//! CLIs additionally load the transparency KEYS (keys.ts). Nothing here is a
//! secret — pubkeys and addresses only; `.env.example` carries placeholders.

import { address, type Address } from "@solana/kit";

export type AntCheckMode = "off" | "sample" | "gpa";
export type AnchorTarget = "solana-memo" | "arweave" | "none";

export interface TransparencyConfig {
  /** ARIO SPL mint (reserves balances are read for this mint). */
  mint?: Address;
  /** Hot dispenser (treasury) owner address — its ATA is the hot float. */
  hotDispenser?: Address;
  /** Cold reserve owner address — its ATA is the cold reserve. */
  coldReserve?: Address;
  /** Authority whose ANT ownership is verified (defaults to hotDispenser). */
  antAuthority?: Address;
  antCheck: { mode: "off" } | { mode: "sample"; sampleSize: number } | { mode: "gpa" };
  /** Where anchors land; the anchor CLI reads this. */
  anchorTarget: AnchorTarget;
  /** Memo program used for the Solana anchor (defaults to the live program). */
  anchorMemoProgram?: string;
  /** Published publisher pubkey (hex) — exposed for verifiers. */
  publisherPubkeyHex?: string;
  /** Published audit-key pubkey (hex) — exposed for verifiers. */
  auditPubkeyHex?: string;
}

export function loadTransparencyConfig(env: NodeJS.ProcessEnv = process.env): TransparencyConfig {
  const antMode = (env.RESERVES_ANT_CHECK ?? "off") as AntCheckMode;
  let antCheck: TransparencyConfig["antCheck"];
  if (antMode === "sample") {
    antCheck = { mode: "sample", sampleSize: parseInt(env.RESERVES_ANT_SAMPLE_SIZE ?? "25", 10) };
  } else if (antMode === "gpa") {
    antCheck = { mode: "gpa" };
  } else {
    antCheck = { mode: "off" };
  }

  return {
    mint: env.ARIO_MINT ? address(env.ARIO_MINT) : undefined,
    hotDispenser: env.TREASURY_ADDRESS ? address(env.TREASURY_ADDRESS) : undefined,
    coldReserve: env.COLD_RESERVE_ADDRESS ? address(env.COLD_RESERVE_ADDRESS) : undefined,
    antAuthority: env.ANT_AUTHORITY_ADDRESS ? address(env.ANT_AUTHORITY_ADDRESS) : undefined,
    antCheck,
    anchorTarget: (env.ANCHOR_TARGET ?? "solana-memo") as AnchorTarget,
    anchorMemoProgram: env.ANCHOR_MEMO_PROGRAM,
    publisherPubkeyHex: env.LEDGER_PUBLISHER_PUBKEY_HEX,
    auditPubkeyHex: env.AUDIT_PUBKEY_HEX,
  };
}
