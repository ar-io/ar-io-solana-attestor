-- Up Migration
--
-- Display-only: store an ANT's on-chain ArNS name (the MPL Core asset `name`
-- field) alongside the asset so the API + frontend can show the human-readable
-- name (e.g. `wolfethyst`) instead of the raw mint address. Additive and
-- NOT part of the money path: this column never influences custody, settlement,
-- verification, reconciliation, or the canonical claim message. Nullable —
-- only ANTs carry a name; token/vault assets leave it NULL. Populated out of
-- band by the `backfill:ant-names` CLI (getAccountInfo on the mint -> decode).

ALTER TABLE assets ADD COLUMN ant_name TEXT;

-- Down Migration
ALTER TABLE assets DROP COLUMN IF EXISTS ant_name;
