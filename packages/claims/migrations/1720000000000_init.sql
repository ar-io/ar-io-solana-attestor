-- Up Migration
--
-- M0 scaffold: intentionally EMPTY. This placeholder gives node-pg-migrate
-- a valid, ordered starting point and lets CI prove `node-pg-migrate up`
-- succeeds against a fresh Postgres. The claims ledger schema
-- (recipients / assets / claims / audit_log — pivot plan section 3.1)
-- is introduced in M1 as the next migration.
SELECT 1;

-- Down Migration
--
-- Nothing to roll back for the empty initial migration.
SELECT 1;
