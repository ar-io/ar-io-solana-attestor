-- Up Migration
--
-- Anti-redirect hardening for the operator wallet-signed ANT flow: make the SERVER
-- authoritative over the transaction MESSAGE bytes, enforced IN-PROCESS (not
-- delegated to the validator's fee-payer signature check).
--
-- Before this, `submitAntBatch` matched a reservation by txid and verified the
-- operator's authority signature over WHATEVER message the client submitted, then
-- broadcast the client's wire. A malicious/compromised operator could copy the
-- reserved txid into the fee-payer slot, tamper the message (redirect the ANT or
-- strip the memo), sign the authority slot over the tampered message, and the
-- backend would broadcast doomed bytes (rejected on-chain, but churning the claim
-- into dead-tx recovery — a self-inflicted DoS).
--
-- Fix: persist the EXACT server-built, treasury-cosigned partial wire at build
-- time. On submit the server takes ONLY the operator's authority signature,
-- reconstructs the broadcast wire from THIS stored wire + that signature, and
-- verifies the authority signature over the STORED message. The client never
-- controls the broadcast bytes. No money column is touched; this is nullable,
-- append-only reservation metadata.

ALTER TABLE claims
  -- The base64 server-built partial transaction (treasury fee-payer signature +
  -- message, authority slot EMPTY) for the current reservation. The authoritative
  -- message the operator must sign; the broadcast wire is rebuilt from it.
  ADD COLUMN ant_reserved_wire TEXT;

-- Down Migration
ALTER TABLE claims
  DROP COLUMN IF EXISTS ant_reserved_wire;
