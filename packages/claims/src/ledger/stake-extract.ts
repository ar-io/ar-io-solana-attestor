//! Stake + withdrawal escrow extraction — SELF-CONTAINED copy of
//! `solana-ar-io/migration/import/src/planning/escrow-extract.ts`. Flattens the
//! reviewed `delivery-escrow-plan.json`'s UNMAPPED stake + withdrawal escrow
//! outputs into normalized deposit entries with a stable, unique `assetIdSeed`
//! (hashed to the 32-byte escrow asset_id). Vault entries carry the absolute
//! `unlockTs`; the executor computes `lock_duration = unlockTs - now` at send
//! time and falls back to a liquid escrow below the 14-day minimum. Operator
//! exit-vaults carry their source so a still-locked exit is extended (not
//! liquid-expedited).
//!
//! CROSS-REPO "normalize first" CONTRACT: EVERY address-bearing seed namespace
//! (`stake-escrow:`, `stake-escrow-liquid:`, `withdrawal-escrow:`,
//! `withdrawal-escrow-liquid:`) wraps its address in `normalizeSourceAddress`
//! (lowercase ETH) so an ETH owner's asset_id is case-STABLE — a claimant signing
//! with a checksummed address and a snapshot carrying lowercase must land on the
//! SAME escrow PDA. This copy MUST stay byte-identical to the authoritative
//! solana-ar-io original; the M1 reconciler imports that original and diffs.

import { normalizeSourceAddress } from "./normalize.js";

export interface EscrowVaultDeposit {
  arweaveAddr: string;
  /** Unique seed -> sha256 -> 32-byte asset_id. */
  assetIdSeed: string;
  amountMario: bigint;
  /** Absolute target unlock (unix seconds). */
  unlockTs: number;
  /** Provenance for audit + manifest. */
  kind: string;
}

export interface EscrowLiquidDeposit {
  arweaveAddr: string;
  assetIdSeed: string;
  amountMario: bigint;
  kind: string;
}

export interface EscrowDepositSet {
  vaults: EscrowVaultDeposit[];
  liquid: EscrowLiquidDeposit[];
}

/** Serialized plan artifact shape (amounts are strings post-JSON). */
export interface PlanArtifact {
  plans: {
    stakePlan: {
      operatorEscrowVaults: {
        arweaveAddr: string;
        kind: string;
        amountMario: string;
        unlockTs: number;
      }[];
      operatorLiquidEscrows: { arweaveAddr: string; kind: string; amountMario: string }[];
      delegatorEscrowVaults: {
        arweaveAddr: string;
        kind: string;
        amountMario: string;
        unlockTs: number;
      }[];
      delegatorLiquidEscrows: { arweaveAddr: string; kind: string; amountMario: string }[];
    };
    withdrawalPlan: {
      escrowVaults: {
        arweaveAddr: string;
        vaultKey: string;
        amountMario: string;
        unlockTs: number;
        source?: string;
      }[];
      liquidEscrows: {
        arweaveAddr: string;
        vaultKey: string;
        amountMario: string;
        source?: string;
      }[];
    };
  };
}

/** Collect the stake + withdrawal escrow deposits from a plan artifact. */
export function collectStakeWithdrawalEscrow(artifact: PlanArtifact): EscrowDepositSet {
  const { stakePlan, withdrawalPlan } = artifact.plans;

  const vaults: EscrowVaultDeposit[] = [
    ...stakePlan.operatorEscrowVaults.map((v) => ({
      arweaveAddr: v.arweaveAddr,
      assetIdSeed: `stake-escrow:${normalizeSourceAddress(v.arweaveAddr)}:${v.kind}`,
      amountMario: BigInt(v.amountMario),
      unlockTs: v.unlockTs,
      kind: v.kind,
    })),
    ...stakePlan.delegatorEscrowVaults.map((v) => ({
      arweaveAddr: v.arweaveAddr,
      assetIdSeed: `stake-escrow:${normalizeSourceAddress(v.arweaveAddr)}:${v.kind}`,
      amountMario: BigInt(v.amountMario),
      unlockTs: v.unlockTs,
      kind: v.kind,
    })),
    ...withdrawalPlan.escrowVaults.map((v) => ({
      arweaveAddr: v.arweaveAddr,
      assetIdSeed: `withdrawal-escrow:${normalizeSourceAddress(v.arweaveAddr)}:${v.vaultKey}`,
      amountMario: BigInt(v.amountMario),
      unlockTs: v.unlockTs,
      kind: `withdrawal:${v.source ?? "unknown"}:${v.vaultKey}`,
    })),
  ];

  const liquid: EscrowLiquidDeposit[] = [
    ...stakePlan.operatorLiquidEscrows.map((v) => ({
      arweaveAddr: v.arweaveAddr,
      assetIdSeed: `stake-escrow-liquid:${normalizeSourceAddress(v.arweaveAddr)}:${v.kind}`,
      amountMario: BigInt(v.amountMario),
      kind: v.kind,
    })),
    ...stakePlan.delegatorLiquidEscrows.map((v) => ({
      arweaveAddr: v.arweaveAddr,
      assetIdSeed: `stake-escrow-liquid:${normalizeSourceAddress(v.arweaveAddr)}:${v.kind}`,
      amountMario: BigInt(v.amountMario),
      kind: v.kind,
    })),
    ...withdrawalPlan.liquidEscrows.map((v) => ({
      arweaveAddr: v.arweaveAddr,
      assetIdSeed: `withdrawal-escrow-liquid:${normalizeSourceAddress(v.arweaveAddr)}:${v.vaultKey}`,
      amountMario: BigInt(v.amountMario),
      kind: `withdrawal:${v.source ?? "unknown"}:${v.vaultKey}`,
    })),
  ];

  return { vaults, liquid };
}

/** Total mARIO this escrow set moves out of the authority ATA. */
export function totalEscrowMario(set: EscrowDepositSet): bigint {
  let sum = 0n;
  for (const v of set.vaults) sum += v.amountMario;
  for (const l of set.liquid) sum += l.amountMario;
  return sum;
}

/**
 * Assert every assetIdSeed is unique — a collision would alias escrow PDAs.
 *
 * Checks BOTH exact and case-INSENSITIVE uniqueness. All address-bearing seeds
 * are normalized (`normalizeSourceAddress` -> lowercase ETH), so two entries that
 * differ only in an ETH address's case now collapse to the same exact seed and
 * the exact check catches them. The case-insensitive check is the belt-and-
 * suspenders guard that would have caught the ORIGINAL casing bug (a raw
 * `withdrawal-escrow:0xABC…` vs `withdrawal-escrow:0xabc…`) even before the
 * normalization fix — a residual case-variant collision is a red flag.
 */
export function assertUniqueAssetSeeds(set: EscrowDepositSet): void {
  const seen = new Set<string>();
  const seenLower = new Map<string, string>();
  for (const e of [...set.vaults, ...set.liquid]) {
    if (seen.has(e.assetIdSeed)) {
      throw new Error(
        `stake-extract: duplicate assetIdSeed "${e.assetIdSeed}" — escrow PDAs would alias`,
      );
    }
    const lower = e.assetIdSeed.toLowerCase();
    const prior = seenLower.get(lower);
    if (prior !== undefined && prior !== e.assetIdSeed) {
      throw new Error(
        `stake-extract: case-variant assetIdSeed collision "${prior}" vs "${e.assetIdSeed}" — ` +
          `these differ only by case (likely an un-normalized ETH address) and would alias escrow PDAs`,
      );
    }
    seen.add(e.assetIdSeed);
    seenLower.set(lower, e.assetIdSeed);
  }
}
