//! Shared types for the M1 ledger builder + reconciler.

export type Protocol = 0 | 1; // 0 = arweave, 1 = ethereum
export type AssetType = "ant" | "token" | "vault";

/** Which batch-escrow phase produced a deposit (provenance, not on-chain type). */
export type Phase = "ant" | "token" | "vault" | "stake";

export interface PlannedRecipient {
  /** normalizeSourceAddress() form — the canonical map/lookup key. */
  sourceAddress: string;
  protocol: Protocol;
  /** 512B modulus (AR) or 20B address (ETH); null only for AT-RISK manual_review. */
  recipientPubkey: Uint8Array | null;
  /** b64url(sha256(recipientPubkey)); for AR == sourceAddress. */
  recipientId: string;
  status: "open" | "manual_review";
}

export interface PlannedAsset {
  /** ant-mint base58 (ant) or 64-hex asset_id (token/vault). Globally unique. */
  assetKey: string;
  /** On-chain deposit instruction: deposit_ant | deposit_tokens | deposit_vault. */
  assetType: AssetType;
  /** The owning recipient's normalized source address. */
  recipientSource: string;
  /** ant-mint base58 (asset_type = ant only). */
  antMint: string | null;
  /** mARIO; null for ANTs. */
  amount: bigint | null;
  /** absolute unlock unix seconds; vault only. */
  vaultEndTs: number | null;
  /** available (claimable/deposited) | manual_review (AT-RISK, operator-queue only). */
  status: "available" | "manual_review";
  /** Provenance for audit + the operator queue. */
  source: {
    phase: Phase;
    aoProcessId?: string;
    arweaveAddress?: string;
    vaultId?: string;
    planKind?: string;
    /** on-chain PDA seed actually used: escrow_ant | escrow_token | escrow_vault. */
    onchainSeed: "escrow_ant" | "escrow_token" | "escrow_vault";
  };
}

/** Phase-grouped counters that mirror batch-escrow's printed manifest totals. */
export interface ManifestCounters {
  ant: number;
  tokenEscrowed: number;
  vaultEscrowed: number;
  stakeEscrowed: number;
}

export interface LedgerPlan {
  recipients: PlannedRecipient[];
  /** Claimable + manual_review assets, keyed by assetKey (unique). */
  assets: PlannedAsset[];
  /** Phase counters for the CLAIMABLE (available) set only. */
  counters: ManifestCounters;
  /** Phase-2 token-escrow ARIO outflow (mARIO) — the ~48.3M gate number. */
  phase2TokenOutflowMario: bigint;
  atRiskRecipientCount: number;
  /** sha256 fingerprints of every frozen input (audit provenance). */
  inputFingerprints: Record<string, string>;
  /** The pinned reference time used for the vault/stake liquid-vs-vault split. */
  nowMs: number;
}
