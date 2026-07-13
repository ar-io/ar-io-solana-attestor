# ar-io-claims — Implementation Notes (SPEC)

Living implementation log for the `feat/ar-io-claims` build. One section
per milestone. **Authoritative design** stays in
`/home/vilenarios/source/solana-ar-io/docs/CENTRALIZED_CLAIM_PIVOT_PLAN.md`;
this file records what was actually built and every decision/trade-off
made along the way. Coordinator source of truth: `docs/claims/BUILD.md`.

---

## M0 — Workspaces scaffold + Postgres + CI + docs

Goal: a clean multi-package yarn workspace where the **claims** service
and the **attestor** service share one verified crypto lib, with CI +
local infra, and **no business logic yet**. The primary safety gate is
that the attestor is behaviorally unchanged and all its pre-existing
tests still pass.

### Final workspace layout

```
ar-io-solana-attestor/                 (workspace root; private)
├── package.json                       root: workspaces + packageManager pin + aggregate scripts
├── tsconfig.base.json                 shared compiler options (mirror of the old attestor tsconfig)
├── docker-compose.yml                 postgres + attestor + claims
├── .github/workflows/ci.yml           install → build → lint/typecheck → migrate → test
├── README.md                          attestor service docs (+ monorepo pointer)
├── SPEC.md                            this file
├── TEST_MATRIX.md                     UAT scenarios seeded from escrow-claim-runner.ts
├── docs/claims/BUILD.md               coordinator doc (unchanged)
└── packages/
    ├── canonical/                     @ar.io/attestor-canonical  (shared, verification-pure crypto)
    │   ├── package.json               builds to dist/ with .d.ts; no HTTP/server deps
    │   ├── tsconfig.json              declaration: true (attestor consumes its types)
    │   └── src/
    │       ├── index.ts               public barrel (re-exports the three modules)
    │       ├── canonical.ts           byte-pinned canonical claim messages
    │       ├── verify-rsa-pss.ts       RSA-PSS-4096 verification
    │       ├── attest.ts              Ed25519 keypair load + attestation signing
    │       ├── canonical.test.ts
    │       ├── canonical.cross.test.ts  attestor ↔ Rust byte-parity (self-skips w/o cargo)
    │       ├── verify-rsa-pss.test.ts
    │       └── attest.test.ts
    ├── attestor/                       @ar.io/escrow-attestor  (the EXISTING Express service)
    │   ├── package.json               depends on @ar.io/attestor-canonical
    │   ├── tsconfig.json
    │   ├── Dockerfile                 monorepo-aware (context = repo root)
    │   └── src/
    │       ├── index.ts               HTTP entry
    │       ├── app.ts                 Express app factory (imports shared crypto)
    │       ├── config.ts              env-driven config
    │       ├── keygen.ts              Ed25519 keygen CLI
    │       ├── app.test.ts
    │       └── integration.test.ts
    └── claims/                         @ar.io/claims  (NEW skeleton service — no business logic)
        ├── package.json
        ├── tsconfig.json
        ├── Dockerfile
        ├── .env.example               documented env; NO secrets
        ├── migrations/1720000000000_init.sql   empty initial migration
        └── src/
            ├── index.ts               boot: config → db pool → kit rpc → fastify.listen
            ├── app.ts                 Fastify factory: GET /health, GET /health/ready
            ├── config.ts              env-driven config (Network, DATABASE_URL, RPC, port…)
            ├── db.ts                  lazy pg.Pool + ping()
            ├── solana.ts              @solana/kit createSolanaRpc wiring
            └── health.test.ts         placeholder test (app.inject)
```

### How the canonical library was extracted

`canonical.ts`, `verify-rsa-pss.ts`, and `attest.ts` were already
side-effect-free, config-free, verification-pure functions over bytes —
`attest.ts` in particular has no HTTP or process coupling (just
`loadAttestorKeypair` + `signAttestation`), so the *entire* file moved to
`packages/canonical` rather than being split. Their four test files moved
with them, including the load-bearing `canonical.cross.test.ts`
(attestor ↔ Rust byte parity). A new `src/index.ts` barrel re-exports the
public surface; the attestor now imports `@ar.io/attestor-canonical`
instead of relative `./canonical.js` / `./verify-rsa-pss.js` /
`./attest.js`.

Attestor import edits (the ONLY changes to attestor logic — pure import
path swaps, no behavior change):
- `app.ts`: `buildAntEscrowClaimMessage`, `buildEscrowClaimMessage`,
  `RSA_4096_BYTES`, `RsaPssError`, `deriveArweaveAddress`, `verifyRsaPss`,
  `signAttestation` → from `@ar.io/attestor-canonical`.
- `config.ts`: `loadAttestorKeypair`, `AttestorKeypair` → from the package.
- `integration.test.ts`: `buildAntEscrowClaimMessage`, `RSA_4096_BYTES` →
  from the package.

`canonical.cross.test.ts` was reworked for the path move AND to close a
defect the tester flagged (see Decision #9): it now reads committed golden
vectors relative to its own file and, for the live-Rust drift check,
locates the sibling `ar-io-solana-contracts` repo (four `..` hops from
`packages/canonical/src/`; `CONTRACTS_REPO_DIR` still overrides — and is
now the *exclusive* candidate when set, no silent sibling fallback).

### Decisions & trade-offs

1. **Package manager: yarn classic v1, pinned via corepack.** The repo's
   committed `yarn.lock` is v1 format and a `node_modules/` linker was in
   use, but only yarn 3.8.7 (berry) was on PATH via corepack — and berry
   rejects the v1 lockfile. To match existing tooling with the least risk,
   the root `package.json` pins `"packageManager": "yarn@1.22.22"`, so
   corepack deterministically runs classic yarn locally, in Docker, and in
   CI. Yarn v1 workspaces (node-modules hoisting) are exactly what the repo
   already expected. Consequence: workspace deps use exact-version ranges
   (`"@ar.io/attestor-canonical": "0.1.0"`), NOT the `workspace:*` protocol
   (v1 doesn't support it).

2. **Build order is canonical-first, enforced explicitly.** The attestor
   package consumes `@ar.io/attestor-canonical` via its built `dist/`
   (its `exports`/`main`/`types` point at `dist/index.js` / `.d.ts`), so
   the shared lib must be compiled before the attestor is built,
   typechecked, or tested. Rather than rely on yarn v1's non-topological
   `workspaces run`, the root scripts call `build:canonical` first:
   `build`, `lint`, `typecheck`, and `test` all begin by building
   canonical. Chosen over pointing `exports` at raw `.ts` because the
   attestor's production entry is `node dist/index.js` (plain Node, no
   tsx) and must resolve a real `.js` — pointing at `.ts` would break
   production while only saving a build step in the dev loop.

3. **Migration tool: `node-pg-migrate` (+ `pg`).** Picked over drizzle and
   prisma because the pivot plan §3.1 specifies a hand-written SQL schema;
   node-pg-migrate runs raw `.sql` migrations 1:1 with that spec, has no
   codegen/DSL/engine-binary, and installs cleanly in Alpine/CI. The
   initial migration `1720000000000_init.sql` is intentionally empty
   (a `SELECT 1;` up/down with the schema deferred to M1). Verified:
   `migrate:up` and `migrate:down` both apply against a real Postgres 16.

   **Destructive down-migrations are gated (adversarial-pass item E).**
   `migrate:down` runs through `scripts/migrate-down-guard.mjs`, which REFUSES
   unless `ALLOW_DESTRUCTIVE_DOWN=1` **and** `NETWORK != solana-mainnet` (never on
   mainnet, even with the flag). The migrations' Down bodies remain for local/dev
   rollback; the runner is the guard. In production the app DB role SHOULD NOT
   hold `DROP` (defense in depth), and the `ledger` / `audit_log` tables are
   APPEND-ONLY — a down-migration must never be the mechanism that mutates them.

4. **HTTP framework for claims: Fastify.** The task allowed Fastify or
   Express. Fastify was chosen for the new service because (a) it has
   first-class pino logging (the attestor already standardizes on pino);
   (b) `app.inject()` makes the placeholder (and future) tests hit routes
   without binding a port — fast and CI-robust; (c) its schema-validation
   and plugin model are a better base for the M3 claims API. The attestor
   stays on Express, untouched.

5. **`@solana/kit`, not web3.js.** Per the non-negotiables. `solana.ts`
   wires `createSolanaRpc(config.solanaRpcUrl)` (built at boot so a bad URL
   fails fast; no on-chain reads yet). Importing `@solana/kit` eagerly
   pulls its rpc-subscriptions + string-codec subtrees, which declare `ws`
   and `fastestsmallesttextencoderdecoder` as unmet *peer* deps (yarn warns
   on install). Only **`ws` is load-bearing**: the Node build of
   `@solana/rpc-subscriptions-channel-websocket` statically imports it, so
   without it the service throws `ERR_MODULE_NOT_FOUND` at boot (verified).
   **`fastestsmallesttextencoderdecoder` is NOT** required by the Node path —
   `@solana/codecs-strings`' node build uses `globalThis.TextEncoder/
   TextDecoder` (the peer is a browser-only perf shim), so its absence does
   not break the import. Both are still added as explicit `claims`
   dependencies: `ws` because it's required, the text-encoder only to
   silence the peer warning and match the browser build's expectation.

6. **Health vs readiness split.** `GET /health` is pure liveness — always
   200 while the process is up, so an orchestrator restarts only on a hard
   crash, not a transient DB blip (this is the endpoint the acceptance
   gate and the Docker healthchecks use). `GET /health/ready` is the
   DB-aware signal: 200 when Postgres answers `SELECT 1`, 503 otherwise.
   The `pg.Pool` is created lazily and NOT connected at import, so the
   service boots and serves `/health` even with Postgres down.

7. **Docker: monorepo-aware, build context = repo root.** Each service's
   Dockerfile copies all workspace manifests (yarn v1 validates the whole
   graph), installs frozen, builds shared-lib-first, prunes dev deps, and
   copies the needed `dist/` + manifests to a non-root runtime stage.
   Known M0 simplification: yarn v1 hoists to a single root `node_modules`,
   so the attestor image also carries the claims service's production deps
   (and vice-versa). Acceptable for scaffold; a per-service prune is a
   later hardening.

8. **`claims` does not yet depend on `@ar.io/attestor-canonical`.** The
   pivot plan has the claims service reuse the attestor's crypto for
   identity-proof verification — but that is M2 work. Keeping claims
   self-contained in M0 avoids coupling its build/test to a canonical
   build and keeps the skeleton minimal. The dependency is added in M2.

9. **Cross-language parity is fail-closed via golden vectors** (fixes a
   HIGH the tester found: the old `if (!cargoAvailable) return;` was a
   *vacuous pass*, so CI — which ships no Rust toolchain — reported
   byte-parity green while verifying nothing). Chosen approach: the
   preferred one. `canonical.cross.golden.json` holds vectors generated
   from the on-chain Rust `canonical` example (network-mainnet feature) and
   pins the FROZEN, deployed-contract format. The cross test now has two
   layers:
   - **Layer 1 (always runs, no cargo):** the TS builders must reproduce
     every golden vector byte-for-byte. This is the parity gate CI enforces
     on every run; a TS drift from the deployed format hard-fails here.
     Since the mainnet escrow is deployed and frozen, pinning to golden
     vectors is arguably the *more* correct guarantee than rebuilding Rust.
   - **Layer 2 (drift detector):** re-derives from a freshly built Rust
     binary and asserts it still equals the golden bytes (catches
     contract-side canonical changes). It runs when cargo + the contracts
     repo are present; otherwise each case is a **visible `skip`** — unless
     `REQUIRE_RUST_PARITY=1`, which makes a missing toolchain/repo (or a
     failed build) a **hard FAIL**. Release/verification jobs flip that
     switch.

   Regenerate the golden file if the contract canonical format changes on
   purpose:
   ```bash
   # with the ar-io-solana-contracts sibling present + cargo installed
   cd ../ar-io-solana-contracts && cargo build --example canonical -p ario-ant-escrow
   # then re-run the committed generator (see the repo's gen-golden helper),
   # or delete the golden file and run the cross test under REQUIRE_RUST_PARITY=1
   # to confirm live Rust == the new golden.
   ```
   Proven fail-closed (all with NO toolchain, i.e. CI-equivalent): a
   corrupted/mismatched golden vector → test FAILS (exit 1); and
   `REQUIRE_RUST_PARITY=1` with the repo absent → suite FAILS (exit 1).
   With the toolchain present both layers pass 13/0/0.

### Lint / format

The attestor's only "lint" was `tsc --noEmit` (no eslint/biome/prettier in
the repo). That convention is preserved: every package's `lint` and
`typecheck` scripts are `tsc --noEmit`, and the root `lint`/`typecheck`
run them across all workspaces after building canonical. So "lint" and
"typecheck" are the same strict-TS gate here, by design.

**Test-file typecheck (the tester's optional INFO).** Like the
pre-workspaces attestor, the per-package build/lint configs exclude
`**/*.test.ts`, so tsx only type-strips tests at runtime. Added a scoped
`typecheck:tests` on the **claims** package (`tsc -p tsconfig.tests.json`,
wired into CI) so genuine type errors in the new service's tests are
caught. Deliberately NOT extended to the legacy attestor/canonical suites:
a full test-typecheck of them surfaces pre-existing `@ts-expect-error`
"unused directive" and `unknown`-body diagnostics, and fixing those would
mean editing the frozen attestor tests — churn against the
"behaviorally-unchanged" guarantee for no runtime benefit. They stay
type-stripped, exactly as before the reshape.

### Verification performed (M0)

All commands run from the repo root with corepack-pinned yarn 1.22.22.

- `yarn install` — clean, lockfile regenerated for the workspace.
- `yarn build` — tsc clean across canonical, attestor, claims.
- `yarn test` — **attestor 11 + canonical 49 = 60 pass / 0 fail / 0
  skipped** with the Rust toolchain present (the canonical count rose from
  42 to 49 because the cross test now has both the golden-vector layer and
  the live-Rust layer; the attestor 11 are unchanged from baseline, proving
  attestor behavior is untouched). Plus **claims 3 pass / 0 fail**.
  Golden-vector fail-closed behavior proven with NO toolchain (CI-equiv):
  a mismatched golden vector → FAIL (exit 1); `REQUIRE_RUST_PARITY=1`
  without the repo → FAIL (exit 1); default (repo absent) → golden layer
  passes + live-Rust layer 6× visible `skip`.
- Attestor boots (`node packages/attestor/dist/index.js`), `GET /health`
  → 200 with the expected `{ok, network, attestorPubkeyBase58}`.
- Claims boots (`node packages/claims/dist/index.js`), `GET /health` →
  200; `GET /health/ready` → 503 with DB down, 200 (`{ready:true,db:"up"}`)
  with a live Postgres.
- `node-pg-migrate up`/`down` apply the empty migration against Postgres 16.
- `docker compose config` validates; `docker compose up --build` brings up
  postgres + attestor + claims (see the M0 verification log appended by the
  final commit).

### What the tester should scrutinize

- **Baseline parity:** re-run the pre-move attestor tests (53) and confirm
  0 regressions. The split moved 4 test files to `canonical` and 2 to
  `attestor`; the union must still be the original 53.
- **Cross-parity (was the HIGH; now fail-closed):** the golden layer runs
  in CI with no cargo and hard-fails on TS drift; the live-Rust layer is a
  visible skip unless `REQUIRE_RUST_PARITY=1`. Worth re-checking: (a) the
  golden file is genuinely the Rust output — regenerate and diff (it's
  deterministic); (b) `REQUIRE_RUST_PARITY=1` with the contracts repo
  present + cargo actually runs Layer 2 (not skipped) and a wrong-output
  Rust stub makes it FAIL; (c) the CI job's `yarn test` includes Layer 1
  (it does — no env needed).
- **yarn version drift:** anyone without corepack, or with berry on PATH
  and no packageManager honoring, will hit the v1-lockfile rejection seen
  during setup. CI pins it via `corepack enable`; local devs need the same.
- **kit peer deps:** confirm the claims service still boots after any
  `@solana/kit` bump (the `ws` / text-encoder peers can shift).
- **Docker image bloat:** the shared-node_modules simplification (decision
  7) — fine for M0, flag if it matters for image-size budgets.

## M1 — Ledger + reconciliation

Populates the `recipients` + `assets` ledger from the frozen mainnet capture
(`/programs/ario-snapshot/output-mainnet-prod-remediation/`), reproducing what
the deployed on-chain `batch-escrow.ts` would deposit, and proves it **bit-exact**
against an INDEPENDENT re-derivation.

### Schema (migration `1720000001000_ledger_schema.sql`)

Four tables per pivot plan §3.1: `recipients`, `assets`, `claims`, `audit_log`.
M1 populates the first two; `claims`/`audit_log` are created (complete, reviewable)
but exercised in M3+/M6. Two documented adjustments to §3.1:

1. **AT-RISK owners load `status = 'manual_review'`** (BUILD.md non-negotiable),
   not `'frozen'`. Their assets get rows too, flagged `assets.status =
   'manual_review'` — flagged, not deleted; an operator queue reads them.
2. **`recipients.recipient_pubkey` is nullable** (AT-RISK owners never published
   a key), guarded by `CHECK (status = 'manual_review' OR recipient_pubkey IS NOT
   NULL)`. Plus shape CHECKs (ant⇒mint,no-amount; non-ant⇒amount; nonce=32B) and
   the `one_live_claim_per_asset` partial-unique index. Migrates up **and** down
   cleanly (verified).

### Ledger builder (`src/ledger/`, `src/cli/build-ledger.ts`)

Pure planner `buildLedgerPlan(inputs, {antMintSecret, nowMs})` reproduces
batch-escrow's four phases EXACTLY, then `writeLedger` persists it (one tx,
idempotent upsert, nonce preserved on re-run). Fidelity points:

- **Owner selection** = unmapped via the normalized address-map
  (`makeNormalizedAddressMap`, ETH case-insensitive — the B6Nf lesson); the
  `AO_PROCESS_ID` self-balance is excluded from token escrow.
- **asset_id seeds** identical to the deployed path: token
  `sha256("token-escrow:"+normAddr)`, vault `sha256("vault-escrow:"+normAddr+
  ":"+vaultId)`, stake `sha256(<escrow-extract seed>)`; ANT key =
  `deriveAntMintBase58(processId, secret)`.
- **ANT mint** derived with `@noble/ed25519` (`Keypair.fromSeed(seed).publicKey`
  ≡ `ed25519.getPublicKey(seed)`) — **no `@solana/web3.js` in claims runtime**
  (BUILD.md), proven byte-identical to web3.js via the frozen `ANT_MINT_FIXTURES`.
- **Fallbacks** mirror batch-escrow: expired vault → liquid token escrow;
  sub-min / short-lock vault → liquid token escrow (`vaultEscrowFallsBackToLiquid`);
  operator-exit vaults extended (not liquid-expedited); stake vault/liquid routing
  via the authoritative `collectStakeWithdrawalEscrow` shape.
- **Money is integer `bigint` (mARIO)** throughout; amounts land in `NUMERIC(20,0)`.
- **Time pin:** the vault/stake liquid-vs-vault split depends on "now" (lock =
  unlock − now). The build PINS `LEDGER_NOW_MS`, default **1783641600000**
  (2026-07-10T00:00:00Z) — the reference that reproduces the frozen dry-run gate
  (2269/5374/111/2957). Env-overridable; the reconciler uses the same pin.

The DB `asset_type` is the **on-chain deposit instruction** the frontend claims
against (`ant`|`token`|`vault` = `deposit_ant`|`deposit_tokens`|`deposit_vault`),
so stake and expired/fallback vaults correctly surface as `token` (liquid). The
`source` JSONB carries phase provenance (aoProcessId / arweaveAddress / vaultId /
planKind / onchainSeed) for the operator queue.

### Reconciliation — how it stays INDEPENDENT (the tester will probe this hardest)

`src/reconcile/authoritative.ts` derives the would-be-deposit set WITHOUT any of
the builder's code, by importing the **deployed solana-ar-io modules directly**
(`SOLANA_AR_IO_IMPORT_SRC`, default the standard checkout):

- `normalize-address.ts` — the real `normalizeSourceAddress` /
  `makeNormalizedAddressMap` (the unmapped filter + ETH casing).
- `derive-ant-mint.ts` — the real `deriveAntMintPubkey` (web3.js
  `Keypair.fromSeed`, resolved from solana-ar-io's own node_modules). All 2,269
  ANT mints are graded against web3.js, not against the builder's noble copy.
- `batch-escrow.ts` — the real **`deriveTokenAssetId` / `deriveVaultAssetId`**
  (the escrow asset_id = the money identifier). batch-escrow now `export`s these
  (a visibility-only, committed change in solana-ar-io); importing the module
  does NOT run its argv-guarded `main()`.
- `planning/escrow-extract.ts` — the real stake/withdrawal set + `assetIdSeed`s.
- `planning/vault-plan.ts` — the real `vaultEscrowFallsBackToLiquid` + constants.

**Why the asset_ids are imported, not guarded (a tester-found fix).** The first
M1 cut source-guarded the token/vault seed via a bare `.includes()` substring.
The tester changed the deployed `deriveTokenAssetId` to append `+ ':v2'` — a REAL
asset_id change — and the substring still matched (a superset contains its
substring) → **false PASS 10711/10711**. Importing and calling the real function
closes this completely: reproducing the `:v2` change now drops matched to 5,350
(exactly the 5,361 Phase-2 token deposits that use `deriveTokenAssetId` diverge)
→ FAIL. The remaining INLINE bits with no exported function — the stake
`sha256(<authoritative seed>)` step, the vault expired check + ms→s lock formula,
and the stake operator-exit extension — are still pinned to the live source via
`assertSourceGuards()`, but now with **DELIMITER-BOUNDED byte-exact snippets**
(each includes its surrounding `const … ;` / `),` boundary), so an
append/superset — the exact class the tester exploited — shifts the delimiter and
FAILS the match (unit-tested in `source-guard.test.ts`). The AO self-balance
exclusion id is regex-extracted (fail-closed). Net: every money identifier and
bug-prone predicate is the authoritative code; only trivial arithmetic remains,
byte-pinned append-proof. Because the builder (self-contained copies) and the
reconciler (authoritative imports) are **different code paths**, a bug in the
builder's reimplementation shows up as a diff.

`reconcile()` diffs the tuple **(assetType, assetKey, amount, recipient bytes)**
per asset over the `available` set (AT-RISK `manual_review` rows are batch-escrow
skips, so they are excluded from the compare, matching on-chain). `RECONCILE_SOURCE=db`
reads the persisted ledger (proves persistence); `=plan` reconciles the in-memory
plan (CI/no-DB). Both the authoritative side AND the builder side are checked
against the published gate numbers independently.

### Reconciliation result (real mainnet inputs, `RECONCILE_SOURCE=db`)

```
authoritative counters: ant=2269 tokenEscrowed=5374 vaultEscrowed=111 stakeEscrowed=2957
built (plan)  counters: ant=2269 tokenEscrowed=5374 vaultEscrowed=111 stakeEscrowed=2957
built assets 10711 / authoritative 10711 / matched 10711
seed counts (both): ant=2269 token=8031 vault=411
Σ mARIO built == authoritative == 73277178580427 (73,277,178.58 ARIO)
recipients=8347 (8136 frozen moduli + 136 AT-RISK + 75 ETH) assets=10893 (available 10711 + manual_review 182)
RESULT: PASS — bit-exact
```

Proven that the gate CATCHES divergence: a +1 mARIO tamper on one DB asset →
`amount_mismatch`, RESULT FAIL, exit 1.

### Running it

```bash
# Postgres up + migrated:
DATABASE_URL=... yarn workspace @ar.io/claims migrate:up
# Build the ledger from the frozen inputs:
FROZEN_INPUTS_DIR=/programs/ario-snapshot/output-mainnet-prod-remediation \
ANT_MINT_SECRET="$(tr -d '\n' < keys/mainnet/ant-mint-secret.txt)" \
DATABASE_URL=... yarn workspace @ar.io/claims build:ledger
# Reconcile the persisted ledger vs the authoritative deposits (exit 0 = PASS):
FROZEN_INPUTS_DIR=... ANT_MINT_SECRET=... DATABASE_URL=... \
SOLANA_AR_IO_IMPORT_SRC=/home/vilenarios/source/solana-ar-io/migration/import/src \
yarn workspace @ar.io/claims reconcile:ledger
```

### Not wired into CI (deliberate)

The reconciliation GATE needs the solana-ar-io repo, the ~6 MB frozen inputs, and
`ANT_MINT_SECRET` — none present in CI. CI runs the fast unit tests that cover the
derivation logic (plan / asset-id / ant-mint / reconcile diff engine) plus the DB
round-trip against the Postgres service. The bit-exact gate is a local/ops run
(the tester reproduces it with the same repos + inputs).

### What I could not fully verify / caveats

- The reconciliation depends on `SOLANA_AR_IO_IMPORT_SRC` pointing at the deployed
  batch-escrow tree. It is a **local** gate by design (see above); it is not a
  hermetic CI check.
- The vault/stake liquid-vs-vault split is **time-sensitive** (stake vaults nearly
  all fall back to liquid by 2026-07-10 because their unlocks are close). The build
  pins `nowMs` so the ledger is deterministic and matches the frozen dry-run gate.
  The published oracle counts (2269/5374/111/2957) are now explicitly coupled to
  that instant via `EXPECTED_GATE.nowMs` + `gateAppliesAt(nowMs)`: at any other pin
  the CLI **loudly skips** the hardcoded oracle and relies on the (nowMs-agnostic)
  bit-exact diff — no silent mismatch on a cutover re-pin. The eventual real
  cutover re-pins `nowMs` to the dispatch window (M4's claim-time vault settlement
  re-computes remaining live regardless).
- The token/vault escrow asset_ids are now **authoritative-imported** (batch-escrow
  exports `deriveTokenAssetId`/`deriveVaultAssetId`; committed there). The one spot
  the first cut got wrong — a substring source-guard that a `+ ':v2'` superset
  slipped past → false PASS — is fixed and regression-tested (`source-guard.test.ts`
  + the live `:v2` demo). The residual inline bits (stake sha256-of-authoritative-
  seed, vault ms→s lock arithmetic, operator-exit extension) are byte-pinned with
  delimiter-bounded append-proof snippets; they affect only `asset_type`
  routing/arithmetic, never the asset_id / amount / recipient (all authoritative).

## M2 — Identity-proof verification (AR / ETH / vault)

Verifies a claimant's ownership of the frozen recipient identity, enforcing the
SAME rules the deployed `ario-ant-escrow` `claim_*` instructions enforce
(Appendix A of the pivot plan). In the centralized model the service verifies
the RSA-PSS / secp256k1 proof **directly** — there is no on-chain sigverify and
no attestor Ed25519 re-sign step to satisfy; a valid proof IS the authorization
to dispense. The *validity rules* are identical to the contract's; only the
consumer changes. All code is in `packages/claims/src/verify/` (verification
modules only — NOT the M3 API or M4 dispatch).

### Modules

- **`canonical-message.ts`** — the anti-replay carrier. Rebuilds the canonical
  claim bytes FROM ledger state (never client-supplied) by REUSING the
  byte-pinned `@ar.io/attestor-canonical` builders (`buildAntEscrowClaimMessage`
  / `buildEscrowClaimMessage`), which are cross-pinned to Rust `canonical.rs` by
  `canonical.cross.golden.json`. No canonical format is re-implemented. Shape
  selection mirrors the on-chain claim instruction: `ant` → ANT header;
  `token`/`vault` → escrow header with the STORED `type:` (independent of the
  live liquid-vs-relock decision, exactly as `claim_vault_*` always signs
  `type: vault`). The rebuilt message binds (recipient identity, asset id/key,
  amount, nonce, claimant), so a proof cannot be replayed against a different
  asset/recipient/amount/wallet — any change flips the bytes.
- **`arweave.ts`** (`verifyArweaveProof`, protocol=0) — REUSES `verifyRsaPss`
  (Node/OpenSSL, no custom bigint) + `deriveRecipientIdB64Url` from canonical.
  Enforces: protocol==arweave, modulus is 512B, F-1 binding
  (`b64url(sha256(modulus)) == recipient_id == AR source_address`; optional
  client-echoed modulus must be byte-equal), salt ∈ {0,32}, then RSA-PSS over
  the ledger-rebuilt canonical against the STORED modulus.
- **`ethereum.ts`** (`verifyEthereumProof`, protocol=1) — a **byte-for-byte port
  of `verify/ethereum.rs::verify_personal_sign`**: EIP-191 prefix
  (`"\x19Ethereum Signed Message:\n"` + ASCII-decimal length + canonical),
  keccak256, v-normalize {0,1,27,28}, **EIP-2 low-S enforced via a raw-byte
  compare against n/2** (mirrors the Rust `is_s_low`, so the malleability
  decision never depends on a library's internal range checks),
  `secp256k1_recover`, `address = keccak256(pubkey)[12..32]`, XOR-accumulator
  compare vs the stored 20 bytes. Uses `@noble/secp256k1` (recover + `hasHighS`)
  + `@noble/hashes/sha3` (keccak). **No web3.js.**
- **`vault-settlement.ts`** (`computeVaultSettlement`) — pure ADR-027 decision
  consumed by M4. `remaining = vault_end_ts − now`; three branches:
  `remaining ≤ 0` → liquid (expired); `amount < MIN_VAULT_SIZE` → liquid
  (a re-lock CPI would revert `VaultBelowMinimum`); `remaining < min_vault_duration`
  → liquid (BD-113 early-liquidity window); else **re-lock** for the full
  remaining time (unlock == the ORIGINAL `vault_end_timestamp`, revocable=false).
  `remaining > max_vault_duration` throws `LOCK_DURATION_TOO_LONG` (no silent
  cap). The on-chain ADR-027 create_vault-vs-vaulted_transfer split collapses to
  one treasury-signed path (treasury is a normal wallet). `min`/`max` are LIVE
  values M4 reads from ario-core `ArioConfig` at dispatch. Money/timestamps as
  `bigint`. Reuses `MIN_VAULT_SIZE_MARIO` / `MIN_VAULT_LOCK_SECONDS` from M1's
  `ledger/vault-rules.ts`.
- **`errors.ts`** — `VerificationError` with codes mapped 1:1 to the contract's
  `EscrowError` variants (ProtocolMismatch, NonceMismatch, EcdsaHighS,
  EthereumAddressMismatch, …) so an auditor lines the two up. **`index.ts`** —
  `verifyClaim` dispatches by the recipient's frozen protocol + re-exports.

### How each proof byte-matches the contract

- **Canonical bytes:** `canonical-message.test.ts` rebuilds from ledger state
  and asserts equality against the SAME `canonical.cross.golden.json` vectors the
  canonical package pins to live Rust — both ANT and token/vault shapes. So the
  bytes verified are provably the frozen deployed-contract format.
- **ETH:** ground truth = `ethereum.golden.json`, generated by **ethers v6
  `Wallet.signMessage`** (the exact library the escrow frontend signs with —
  `ClaimPage.tsx handleEthereumSign`). `claimVectors` are FULL canonical claim
  messages signed by the wallet whose 20-byte address IS the recipient →
  `verifyEthereumProof` accepts and rebuilds the exact signed bytes. `eip191Hash`
  is asserted against ethers `hashMessage`; `deriveEthereumAddress` against the
  well-known privkey→address vectors (1/2/3). v is legacy 27/28 in every vector,
  exercising normalization.
- **AR:** ground truth = `arweave.golden.json`, a real 4096-bit RSA key signing
  the byte-pinned canonical (salt 0 and 32); the module reuses the same
  `verifyRsaPss` the attestor uses.

### Adversarial negatives covered (all rejected)

wrong modulus (valid sig for a different key → `RSA_SIGNATURE_INVALID`);
off-by-one amount in the message (server rebuilds from ledger → recover/RSA
mismatch); tampered claimant (front-run proof); replayed/mismatched nonce echo
(`NONCE_MISMATCH`); protocol mismatch; **length mismatch 20-vs-512** (RSA sig at
an ETH recipient and vice-versa → `SIGNATURE_VERIFICATION_FAILED`); **malleable
high-S secp256k1** (built as `s' = n−s`, `v'=v^1` → `ECDSA_HIGH_S`); invalid
recovery id (v=5); unrecoverable sig (r=0); wrong/empty/oversized signature
lengths; unsupported salt (16) + salt mismatch (salt-32 sig verified as salt-0);
recipient_id / source_address inconsistent with modulus; single-bit sig tamper;
vault settlement bounds (expired/sub-min-amount/early-window → liquid;
over-max → error). **122 claims tests pass** (0 fail); test files typecheck
(`typecheck:tests`); root `yarn test` green (attestor 11 + canonical 49
unchanged, claims 122).

### Dependency added

`@noble/secp256k1@^2.3.0` (dependency-free v2; matches the installed
`@noble/ed25519@2.3.0` / `@noble/hashes@1.8.0` peers). Recover + `hasHighS` only —
no signing in the runtime. keccak256 comes from the already-present
`@noble/hashes/sha3`.

### What I could not fully verify / caveats (M2)

- **No live contract test vector for the ETH path.** The escrow program's own
  tests (`programs/ario-ant-escrow/tests/integration.rs`,
  `verify/ethereum.rs` `#[cfg(test)]`) sign with `libsecp256k1` inside Rust and
  don't emit reusable JSON vectors, and I did not run cargo to extract them.
  Instead the ETH ground truth is **ethers v6** — the exact library the frontend
  uses — which is a stronger real-world cross-check of the EIP-191 wire format
  than a self-signed Rust vector, and the port mirrors `verify/ethereum.rs`
  line-for-line (prefix, v-normalize, raw-byte low-S, recover, address compare).
  The `canonical.cross.golden.json` vectors ARE contract-derived (generated from
  the Rust `canonical` example) and pin the message bytes both paths sign over.
- The AR golden vector is a freshly-generated 4096-bit key (deterministic
  round-trip: sign canonical → verify), not a captured mainnet recipient
  signature. The canonical bytes it signs are contract-pinned; `verifyRsaPss` is
  the attestor's already-tested primitive. A captured real wallet signature would
  add nothing the round-trip + canonical pin don't already cover.
- `verifyClaim` dispatches on the recipient's stored protocol (authoritative, as
  on-chain the deposit's `recipient_protocol` fixes the valid claim path). The
  "proof.protocol == recipient.protocol" rule is enforced by each verifier's
  internal guard + the length gate, not by a separate top-level field.

## M3 — Claims API + replay / double-claim defense

The HTTP + persistence layer over M1's ledger + M2's verifier (pivot plan §4.1).
On-chain dispatch/custody is NOT here — that's M4; a completed claim records a
**dispatch intent** M4 consumes. All code is in `packages/claims/src/api/` plus
migration `1720000002000_claims_api.sql`.

### Endpoints (real shapes)

- `GET /v1/claimable?protocol=&address=` **or** `?recipientId=` — read-only
  lookup by identity. ETH addresses normalize case-insensitively
  (`normalizeSourceAddress`). Returns `{ recipientId, protocol, sourceAddress,
  assets:[{ assetKey, assetType, antMint, amount(string mARIO), vaultEndTimestamp,
  nonceHex, status }] }`. **`status='available'` only — `manual_review`/AT-RISK
  assets are excluded entirely** (a manual_review recipient returns `assets:[]`).
- `GET /v1/assets/{assetKey}` — single asset, same element shape; `manual_review`
  hidden as 404.
- `POST /v1/claims/initiate` `{ assetKey, claimant, idempotencyKey? }` → `201
  { claimId, status:"claiming", protocol, recipientId, network, nonceHex,
  canonicalMessageHex, canonicalMessageBase64, expiresAt }`. Mints a **fresh
  single-use 32-byte challenge nonce** + expiry, persists a `claiming` claim
  bound to (asset, claimant, nonce, expiry), and returns the **exact canonical
  bytes to sign** — server-built from ledger state via M2's
  `buildCanonicalFromLedger` (never client bytes).
- `POST /v1/claims/complete` `{ claimId | idempotencyKey, nonceHex?, proof }` →
  `202 { claimId, status:"verified"|"pending_review", settlement, idempotentReplay }`.
  Rebuilds the canonical from the STORED challenge nonce + recipient + asset,
  verifies via M2 `verifyClaim`, and atomically consumes the asset. Proof shape
  is §4.1's: `{protocol:"arweave", rsaSignatureBase64Url, rsaModulusBase64Url?,
  saltLength?}` or `{protocol:"ethereum", signatureHex}`.
- `GET /v1/claims/{claimId}` — claim status.

### Claim state machine + how double-claim is prevented

Asset: `available → claiming → claimed`. `claiming` = a verified claim has WON it
(dispatch intent recorded; M4 dispenses); `claimed` = M4 confirmed on-chain
(terminal). Any state ≠ `available` reads as "already claimed" to a competing
claim. Claim: `claiming → verified` (dispatch intent) `| pending_review | rejected
| expired`.

`completeClaim` is ONE transaction with **two row locks, always in the same order
(no deadlock cycle)**:
1. `SELECT … FROM claims WHERE claim_id = $1 FOR UPDATE` — the claim row.
2. `SELECT … FROM assets WHERE asset_key = $1 FOR UPDATE` — the asset row.

- **Two parallel completes of DIFFERENT claims for the SAME asset** lock
  different claim rows, then serialize on the asset row. The first sees
  `available`, verifies, flips it to `claiming`; the rest then see `claiming` and
  return a clean **409 ALREADY_CLAIMED** (without even re-verifying). Exactly one
  wins — enforced by the Postgres lock + the state machine, NOT an app-level
  read-then-write.
- **N parallel completes of the SAME claim** serialize on the claim row; the
  first transitions it to `verified`, the rest observe the terminal state and
  return the SAME result (`idempotentReplay:true`) with **no second dispatch
  intent**.
- Backstop: the partial-unique index `one_live_claim_per_asset` (over
  `verified|pending_review|dispatching`) makes a second won-claim a 23505 →
  mapped to ALREADY_CLAIMED, so even a logic bug can't double-dispense.

### Replay / idempotency model

- **Single-use challenge nonce**, minted at initiate, bound into the canonical the
  client signs, consumed when the asset transitions out of `available`. A replayed
  proof after success → the asset is `claiming`/`claimed` → ALREADY_CLAIMED (or,
  for the same claim, an idempotent replay of the stored success). An **expired
  challenge** → claim `expired`, **409 CHALLENGE_EXPIRED**, asset NOT consumed. A
  wrong **echoed `nonceHex`** → M2 `NONCE_MISMATCH` (409).
- **Proof for asset A cannot claim asset B**: the canonical binds the asset id +
  challenge nonce; the server rebuilds it for B, so A's signature fails to verify
  (401/422) and B stays `available`. (M2 binds this; M3 enforces it end-to-end.)
- **Idempotency**: `idempotencyKey` (UNIQUE) makes a retried initiate return the
  SAME claim and a retried complete return the SAME result without a second
  dispatch intent. The claim's own identity (`claimId`) is the natural idempotency
  unit even without a client key.
- **Bad proof** → claim `rejected`, asset untouched (never consumed on a failed
  verification); the user re-initiates a fresh challenge.

**A `complete` 202 always means a valid proof was presented (M4/frontend: do NOT
read it as caller-authentication).** The idempotent-replay path RE-VERIFIES the
submitted proof against the stored identity + challenge before returning any
`verified`/`pending_review` — so an unauthenticated replay (garbage or foreign
signature) gets a 401/422, never a success. A 202 therefore certifies "a valid
recipient-key proof was presented for this claim"; it does NOT certify the *caller*
is the recipient — dispensing always goes to the claimant bound INSIDE the
canonical, exactly as on-chain (anyone may submit). A genuine retry (same valid
proof) still replays idempotently to the SAME result with no new dispatch intent.

### Post-review fixes (M3 tester round 1)

The tester found no double-dispense path (N=48/64 + 40×64 soak + external-lock +
connection-kill all held); three non-double-spend defects were fixed here:

- **Concurrency-safe idempotent initiate** (was: HTTP 500 on a lost race). Two
  initiates sharing one `idempotencyKey` can both pass the pre-check SELECT then
  race the INSERT; the loser hit the `idempotency_key` unique violation (23505)
  which surfaced as 500. `initiateClaim` now catches 23505 (only fires *after* the
  winner committed, so its row is visible) → re-SELECTs and returns the winner's
  claim (mirrors `completeClaim`'s 23505 handling). Proven: 8-way concurrent
  initiate on one key → all return the SAME claim, zero failures, one claim row.
- **Replay re-verification** (see the 202 note above) — the `verified`/
  `pending_review` idempotent short-circuits now call `verifyReplayProof` first.
- **AT-RISK existence hidden** — `initiate`/`complete` on a `manual_review`
  assetKey now return **404 ASSET_NOT_FOUND** (byte-identical to a nonexistent
  asset), not 409 `MANUAL_REVIEW`. `toRecipientView`'s null-key path is hidden the
  same way. Matches `getAsset`, closing the existence-confirmation info-leak.

### Schema changes (`1720000002000_claims_api.sql`)

Assets gain the `claiming` status. Claims gain `challenge_nonce`,
`challenge_expires_at`, `recipient_id`, `protocol`, `updated_at`;
`user_signature` becomes nullable (a claim is created at initiate, before the
signature exists); a `claims_status_ck` is added; `one_live_claim_per_asset` is
recreated over the won states. Migrates up **and** down cleanly (verified against
the same Postgres the ledger is built into).

### Rate limiting + audit

- `src/api/rate-limit.ts` — dependency-free fixed-window limiter, two dimensions
  (per-IP over all `/v1`, per-identity on identity-bearing routes), mirroring the
  attestor's `express-rate-limit` posture. Bounded memory (lazy GC + FIFO cap).
- `src/api/audit.ts` — every transition (`claim.initiate|verified|rejected|
  expired|pending_review`) appends one `audit_log` row with enough to reconstruct
  the claim. M3 already writes a **real sha256 hash chain** (`entry_hash =
  sha256(prev_hash || canonical_json(entry))`, serialized by a transaction-scoped
  advisory lock); the `signature` column holds a 64-byte zero placeholder that
  **M6** replaces with the Ed25519 audit-key signature.

### Vault settlement (provisional)

For vault assets, `completeClaim` records a coarse `settlement` (`liquid|relock`)
via the deposit-time `vaultEscrowFallsBackToLiquid` + an expiry check. **M4
recomputes it at dispatch** (the authoritative decision) from
`ArioConfig.min/max_vault_duration`; M3's value is advisory for the audit trail.
Those durations come from the worker config (`VAULT_MIN/MAX_DURATION_SECONDS`)
and are **reconciled against the live on-chain `ArioConfig` at worker boot** — a
mismatch FAILS the boot (`dispatch/ario-config.ts`), so they are guaranteed to
equal the on-chain values even though they are not re-read per dispatch. A
still-locked (`relock`) settlement is NOT auto-relocked via a CPI: it routes to
the **manual-delivery operator queue** (`awaiting_manual_vault_delivery`, see
`yarn vault:manual-queue`) carrying the correct absolute unlock timestamp; if the
unlock has since passed it is delivered liquid instead.

### Money & reuse

Money is `bigint` mARIO throughout (`NUMERIC(20,0)` ↔ `BigInt`); the API amount
field is a decimal string, never a JS number. Verification is **100% M2
`verifyClaim`** — no crypto re-implemented. No `@solana/web3.js` in the runtime.

### Verification performed (M3)

Real Postgres (dedicated container) with the **real mainnet ledger** built from
the frozen inputs (`build:ledger` → recipients=8347, assets=10893, available=10711,
manual_review=182). Then:

- `GET /v1/claimable` against real recipients (AR 157-asset, ETH 22-asset);
  ETH mixed-case body normalized; unknown identity 404; manual_review asset 404;
  manual_review recipient → `assets:[]`.
- `POST /v1/claims/initiate` on a real asset → server-built canonical
  (`ar.io escrow claim` header, F-1 recipient binding) + fresh challenge.
- Full `initiate → sign → complete → status` over HTTP (curl/fetch) with a
  **synthetic ETH identity we hold the key for** (real recipients' keys are
  theirs): 202 verified, idempotent replay 202 (`idempotentReplay:true`), asset →
  `claiming`, audit trail `claim.initiate, claim.verified`, bad proof → 401 with
  the asset left `available`.
- **Concurrency (the gate)**: `service.db.test.ts` fires **8 parallel completes**
  against real Postgres — (a) 8 DIFFERENT valid claims for ONE asset →
  **exactly 1 verified, 7 ALREADY_CLAIMED**, asset consumed once, one dispatch
  intent; (b) 8 completes of the SAME claim → **8 successes, 7 idempotent replays,
  one `claim.verified` audit row** (no double dispatch). Plus AR RSA-PSS (salt 0
  and 32), replay-across-assets, expired challenge, re-initiate-after-claim, bad
  signature, nonce echo mismatch, big-claim brake → `pending_review`, wrong
  protocol → `PROTOCOL_MISMATCH`.
- **Post-review proofs**: 8-way concurrent initiate on one `idempotencyKey` → all
  return the SAME claim, zero 500s; a garbage/foreign-signature replay of a
  completed claim → 401 (never `verified`), while the genuine proof still replays
  idempotently; `initiate` on a `manual_review` asset → 404 (indistinguishable
  from nonexistent).
- Full suite green: **claims 219** — 32 M3 tests (service.db 15, http 4,
  rate-limit 6, errors 4, audit 3) + the tester's `service.adversarial.db.test.ts`
  (16) + M1/M2 suites, and **attestor 11 + canonical 49 unchanged**. Lint/typecheck
  (incl. `typecheck:tests`) clean. Migration up/down round-trips.

### What I could NOT fully verify / caveats (M3)

- **`complete` is driven with synthetic recipient keypairs**, not captured
  mainnet-wallet signatures (those keys are the real owners' alone). The canonical
  bytes are server-built from the real ledger and the RSA-PSS/secp256k1 primitives
  are M2's contract-pinned code, so a self-signed proof over the real canonical is
  a faithful drive — the same technique the M2 golden vectors use.
- The concurrency proof runs at **8-way** parallelism against a local Postgres 16.
  The guarantee is structural (row-lock serialization), not load-dependent, but I
  did not run a high-N soak.
- The DB-backed API/concurrency tests are **not wired into CI** yet — they need a
  Postgres service + the migrated M3 schema (the M0/M1 pattern). The fast unit
  tests (rate-limit, errors, audit-json) run without a DB. The tester reproduces
  the DB gate with `migrate:up` + `DATABASE_URL`.
- `settlement` is **provisional** (see above); the big-claim brake checks the
  per-asset amount and the recipient's available total, but the operator
  approval/dispatch flow itself is **M4**.

## M4 — Dispatch + custody (the money-movement layer)

Consumes M3's verified dispatch-intents (a `verified` claim = a won asset) and
executes the on-chain transfer **idempotently and exactly-once** (pivot plan
§4.3/§4.4). All code is in `packages/claims/src/dispatch/` + migration
`1720000003000_dispatch.sql`; operator CLIs in `src/cli/`. `@solana/kit`
throughout — **no `@solana/web3.js`**. Money is integer `bigint` mARIO.

### Custody / signer model (pluggable)

- **`DispenserSigner`** (`signer.ts`) is the pluggable interface the worker signs
  through. Default backend **`EncryptedKeypairSigner`** decrypts a 32-byte
  Ed25519 seed at runtime from an **AES-256-GCM sealed blob** (`crypto-box.ts`,
  scrypt KDF) whose passphrase (KEK) is injected SEPARATELY at runtime — the
  seed never touches disk in the clear (same operational discipline as the
  attestor key, one at-rest layer heavier because this key moves money). Seal a
  key with `yarn encrypt:treasury-key --generate --out <path>` (prints only the
  address). `KmsSigner` / `SquadsSigner` are interface-only stubs — they slot in
  with **no worker rewrite** (the worker only ever sees `DispenserSigner`).
- **Two separable custody ROLES** (`SignerRegistry`, guarded by
  `assertSeparableRoles` — the ANT signer MUST NOT be the hot key):
  - `token` — the **HOT dispenser**, holds ONLY the bounded ARIO float (≤500k);
    signs SPL transfers + vault settlements. Worst-case loss = the float.
  - `ant` — the **ANT custody signer**, a SEPARATE key. See the ANT proposal.

### ANT-custody proposal (flagged for coordinator review)

The plan's baseline (bulk-move all 2,269 ANTs to the hot dispenser at cutover)
puts every NFT in the hot key's blast radius. **This build instead implements
the "config-toggle" alternative the plan itself offers, as the default:** ANTs
are dispensed by a SEPARATE `ant` signer and every ANT dispatch is
**operator-approval gated** (`antRequiresApproval`, default `true`) — an NFT is
NEVER auto-dispensed from a hot key. A verified ANT claim routes to
`pending_review`; an operator approves (`yarn dispatch:approve <claimId>`) and
only then does the worker sign the `TransferV1`+`UpdateV1` with the `ant` signer.
Because the signer is pluggable, the `ant` role is the natural home for a
**cold / KMS / Squads-multisig** backend brought online per-batch — so the 2,269
ANTs stay off the hot path entirely (they can remain under the cold authority,
approved in batches, or a JIT per-claim delegation). ANT claim frequency is low,
so the operator-in-the-loop latency is acceptable.

**DECISION (confirmed by the operator): cold authority, signed PER APPROVAL
BATCH.** Implemented as the default: there is **no persistent server-side ANT
key** and **no bulk-move of the 2,269 ANTs**. The dispatch worker's
`SignerRegistry` is **token-only** in production (`loadSignerRegistry` loads
`ant` only if a deployment explicitly opts in). A verified ANT claim routes to
`pending_review`; the operator approves (`yarn dispatch:approve`), then runs
`yarn dispatch:ants` with the **cold ANT authority loaded at runtime for that
batch only** (`ANT_COLD_KEYPAIR_PATH` — a Solana keypair JSON — or a sealed
blob + passphrase). That CLI calls `worker.runAntBatch(coldSigner)`, which
dispenses every approved ANT with the cold key and then discards it. Between an
approval and the batch run the claim sits in a new `awaiting_ant_signer`
outcome (approved, but the cold key isn't loaded) — an NFT is provably never
dispensed without the operator-supplied cold signer. `runAntBatch` also refuses
a non-`ant`-role signer or one whose address equals the hot dispenser.
**Proven live on surfpool** (token-only worker → gated → approved →
`awaiting_ant_signer` → `runAntBatch(cold)` → `TransferV1`+`UpdateV1`, Owner+UA
== claimant on-chain).

### Exactly-once dispatch (how a crash can't double-send)

`worker.ts` `DispatchWorker`. A Solana signature is deterministic from
(message + signer) and only landable while its blockhash is valid — the worker
exploits both, WITHOUT durable nonces:

1. **FRESH** (`verified` / approved `pending_review`): build + **SIGN** the tx →
   get the deterministic signature → in ONE committed DB txn **PERSIST the
   signature + its blockhash/lastValidBlockHeight and flip the claim to
   `dispatching`** (re-checking state under `SELECT … FOR UPDATE` so a concurrent
   worker/completer can't double-dispatch; a loser ABORTS and never broadcasts
   its signed tx). Only AFTER that commit: **broadcast**, then **confirm**.
2. **RECOVERY** (restart sees `dispatching` + a recorded sig — the "check for an
   existing successful tx before sending" guard): `getSignatureStatuses(sig)` →
   `confirmed` → finalize (no resend); `failed` → claim `failed`, asset stays
   `claiming` for an operator (never auto-retried); `pending` + blockhash valid →
   wait (a prior broadcast may land); `pending` + `lastValidBlockHeight` passed →
   the tx is **permanently dead**, so re-sign a fresh one. A replacement is only
   ever signed once the previous one is provably dead ⇒ **at most one signature
   per claim ever lands.**

   **Lagging/pooled-RPC hardening (minimal, no durable nonces).** A lagging or
   pooled confirm-RPC can misreport a *landed* tx as `expired`, which would
   double-send. So on `expired`, **before re-signing**, the worker scans the
   dispenser's + claimant's on-chain outflows (`getSignaturesForAddress`) for a
   CONFIRMED tx that is one of THIS claim's own recorded signatures; if found it
   finalizes `confirmed` and never re-sends (match is by our own signature —
   decoy-proof). If no landed outflow exists, it re-signs, but a **HARD CAP of one
   re-sign per claim** (`dispatch_resign_count`) bounds the blast radius: a second
   `expired` with no outflow freezes the claim `needs_operator` (never loops) and
   fires a CRITICAL alert (`dispatch-needs-operator`). Operator keeps a single
   consistent `CONFIRM_RPC_URL`; this is defense-in-depth, not a substitute.

Asset lifecycle `available → claiming → claimed`; a confirmed dispense marks the
asset `claimed` (terminal) + the `one_live_claim_per_asset` unique index is the
belt-and-suspenders backstop, so no second claim can win and no second dispatch
row can exist. Confirmation only flips the asset to `claimed` (never on the
un-confirmed broadcast).

### Settlements

- **Token**: idempotent `createIdempotent` ATA + plain SPL `Transfer` of the
  exact mARIO from the hot dispenser to the claimant ATA (`instructions.ts`,
  byte-parity unit-tested vs the mainnet-proven `claim-transfers.ts`).
- **Vault**: recomputed at dispatch via M2 `computeVaultSettlement` against
  `ArioConfig.min/max_vault_duration` (passed as `vaultDurations` from the worker
  config, and **boot-reconciled against the live on-chain `ArioConfig`** — a
  mismatch aborts the worker, so they equal on-chain even though not re-read per
  dispatch). `liquid` (expired / sub-min / early-window) → SPL transfer. `relock`
  (still-locked) → routed to the **manual-delivery operator queue**
  (`awaiting_manual_vault_delivery`), NOT an auto CPI and NOT a `pending_review`
  loop: the operator hand-delivers a "transfer tokens locked" to the correct
  ABSOLUTE unlock (== the escrow's original `vault_end_timestamp`) via
  `yarn vault:manual-queue`; if that unlock has since passed it is flagged
  deliver-UNLOCKED (liquid). **Never silently caps an over-max lock** — an
  over-`max_vault_duration` remaining is surfaced to the same operator queue
  rather than downgraded to liquid.
- **ANT**: `TransferV1` (Owner) + `UpdateV1` (UpdateAuthority) atomic, via the
  `ant` signer (ADR-013), mirroring `claim-transfers.ts::transferNft`.

### Float manager (`float.ts`)

Live hot-ATA balance (from chain) minus in-flight reserved (verified+dispatching
token/vault amounts, excluding the claim under eval). Refuses a dispatch that
would exceed available float (leaves the claim queued + raises `refillNeeded` —
NOT a failure; operator tops up from cold). Enforces the **500k cap** (overCap
flag) and, defensively, the **>100k per-claim brake** at dispatch time (over
threshold + unapproved → `pending_review`, never auto-signed) — belt & suspenders
over M3's complete-time routing.

### Reconciliation-after-dispatch (`reconcile-dispatch.ts`, `yarn reconcile:dispatch`)

Proves: Σ dispatched (`settlement_amount`) == Σ claimed (`asset.amount`) over
confirmed token/vault claims; every confirmed claim recorded a tx signature;
exactly one confirmed claim per `claimed` asset (no double-dispense) and no
orphan settle; an audit row per dispatch transition (`claim.dispatching` +
`claim.confirmed`). Optional `assetKeys` scope for per-batch ops reconcile.

### Verification performed (M4)

- **Unit (no DB, no chain).** crypto-box seal/open + fail-closed on bad
  passphrase / GCM tamper; instruction byte-parity (SPL Transfer `[3,u64]`,
  createIdempotent ATA `[1]`, MPL Core `TransferV1 [14,0]` / `UpdateV1
  [15,0,0,1,1,pubkey]`, `vaulted_transfer` disc = `sha256("global:vaulted_transfer")[..8]`
  + args, memo); **golden PDA test** — `deriveArioConfig` == mainnet
  `EdtCcYk9…` + vault/vault_counter anchors; encrypted-signer load/unlock +
  separable-role guard; KMS/Squads stubs; float brake/insufficient/cap/refill;
  **TOCTOU expiry** (`chain.test.ts` — height-before-status, last-slot→pending,
  provably-dead→expired).
- **DB-backed exactly-once (FakeChainGateway):** token happy path → confirmed +
  asset claimed + ONE signature + idempotent re-run; **crash AFTER land, before
  finalize → recovery confirms, NO re-send (signCount stays 1)**; **crash BEFORE
  broadcast + blockhash expiry → re-sign, EXACTLY ONE tx lands**; two concurrent
  workers on one claim → single dispatch; >100k brake → not dispensed until
  approved; insufficient float → queued (deferred_refill); vault-liquid vs
  vault-relock routing; **already-claimed asset → ABORT, 0 transfers** +
  **asset-flips-to-claimed-mid-sign → persist FOR UPDATE guard aborts, 0
  transfers** (`worker.fixes.db.test.ts`); **ANT cold-authority-per-batch** —
  token-only worker holds an approved ANT (`awaiting_ant_signer`) until
  `runAntBatch(coldSigner)` dispenses it. Plus reconcile CATCHES tampers
  (dispatched≠claimed, missing sig, double-dispense, missing audit).
- **LIVE on surfpool (mainnet-forked SVM) through the REAL `DispatchWorker` +
  the real DB** (`scripts/m4-localnet-proof.ts`): created an ARIO SPL mint,
  funded a 300k float, then **all six phases PASS** —
  (1) float funded; (2) **TOKEN** dispensed to a claimant ATA (on-chain balance
  == 1234 ARIO); (3) **idempotency** — re-run → `already_confirmed`, balance
  unchanged; (4) **VAULT-liquid** dispensed (5000 ARIO); (5) **ANT** (production
  flow) — minted an MPL Core asset, token-only worker gated
  (`awaiting_approval`), approved, held (`awaiting_ant_signer`), then
  **`runAntBatch(cold authority)`** → `TransferV1`+`UpdateV1` → **Owner AND
  UpdateAuthority both == claimant, read back from the on-chain asset**;
  (6) **>100k brake** → `routed_to_review`, balance 0. A full 3-asset-type
  on-chain dispense, not a simulation.
- Full suite green: **attestor 11 + canonical 49 unchanged** (behavior
  untouched), **claims 223 (no DB) / 286 (with DB)**. `build` + `typecheck` +
  `typecheck:tests` clean. Migration `1720000003000_dispatch` up + down verified.

### What I could NOT fully verify / caveats (M4)

- **Vault RE-LOCK is not exercised live.** A treasury-signed `vaulted_transfer`
  needs the deployed ario-core + genesis `ArioConfig` + a vault ATA provisioned
  for the (yet-to-exist) vault PDA — not available on the forked surfnet. The
  instruction encoding (discriminator + u64/i64/bool args) + the config/counter/
  vault PDA derivations are unit-tested; the worker **routes a relock to the
  operator** rather than silently settling it liquid. The live proof covers the
  vault-LIQUID path (an SPL transfer, identical to what an expired on-chain vault
  claim does).
- **The SPL Memo ix is disabled in the surfpool proof** — the surfnet datasource
  would not clone the Memo program (`account not found`). The memo is cosmetic
  traceability; the worker makes it optional (`includeMemo`, default `true`) so a
  cluster lacking the Memo program can never brick a dispense. Production keeps it
  on. The memo bytes are trivial and not otherwise load-bearing.
- **Live crash-kill is proven via the FakeChainGateway** (a deterministic SVM),
  not by SIGKILL-ing a process mid-broadcast on surfpool — the fake reproduces
  every crash point exactly (land-then-report-pending, crash-before-broadcast,
  expiry) which a wall-clock kill cannot do deterministically. The live run
  independently proves real on-chain idempotency (re-run → no double-send).
- **Signers are `EncryptedKeypairSigner` / `InMemoryKeypairSigner`.** KMS/Squads
  are interface stubs (they need a cloud/multisig dependency); the interface is
  exercised so a real backend drops in without touching the worker.
- The worker is **single-flight / sequential** (one process). The per-claim row
  lock makes concurrent workers safe (proven), but horizontal scaling of the
  float check across processes would want a distributed advisory lock — noted,
  not needed for the cutover's claim rate.

### M4 — operational requirements

- **Confirmation reads MUST use a single consistent RPC** (or a read quorum),
  NOT a round-robin / load-balanced pool. Exactly-once rests on
  `confirmSignature`'s "provably dead" classification, which reads
  `getBlockHeight` + `getSignatureStatuses`; a lagging replica can report a
  landed tx as not-found → misclassify `expired` → re-sign → **double-send**.
  Configure via `CONFIRM_RPC_URL` (defaults to `SOLANA_RPC_URL`); the worker CLIs
  build the gateway from it and `assertSingleConfirmRpc` warns on a pool-shaped
  URL. This is an operational invariant, not something code can fully enforce.

### M4 — tester round-1 fixes (post-gate)

The tester passed the gate but flagged five defects; all fixed on this branch,
each with a regression test:

1. **Worker double-send-safe in isolation (MEDIUM/LOW #1).** The worker never
   re-checked the asset before signing — a lone `verified` claim on an
   already-`claimed` asset dispensed a SECOND transfer (not reachable via M3's
   normal flow, but the worker must not rely solely on M3). Fix: a cheap pre-sign
   asset-state skip **plus** the authoritative re-load of the asset
   `FOR UPDATE` inside `#persistDispatching` (same txn as the claim lock, order
   claim→asset == `service.ts`), aborting unless the asset is still
   `claiming`/`pending_review`. On abort the signed tx is **discarded, never
   broadcast**. Proven (`worker.fixes.db.test.ts`): already-claimed asset →
   0 signs, 0 transfers; asset flipped to `claimed` mid-sign (via the fake's
   `onSign` hook) → persist guard aborts, **0 transfers**, no `dispatch_signature`
   persisted.
2. **TOCTOU in expiry classification (MEDIUM/LOW #2).** `#statusOnce` read
   statuses then height non-atomically — a tx landing in its final valid slot
   between the reads could be misclassified `expired` → re-sign → double-send.
   Fix: sample `getBlockHeight` **FIRST**, then statuses; only classify
   `expired` when a not-found is observed at a height that was **already strictly
   greater** than `lastValidBlockHeight` at sample time (`searchTransactionHistory`
   kept). Proven (`chain.test.ts`): call order asserted height-before-status;
   not-found at height==lastValid → `pending` (never expired); height>lastValid →
   `expired`; landed-at-last-slot → `confirmed`.
3. **`CONFIG_SEED` was wrong (MEDIUM #3).** It was `"config"`; ario-core uses
   `b"ario_config"` (`state/mod.rs`), so `deriveArioConfig` derived the WRONG
   PDA (latent — the worker routes relock to the operator, and on-chain it would
   fail-safe as a `ConstraintSeeds` revert — but it broke the operator relock
   tooling). Fixed + **golden PDA test** (`instructions.test.ts`):
   `deriveArioConfig("73YoECm6…")` == the mainnet ArioConfig PDA
   `EdtCcYk9RAHyakTSBwtJit6SJcrrk9hj82sASekszLf5`. Added regression anchors for
   the vault + vault_counter derivations (seeds `b"vault"` / `b"vault_counter"`,
   which were already correct). The SPEC's "PDA-derivations unit-tested" claim is
   now true.
4. **Single-RPC operational requirement (LOW/INFO #4).** See "operational
   requirements" above — `CONFIRM_RPC_URL` + `assertSingleConfirmRpc` + docs.
5. **Misleading determinism comment (INFO #5).** Reworded the worker / chain /
   migration headers: a retry re-signs against a FRESH blockhash → a DIFFERENT
   signature; the guarantee is persist-sig-before-broadcast +
   re-sign-only-after-the-old-sig-is-PROVABLY-dead, not "recompute the same sig".

Full suite after the fixes: **attestor 11 + canonical 49 unchanged**, **claims
223 (no DB) / 286 (with DB)**; the live surfpool proof re-run green (now
exercising the operator ANT-batch flow end-to-end on-chain).

## M6 — Transparency (signed ledger + anchored audit log + reserves)

Keeps the centralized custodian auditable-after-the-fact (pivot plan §6.5, a
stated non-negotiable). All code in `packages/claims/src/transparency/` +
`src/api/transparency.ts` + migration `1720000004000_transparency.sql`; CLIs in
`src/cli/`. **`@solana/kit` only** (no web3.js); money stays integer `bigint`
mARIO. Three keys, all SEPARATE from the treasury + attestor keys.

### Keys (`transparency/keys.ts`) — separable blast radii

Two Ed25519 keys, distinct from the hot dispenser (treasury) and the attestor
signing key (BUILD.md non-negotiable), loaded with the same at-rest discipline as
the treasury key (sealed AES-256-GCM blob via `crypto-box.ts`, passphrase
injected separately; a bare `*_SEED_BASE64` is localnet/tests only):

- **AUDIT** key — signs each `audit_log.entry_hash` (schema §3.1: "Ed25519 over
  entry_hash by the AUDIT key (≠ attestor, ≠ treasury)").
- **LEDGER_PUBLISHER** key — signs the published-ledger manifest AND is the
  fee-payer/signer of the on-chain anchor memo tx (the "ledger-publisher/anchor"
  key). `assertTransparencyKeysSeparable` guards audit ≠ publisher.

### 1. Published, signed ledger (`ledger-artifact.ts` + `merkle.ts`)

A deterministic, third-party-verifiable commitment. Each asset → a canonical
LEAF (`recipientId, protocol, assetKey, assetType, amount, antMint, vaultEndTs,
status` — **no secrets**: no nonce, no modulus; `recipientId` is already a public
sha256 handle). Leaves are sorted by `assetKey` and committed under a **binary
Merkle tree** (`merkle.ts`): domain-separated hashing (`leaf = sha256(0x00‖data)`,
`node = sha256(0x01‖L‖R)` — closes CVE-2012-2459) and **promote-on-odd** (no
ambiguous duplicate pair). The root + counts + totals + input fingerprints form a
MANIFEST, signed by the publisher key. `buildLeavesFromDb` reads all non-cancelled
assets (available + `manual_review` AT-RISK, marked as such — nothing that affects
claimability trust is excluded).

- **Verifier** (`verifyLedgerArtifact`, `proveMembership`/`verifyMembership`, and
  the standalone `cli/verify-transparency.ts artifact <file>`): re-derives the
  root from the leaves, checks it equals the signed manifest root + verifies the
  publisher signature, then proves a single asset's membership with ~log₂(N)
  sibling hashes. **Tamper detection**: any altered/removed leaf changes the root
  → the publisher signature no longer matches → flagged; a tampered leaf in a
  membership proof no longer folds to the committed root → flagged.
- **Publish**: `cli/publish-ledger.ts` (`yarn publish:ledger`) builds+signs the
  artifact, self-verifies, persists an immutable snapshot to `published_ledger`,
  and writes the artifact JSON (upload to Arweave/IPFS for permanence).

### 2. Tamper-evident audit-log anchoring (`audit-chain.ts` + `anchor.ts`)

The M1/M3 `audit_log` sha256 hash chain is verified independently
(`verifyAuditChain`: recompute every `entry_hash` from the stored `entry` jsonb
via the SAME `canonicalJson`, check the hash AND the `prev_hash` linkage; a
suffix can be verified with `initialPrevHash`). The AUDIT key signs each
`entry_hash` — on write when `setAuditSigner` is registered (M6 service boot),
else the placeholder is back-filled by `signUnsignedAuditRows` (batched UPDATE).

The current chain HEAD (`{seq, entryHash}`) is anchored on-chain as a **Solana
Memo tx** signed by the publisher/anchor key (`submitAnchor` → SIGN→broadcast→
confirm via the M4 chain gateway), recorded in `audit_anchors`. `cli/anchor-audit-log.ts`
(`yarn anchor:audit-log`) back-fills signatures, verifies the full chain (refuses
to anchor a broken one), and posts the anchor; cadence + target are configurable
(`ANCHOR_TARGET`, cron interval; Arweave data-item is a documented "and/or"
extension). A verifier confirms extension: `fetchAnchorMemo` reads the memo BACK
FROM CHAIN (does not trust the DB), and `checkExtendsAnchor` confirms the live log
still reproduces the anchored hash at the anchored seq — a rewrite at/before that
seq diverges and is flagged.

**Memo-program finding (latent M4 bug).** The `MEMO_PROGRAM` constant in
`dispatch/instructions.ts` (`MemoSq4gq4qMz6H4dS7YEG2KDsF7hCkQqRr5dW5CtBc`, the
"v2" id) resolves to **NO account on devnet OR mainnet** (verified via
`getAccountInfo` on both public RPCs). The SPL Memo program actually deployed on
both clusters is `Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo` (executable). This
is exactly the "surfpool would not clone the Memo program" note in the M4 caveats
— the address itself is dead. M6 anchoring uses the live program
(`LIVE_MEMO_PROGRAM`, override `ANCHOR_MEMO_PROGRAM`). **M4's claim memo would
fail in production if enabled** — flagged for the M4 owner (M4 made the memo
optional/off, so no live impact today).

### 3. Reserves / proof-of-holdings (`reserves.ts`)

`GET /v1/transparency/reserves` (`computeReserves`) reports LIVE on-chain holdings
vs the ledger liability so anyone can check holdings ≥ liabilities:

- **Reserve side, read live via `@solana/kit`** (never DB-asserted): hot ARIO
  float = SPL balance of the treasury dispenser ATA; cold reserve = SPL balance of
  the cold-reserve owner's ATA; ANT holdings = a live sample of outstanding ANT
  mints whose on-chain Owner == the authority (`sampleAntHoldings`/`readCoreOwner`,
  offset-1 of AssetV1), or a full `getProgramAccounts` count (`RESERVES_ANT_CHECK`).
- **Liability side, from the ledger** (`readLiabilities`): outstanding mARIO =
  Σ token/vault amount not yet claimed/cancelled; outstanding ANTs = count.
- **Coverage**: `tokenVaultCovered = totalReserve ≥ outstanding`, `surplusMario`,
  `antCovered`.

### Endpoints + wiring

`src/api/transparency.ts` + `routes.ts`: `GET /v1/transparency/ledger[?id=&full=1]`,
`/ledger/proof?assetKey=[&id=]` (membership proof + self-check), `/log[?sinceSeq=&limit=]`,
`/anchors[?kind=&limit=]`, `/reserves`. `/health/ready` gains `ledgerRootHash` +
`auditLogHead` (§4.1, best-effort). The reserves route builds a kit RPC + gateway
lazily. CLIs: `yarn publish:ledger`, `yarn anchor:audit-log`, `yarn verify:transparency`.

### Verification performed (M6)

- **Unit (no DB/chain, `transparency/*.test.ts` + `api/audit.signer.test.ts`):**
  Merkle root/proof for n∈{1,2,3,4,5,7,8,16,33} + tamper (modified leaf/sibling,
  deleted leaf) + domain separation; artifact build/verify/membership + tamper
  (altered amount, removed leaf, hidden `manual_review`) + wrong-publisher-key;
  audit-chain linkage/signature/altered-content/broken-link/forged-sig + extends
  vs rewrite-detection; anchor memo build/parse + the live-vs-dead memo-program
  assertion; sign-on-write hook (mock client).
- **DB-backed (`transparency.db.test.ts`, `api/transparency.http.test.ts`):**
  concurrency-safe (READ-ONLY over the shared append-only `audit_log`; own rows
  read BY ID): publish + read-back + membership + tamper; deterministic
  build-from-DB; reserves coverage math (huge-covers / zero-shortfall / internal
  consistency) with an on-chain-balance fake; anchors round-trip; HTTP endpoints.
- **LIVE on devnet (`scripts/m6-devnet-proof.ts`, single-process, self-restoring):**
  all 7 phases PASS — (1) fund an ephemeral anchor key; (2) ledger verifies +
  membership + tamper; (3) **audit head anchored ON-CHAIN** (real memo tx
  `3aik6XKT…`, slot 475288747, `Memo1Uhk…` success), memo read back FROM CHAIN,
  log confirmed to EXTEND the anchored head, rewrite detected; (4) reserves — a
  cold reserve funded to cover the live ledger liability, read LIVE via kit
  (cold == 81,147,797.204002 ARIO ≥ outstanding 81,147,796.204002), unfunded →
  NOT covered, live ANT-owner read. DB restored (no signed rows / no appended
  rows / no published_ledger / no anchors left behind).
- Full suite green: **attestor 11 + canonical 49 unchanged**, **claims 339**
  (+48). `build`/`typecheck`/`typecheck:tests`/`lint` clean; migration
  `1720000004000_transparency` up + down verified.

### What I could NOT fully verify / caveats (M6)

- **Anchoring proven on DEVNET, not mainnet** (as scoped). The mechanism is
  cluster-agnostic; mainnet just needs the anchor key funded + `NETWORK` set.
- **The production `anchor-audit-log` CLI refuses a broken chain** (`verifyAuditChain`
  must pass before anchoring). The SHARED dev DB's `audit_log` has deletion-induced
  gaps from prior M3/M4 test cleanups (append-only is a production invariant), so
  the CLI won't anchor against it as-is; the live proof anchors a controlled clean
  SUFFIX instead. On a real append-only mainnet log the CLI runs end-to-end.
- **Arweave data-item anchoring is a documented extension** (the plan's "and/or").
  The Solana-memo path is implemented + proven; Arweave would add a Turbo upload +
  a `target='arweave'` branch (schema already allows it).
- **ANT holdings default to sampling** (`getProgramAccounts` is heavy / often
  RPC-disabled). The live proof exercises the `readCoreOwner` primitive; a full
  live sample against the 2,269 real ANT mints needs mainnet (they don't exist on
  devnet).

### M6 — tester round-1 fixes (post-gate)

The crypto passed but the tester found defects undermining third-party
verifiability; all fixed on this branch, each with a regression in
`transparency/adversarial.uat.test.ts` (the tester's `weakness:` tests, updated
to assert the SECURED behavior — they now fail if the exploit is reintroduced).

1. **MANDATORY publisher pin (MEDIUM #1).** `verify-transparency artifact <file>`
   without `--publisher` printed PASS on an artifact an attacker rewrote AND
   re-signed with their own key (pubkey swapped) — a self-consistent forgery.
   Fix: `verifyLedgerArtifact` now carries a `pinned` flag and **returns `ok:false`
   when no independent publisher key is supplied** (signature is only checked
   against the PINNED key, never the artifact's embedded one; a key-swap fails
   `pubkeyMatches`). The CLI **refuses to print PASS unpinned**, requiring
   `--publisher` / `LEDGER_PUBLISHER_PUBKEY_HEX`, OR pinning the root from an
   on-chain ledger-root anchor (`--ledger-anchor-sig` + `--rpc`, with an optional
   signer check). Unpinned self-signed forgery now FAILS; the genuine artifact
   pinned still verifies.
2. **Anchor SIGNER pin (MEDIUM #2).** The memo BODY is forgeable — any funded key
   can post a memo carrying a rewritten head, and the log "extends" it. Fix:
   `fetchAnchorMemo` now returns the tx's `feePayer` + `signers`, and
   `anchorSignedBy` requires the anchor tx to be signed by the KNOWN
   publisher/anchor key. The verifier pins the ORIGINAL anchor txid itself
   (`--anchor-sig`, never read from the operator DB for a trust verdict) AND the
   signer (`--anchor-address` / `--publisher`). A fresh attacker-posted anchor is
   rejected. Proven live: the devnet anchor proof asserts `signer=true` against
   the pinned publisher address.
3. **Distinct-custody guard (MEDIUM #3).** `computeReserves` now **throws if
   `coldReserve == hotDispenser`** (the same ATA counted twice → false surplus),
   and dedupes ATAs defensively before summing. Same-address configs can no
   longer mask a shortfall.
4. **ANT coverage honesty (LOW-MED #4).** `coverage.antCovered` is a boolean ONLY
   under a full `gpa` count; under sampling it is **`"sampled-only"`** and can
   NEVER read `true` (a partial sample proves the sampled few are owned, not
   holdings ≥ outstanding ANTs).
5. **Key-reuse guard (LOW #5).** `assertTransparencyKeysDistinct` +
   `loadReservedAddresses` assert the audit + publisher keys differ from each
   other AND from the treasury (`TREASURY_ADDRESS`) + attestor
   (`ATTESTOR_PUBKEY_*`) addresses; wired into the publish + anchor CLIs.

**HIGH — M4 memo constant (bundled fix).** `dispatch/instructions.ts`
`MEMO_PROGRAM` was the "v2" id `MemoSq4g…`, a DEAD account on devnet AND mainnet;
with `includeMemo` defaulting ON (`worker.ts`), a default production dispatch
would reference a nonexistent program and FAIL. Fixed the constant to the live
`Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo` (single source of truth, aliased by
`anchor.ts::LIVE_MEMO_PROGRAM`). **Proven live on devnet**
(`scripts/m6-memo-dispatch-devnet.ts`): a DEFAULT-config (memo ON) token dispense
through the real `DispatchWorker` confirmed, delivered 1,234 ARIO, and its tx
invoked the live memo program with the `ar.io-claim:<id>` memo landed on-chain
(decoded from the tx — the v1 memo program doesn't log the text).

Re-verify after the fixes: **attestor 11 + canonical 49 unchanged**, **claims
356**; `build`/`typecheck`/`typecheck:tests`/`lint` clean. Both devnet proofs
green (anchor/reserves 7/7 with `signer=true`; memo-dispatch PASS).

## M7 — Ops hardening + staging rehearsal + decommission

The last build milestone before the security audit. Three deliverables:
ops/observability, the operator runbooks + decommission plan, and the full
end-to-end staging rehearsal on devnet. Plus the test-isolation flake fix.

### Test-isolation flake fix (stable green)

Two DB-backed tests flaked because aggregate queries scan the WHOLE shared
Postgres, so rows from concurrently-running test files poisoned the assertion:

1. `worker.db.test.ts › insufficient float … deferred_refill` — `float.reserved()`
   sums ALL in-flight token/vault claims globally; an unrelated file's verified
   claims pushed available float below the refill amount → the refill step read
   `deferred_refill` instead of `confirmed`.
2. `adversarial.uat.test.ts › reserves` — `readLiabilities` / `sampleAntHoldings`
   read the global outstanding count; when the shared DB happened to hold exactly
   `sampleSize` ANTs the "partial sample" assertion flipped.

**Fix (scoped queries, production semantics unchanged):** added an OPTIONAL asset-
key scope — `FloatManager({ reservedAssetScope })` and `computeReserves({
assetScope })` / `readLiabilities(pool, scope)` / `sampleAntHoldings(..., scope)`.
Production omits the scope → global (correct: the hot ATA is one shared pool; the
reserves are the whole ledger). The two suites pass their OWN seeded asset keys, so
their aggregates are measured only against their own rows. The reserves suite also
now seeds a deterministic isolated fixture (1 token + 4 ANTs) instead of reading
whatever the shared DB happened to hold. **Proven** by injecting the exact
contamination (250M ARIO of orphaned in-flight token claims + 14 outstanding ANTs)
and re-running the two files green, plus 12× full-suite serial runs (0 fail).

### Ops surface (`src/ops/` + `src/api/metrics.ts`)

- **`metrics.ts`** — `collectDbMetrics(pool)` + `collectMetrics(pool, {float?,
  reserves?})`: dispatch confirmed/failed/in-flight, reconciliation drift
  (`Σ dispatched − Σ claimed`, must be 0), claim rate (confirmed 1h/24h, created
  1h), error rates, the >100k/ANT review-queue depth + oldest age, dispatching
  stall age, audit head seq + unsigned-row backlog, last-anchor age; folds in
  live **float** + **reserves** blocks. `renderPrometheus` emits scrape text.
- **`alerts.ts`** — pure `evaluateAlerts(snapshot, thresholds)`:
  `reconciliation-mismatch` / `reserves-shortfall` / `dispatch-failure` (critical);
  `float-low` / `float-over-cap` / `big-claim-queue-growing` / `-sla-breach` /
  `dispatch-stalled` / `anchor-failure` / `anchor-unconfirmed` /
  `audit-unsigned-backlog` (warning). Thresholds env-tunable (`ALERT_*`).
- **`config-validation.ts`** — `assertBootConfig(env, {role})` FAILS FAST (aborts
  boot) on: a pooled `CONFIRM_RPC_URL` (worker; the runtime guard only warns),
  any two of the FIVE distinct keys sharing an address, NETWORK vs RPC-host
  mismatch, a bare `*_SEED_BASE64` on mainnet, missing `ARIO_MINT`/treasury signer
  (worker), missing explicit `DATABASE_URL` off localnet. Wired into `index.ts`
  (API) + `cli/dispatch-worker.ts` (worker).
- Surfaces: **`GET /metrics`** (Prometheus, not `/v1` → not rate-limited),
  **`GET /metrics.json`** (snapshot + `alerts[]` + `alertLevel`), **`yarn
  ops:metrics`** (structured-JSON CLI, exit 2 on critical), and the dispatch
  worker logs firing alerts each tick.
- Tests: `ops/config-validation.test.ts` (each documented misconfig fails fast),
  `ops/alerts.test.ts` (each condition fires / quiet when healthy),
  `ops/metrics.db.test.ts` (collector shape + lower-bound presence + Prometheus
  format), `api/app.http.test.ts` (metrics endpoints served + never rate-limited).

### Runbooks + decommission (`docs/claims/runbooks/`)

`README` (index + observability/alert reference + the **append-only `audit_log`
production invariant** + boot-validation), `01-deploy`, `02-key-ceremony` (the
five distinct keys, sealed at rest), `03-hot-float-refill` (cold→hot 4-eyes),
`04-big-claim-approval` (>100k review + AT-RISK), `05-ant-cold-batch-dispatch`
(`dispatch:ants`, cold authority per batch, no persistent key),
`06-transparency-cadence` (publish + anchor cadence + reserves gpa decision),
`07-incident-response` (freeze-first; double-dispatch / key compromise / RPC-pool
outage / anchor failure), `08-decommission` (T-30d → teardown executable
checklist; unclaimed held-not-burned; escrow program stays as fallback).

### FULL staging rehearsal (`scripts/staging-rehearsal.ts`, `yarn rehearsal:staging`)

A single scripted run that stands up a **clean dedicated `claims_rehearsal` DB**
(append-only audit_log for the transparency proofs), seeds a representative ledger
with AR (RSA-4096) + ETH (secp256k1) identities we control, and drives the FULL
matrix through the **real HTTP API + real DispatchWorker on-chain**, then reconcile
+ publish + anchor + reserves — each verified as a third party.

**PROVEN LIVE on devnet** (QuickNode staging RPC, funded by the staging authority)
— all 14 phases PASS:
- 8 matrix rows: **AR-token** (tx `53Yv2tCQ…`), **ETH-token** (`3BSWkKGj…`),
  **vault-expired→liquid**, **vault-active→relock ROUTED to operator**, **>100k**
  (complete=`pending_review` → operator approve → confirmed, tx `48MZuezZ…`),
  **AR-ANT** + **ETH-ANT** dispensed by a SINGLE `runAntBatch(cold)` (Owner AND
  UpdateAuthority == claimant, read back on-chain), and the cold-batch handling
  BOTH ANTs at once. Each: lookup → initiate → sign → complete → dispatch →
  on-chain confirm.
- **reconcile-dispatch** clean: 6 confirmed claims, Σ dispatched == Σ claimed =
  158,234 ARIO, 2 ANTs.
- **publish ledger** signed + third-party verified PINNED (unpinned refuses) +
  membership proof.
- **anchor audit head on-chain** (memo tx `5o2qJjyy…`, seq 32): memo read BACK
  FROM CHAIN, `checkExtendsAnchor` = true, signer pinned to the publisher = true.
- **reserves** covered (holdings 1,141,766 ≥ outstanding 3,000 ARIO). The vault-
  active relock stays a liability (routed, not claimed) — correctly covered.

Re-runnable (drops+recreates the rehearsal DB, fresh keys, funds ~1.5 SOL/run);
artifacts (tx sigs + reconcile/reserves/anchor) written to `REHEARSAL_OUT`. On a
surfpool mainnet-fork localnet it runs off airdrops (no funder).

**Residuals folded from the carry-forward:** single-consistent CONFIRM_RPC and the
append-only audit_log are now enforced/validated at boot + documented in the
runbooks; the reserves ANT-gpa cadence + dedicated RPC is an operator decision
documented in runbook 06; the human browser+wallet UAT, counsel sign-off, and the
external security review remain hard cutover gates (SEC milestone).

Full suite after M7: **attestor 11 + canonical 49 unchanged**, **claims 356 + M7
additions**; `build`/`typecheck`/`typecheck:tests`/`lint` clean. Vault RE-LOCK is
still routed-to-operator (not executed on an ad-hoc mint — the M4 caveat; the
rehearsal proves the routing, not a live relock CPI).
