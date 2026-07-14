-- Up Migration
--
-- INFO-7: the audit hash chain must hash the EXACT canonical-JSON bytes that
-- were signed, not a re-serialization of the `entry` jsonb read back from
-- Postgres. jsonb does not preserve byte-form (number reformatting, duplicate
-- keys, unicode escaping), so recomputing `canonical_json(entry)` on read is
-- fragile: a future entry carrying a float / bignum / duplicate key could make a
-- correctly-chained row fail verification (or, worse, mask a tamper).
--
-- Store the canonical bytes verbatim in a TEXT column and hash THOSE. Existing
-- rows keep `entry_canonical = NULL` and remain verifiable via the
-- `canonical_json(entry)` fallback in verifyAuditChain (all historical entries
-- are string-valued, so their jsonb round-trip is stable) — a documented cutover,
-- no backfill required.

ALTER TABLE audit_log ADD COLUMN entry_canonical TEXT;

COMMENT ON COLUMN audit_log.entry_canonical IS
  'Exact canonical-JSON bytes hashed into entry_hash: entry_hash = sha256(prev_hash || entry_canonical). NULL for legacy rows written before this column existed; those verify via the canonical_json(entry jsonb) fallback.';

-- Down Migration
ALTER TABLE audit_log DROP COLUMN IF EXISTS entry_canonical;
