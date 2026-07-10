//! Persist a LedgerPlan into Postgres (`recipients` + `assets`).
//!
//! Idempotent: re-running upserts by primary key. A fresh random 32-byte nonce
//! is minted per asset on first insert and PRESERVED on re-insert (rotation is
//! an explicit admin action — `update_recipient` — not a side effect of a
//! rebuild). Runs in one transaction so a crash leaves no partial ledger.

import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { LedgerPlan, PlannedAsset } from "./types.js";

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

export async function writeLedger(pool: Pool, plan: LedgerPlan): Promise<BuildResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

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
      `ON CONFLICT (asset_key) DO UPDATE SET
         asset_type = EXCLUDED.asset_type,
         recipient_id = EXCLUDED.recipient_id,
         ant_mint = EXCLUDED.ant_mint,
         amount = EXCLUDED.amount,
         vault_end_ts = EXCLUDED.vault_end_ts,
         status = EXCLUDED.status,
         source = EXCLUDED.source,
         updated_at = now()`,
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
