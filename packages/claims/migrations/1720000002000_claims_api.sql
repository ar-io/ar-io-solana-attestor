-- Up Migration
--
-- M3 claims API + replay/double-claim defense. Extends the M1 `claims` +
-- `assets` schema with the columns the initiate/complete state machine needs,
-- and tightens the DB-level guards that make double-dispense impossible under
-- concurrency (pivot plan §4.1, docs/CENTRALIZED_CLAIM_PIVOT_PLAN.md).
--
-- Design (see SPEC.md "M3"):
--   * Asset lifecycle:  available -> claiming -> claimed.
--       - available : claimable, no claim has won it.
--       - claiming  : a completed+verified claim has WON it; dispatch intent
--                     recorded; M4's worker dispenses on-chain. Irrevocable —
--                     any competing claim sees this as "already claimed".
--       - claimed   : M4 confirmed the dispensing tx on-chain (terminal).
--   * Claim lifecycle:  claiming -> verified -> (dispatching -> confirmed | failed)
--                       claiming -> rejected | expired | pending_review
--       - claiming  : initiated; a single-use challenge nonce + expiry issued;
--                     awaiting the signed proof.
--       - verified  : proof verified; the asset is now `claiming`; THIS row is
--                     the dispatch intent M4 consumes.
--       - pending_review : big-claim brake tripped (amount > threshold); an
--                     operator approves before dispatch (§4.3).
--       - rejected  : proof failed verification, OR the asset was already won
--                     by another claim (clean ALREADY_CLAIMED). Asset untouched.
--       - expired   : the challenge nonce expired before completion.
--
-- The hard double-claim guard is a row-level lock at complete
-- (`SELECT asset FOR UPDATE`) plus the asset state machine — NOT app-level
-- checks. The partial-unique index below is a belt-and-suspenders backstop:
-- at most ONE claim per asset may sit in a won state.

-- 1. Assets may now be `claiming` (won, dispatch pending).
ALTER TABLE assets DROP CONSTRAINT assets_status_ck;
ALTER TABLE assets ADD CONSTRAINT assets_status_ck CHECK (status IN
  ('available', 'claiming', 'manual_review', 'pending_review', 'claimed', 'cancelled', 'frozen'));

-- 2. Claim-row columns the two-phase flow needs.
--    A claim is created at INITIATE, before the signature exists, so
--    user_signature becomes nullable (filled at COMPLETE). canonical_message
--    stays NOT NULL — the server builds and stores it at initiate.
ALTER TABLE claims ALTER COLUMN user_signature DROP NOT NULL;

ALTER TABLE claims
  -- The single-use challenge issued at initiate and bound into the canonical
  -- message the client signs. Consumed atomically at complete.
  ADD COLUMN challenge_nonce      BYTEA,
  ADD COLUMN challenge_expires_at TIMESTAMPTZ,
  -- Denormalized for the audit trail + per-identity rate limiting (avoids a
  -- join on every request). protocol mirrors recipients.protocol.
  ADD COLUMN recipient_id         TEXT REFERENCES recipients,
  ADD COLUMN protocol             SMALLINT,
  ADD COLUMN updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD CONSTRAINT claims_challenge_nonce_len_ck
    CHECK (challenge_nonce IS NULL OR octet_length(challenge_nonce) = 32),
  ADD CONSTRAINT claims_protocol_ck
    CHECK (protocol IS NULL OR protocol IN (0, 1)),
  ADD CONSTRAINT claims_status_ck CHECK (status IN
    ('claiming', 'verified', 'pending_review', 'dispatching',
     'confirmed', 'rejected', 'expired', 'failed'));

-- 3. Recreate the double-claim backstop over the WON states only.
--    `claiming` claims (initiated, unproven) are intentionally excluded so
--    multiple claimants may race an asset; the winner is decided by the asset
--    FOR UPDATE lock at complete. Once a claim is `verified`/`pending_review`/
--    `dispatching`, no second one for the same asset can exist.
DROP INDEX IF EXISTS one_live_claim_per_asset;
CREATE UNIQUE INDEX one_live_claim_per_asset ON claims (asset_key)
  WHERE status IN ('verified', 'pending_review', 'dispatching');

-- 4. Lookup indexes for the reaper (expired challenges) + operator queue.
CREATE INDEX claims_by_status         ON claims (status);
CREATE INDEX claims_by_recipient      ON claims (recipient_id);
CREATE INDEX claims_challenge_expires ON claims (challenge_expires_at)
  WHERE status = 'claiming';

-- Down Migration
DROP INDEX IF EXISTS claims_challenge_expires;
DROP INDEX IF EXISTS claims_by_recipient;
DROP INDEX IF EXISTS claims_by_status;
DROP INDEX IF EXISTS one_live_claim_per_asset;
CREATE UNIQUE INDEX one_live_claim_per_asset ON claims (asset_key)
  WHERE status IN ('received', 'verified', 'pending_review', 'dispatching');
ALTER TABLE claims
  DROP CONSTRAINT IF EXISTS claims_status_ck,
  DROP CONSTRAINT IF EXISTS claims_protocol_ck,
  DROP CONSTRAINT IF EXISTS claims_challenge_nonce_len_ck,
  DROP COLUMN IF EXISTS updated_at,
  DROP COLUMN IF EXISTS protocol,
  DROP COLUMN IF EXISTS recipient_id,
  DROP COLUMN IF EXISTS challenge_expires_at,
  DROP COLUMN IF EXISTS challenge_nonce;
ALTER TABLE claims ALTER COLUMN user_signature SET NOT NULL;
ALTER TABLE assets DROP CONSTRAINT assets_status_ck;
ALTER TABLE assets ADD CONSTRAINT assets_status_ck CHECK (status IN
  ('available', 'manual_review', 'pending_review', 'claimed', 'cancelled', 'frozen'));
