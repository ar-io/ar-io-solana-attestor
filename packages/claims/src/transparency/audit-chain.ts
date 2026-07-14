//! Audit-log chain verification + signing (M6 deliverable #2, pivot plan §6.5.2).
//!
//! The `audit_log` table already carries a sha256 hash chain written by M3/M4
//! (`entry_hash = sha256(prev_hash || canonical_json(entry))`, `prev_hash` =
//! the previous row's `entry_hash`, genesis prev = 32 zero bytes). This module:
//!
//!   * VERIFIES the chain independently — recomputes every `entry_hash` from the
//!     stored `entry` jsonb and confirms both the hash and the `prev_hash`
//!     linkage, so any silent edit/insert/delete surfaces as a break.
//!   * SIGNS each `entry_hash` with the SEPARATE audit key (schema §3.1) — either
//!     on write (setAuditSigner) or by back-filling placeholder rows here.
//!   * Exposes the chain HEAD ({seq, entryHash}) — the value anchored on-chain so
//!     the log cannot be rewritten after the fact (anchor.ts).
//!
//! Money is never touched here; this is pure integrity over bytes.

import { Buffer } from "node:buffer";
import type { Pool, PoolClient } from "pg";

import { computeEntryHash, hashCanonical, UNSIGNED_PLACEHOLDER } from "../api/audit.js";
import { verifyEd25519, type TransparencyKeypair } from "./keys.js";

/** A raw audit row as read from Postgres (bytea -> Buffer, bigserial -> string). */
export interface AuditRow {
  seq: string;
  prevHash: Buffer;
  entry: unknown;
  /**
   * Exact canonical-JSON bytes that were hashed (INFO-7). Present for rows written
   * on/after the `entry_canonical` migration; the verifier hashes THESE. `null`/
   * `undefined` for legacy rows, which fall back to re-serializing `entry`.
   */
  entryCanonical?: string | null;
  entryHash: Buffer;
  signature: Buffer;
}

export interface ChainHead {
  seq: string;
  entryHashHex: string;
}

export interface ChainVerification {
  ok: boolean;
  count: number;
  /** Rows carrying a real (non-placeholder) audit-key signature. */
  signedCount: number;
  /** Rows whose signature verified against `auditPubkey` (0 if no key given). */
  signatureValidCount: number;
  head: ChainHead | null;
  /** seq of the first row that broke linkage/hash/signature, if any. */
  firstBadSeq: string | null;
  issues: string[];
}

const ZERO32 = Buffer.alloc(32);

function isPlaceholder(sig: Buffer): boolean {
  return sig.length === UNSIGNED_PLACEHOLDER.length && sig.equals(UNSIGNED_PLACEHOLDER);
}

export interface VerifyChainOptions {
  auditPubkey?: Uint8Array;
  /**
   * Expected prev_hash of the FIRST row. Default = genesis (32 zeros) for a full
   * audit from the start. Pass a known prior entry_hash to verify a CONTIGUOUS
   * SUFFIX (the audit log is append-only in production; deleting a row breaks the
   * chain — which is exactly what full-chain verification is meant to catch).
   */
  initialPrevHash?: Buffer;
}

/**
 * Verify the hash-chain linkage (and, when `auditPubkey` is given, the Ed25519
 * signatures) over `rows` (seq ascending). Rows must be a CONTIGUOUS run; pass
 * the whole log from genesis for a full audit, or a suffix with `initialPrevHash`.
 */
export function verifyAuditChain(
  rows: AuditRow[],
  auditPubkeyOrOpts?: Uint8Array | VerifyChainOptions,
): ChainVerification {
  const opts: VerifyChainOptions =
    auditPubkeyOrOpts instanceof Uint8Array ? { auditPubkey: auditPubkeyOrOpts } : (auditPubkeyOrOpts ?? {});
  const auditPubkey = opts.auditPubkey;
  const issues: string[] = [];
  let signedCount = 0;
  let signatureValidCount = 0;
  let firstBadSeq: string | null = null;
  let prev: Buffer = opts.initialPrevHash ?? ZERO32;
  let head: ChainHead | null = null;

  for (const row of rows) {
    let bad = false;

    if (!row.prevHash.equals(prev)) {
      issues.push(`seq ${row.seq}: prev_hash does not chain to the prior entry_hash`);
      bad = true;
    }
    // Hash the exact stored canonical bytes when present (INFO-7); otherwise fall
    // back to re-serializing the `entry` jsonb (legacy pre-migration rows).
    const recomputed =
      row.entryCanonical != null
        ? hashCanonical(row.prevHash, row.entryCanonical)
        : computeEntryHash(row.prevHash, row.entry);
    if (!recomputed.equals(row.entryHash)) {
      issues.push(`seq ${row.seq}: entry_hash mismatch (entry content altered)`);
      bad = true;
    }

    if (!isPlaceholder(row.signature)) {
      signedCount++;
      if (auditPubkey) {
        const ok = verifyEd25519(row.entryHash, row.signature, auditPubkey);
        if (ok) signatureValidCount++;
        else {
          issues.push(`seq ${row.seq}: audit signature invalid`);
          bad = true;
        }
      }
    }

    if (bad && firstBadSeq === null) firstBadSeq = row.seq;
    prev = row.entryHash;
    head = { seq: row.seq, entryHashHex: row.entryHash.toString("hex") };
  }

  return {
    ok: firstBadSeq === null,
    count: rows.length,
    signedCount,
    signatureValidCount,
    head,
    firstBadSeq,
    issues,
  };
}

export interface ExtendsCheck {
  ok: boolean;
  /** The chain up to the anchored seq is internally valid. */
  chainOk: boolean;
  /** The anchored seq exists in the current log. */
  anchoredSeqFound: boolean;
  /** The entry_hash at the anchored seq equals the anchored hash. */
  hashMatches: boolean;
  issues: string[];
}

/**
 * Confirm the current log EXTENDS a previously-anchored head: the chain up to
 * `anchoredSeq` is valid AND the entry_hash there equals `anchoredHashHex`. If
 * the operator rewrote any entry at or before `anchoredSeq`, the recomputed hash
 * at that seq diverges from the on-chain anchor -> flagged. `rows` must be the
 * full log from genesis (seq ascending).
 */
export function checkExtendsAnchor(
  rows: AuditRow[],
  anchoredSeq: string,
  anchoredHashHex: string,
  auditPubkeyOrOpts?: Uint8Array | VerifyChainOptions,
): ExtendsCheck {
  const issues: string[] = [];
  const upTo = rows.filter((r) => BigInt(r.seq) <= BigInt(anchoredSeq));
  const chain = verifyAuditChain(upTo, auditPubkeyOrOpts);
  if (!chain.ok) issues.push(`chain up to anchored seq ${anchoredSeq} is invalid: ${chain.issues.join("; ")}`);

  const row = upTo.find((r) => r.seq === anchoredSeq);
  const anchoredSeqFound = row !== undefined;
  if (!anchoredSeqFound) issues.push(`anchored seq ${anchoredSeq} not found in the current log`);

  const hashMatches = row !== undefined && row.entryHash.toString("hex") === anchoredHashHex.toLowerCase();
  if (row && !hashMatches) {
    issues.push(
      `entry_hash at anchored seq ${anchoredSeq} (${row.entryHash.toString("hex")}) != anchored hash ${anchoredHashHex} — history was rewritten`,
    );
  }

  return { ok: chain.ok && anchoredSeqFound && hashMatches, chainOk: chain.ok, anchoredSeqFound, hashMatches, issues };
}

/** Load audit rows (ascending) for verification. `limit`/`sinceSeq` paginate. */
export async function loadAuditRows(
  db: Pool | PoolClient,
  opts: { sinceSeq?: string; limit?: number } = {},
): Promise<AuditRow[]> {
  const since = opts.sinceSeq ?? "0";
  const params: unknown[] = [since];
  let sql =
    "SELECT seq, prev_hash, entry, entry_canonical, entry_hash, signature FROM audit_log WHERE seq > $1 ORDER BY seq ASC";
  if (opts.limit !== undefined) {
    params.push(opts.limit);
    sql += " LIMIT $2";
  }
  const res = await db.query<{
    seq: string;
    prev_hash: Buffer;
    entry: unknown;
    entry_canonical: string | null;
    entry_hash: Buffer;
    signature: Buffer;
  }>(sql, params);
  return res.rows.map((r) => ({
    seq: r.seq,
    prevHash: r.prev_hash,
    entry: r.entry,
    entryCanonical: r.entry_canonical,
    entryHash: r.entry_hash,
    signature: r.signature,
  }));
}

/** The current chain head (latest seq + entry_hash), or null on an empty log. */
export async function getAuditHead(db: Pool | PoolClient): Promise<ChainHead | null> {
  const res = await db.query<{ seq: string; entry_hash: Buffer }>(
    "SELECT seq, entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1",
  );
  const row = res.rows[0];
  return row ? { seq: row.seq, entryHashHex: row.entry_hash.toString("hex") } : null;
}

/**
 * Back-fill Ed25519 signatures onto every placeholder (all-zero) audit row using
 * the audit key. Signs over the immutable `entry_hash`, so this produces exactly
 * the signature `appendAudit` would have written with the signer registered.
 * Returns how many rows were signed.
 */
export async function signUnsignedAuditRows(pool: Pool, keypair: TransparencyKeypair): Promise<number> {
  const res = await pool.query<{ seq: string; entry_hash: Buffer }>(
    "SELECT seq, entry_hash FROM audit_log WHERE signature = $1 ORDER BY seq ASC",
    [UNSIGNED_PLACEHOLDER],
  );
  if (res.rows.length === 0) return 0;
  const seqs: string[] = [];
  const sigs: Buffer[] = [];
  for (const row of res.rows) {
    seqs.push(row.seq);
    sigs.push(Buffer.from(keypair.sign(row.entry_hash)));
  }
  // Batched UPDATE (one round-trip) — mainnet has thousands of rows to back-fill.
  const CHUNK = 1000;
  for (let i = 0; i < seqs.length; i += CHUNK) {
    const seqChunk = seqs.slice(i, i + CHUNK);
    const sigChunk = sigs.slice(i, i + CHUNK);
    await pool.query(
      `UPDATE audit_log AS al SET signature = d.sig
         FROM (SELECT unnest($1::bigint[]) AS seq, unnest($2::bytea[]) AS sig) AS d
        WHERE al.seq = d.seq`,
      [seqChunk, sigChunk],
    );
  }
  return seqs.length;
}
