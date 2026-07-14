-- Up Migration
--
-- Adversarial-pass hardening (items A + V):
--
--   A) MINIMAL exactly-once guard against a lagging/pooled confirm-RPC. The
--      dispatch worker recovery path re-signs a claim only after its prior tx is
--      classified `expired` (provably dead). A lagging/pooled RPC can misreport a
--      LANDED tx as not-found -> expired, which without a bound would re-sign (and,
--      if it kept lagging, re-sign again) -> N on-chain sends. Two mitigations:
--        1. `dispatch_resign_count` — a HARD CAP of ONE re-sign per claim. On the
--           second expiry with no evidence of a landed outflow, the claim goes to
--           the terminal `needs_operator` state (never loops) + a CRITICAL alert.
--        2. (code) before re-signing, the worker scans the dispenser's on-chain
--           outflows for a CONFIRMED tx carrying THIS claim's own recorded
--           signature; if found it marks the claim confirmed instead of re-sending.
--
--   V) Vault RE-LOCK settlements route to a MANUAL operator delivery queue (the
--      operator hand-delivers a "transfer tokens locked" with the correct absolute
--      unlock date), NOT an auto CPI and NOT an infinite `pending_review` loop.
--      New terminal-until-operator status `awaiting_manual_vault_delivery`.
--
-- All money stays integer mARIO. `needs_operator` / `awaiting_manual_vault_delivery`
-- are non-dispatch states — the worker's pickup queue never selects them, so a
-- claim in either state is inert until an operator acts on it.

ALTER TABLE claims
  -- Number of times the dispatch worker has RE-SIGNED this claim after its prior
  -- tx was classified provably-dead (`expired`). Capped at 1: on the next expiry
  -- the claim goes terminal `needs_operator` rather than emitting another send.
  ADD COLUMN dispatch_resign_count INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT claims_dispatch_resign_count_ck CHECK (dispatch_resign_count >= 0);

-- Extend the claim status domain with the two new terminal-until-operator states.
ALTER TABLE claims DROP CONSTRAINT IF EXISTS claims_status_ck;
ALTER TABLE claims ADD CONSTRAINT claims_status_ck CHECK (status IN
  ('claiming', 'verified', 'pending_review', 'dispatching',
   'confirmed', 'rejected', 'expired', 'failed',
   'needs_operator', 'awaiting_manual_vault_delivery'));

-- Operator work-queue lookups for the two new states (kept tiny by the partial
-- predicate — the vast majority of claims never enter them).
CREATE INDEX IF NOT EXISTS claims_needs_operator
  ON claims (updated_at) WHERE status = 'needs_operator';
CREATE INDEX IF NOT EXISTS claims_awaiting_manual_vault
  ON claims (updated_at) WHERE status = 'awaiting_manual_vault_delivery';

-- Down Migration
DROP INDEX IF EXISTS claims_awaiting_manual_vault;
DROP INDEX IF EXISTS claims_needs_operator;
ALTER TABLE claims DROP CONSTRAINT IF EXISTS claims_status_ck;
ALTER TABLE claims ADD CONSTRAINT claims_status_ck CHECK (status IN
  ('claiming', 'verified', 'pending_review', 'dispatching',
   'confirmed', 'rejected', 'expired', 'failed'));
ALTER TABLE claims
  DROP CONSTRAINT IF EXISTS claims_dispatch_resign_count_ck,
  DROP COLUMN IF EXISTS dispatch_resign_count;
