//! Stake + withdrawal escrow extraction — SELF-CONTAINED copy of
//! `solana-ar-io/migration/import/src/planning/escrow-extract.ts`. Flattens the
//! reviewed `delivery-escrow-plan.json`'s UNMAPPED stake + withdrawal escrow
//! outputs into normalized deposit entries with a stable, unique `assetIdSeed`
//! (hashed to the 32-byte escrow asset_id). Vault entries carry the absolute
//! `unlockTs`; the executor computes `lock_duration = unlockTs - now` at send
//! time and falls back to a liquid escrow below the 14-day minimum. Operator
//! exit-vaults carry their source so a still-locked exit is extended (not
//! liquid-expedited).

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
      assetIdSeed: `withdrawal-escrow:${v.arweaveAddr}:${v.vaultKey}`,
      amountMario: BigInt(v.amountMario),
      unlockTs: v.unlockTs,
      kind: `withdrawal:${v.source ?? "unknown"}:${v.vaultKey}`,
    })),
  ];

  const liquid: EscrowLiquidDeposit[] = [
    ...stakePlan.operatorLiquidEscrows.map((v) => ({
      arweaveAddr: v.arweaveAddr,
      assetIdSeed: `stake-escrow-liquid:${v.arweaveAddr}:${v.kind}`,
      amountMario: BigInt(v.amountMario),
      kind: v.kind,
    })),
    ...stakePlan.delegatorLiquidEscrows.map((v) => ({
      arweaveAddr: v.arweaveAddr,
      assetIdSeed: `stake-escrow-liquid:${v.arweaveAddr}:${v.kind}`,
      amountMario: BigInt(v.amountMario),
      kind: v.kind,
    })),
    ...withdrawalPlan.liquidEscrows.map((v) => ({
      arweaveAddr: v.arweaveAddr,
      assetIdSeed: `withdrawal-escrow-liquid:${v.arweaveAddr}:${v.vaultKey}`,
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

/** Assert every assetIdSeed is unique — a collision would alias escrow PDAs. */
export function assertUniqueAssetSeeds(set: EscrowDepositSet): void {
  const seen = new Set<string>();
  for (const e of [...set.vaults, ...set.liquid]) {
    if (seen.has(e.assetIdSeed)) {
      throw new Error(
        `stake-extract: duplicate assetIdSeed "${e.assetIdSeed}" — escrow PDAs would alias`,
      );
    }
    seen.add(e.assetIdSeed);
  }
}
