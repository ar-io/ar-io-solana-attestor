//! audit_log append (M3 writes the rows; M6 signs + anchors them).
//!
//! Every claim state transition (initiate / complete / reject / expire /
//! pending_review) appends one row here, carrying enough to reconstruct the
//! claim. M3's remit was "just write the rows" — with a REAL sha256 hash chain
//! (`entry_hash = sha256(prev_hash || canonical_json(entry))`). M6 adds the
//! Ed25519 signature over `entry_hash` with the SEPARATE audit key: when an
//! audit signer is registered via `setAuditSigner`, new rows are signed on
//! write; otherwise a 64-byte zero placeholder is stored and the M6 anchor CLI
//! back-fills the signature (`signUnsignedAuditRows`). Either way the chain is
//! independently verifiable and, once anchored on-chain, tamper-evident.
//!
//! The chain is kept linear under concurrency with a transaction-scoped
//! advisory lock (`pg_advisory_xact_lock`), taken INSIDE this helper — i.e.
//! after any row locks the caller already holds — so ordering is always
//! (claim row -> asset row -> audit advisory) and no cycle can form.

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

/** Stable advisory-lock key for serializing audit-log appends (arbitrary). */
const AUDIT_ADVISORY_KEY = 748_291_003n;

/** 64-byte zero placeholder; back-filled with an Ed25519 audit-key signature. */
export const UNSIGNED_PLACEHOLDER = Buffer.alloc(64);

/**
 * Optional process-wide audit signer. When set (M6 service boot), `appendAudit`
 * signs each new row's `entry_hash` on write. Kept as a pluggable hook so the
 * M3/M4 code paths that call `appendAudit` need no signature-awareness and the
 * default (unset) behavior — placeholder + later back-fill — is unchanged.
 */
export interface AuditEntrySigner {
  /** Sign a 32-byte entry hash, returning a 64-byte Ed25519 signature. */
  signEntryHash(entryHash: Buffer): Buffer;
}
let auditSigner: AuditEntrySigner | null = null;
export function setAuditSigner(signer: AuditEntrySigner | null): void {
  auditSigner = signer;
}

export interface AuditEntry {
  /** e.g. "claim.initiate" | "claim.verified" | "claim.rejected" | ... */
  event: string;
  claimId?: string;
  assetKey?: string;
  claimant?: string;
  recipientId?: string;
  protocol?: number;
  /** resulting status of the claim/asset after the transition */
  status?: string;
  /** machine reason on a rejection */
  reason?: string;
  /** free-form extra context (amounts as strings — never JS numbers for money) */
  detail?: Record<string, unknown>;
}

/** Deterministic JSON: object keys sorted recursively, so the hash is stable. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${parts.join(",")}}`;
}

/**
 * Append one audit row on `client` (MUST be inside the caller's transaction so
 * the audit entry commits atomically with the state transition it records).
 */
export async function appendAudit(client: PoolClient, entry: AuditEntry): Promise<void> {
  // Serialize appends so prev_hash is read consistently (kept linear for M6).
  await client.query("SELECT pg_advisory_xact_lock($1)", [AUDIT_ADVISORY_KEY]);

  const prevRes = await client.query<{ entry_hash: Buffer }>(
    "SELECT entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1",
  );
  const prevHash = prevRes.rows[0]?.entry_hash ?? Buffer.alloc(32);

  const record = { ts: new Date().toISOString(), ...entry };
  const json = canonicalJson(record);
  const entryHash = createHash("sha256")
    .update(prevHash)
    .update(Buffer.from(json, "utf8"))
    .digest();

  // Sign on write when an audit signer is registered (M6); else placeholder,
  // back-filled by the anchor CLI. Signing over entry_hash (immutable) means a
  // later back-fill produces the identical signature.
  const signature = auditSigner ? auditSigner.signEntryHash(entryHash) : UNSIGNED_PLACEHOLDER;

  await client.query(
    "INSERT INTO audit_log (prev_hash, entry, entry_hash, signature) VALUES ($1, $2::jsonb, $3, $4)",
    [prevHash, json, entryHash, signature],
  );
}

/**
 * Recompute an entry's hash from `prevHash` and the entry object as stored in
 * the `entry` jsonb column. MUST reproduce the bytes `appendAudit` hashed, so it
 * uses the SAME canonical serialization. The verifier (audit-chain.ts) folds
 * this across the whole log to prove linkage independently of the DB.
 */
export function computeEntryHash(prevHash: Buffer, entry: unknown): Buffer {
  const json = canonicalJson(entry);
  return createHash("sha256").update(prevHash).update(Buffer.from(json, "utf8")).digest();
}

export { canonicalJson, canonicalJson as _canonicalJsonForTest };
