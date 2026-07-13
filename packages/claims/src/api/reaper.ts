//! Expired-challenge reaper (adversarial-pass low/info hardening).
//!
//! A claim is created `claiming` at initiate with a single-use challenge nonce +
//! `challenge_expires_at`. Expiry was previously handled ONLY lazily — the next
//! `complete` attempt on that claim flips it to `expired`. A claim that is
//! initiated but NEVER completed therefore sits `claiming` forever, so a
//! challenge-flood (many initiates, no completes) accumulates unbounded rows.
//! `claiming` is deliberately excluded from the `one_live_claim_per_asset` unique
//! index, so these stale rows never block a real claim — but they are DB bloat
//! and an amplification surface.
//!
//! This reaper sweeps `claiming` claims whose challenge has expired to `expired`
//! (idempotent; safe to run on a schedule / cron). It uses the partial index
//! `claims_challenge_expires`. Money is untouched — a `claiming` claim never won
//! an asset (the asset is still `available`), so nothing is released or dispensed.

import type { Pool } from "pg";
import { appendAudit } from "./audit.js";

/**
 * Mark up to `limit` expired `claiming` claims as `expired`, appending an audit
 * row per reaped claim. Returns the number reaped. Batch again until it returns 0.
 */
export async function reapExpiredChallenges(
  pool: Pool,
  opts: { now?: Date; limit?: number } = {},
): Promise<number> {
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5000);
  const now = opts.now ?? new Date();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Lock the batch so a concurrent complete() can't race an expiry transition.
    const r = await client.query<{ claim_id: string; asset_key: string; recipient_id: string | null; protocol: number | null }>(
      `SELECT claim_id, asset_key, recipient_id, protocol
         FROM claims
        WHERE status = 'claiming' AND challenge_expires_at IS NOT NULL AND challenge_expires_at <= $1
        ORDER BY challenge_expires_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    for (const row of r.rows) {
      await client.query(
        "UPDATE claims SET status = 'expired', updated_at = now() WHERE claim_id = $1 AND status = 'claiming'",
        [row.claim_id],
      );
      await appendAudit(client, {
        event: "claim.expired",
        claimId: row.claim_id,
        assetKey: row.asset_key,
        recipientId: row.recipient_id ?? undefined,
        protocol: row.protocol ?? undefined,
        status: "expired",
        reason: "challenge expired (reaped)",
      });
    }
    await client.query("COMMIT");
    return r.rows.length;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Drain the whole backlog in bounded batches. Returns the total reaped. */
export async function reapAllExpiredChallenges(
  pool: Pool,
  opts: { now?: Date; batch?: number } = {},
): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await reapExpiredChallenges(pool, { now: opts.now, limit: opts.batch });
    total += n;
    if (n === 0) break;
  }
  return total;
}
