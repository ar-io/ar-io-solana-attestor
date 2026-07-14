//! Transparency persistence (M6): build ledger leaves from the DB, store/read
//! published-ledger snapshots, record/read on-chain anchors.
//!
//! The published ledger is an IMMUTABLE snapshot: once a `published_ledger` row
//! is written, the membership/tamper checks run against THAT frozen artifact, not
//! the live tables (which keep changing as claims are dispensed). Anchors are
//! append-only pointers to on-chain memo txs.

import { Buffer } from "node:buffer";
import type { Pool } from "pg";

import type { LedgerArtifact, LedgerLeaf } from "./ledger-artifact.js";
import { fromHex } from "./merkle.js";
import type { AnchorKind } from "./anchor.js";

/**
 * Read every ledger asset (joined to its recipient) as public LEAVES. Includes
 * all non-cancelled assets — available + manual_review (AT-RISK) + in-flight +
 * claimed — so the commitment reflects the full entitlement set; each leaf
 * carries its status. `cancelled` rows (operator-voided, never owed) are omitted.
 */
export async function buildLeavesFromDb(pool: Pool): Promise<LedgerLeaf[]> {
  const res = await pool.query<{
    asset_key: string;
    asset_type: "ant" | "token" | "vault";
    recipient_id: string;
    protocol: number;
    amount: string | null;
    ant_mint: string | null;
    vault_end_ts: string | null;
    status: string;
  }>(
    `SELECT a.asset_key, a.asset_type, a.recipient_id, r.protocol,
            a.amount::text AS amount, a.ant_mint, a.vault_end_ts::text AS vault_end_ts, a.status
       FROM assets a JOIN recipients r ON r.recipient_id = a.recipient_id
      WHERE a.status <> 'cancelled'
      ORDER BY a.asset_key ASC`,
  );
  return res.rows.map((r) => ({
    recipientId: r.recipient_id,
    protocol: r.protocol,
    assetKey: r.asset_key,
    assetType: r.asset_type,
    amount: r.amount,
    antMint: r.ant_mint,
    vaultEndTs: r.vault_end_ts === null ? null : Number(r.vault_end_ts),
    status: r.status,
  }));
}

export interface StoredLedger {
  id: string;
  ledgerVersion: string;
  rootHex: string;
  entryCount: number;
  artifact: LedgerArtifact;
  createdAt: string;
}

/** Persist a signed artifact as an immutable published-ledger snapshot. */
export async function persistPublishedLedger(pool: Pool, artifact: LedgerArtifact): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO published_ledger
       (ledger_version, root_hash, entry_count, total_claimable_mario, artifact, signature, publisher_pubkey)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING id`,
    [
      artifact.manifest.ledgerVersion,
      Buffer.from(fromHex(artifact.manifest.rootHex)),
      artifact.manifest.entryCount,
      artifact.manifest.totalClaimableMario,
      JSON.stringify(artifact),
      Buffer.from(fromHex(artifact.signatureHex)),
      Buffer.from(fromHex(artifact.publisherPubkeyHex)),
    ],
  );
  return res.rows[0].id;
}

function rowToStoredLedger(row: {
  id: string;
  ledger_version: string;
  root_hash: Buffer;
  entry_count: number;
  artifact: LedgerArtifact;
  created_at: Date;
}): StoredLedger {
  return {
    id: row.id,
    ledgerVersion: row.ledger_version,
    rootHex: row.root_hash.toString("hex"),
    entryCount: row.entry_count,
    artifact: row.artifact,
    createdAt: row.created_at.toISOString(),
  };
}

const LEDGER_COLS = "id, ledger_version, root_hash, entry_count, artifact, created_at";

/** The latest published-ledger snapshot, or null if none published yet. */
export async function getLatestPublishedLedger(pool: Pool): Promise<StoredLedger | null> {
  const res = await pool.query(`SELECT ${LEDGER_COLS} FROM published_ledger ORDER BY id DESC LIMIT 1`);
  return res.rows[0] ? rowToStoredLedger(res.rows[0]) : null;
}

/** A specific published-ledger snapshot by id (historical / deterministic reads). */
export async function getPublishedLedgerById(pool: Pool, id: string): Promise<StoredLedger | null> {
  const res = await pool.query(`SELECT ${LEDGER_COLS} FROM published_ledger WHERE id = $1`, [id]);
  return res.rows[0] ? rowToStoredLedger(res.rows[0]) : null;
}

export interface AnchorRecord {
  id: string;
  kind: AnchorKind;
  anchoredRef: string;
  headHashHex: string;
  target: string;
  network: string;
  txid: string | null;
  slot: string | null;
  memo: string;
  confirmed: boolean;
  createdAt: string;
}

export async function recordAnchor(
  pool: Pool,
  a: {
    kind: AnchorKind;
    anchoredRef: string;
    headHashHex: string;
    target: string;
    network: string;
    txid: string | null;
    slot: bigint | null;
    memo: string;
    confirmed: boolean;
  },
): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO audit_anchors (kind, anchored_ref, head_hash, target, network, txid, slot, memo, confirmed)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      a.kind,
      a.anchoredRef,
      Buffer.from(fromHex(a.headHashHex)),
      a.target,
      a.network,
      a.txid,
      a.slot === null ? null : a.slot.toString(),
      a.memo,
      a.confirmed,
    ],
  );
  return res.rows[0].id;
}

export async function getAnchors(pool: Pool, opts: { kind?: AnchorKind; limit?: number } = {}): Promise<AnchorRecord[]> {
  const params: unknown[] = [];
  let sql =
    "SELECT id, kind, anchored_ref, head_hash, target, network, txid, slot::text AS slot, memo, confirmed, created_at FROM audit_anchors";
  if (opts.kind) {
    params.push(opts.kind);
    sql += ` WHERE kind = $${params.length}`;
  }
  sql += " ORDER BY id DESC";
  if (opts.limit !== undefined) {
    params.push(opts.limit);
    sql += ` LIMIT $${params.length}`;
  }
  const res = await pool.query<{
    id: string;
    kind: AnchorKind;
    anchored_ref: string;
    head_hash: Buffer;
    target: string;
    network: string;
    txid: string | null;
    slot: string | null;
    memo: string;
    confirmed: boolean;
    created_at: Date;
  }>(sql, params);
  return res.rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    anchoredRef: r.anchored_ref,
    headHashHex: r.head_hash.toString("hex"),
    target: r.target,
    network: r.network,
    txid: r.txid,
    slot: r.slot,
    memo: r.memo,
    confirmed: r.confirmed,
    createdAt: r.created_at.toISOString(),
  }));
}

/** The most-recent confirmed audit-head anchor (for the "extends head" check). */
export async function getLatestAuditAnchor(pool: Pool): Promise<AnchorRecord | null> {
  const rows = await getAnchors(pool, { kind: "audit-head", limit: 1 });
  return rows[0] ?? null;
}
