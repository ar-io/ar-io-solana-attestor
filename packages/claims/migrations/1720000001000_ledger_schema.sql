-- Up Migration
--
-- M1 ledger schema — the recipient -> asset ledger that replaces on-chain
-- ario-ant-escrow custody. Mirrors pivot plan section 3.1
-- (docs/CENTRALIZED_CLAIM_PIVOT_PLAN.md), with two adjustments called out in
-- SPEC.md: (1) AT-RISK owners load status = 'manual_review' (BUILD.md
-- non-negotiable) rather than 'frozen'; (2) recipient_pubkey is nullable for
-- manual_review recipients (they have not published a key), guarded by a CHECK.
--
-- M1 populates `recipients` + `assets`. `claims` + `audit_log` are created here
-- so the schema is complete and reviewable, but are exercised in M3+/M6.

-- ---------------------------------------------------------------------------
-- recipients — one row per frozen recipient identity.
-- ---------------------------------------------------------------------------
CREATE TABLE recipients (
  recipient_id     TEXT PRIMARY KEY,     -- b64url(sha256(recipient_pubkey)), 43 chars for AR
                                         --   (== the Arweave address). Same derivation as
                                         --   canonical.rs::derive_recipient_id_b64url. For a
                                         --   manual_review AR owner with no known key this is
                                         --   the source Arweave address verbatim.
  protocol         SMALLINT NOT NULL,    -- 0 = arweave (512B RSA-4096 modulus), 1 = ethereum (20B addr)
  source_address   TEXT NOT NULL,        -- normalizeSourceAddress() form: AR 43-char b64url verbatim,
                                         --   ETH lowercase 0x-hex (cross-repo contract, normalize-address.ts)
  recipient_pubkey BYTEA,                -- 512B modulus (AR) or 20B address (ETH) — the exact bytes the
                                         --   contract would store. NULL only for manual_review AT-RISK owners.
  status           TEXT NOT NULL DEFAULT 'open',
                                         -- open | manual_review | frozen | closed
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT recipients_protocol_ck CHECK (protocol IN (0, 1)),
  CONSTRAINT recipients_status_ck   CHECK (status IN ('open', 'manual_review', 'frozen', 'closed')),
  -- A claimable recipient MUST carry the deposit-time pubkey; only the AT-RISK
  -- manual_review path is allowed to have none (no key was ever published).
  CONSTRAINT recipients_pubkey_present_ck
    CHECK (status = 'manual_review' OR recipient_pubkey IS NOT NULL)
);
CREATE UNIQUE INDEX recipients_source ON recipients (source_address);

-- ---------------------------------------------------------------------------
-- assets — one row per claimable asset (mirrors one would-be escrow deposit).
-- ---------------------------------------------------------------------------
CREATE TABLE assets (
  asset_key        TEXT PRIMARY KEY,     -- ANT: ant-mint base58. token/vault: 64-hex asset_id =
                                         --   sha256("token-escrow:"+addr) / sha256("vault-escrow:"+addr+":"+vaultId)
                                         --   / sha256(stake seed) — identical seeds to batch-escrow.ts +
                                         --   planning/escrow-extract.ts, so every id matches the on-chain path.
  asset_type       TEXT NOT NULL,        -- ant | token | vault  (on-chain deposit instruction:
                                         --   deposit_ant | deposit_tokens | deposit_vault). Stake + expired /
                                         --   sub-min / short vaults land as 'token' via the liquid fallback,
                                         --   exactly as batch-escrow classifies them.
  recipient_id     TEXT NOT NULL REFERENCES recipients,
  ant_mint         TEXT,                 -- asset_type = ant
  amount           NUMERIC(20,0),        -- mARIO (u64 range); NULL for ANTs
  vault_end_ts     BIGINT,               -- unix seconds; asset_type = vault only (absolute unlock)
  nonce            BYTEA NOT NULL,       -- 32 random bytes minted at ledger build;
                                         --   rotated on every recipient update (mirrors update_recipient)
  status           TEXT NOT NULL DEFAULT 'available',
                                         -- available | manual_review | pending_review | claimed | cancelled | frozen
  source           JSONB NOT NULL,       -- provenance: {phase, aoProcessId|arweaveAddress, vaultId?, planKind?, ...}
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assets_type_ck   CHECK (asset_type IN ('ant', 'token', 'vault')),
  CONSTRAINT assets_status_ck CHECK (status IN
    ('available', 'manual_review', 'pending_review', 'claimed', 'cancelled', 'frozen')),
  -- Shape invariants that mirror the on-chain deposit shapes.
  CONSTRAINT assets_ant_shape_ck CHECK (
    (asset_type = 'ant'  AND ant_mint IS NOT NULL AND amount IS NULL)
    OR (asset_type <> 'ant' AND amount IS NOT NULL)
  ),
  CONSTRAINT assets_nonce_len_ck CHECK (octet_length(nonce) = 32)
);
CREATE INDEX assets_by_recipient ON assets (recipient_id);
CREATE INDEX assets_by_status    ON assets (status);

-- ---------------------------------------------------------------------------
-- claims — one row per claim attempt (populated in M3). Terminal states:
-- confirmed | rejected | failed.
-- ---------------------------------------------------------------------------
CREATE TABLE claims (
  claim_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_key         TEXT NOT NULL REFERENCES assets,
  claimant          TEXT NOT NULL,       -- Solana pubkey, base58
  canonical_message BYTEA NOT NULL,      -- exact bytes verified (rebuilt server-side, never client-supplied)
  user_signature    BYTEA NOT NULL,      -- 512B RSA-PSS or 65B r||s||v
  salt_length       SMALLINT,            -- 0 | 32, arweave only
  attestation_sig   BYTEA,               -- Ed25519 by attestor key, arweave only (audit trail)
  settlement        TEXT,                -- liquid | relock (vaults; NULL for ant/token)
  status            TEXT NOT NULL,       -- received | verified | pending_review | dispatching
                                         --   | confirmed | rejected | failed
  tx_signatures     TEXT[],              -- Solana signature(s) of the dispensing tx(s)
  idempotency_key   TEXT UNIQUE,         -- client-supplied UUID; replays return the original claim
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at       TIMESTAMPTZ,
  confirmed_at      TIMESTAMPTZ
);
-- Hard double-claim guard: at most ONE live claim per asset, enforced by the DB.
CREATE UNIQUE INDEX one_live_claim_per_asset ON claims (asset_key)
  WHERE status IN ('received', 'verified', 'pending_review', 'dispatching');

-- ---------------------------------------------------------------------------
-- audit_log — tamper-evident, hash-chained (populated in M6).
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  seq        BIGSERIAL PRIMARY KEY,
  prev_hash  BYTEA NOT NULL,             -- entry_hash of seq-1 (genesis: 32 zero bytes)
  entry      JSONB NOT NULL,             -- {event, ts, ...} — every state transition writes here
  entry_hash BYTEA NOT NULL,             -- sha256(prev_hash || canonical_json(entry))
  signature  BYTEA NOT NULL              -- Ed25519 over entry_hash by the AUDIT key (!= attestor, != treasury)
);

-- Down Migration
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS claims;
DROP TABLE IF EXISTS assets;
DROP TABLE IF EXISTS recipients;
