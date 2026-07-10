# Runbook 06 — Ledger-publish + audit-anchor cadence

Keeps the custodial service **auditable-after-the-fact** (pivot plan §6.5): a
signed frozen ledger, a hash-chained audit log anchored on-chain, and a live
reserves check. Third parties pin the publisher key + the anchor tx and verify
independently.

## The append-only invariant (read first)

The audit log's tamper-evidence depends on it being **append-only** in production
(see [README](README.md#the-append-only-audit_log-production-invariant)). The
anchor job below **refuses to anchor a broken chain** (`verifyAuditChain` must
pass first) — a deleted/edited row makes it hard-fail, which is the point.

## 1. Publish the signed ledger — on ledger change

Run after the ledger is built/updated (launch, and after any `update-recipient` /
`cancel` admin action):

```bash
LEDGER_PUBLISHER_KEY_SEALED_PATH=/secure/ledger-publisher.sealed.json \
  LEDGER_PUBLISHER_KEY_PASSPHRASE='<KEK>' \
  DATABASE_URL='...' NETWORK=solana-mainnet \
  yarn publish:ledger --out ledger-artifact.$(date +%F).json --version $(date +%F)
```

It builds the canonical leaf set + Merkle root, **signs** the manifest with the
publisher key, self-verifies (never publishes an artifact it can't verify),
persists an immutable snapshot to `published_ledger`, and writes the artifact JSON.
**Upload the JSON to Arweave/IPFS** for permanence and **announce the pinned
publisher pubkey** (`LEDGER_PUBLISHER_PUBKEY_HEX`).

Third-party verification (what a skeptic runs):
```bash
yarn verify:transparency artifact ledger-artifact.<date>.json --publisher <LEDGER_PUBLISHER_PUBKEY_HEX>
# MUST be run PINNED — an unpinned verify refuses to print PASS (a self-signed
# forgery would otherwise pass). Membership of any asset is provable in ~log2(N).
```

## 2. Anchor the audit head on-chain — on a cadence (e.g. daily)

```bash
AUDIT_KEY_SEALED_PATH=/secure/audit.sealed.json AUDIT_KEY_PASSPHRASE='<KEK>' \
  LEDGER_PUBLISHER_KEY_SEALED_PATH=/secure/ledger-publisher.sealed.json \
  LEDGER_PUBLISHER_KEY_PASSPHRASE='<KEK>' \
  DATABASE_URL='...' NETWORK=solana-mainnet SOLANA_RPC_URL='...' \
  yarn anchor:audit-log            # add --ledger-root to also anchor the latest ledger root
```

Steps it performs (idempotent, safe on a cron): back-fill any unsigned audit rows
with the AUDIT key → verify the FULL chain (refuses to anchor if broken) → post the
head `(seq, entry_hash)` as a **Solana memo tx** signed by the **publisher/anchor
key** → record it in `audit_anchors`. **The publisher/anchor key must be funded
with a little SOL** to pay the memo tx fee.

**Cadence:** the `anchor-failure` alert fires when the last audit-head anchor is
older than `2× ALERT_ANCHOR_CADENCE_SECONDS` (default cadence 24h → warn > 48h).
Pick a cadence (daily is typical) and schedule it; keep the anchor key funded.

Third-party verification (pins the ORIGINAL anchor tx + the signer — never the
operator DB):
```bash
yarn verify:transparency anchor --anchor-sig <txid> --anchor-address <LEDGER_PUBLISHER address> \
  --rpc '<rpc>' --database '...'
# reads the memo BACK FROM CHAIN, confirms the live log still reproduces the
# anchored hash at the anchored seq (checkExtendsAnchor), and that the anchor tx
# was signed by the known publisher/anchor key (a rewrite or a forged anchor fails).
```

## 3. Reserves — proof of holdings

`GET /v1/transparency/reserves` (and `yarn ops:metrics | jq '.snapshot.reserves'`)
reports live on-chain holdings vs. the outstanding ledger liability so anyone can
check **holdings ≥ liabilities**:

- **token/vault** coverage is authoritative (hot float + cold reserve balances vs
  Σ outstanding mARIO).
- **ANT** coverage: sampling (`RESERVES_ANT_CHECK=sample`) reports `"sampled-only"`
  and can NEVER read `true` — a partial sample proves the sampled few are owned,
  not the whole set. The authoritative full count is `RESERVES_ANT_CHECK=gpa`
  (`getProgramAccounts`), which is **RPC-heavy** (2,269 mainnet ANTs) and often
  disabled on public RPCs. **Ops decision:** run the full `gpa` count on a
  cadence against a **dedicated RPC** that allows gPA (e.g. weekly), and keep
  sampling for the routine endpoint. Publish the cron output.

Configure: `ARIO_MINT`, `TREASURY_ADDRESS` (hot), `COLD_RESERVE_ADDRESS` (cold —
must differ from hot, or `computeReserves` throws to prevent a double-count),
`ANT_AUTHORITY_ADDRESS`, `RESERVES_ANT_CHECK`.

## Suggested schedule

| Job | Cadence |
|---|---|
| `publish:ledger` | on every ledger change (recipient update / cancel), + at launch |
| `anchor:audit-log` | daily (keep the anchor key funded) |
| reserves full `gpa` count | weekly (dedicated RPC) |
| `ops:metrics` (alert check) | every 1–5 min (pages on critical) |
