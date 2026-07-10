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
recomputes it live** from `ArioConfig.min/max_vault_duration` at dispatch (the
authoritative decision); M3's value is advisory for the audit trail.

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
- Full suite green: **claims 199** (28 new M3: service.db 12, http 3, rate-limit 6,
  errors 4, audit 3) + **attestor 11 + canonical 49 unchanged**. Lint/typecheck
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
