//! Vault claim settlement decision (ADR-027) — pure, recomputed at claim time.
//!
//! Consumed by M4 dispatch. Given the escrow's ORIGINAL `vault_end_timestamp`
//! + amount and the LIVE `ArioConfig.min_vault_duration` / `max_vault_duration`
//! (read from ario-core at dispatch), decide how to settle the claim. This is
//! the authoritative settlement decision — the ledger's `asset_type` is
//! ADVISORY; a deposit that was `deposit_vault` at freeze may have crossed its
//! unlock (or its early-liquidity window) by claim time.
//!
//! ADR-022 removed on-chain active-vault re-lock; ADR-027 RESTORED it. On-chain,
//! ADR-027 re-lock has two internal forms — `create_vault` when the payer IS the
//! claimant, `vaulted_transfer` otherwise. In the CENTRALIZED model the treasury
//! is always the sender (a normal wallet), so both collapse into a single
//! treasury-signed `vaulted_transfer(amount, remaining, revocable=false,
//! recipient=claimant)`; the unlock lands at exactly the original
//! `vault_end_timestamp`. So the SETTLEMENT OUTCOME is binary (relock | liquid),
//! reached via the three decision branches below.
//!
//! Branches (mirrors `claim_vault_*` + the deposit-time `vaultEscrowFallsBackToLiquid`
//! + ario-core `create_vault`/`vaulted_transfer` guards):
//!   remaining = vault_end_ts - now
//!   remaining <= 0                          -> liquid  (expired; delivered liquid)
//!   amount   <  MIN_VAULT_SIZE              -> liquid  (re-lock would revert VaultBelowMinimum)
//!   remaining <  min_vault_duration         -> liquid  (BD-113 early-liquidity window, preserved)
//!   otherwise                               -> RE-LOCK for `remaining`, revocable=false
//!     (remaining > max_vault_duration is an on-chain LockDurationTooLong -> error)
//!
//! All money is `bigint` mARIO; all durations/timestamps are `bigint` seconds.

import { VerificationError } from "./errors.js";
import { MIN_VAULT_SIZE_MARIO } from "../ledger/vault-rules.js";

export type VaultSettlement =
  | {
      kind: "liquid";
      /** Why liquid — provenance for the audit log / operator view. */
      reason: "expired" | "below_min_amount" | "below_min_duration";
      remainingSeconds: bigint;
    }
  | {
      kind: "relock";
      /** New lock duration for the treasury `vaulted_transfer` — == remaining. */
      lockDurationSeconds: bigint;
      /** Absolute unlock == the ORIGINAL vault_end_timestamp. */
      unlockTimestamp: bigint;
      /** Re-locked vaults are non-revocable (ADR-027 / migration policy). */
      revocable: false;
      remainingSeconds: bigint;
    };

function toBig(v: bigint | number): bigint {
  if (typeof v === "bigint") return v;
  if (!Number.isInteger(v)) {
    throw new VerificationError("INVALID_INPUT", `expected an integer, got ${v}`);
  }
  return BigInt(v);
}

/**
 * Compute the ADR-027 settlement for a vault claim. Pure — no I/O. `now`,
 * `minVaultDuration`, `maxVaultDuration` are LIVE values (M4 reads them from
 * ario-core `ArioConfig` at dispatch time and passes them in).
 */
export function computeVaultSettlement(args: {
  /** Original absolute unlock, unix seconds. */
  vaultEndTs: bigint | number;
  /** Escrowed amount, mARIO. */
  amount: bigint | number;
  /** Live `ArioConfig.min_vault_duration`, seconds. */
  minVaultDuration: bigint | number;
  /** Live `ArioConfig.max_vault_duration`, seconds. */
  maxVaultDuration: bigint | number;
  /** Current time, unix seconds (M4 passes the live clock). */
  now: bigint | number;
}): VaultSettlement {
  const vaultEndTs = toBig(args.vaultEndTs);
  const amount = toBig(args.amount);
  const minVaultDuration = toBig(args.minVaultDuration);
  const maxVaultDuration = toBig(args.maxVaultDuration);
  const now = toBig(args.now);

  if (amount < 0n) {
    throw new VerificationError("INVALID_INPUT", `vault amount must be >= 0, got ${amount}`);
  }

  const remaining = vaultEndTs - now;

  // Branch 1: already unlocked -> liquid pass-through.
  if (remaining <= 0n) {
    return { kind: "liquid", reason: "expired", remainingSeconds: remaining };
  }

  // Branch 2: below the on-chain minimum vault size -> a re-lock CPI would
  // revert (ArioError::VaultBelowMinimum), so deliver liquid (matches the
  // deposit-time `vaultEscrowFallsBackToLiquid` amount fallback). Real ledger
  // `vault` assets already cleared MIN_VAULT_SIZE at deposit; this guards the
  // anomaly rather than stranding the claim.
  if (amount < MIN_VAULT_SIZE_MARIO) {
    return { kind: "liquid", reason: "below_min_amount", remainingSeconds: remaining };
  }

  // Branch 3: inside the early-liquidity window -> liquid (BD-113). A re-lock
  // for < min_vault_duration would revert (ArioError::LockDurationTooShort).
  if (remaining < minVaultDuration) {
    return { kind: "liquid", reason: "below_min_duration", remainingSeconds: remaining };
  }

  // Otherwise: RE-LOCK for the full remaining time, unlock == original end.
  if (remaining > maxVaultDuration) {
    // No valid single re-lock exists (ario-core LockDurationTooLong). Surface it
    // rather than silently capping (which would move the unlock earlier).
    throw new VerificationError(
      "LOCK_DURATION_TOO_LONG",
      `remaining lock ${remaining}s exceeds max_vault_duration ${maxVaultDuration}s`,
    );
  }

  return {
    kind: "relock",
    lockDurationSeconds: remaining,
    unlockTimestamp: vaultEndTs,
    revocable: false,
    remainingSeconds: remaining,
  };
}
