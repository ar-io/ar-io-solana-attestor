-- Up Migration
--
-- Track the post-dispatch ACL / ownership reconcile for each ANT claim. Our ANT
-- dispatch hands the claimant the MPL Core asset via a raw TransferV1 + UpdateV1,
-- which bypasses the `ario-ant` on-chain ACL — so arns.app keeps showing the OLD
-- owner until we run the permissionless, treasury-paid heal (`reconcile` + ACL
-- owner swap; see src/dispatch/ant-acl-instructions.ts). The dispatch worker
-- sweeps confirmed ANT claims where `ant_acl_healed_at IS NULL` and heals them
-- in-process (it already holds the treasury signer).
--
-- Additive + NOT the money path: these columns never influence custody,
-- settlement, verification, reconciliation, or the ARIO liability ledger — only
-- the ArNS ownership-index bookkeeping. `ant_acl_healed_at` marks the claim as
-- "processed" (healed, already-in-sync, or permanently not-ours-to-heal);
-- `attempts` + `note` are for observability + bounded retry/alerting.

ALTER TABLE claims ADD COLUMN ant_acl_healed_at TIMESTAMPTZ;
ALTER TABLE claims ADD COLUMN ant_acl_heal_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE claims ADD COLUMN ant_acl_heal_note TEXT;

-- Down Migration
ALTER TABLE claims DROP COLUMN IF EXISTS ant_acl_heal_note;
ALTER TABLE claims DROP COLUMN IF EXISTS ant_acl_heal_attempts;
ALTER TABLE claims DROP COLUMN IF EXISTS ant_acl_healed_at;
