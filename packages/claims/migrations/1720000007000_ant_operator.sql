-- Up Migration
--
-- Operator wallet-signed ANT dispatch (docs/claims/ANT_OPERATOR_SIGNING_SPEC.md).
--
-- The ANT authority key stays in the operator's wallet (Phantom/Ledger). The
-- server builds one MPL Core transfer tx per eligible ANT claim with the TREASURY
-- as fee payer (so the server knows + persists the txid BEFORE the operator ever
-- co-signs — the exactly-once anchor is unchanged), reserves the claims into a
-- batch, hands the partially-signed txs to the operator to sign, then persists +
-- broadcasts + confirms per tx on submit.
--
-- Reservation bookkeeping lives on the claim row; a batch header lives in
-- `ant_batches`. NONE of this touches a money column — money is still integer
-- mARIO in the existing dispatch/settlement columns, and the exactly-once state
-- machine (dispatch_signature / dispatch_last_valid_bh / one_live_claim_per_asset)
-- is untouched. All new columns are NULLable append-only reservation metadata.

ALTER TABLE claims
  -- The live batch this ANT claim is reserved into (NULL => not reserved). A
  -- claim is in AT MOST ONE live batch; the reservation is taken at build via
  -- SELECT ... FOR UPDATE SKIP LOCKED and cleared when the batch is submitted,
  -- confirmed, or expires (TTL).
  ADD COLUMN ant_batch_id             UUID,
  -- When the reservation was taken. An abandoned batch (never submitted) frees
  -- its claims once ant_reserved_at is older than ANT_RESERVATION_TTL_MS.
  ADD COLUMN ant_reserved_at          TIMESTAMPTZ,
  -- The txid (== the treasury fee-payer signature) of the tx built + partially
  -- signed for this claim at reservation time. On submit the server matches the
  -- operator-signed tx back to its reservation by this txid ("txid unchanged from
  -- the reserved one") before persisting it as dispatch_signature.
  ADD COLUMN ant_reserved_txid        TEXT,
  -- The recent blockhash the reserved tx was built against (informational + copied
  -- into dispatch_blockhash at submit).
  ADD COLUMN ant_reserved_blockhash   TEXT,
  -- lastValidBlockHeight of the reserved tx's blockhash. REQUIRED to classify the
  -- persisted tx `expired` vs `pending` on the confirm/recover sweep (exactly-once
  -- expiry premise) — it cannot be recovered from the tx bytes, so it is persisted
  -- at reservation and copied into dispatch_last_valid_bh at submit.
  ADD COLUMN ant_reserved_last_valid_bh BIGINT,
  ADD CONSTRAINT claims_ant_reserved_bh_ck
    CHECK (ant_reserved_last_valid_bh IS NULL OR ant_reserved_last_valid_bh >= 0);

-- A live-batch reservation lookup (kept tiny — the vast majority of claims are
-- never in a batch).
CREATE INDEX IF NOT EXISTS claims_ant_batch ON claims (ant_batch_id)
  WHERE ant_batch_id IS NOT NULL;
-- TTL sweep of abandoned reservations.
CREATE INDEX IF NOT EXISTS claims_ant_reserved_at ON claims (ant_reserved_at)
  WHERE ant_reserved_at IS NOT NULL;

-- Batch header. One row per build/sign session. Append-only: a row is inserted at
-- build and only its `status` / `submitted_at` are advanced (open -> submitted /
-- expired). Per-claim membership + state live on the claims rows (ant_batch_id).
CREATE TABLE ant_batches (
  batch_id          UUID PRIMARY KEY,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The ANT-authority pubkey (ANT_COLD_ADDRESS) that authenticated the build.
  created_by_pubkey TEXT        NOT NULL,
  claim_count       INTEGER     NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'open',
  submitted_at      TIMESTAMPTZ,
  CONSTRAINT ant_batches_status_ck CHECK (status IN ('open', 'submitted', 'expired', 'completed')),
  CONSTRAINT ant_batches_claim_count_ck CHECK (claim_count >= 0)
);

CREATE INDEX IF NOT EXISTS ant_batches_status ON ant_batches (status, created_at);

-- Down Migration
DROP INDEX IF EXISTS ant_batches_status;
DROP TABLE IF EXISTS ant_batches;
DROP INDEX IF EXISTS claims_ant_reserved_at;
DROP INDEX IF EXISTS claims_ant_batch;
ALTER TABLE claims
  DROP CONSTRAINT IF EXISTS claims_ant_reserved_bh_ck,
  DROP COLUMN IF EXISTS ant_reserved_last_valid_bh,
  DROP COLUMN IF EXISTS ant_reserved_blockhash,
  DROP COLUMN IF EXISTS ant_reserved_txid,
  DROP COLUMN IF EXISTS ant_reserved_at,
  DROP COLUMN IF EXISTS ant_batch_id;
