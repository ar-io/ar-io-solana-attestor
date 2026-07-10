# Runbook 01 — Deploy

Stand up the claims service. Do the **staging rehearsal first** (it is the gate),
then mainnet. Two long-lived processes + scheduled jobs:

- **API** (`packages/claims`, `yarn start` → `dist/index.js`) — the public claim
  surface + ops `/metrics`.
- **Dispatch worker** (`yarn dispatch:worker`) — the single-flight, exactly-once
  dispenser. **Run exactly one.**
- **Scheduled jobs** — `yarn dispatch:ants` (on approval), `yarn publish:ledger`
  (on ledger change), `yarn anchor:audit-log` (cadence), `yarn ops:metrics` (cron
  alert check). See runbooks 05 / 06 / README.

## Pre-flight

1. **Key ceremony done** ([runbook 02](02-key-ceremony.md)) — five distinct keys,
   three sealed; public addresses recorded.
2. **Single-consistent CONFIRM RPC** — a dedicated endpoint or read quorum, **not**
   a load-balanced pool. Set `CONFIRM_RPC_URL`. (Boot-validation aborts the worker
   on a pooled-looking URL.)
3. **Postgres** — managed, PITR backups, the DB role holds `INSERT`+`SELECT` on
   `audit_log` (append-only invariant — see README). Apply migrations:
   `yarn migrate:up`.
4. **Ledger built + reconciled** (M1): `yarn build:ledger` then
   `SNAPSHOT_DIR=<pruned> yarn reconcile:ledger` → **must PASS bit-exact** before
   any claim can be served. The 136 AT-RISK owners load `manual_review`.
5. `.env` from a secret manager (never a file in prod). See
   [`.env.example`](../../../packages/claims/.env.example).

## Staging rehearsal (the gate — do NOT skip)

A single scripted run proves the whole system end-to-end on devnet:

```bash
cd packages/claims
NETWORK=solana-devnet \
  SOLANA_RPC_URL='<dedicated devnet RPC>' SOLANA_WS_URL='<wss ...>' \
  FUNDER_KEYPAIR='<funded devnet keypair>' \
  DATABASE_URL='postgres://.../claims' \
  yarn rehearsal:staging
```

It builds a **clean dedicated `claims_rehearsal` DB**, drives the full claim
matrix (AR/ETH × token/ANT, vault active→relock + expired→liquid, a >100k
review→approve→dispatch, an ANT cold-batch) through the **real API + worker
on-chain**, then runs reconcile + publish + anchor + reserves and verifies each.
**All rows must PASS** (artifacts written to `REHEARSAL_OUT`). Run it twice green
before touching mainnet.

## Boot both processes

Boot-validation runs automatically and **aborts on misconfig**. Confirm it passes:

```bash
# API
NETWORK=solana-mainnet DATABASE_URL='...' SOLANA_RPC_URL='...' \
  TREASURY_ADDRESS='...' ARIO_MINT='...' \
  yarn start          # GET /health -> 200; GET /health/ready -> 200 when DB up

# Worker (exactly ONE instance)
NETWORK=solana-mainnet DATABASE_URL='...' CONFIRM_RPC_URL='<single endpoint>' \
  ARIO_MINT='...' \
  TREASURY_KEY_SEALED_PATH='/secure/treasury.sealed.json' TREASURY_KEY_PASSPHRASE='...' \
  yarn dispatch:worker
```

Health/readiness gate: put the load balancer on `GET /health/ready` (503 when the
DB is unreachable). `GET /health` stays 200 while the process lives.

## Provision the hot float

Move the initial float (default cap 500k ARIO) from the authority/cold reserve to
the treasury ATA. See [runbook 03](03-hot-float-refill.md) for the 4-eyes
procedure. **Do not** overfund past the cap (`float-over-cap` alerts). ANTs are
**not** moved to the hot key — they stay cold, dispensed per batch
([runbook 05](05-ant-cold-batch-dispatch.md)).

## Publish transparency artifacts + wire monitoring

```bash
yarn publish:ledger --out ledger-artifact.json     # sign + persist the ledger
yarn anchor:audit-log                              # anchor the audit head on-chain
# cron: `yarn ops:metrics` (exits non-zero on a critical alert -> page)
#       `yarn anchor:audit-log` on the chosen cadence (runbook 06)
```

Publish `ledger-artifact.json` to Arweave/IPFS and announce the pinned publisher
pubkey so third parties can verify.

## Frontend

Point the escrow app at the claims API (`VITE_CLAIMS_API_URL`, F2 adapter in
`ar-io-solana-escrow-app` `feat/centralized-claims-adapter`). Deposit pages stay
gated off. **Human browser + wallet UAT** (Wander / MetaMask / Phantom) is a hard
cutover gate — see the carry-forward list.

## The on-chain escrow program stays deployed

Do **not** close or `--final` `ario-ant-escrow`. It is the documented fallback:
the same frozen inputs feed `batch-escrow.ts` to resume the trustless path at any
time.

## Rollback

Nothing above is destructive pre-launch. To roll back: freeze the claim API
(runbook 08 §freeze), sweep the float to cold (runbook 03), and resume the
on-chain escrow from the frozen inputs.
