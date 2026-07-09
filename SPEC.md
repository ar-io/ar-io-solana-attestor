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
