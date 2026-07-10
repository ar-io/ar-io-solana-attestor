-- Up Migration
--
-- M4 dispatch + custody. Adds the bookkeeping the dispatch worker needs to
-- dispense a WON claim on-chain **idempotently and exactly-once**, plus the
-- operator-approval columns for the big-claim brake and the operator-gated ANT
-- custody path (pivot plan §4.3, docs/CENTRALIZED_CLAIM_PIVOT_PLAN.md).
--
-- Exactly-once mechanism (see src/dispatch/worker.ts):
--   * verified -> dispatching : the worker builds + SIGNS the dispensing tx,
--     PERSISTS its signature (dispatch_signature) + the blockhash it was signed
--     against (dispatch_blockhash / dispatch_last_valid_bh) BEFORE broadcasting.
--     A crash between persist and land is recoverable: on restart the worker
--     checks the recorded signature via getSignatureStatuses. Found+confirmed ->
--     mark confirmed (no re-send). Not found + the blockhash's lastValidBlockHeight
--     has passed -> the exact tx can NEVER land, so it is safe to re-sign/resend.
--   * dispatching -> confirmed : the tx confirmed on-chain; the asset flips to
--     `claimed` (terminal). The one_live_claim_per_asset index + the asset state
--     machine make a second dispense impossible even across a crash/retry.
--
-- All money stays integer mARIO (NUMERIC(20,0) <-> bigint).

ALTER TABLE claims
  -- The signature of the CURRENT signed dispensing tx, persisted BEFORE the
  -- broadcast. The idempotency anchor: on recovery the worker checks THIS sig's
  -- on-chain status before ever signing a replacement.
  ADD COLUMN dispatch_signature      TEXT,
  -- The recent blockhash the current tx was signed against, and its
  -- lastValidBlockHeight. Together they answer "can the persisted tx still
  -- land?" — if getBlockHeight() > dispatch_last_valid_bh and the sig is not
  -- found, the tx is permanently dead and a fresh one is safe to sign.
  ADD COLUMN dispatch_blockhash      TEXT,
  ADD COLUMN dispatch_last_valid_bh  BIGINT,
  -- When the worker first moved this claim to `dispatching` (single-flight claim).
  ADD COLUMN dispatch_started_at     TIMESTAMPTZ,
  -- Actual mARIO moved on-chain (== amount for token / vault-liquid / vault-relock;
  -- NULL for ANTs). Recorded at confirmation for the dispatched==claimed reconcile.
  ADD COLUMN settlement_amount       NUMERIC(20,0),
  -- Operator approval for a pending_review claim (big-claim brake) OR for an
  -- operator-gated ANT dispatch. NULL => never approved => never auto-dispensed
  -- above the brake threshold / never dispensed from the ANT custody signer.
  ADD COLUMN approved_at             TIMESTAMPTZ,
  ADD COLUMN approved_by             TEXT,
  ADD CONSTRAINT claims_dispatch_bh_ck
    CHECK (dispatch_last_valid_bh IS NULL OR dispatch_last_valid_bh >= 0);

-- The worker's pickup queue: verified (won, awaiting dispatch) + dispatching
-- (in-flight, recovered on restart). Partial index keeps it tiny on a big table.
CREATE INDEX claims_dispatch_queue ON claims (verified_at)
  WHERE status IN ('verified', 'dispatching');

-- Down Migration
DROP INDEX IF EXISTS claims_dispatch_queue;
ALTER TABLE claims
  DROP CONSTRAINT IF EXISTS claims_dispatch_bh_ck,
  DROP COLUMN IF EXISTS approved_by,
  DROP COLUMN IF EXISTS approved_at,
  DROP COLUMN IF EXISTS settlement_amount,
  DROP COLUMN IF EXISTS dispatch_started_at,
  DROP COLUMN IF EXISTS dispatch_last_valid_bh,
  DROP COLUMN IF EXISTS dispatch_blockhash,
  DROP COLUMN IF EXISTS dispatch_signature;
