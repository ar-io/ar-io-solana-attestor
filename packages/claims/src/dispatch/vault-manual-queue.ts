//! Manual vault-delivery operator queue (adversarial-pass item V).
//!
//! A still-locked vault claim (ADR-027 settlement == RE-LOCK) is NOT auto-relocked
//! via a CPI in the centralized model, and must NOT loop forever in
//! `pending_review`. The dispatch worker routes it to the terminal-until-operator
//! status `awaiting_manual_vault_delivery`; this module turns those rows into a
//! precise per-vault operator work-list.
//!
//! For each queued vault the operator needs exactly three things, computed HERE
//! (re-evaluated at report time, since time passes between the settlement decision
//! and the operator acting):
//!   * the claimant (destination wallet),
//!   * the amount (mARIO), and
//!   * the CORRECT ABSOLUTE unlock timestamp == the escrow's ORIGINAL
//!     `vault_end_timestamp` (asset.vault_end_ts). The operator hand-delivers a
//!     "transfer tokens locked" with THIS end date so the unlock is preserved
//!     exactly.
//!   * BUT if that timestamp is already in the PAST at report time, the vault has
//!     since unlocked — the operator must deliver it UNLOCKED (liquid), not re-lock
//!     into the past (which the chain would reject / would be meaningless).
//!
//! Read-only. Money is integer mARIO (bigint); timestamps are bigint unix seconds.

import type { Pool } from "pg";

export type VaultDeliveryKind =
  /** vault_end_ts is still in the future — hand-deliver a locked transfer to it. */
  | "relock"
  /** vault_end_ts already passed at report time — deliver liquid (unlocked). */
  | "liquid_unlocked";

export interface VaultDeliveryItem {
  claimId: string;
  assetKey: string;
  claimant: string;
  amountMario: bigint;
  /** The escrow's original absolute unlock (unix seconds). */
  unlockTimestamp: bigint;
  deliverKind: VaultDeliveryKind;
  /** Seconds remaining to lock for (relock only); 0 for liquid_unlocked. */
  lockDurationSeconds: bigint;
}

export interface VaultDeliveryQueue {
  now: bigint;
  items: VaultDeliveryItem[];
  totalMario: bigint;
  relockCount: number;
  liquidUnlockedCount: number;
}

interface QueueRow {
  claim_id: string;
  asset_key: string;
  claimant: string;
  amount: string | null;
  vault_end_ts: string | null;
}

/**
 * Build the operator's manual vault-delivery work-list from the claims currently
 * `awaiting_manual_vault_delivery`. Pure derivation from DB + `now`.
 */
export async function vaultManualDeliveryQueue(
  pool: Pool,
  opts: { now?: bigint; assetKeys?: string[] } = {},
): Promise<VaultDeliveryQueue> {
  const now = opts.now ?? BigInt(Math.floor(Date.now() / 1000));
  const scope = opts.assetKeys ?? null;
  const r = await pool.query<QueueRow>(
    `SELECT c.claim_id, c.asset_key, c.claimant,
            a.amount::text AS amount, a.vault_end_ts::text AS vault_end_ts
       FROM claims c JOIN assets a ON a.asset_key = c.asset_key
      WHERE c.status = 'awaiting_manual_vault_delivery'
        AND ($1::text[] IS NULL OR c.asset_key = ANY($1::text[]))
      ORDER BY c.updated_at`,
    [scope],
  );

  const items: VaultDeliveryItem[] = [];
  let totalMario = 0n;
  let relockCount = 0;
  let liquidUnlockedCount = 0;

  for (const row of r.rows) {
    const amountMario = BigInt(row.amount ?? "0");
    const unlockTimestamp = BigInt(row.vault_end_ts ?? "0");
    // Re-evaluate against `now`: a re-lock whose unlock has since passed becomes
    // a liquid (unlocked) delivery — never re-lock into the past.
    const remaining = unlockTimestamp - now;
    const isRelock = remaining > 0n;
    items.push({
      claimId: row.claim_id,
      assetKey: row.asset_key,
      claimant: row.claimant,
      amountMario,
      unlockTimestamp,
      deliverKind: isRelock ? "relock" : "liquid_unlocked",
      lockDurationSeconds: isRelock ? remaining : 0n,
    });
    totalMario += amountMario;
    if (isRelock) relockCount += 1;
    else liquidUnlockedCount += 1;
  }

  return { now, items, totalMario, relockCount, liquidUnlockedCount };
}
