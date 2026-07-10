//! Persist a LedgerPlan into Postgres (`recipients` + `assets`).
//!
//! Idempotent for a PRE-LAUNCH ledger: re-running upserts by primary key. A
//! fresh random 32-byte nonce is minted per asset on first insert and PRESERVED
//! on re-insert (rotation is an explicit admin action — `update_recipient` — not
//! a side effect of a rebuild). Runs in one transaction so a crash leaves no
//! partial ledger.
//!
//! REBUILD-SAFETY (never resurrect a dispensed asset).
//! Every asset in a fresh plan carries status `available` or `manual_review`. A
//! naive `ON CONFLICT ... DO UPDATE SET status = EXCLUDED.status` would therefore
//! reset an asset that has since moved to `claiming` / `pending_review` /
//! `claimed` (a claim is live or already paid) straight back to `available` — and
//! `getClaimable` / `completeClaim` would offer it again → DOUBLE PAYOUT. Two
//! independent guards prevent that:
//!   1. HARD REFUSE (default): if any asset has left the buildable set
//!      (`status NOT IN ('available','manual_review')`), `writeLedger` throws
//!      before writing a single row. A rebuild against a live ledger is an
//!      operator error and must be loud, not silent.
//!   2. STATUS-SCOPED UPSERT (always on, even when a rebuild is force-allowed):
//!      the asset `ON CONFLICT` update only touches rows still in the buildable
//!      set (`WHERE assets.status IN ('available','manual_review')`), so a
//!      live/terminal row is left byte-for-byte intact — its status, recipient
//!      linkage and nonce never regress.
//! Pass `{ allowLiveRebuild: true }` (CLI: `ALLOW_LIVE_LEDGER_REBUILD=1`) to skip
//! guard 1 for a deliberate, status-safe refresh of the buildable rows only.

import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { LedgerPlan, PlannedAsset } from "./types.js";

/** Asset statuses that are safe to (re)write on a rebuild. Anything else means a
 *  claim is live or already settled and MUST NOT be regressed to `available`. */
const BUILDABLE_ASSET_STATUSES = ["available", "manual_review"] as const;

export interface WriteLedgerOptions {
  /**
   * Allow the rebuild to proceed even when live/terminal assets exist. The
   * status-scoped upsert still preserves those rows (they are never regressed);
   * this only silences the hard refuse for a deliberate, status-safe refresh of
   * the buildable rows. NEVER set this blindly against a production ledger.
   */
  allowLiveRebuild?: boolean;
}

/** Insert rows in chunks of `size` using per-column placeholders (bytea-safe). */
async function insertChunked(
  client: PoolClient,
  sqlHead: string,
  columns: number,
  rows: unknown[][],
  onConflict: string,
  size = 500,
): Promise<void> {
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    const values: string[] = [];
    const params: unknown[] = [];
    let p = 0;
    for (const row of chunk) {
      const ph: string[] = [];
      for (let c = 0; c < columns; c++) {
        ph.push(`$${++p}`);
        params.push(row[c]);
      }
      values.push(`(${ph.join(",")})`);
    }
    await client.query(`${sqlHead} VALUES ${values.join(",")} ${onConflict}`, params);
  }
}

export interface BuildResult {
  recipientsWritten: number;
  assetsWritten: number;
  availableAssets: number;
  manualReviewAssets: number;
}

export async function writeLedger(
  pool: Pool,
  plan: LedgerPlan,
  opts: WriteLedgerOptions = {},
): Promise<BuildResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Guard 1 — HARD REFUSE a rebuild that would touch a live asset (see file
    // header). Scoped to the asset keys IN THIS PLAN (the only rows a rebuild
    // could overwrite) and counted INSIDE the transaction so the check is
    // consistent with the writes. In production the plan IS the whole ledger, so
    // this catches any live claim; it does not trip on unrelated rows.
    if (!opts.allowLiveRebuild) {
      const planKeys = plan.assets.map((a) => a.assetKey);
      const live = await client.query<{ n: string; statuses: string[] }>(
        `SELECT count(*)::text AS n,
                COALESCE(array_agg(DISTINCT status), '{}') AS statuses
           FROM assets
          WHERE asset_key = ANY($1::text[])
            AND status <> ALL($2::text[])`,
        [planKeys, BUILDABLE_ASSET_STATUSES as unknown as string[]],
      );
      const n = BigInt(live.rows[0]?.n ?? "0");
      if (n > 0n) {
        const statuses = (live.rows[0]?.statuses ?? []).join(", ");
        throw new Error(
          `refusing to rebuild the ledger: ${n} asset row(s) in this plan have left the ` +
            `buildable set (status in: ${statuses}). A rebuild would reset a live/claimed ` +
            `asset to 'available' and enable a DOUBLE PAYOUT. Rebuild only against a ledger ` +
            `with no live claims, or set ALLOW_LIVE_LEDGER_REBUILD=1 for a deliberate, ` +
            `status-safe refresh (live/terminal rows are preserved untouched either way).`,
        );
      }
    }

    // Recipients.
    const recRows = plan.recipients.map((r) => [
      r.recipientId,
      r.protocol,
      r.sourceAddress,
      r.recipientPubkey ? Buffer.from(r.recipientPubkey) : null,
      r.status,
    ]);
    await insertChunked(
      client,
      "INSERT INTO recipients (recipient_id, protocol, source_address, recipient_pubkey, status)",
      5,
      recRows,
      `ON CONFLICT (recipient_id) DO UPDATE SET
         protocol = EXCLUDED.protocol,
         source_address = EXCLUDED.source_address,
         recipient_pubkey = EXCLUDED.recipient_pubkey,
         status = EXCLUDED.status,
         updated_at = now()`,
    );

    // Map recipientSource -> recipient_id for the asset FK.
    const srcToId = new Map(plan.recipients.map((r) => [r.sourceAddress, r.recipientId]));

    const assetRows = plan.assets.map((a: PlannedAsset) => {
      const recipientId = srcToId.get(a.recipientSource);
      if (!recipientId) {
        throw new Error(
          `asset ${a.assetKey} references recipient ${a.recipientSource} not present in recipients`,
        );
      }
      return [
        a.assetKey,
        a.assetType,
        recipientId,
        a.antMint,
        a.amount === null ? null : a.amount.toString(),
        a.vaultEndTs,
        randomBytes(32),
        a.status,
        JSON.stringify(a.source),
      ];
    });
    await insertChunked(
      client,
      "INSERT INTO assets (asset_key, asset_type, recipient_id, ant_mint, amount, vault_end_ts, nonce, status, source)",
      9,
      assetRows,
      // Preserve the existing nonce on re-insert; refresh the mutable fields.
      // Guard 2 (see file header): the `WHERE` scopes the update to rows still in
      // the buildable set. A conflicting row that has advanced to
      // `claiming`/`pending_review`/`claimed` (or an operator `cancelled`/`frozen`)
      // fails the predicate, so ON CONFLICT does NOTHING for it — its status,
      // recipient linkage and nonce are left byte-for-byte intact, and a
      // dispensed asset can never be re-offered by getClaimable/completeClaim.
      `ON CONFLICT (asset_key) DO UPDATE SET
         asset_type = EXCLUDED.asset_type,
         recipient_id = EXCLUDED.recipient_id,
         ant_mint = EXCLUDED.ant_mint,
         amount = EXCLUDED.amount,
         vault_end_ts = EXCLUDED.vault_end_ts,
         status = EXCLUDED.status,
         source = EXCLUDED.source,
         updated_at = now()
       WHERE assets.status IN ('available', 'manual_review')`,
    );

    await client.query("COMMIT");
    return {
      recipientsWritten: plan.recipients.length,
      assetsWritten: plan.assets.length,
      availableAssets: plan.assets.filter((a) => a.status === "available").length,
      manualReviewAssets: plan.assets.filter((a) => a.status === "manual_review").length,
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
