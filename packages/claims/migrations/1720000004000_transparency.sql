-- Up Migration
--
-- M6 transparency layer (pivot plan §6.5). Two append-only records that make the
-- centralized custodian auditable-after-the-fact:
--
--   * published_ledger — each PUBLISH of the signed recipient->asset ledger
--     commitment (Merkle root + manifest + publisher signature + the frozen leaf
--     set). Immutable snapshots; a third party verifies membership + tamper
--     against a row here without trusting the live tables.
--   * audit_anchors — each on-chain ANCHOR of the audit-log head (and optionally
--     the ledger root): the memo tx signature + slot + the anchored hash. A
--     verifier confirms the live log still extends a previously-anchored head.
--
-- The audit-log hash chain + per-row signature live in the M1 `audit_log` table;
-- M6 only adds the two records above (and back-fills audit_log.signature via the
-- anchor CLI — no schema change needed for that).

CREATE TABLE published_ledger (
  id                 BIGSERIAL PRIMARY KEY,
  -- Operator-supplied version label (e.g. an ISO date or monotone tag).
  ledger_version     TEXT NOT NULL,
  -- Merkle root of the committed leaf set (32 bytes).
  root_hash          BYTEA NOT NULL,
  entry_count        INTEGER NOT NULL,
  -- Σ token/vault amount over the committed leaves (mARIO).
  total_claimable_mario NUMERIC(30,0) NOT NULL,
  -- The full signed artifact: { manifest, signatureHex, publisherPubkeyHex, leaves }.
  artifact           JSONB NOT NULL,
  -- Ed25519 signature over canonical_json(manifest) by the publisher key.
  signature          BYTEA NOT NULL,
  -- Publisher Ed25519 public key (32 bytes) — pin for verification.
  publisher_pubkey   BYTEA NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT published_ledger_root_len_ck CHECK (octet_length(root_hash) = 32),
  CONSTRAINT published_ledger_pubkey_len_ck CHECK (octet_length(publisher_pubkey) = 32)
);
CREATE INDEX published_ledger_by_created ON published_ledger (created_at DESC);

CREATE TABLE audit_anchors (
  id             BIGSERIAL PRIMARY KEY,
  -- 'audit-head' | 'ledger-root'.
  kind           TEXT NOT NULL,
  -- audit-head: the anchored audit_log.seq. ledger-root: the published_ledger id.
  anchored_ref   TEXT NOT NULL,
  -- The anchored hash (audit-head: entry_hash; ledger-root: root_hash), 32 bytes.
  head_hash      BYTEA NOT NULL,
  -- 'solana-memo' | 'arweave' — where the anchor landed.
  target         TEXT NOT NULL,
  network        TEXT NOT NULL,
  -- Solana tx signature (base58) or Arweave data-item id.
  txid           TEXT,
  slot           BIGINT,
  -- The exact memo payload posted on-chain (re-derivable, kept for convenience).
  memo           TEXT NOT NULL,
  confirmed      BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT audit_anchors_kind_ck   CHECK (kind IN ('audit-head', 'ledger-root')),
  CONSTRAINT audit_anchors_target_ck CHECK (target IN ('solana-memo', 'arweave')),
  CONSTRAINT audit_anchors_hash_len_ck CHECK (octet_length(head_hash) = 32)
);
CREATE INDEX audit_anchors_by_kind ON audit_anchors (kind, created_at DESC);

-- Down Migration
DROP TABLE IF EXISTS audit_anchors;
DROP TABLE IF EXISTS published_ledger;
