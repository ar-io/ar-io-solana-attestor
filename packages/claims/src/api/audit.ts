//! audit_log append (M3 writes the rows; M6 signs them).
//!
//! Every claim state transition (initiate / complete / reject / expire /
//! pending_review) appends one row here, carrying enough to reconstruct the
//! claim. M3's remit is "just write the rows" — but we already write a REAL
//! sha256 hash chain (`entry_hash = sha256(prev_hash || canonical_json(entry))`)
//! so M6 only has to add the Ed25519 signature over `entry_hash` with the
//! separate AUDIT key. The `signature` column is NOT NULL, so M3 stores a
//! 64-byte zero placeholder and documents the swap.
//!
//! The chain is kept linear under concurrency with a transaction-scoped
//! advisory lock (`pg_advisory_xact_lock`), taken INSIDE this helper — i.e.
//! after any row locks the caller already holds — so ordering is always
//! (claim row -> asset row -> audit advisory) and no cycle can form.

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

/** Stable advisory-lock key for serializing audit-log appends (arbitrary). */
const AUDIT_ADVISORY_KEY = 748_291_003n;

/** 64-byte zero placeholder; M6 replaces with an Ed25519 audit-key signature. */
const UNSIGNED_PLACEHOLDER = Buffer.alloc(64);

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

  await client.query(
    "INSERT INTO audit_log (prev_hash, entry, entry_hash, signature) VALUES ($1, $2::jsonb, $3, $4)",
    [prevHash, json, entryHash, UNSIGNED_PLACEHOLDER],
  );
}

export { canonicalJson as _canonicalJsonForTest };
