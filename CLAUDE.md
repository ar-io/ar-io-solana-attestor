# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A yarn-workspaces monorepo holding two independently deployable services for the ar.io AO→Solana migration, plus the shared crypto library they both build on:

- **`packages/canonical`** (`@ar.io/attestor-canonical`) — verification-pure crypto: byte-pinned canonical claim messages, RSA-PSS-4096 verification, Ed25519 attestation signing. No HTTP, no server deps. Consumed by both services.
- **`packages/attestor`** (`@ar.io/escrow-attestor`) — Express service that verifies Arweave RSA-PSS signatures off-chain and re-signs the same canonical bytes with Ed25519, so the on-chain `ario-ant-escrow` program can verify cheaply via `Ed25519Program` instruction introspection. Exists because `sol_big_mod_exp` is feature-gated on every public Solana cluster. See `README.md`.
- **`packages/claims`** (`@ar.io/claims`) — Fastify + Postgres **centralized custodial dispenser** ("Option B"). Reproduces bit-for-bit what the on-chain escrow would have held and dispenses ~48M ARIO + 2,269 ANTs to claimants who present a valid identity proof. A valid proof *is* the authorization.

The three key docs, in order of authority: `SPEC.md` (implementation notes and every design decision, per milestone M0–M7), `docs/claims/OPERATIONS.md` + `docs/claims/runbooks/` (running claims in production), `TEST_MATRIX.md` (UAT scenarios).

**When touching `packages/claims` at all — deploying, operating, or fixing the money path — invoke the `operate-ar-io-claims` skill first.** It carries the verified CLI table, alert names, state machine, and the diagnose-and-fix decision tree.

## Commands

Run from the repo root; the root scripts build `canonical` first because both services consume its compiled `dist/`.

```bash
yarn install              # corepack pins yarn classic 1.22.22 — do not use berry
yarn build                # canonical → attestor → claims
yarn lint                 # == typecheck: tsc --noEmit across workspaces (there is no eslint/prettier)
yarn test                 # builds canonical, then every workspace's tests
yarn keygen               # attestor Ed25519 keypair; prints the pubkey for the on-chain constant
```

One package: `yarn workspace @ar.io/claims <script>` (likewise `@ar.io/escrow-attestor`, `@ar.io/attestor-canonical`).

A single test file — tests are `node:test` run through `tsx`, so target the file directly:

```bash
yarn build:canonical      # required first if the file imports @ar.io/attestor-canonical
node --test --import tsx packages/claims/src/dispatch/worker.db.test.ts
```

Files named `*.db.test.ts` **self-skip unless `DATABASE_URL` is set** — an unset URL makes them pass vacuously, so export it (`postgres://claims:claims@localhost:5432/claims` matches docker-compose) when your change touches DB behavior. Claims test files are typechecked separately via `yarn workspace @ar.io/claims typecheck:tests`; the per-package build configs exclude `**/*.test.ts`, so `yarn lint` will not catch type errors in tests.

Local stack: `docker compose up --build` (postgres + attestor + claims) after putting `ATTESTOR_SECRET_BASE58` and `NETWORK` in a root `.env`. Claims migrations: `yarn workspace @ar.io/claims migrate:up`.

## Architecture

### Build order is load-bearing

`canonical` is consumed through its built `dist/` (its `exports`/`main`/`types` point at `dist/index.js`), not its source, because the attestor's production entry is plain `node dist/index.js` with no tsx. Yarn v1's `workspaces run` is not topological, so root `build`/`lint`/`typecheck`/`test` each explicitly call `build:canonical` first. If a change to `canonical` seems not to take effect downstream, you skipped that build. Yarn v1 also means workspace deps are pinned exact-version (`"@ar.io/attestor-canonical": "0.1.0"`), never `workspace:*`.

### Canonical parity is the whole safety story

The canonical message format is frozen by the *deployed* mainnet contract. `packages/canonical/src/canonical.cross.test.ts` enforces it in two layers: Layer 1 checks the TS builders against `canonical.cross.golden.json` (the frozen deployed-contract bytes) and always runs, no Rust toolchain, hard-failing on any TS drift. Layer 2 rebuilds the Rust example to catch a contract-side change and is a visible skip without cargo — unless `REQUIRE_RUST_PARITY=1`, which turns a missing toolchain into a hard fail. Never re-implement the canonical format anywhere; import it from `@ar.io/attestor-canonical`. Regenerate the golden file only when the contract format changes on purpose (see SPEC.md §M0 decision 9).

### `packages/claims` pipeline

`src/ledger/` + `src/reconcile/` (build the liability ledger from frozen inputs; independently re-derive it bit-exactly) → `src/verify/` (Arweave RSA-PSS / Ethereum secp256k1 / vault proofs) → `src/api/` (Fastify claim endpoints, rate limit, audit log) → `src/dispatch/` (the exactly-once money-movement worker + custody/signers) → `src/transparency/` (signed Merkle ledger, anchored audit log, reserves) → `src/ops/` (metrics + alerts). `src/cli/` holds one entry per operator command, each wired to a `yarn` script.

Invariants that must always hold — conservation, exactly-once dispatch, ≤1 won claim per asset, AT-RISK assets never self-serve, reserves ≥ liabilities, integer `bigint` mARIO end to end, frozen-input fingerprint pins, single consistent `CONFIRM_RPC_URL`, five distinct keys — are enumerated with their enforcement mechanisms in the `operate-ar-io-claims` skill. Read them before editing anything under `src/dispatch/`, `src/ledger/`, or `src/reconcile/`.

The reconciliation gate (`reconcile:ledger`) and the M1 ledger build need the frozen mainnet inputs plus `ANT_MINT_SECRET`, so they are deliberately **not** wired into CI — they are a local/ops run. CI green does not mean the ledger reconciles.

### Conventions

- `@solana/kit` only for new Solana code; `@solana/web3.js` is prohibited.
- Money is integer `bigint` mARIO end to end — `NUMERIC(20,0)` in Postgres, decimal strings on the wire, never a JS `number`.
- Schema is hand-written SQL under `packages/claims/migrations/`, run by `node-pg-migrate`. `ledger` and `audit_log` are append-only. `migrate:down` goes through `scripts/migrate-down-guard.mjs`, which refuses without `ALLOW_DESTRUCTIVE_DOWN=1` and refuses on `solana-mainnet` regardless.
- Attestor stays on Express and is treated as frozen ("behaviorally unchanged"); claims is Fastify. Don't unify them.
- The attestor never logs RSA moduli, signatures, or canonical bytes.
- `/health` is pure liveness (200 while the process lives); `/health/ready` is the DB-aware signal. The `pg.Pool` is lazy, so claims boots and serves `/health` with Postgres down.
