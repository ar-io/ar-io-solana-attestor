//! Vault "is this still vaultable?" decision — SELF-CONTAINED copy of
//! `solana-ar-io/migration/import/src/planning/vault-plan.ts`. Shared by the
//! deployed batch-escrow execution layer (personal-vault Phase 3 and
//! stake/withdrawal Phase 4). Mirrors `ario-ant-escrow`'s `deposit_vault`
//! guards: the program rejects an amount below MIN_VAULT_SIZE or a remaining
//! lock below the 14-day MIN_VAULT_LOCK_DURATION, so such a would-be vault
//! falls back to a liquid `deposit_tokens` escrow instead.

/** 100 ARIO — `ArioConfig::MIN_VAULT_SIZE`. */
export const MIN_VAULT_SIZE_MARIO = 100_000_000n;
/** 14 days — `min_vault_duration` (live) and escrow `MIN_VAULT_LOCK_DURATION`. */
export const MIN_VAULT_LOCK_SECONDS = 14 * 86_400;

export function vaultEscrowFallsBackToLiquid(
  amountMario: bigint,
  remainingLockSeconds: bigint | number,
): boolean {
  const remaining =
    typeof remainingLockSeconds === "bigint"
      ? remainingLockSeconds
      : BigInt(Math.trunc(remainingLockSeconds));
  return (
    remaining < BigInt(MIN_VAULT_LOCK_SECONDS) || amountMario < MIN_VAULT_SIZE_MARIO
  );
}
