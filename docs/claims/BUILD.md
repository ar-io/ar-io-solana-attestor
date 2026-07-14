# ar-io-claims — Build Coordination

Centralized claim-dispenser service (Option B) that replaces the on-chain
`ario-ant-escrow` custody for the AO→Solana migration, preserving the EXACT
frontend + claim rules. Built on this branch (`feat/ar-io-claims`) as one large
feature PR to `main`.

**Authoritative design:** `/home/vilenarios/source/solana-ar-io/docs/CENTRALIZED_CLAIM_PIVOT_PLAN.md`
(read it — §3–§7 are the spec; Appendix A is the claim-rule conformance
checklist every implementation must pass).
**Mainnet state we build against:** `/home/vilenarios/source/solana-ar-io/docs/MAINNET_ESCROW_CHECKPOINT_2026-07-09.md`.
**Frozen inputs (reused as the ledger source):**
`/programs/ario-snapshot/output-mainnet-prod-remediation/` —
`escrow-recipient-modulus.json` (8,136), `escrow-recipient-AT-RISK.json` (136),
plus the batch-escrow DRY_RUN deposit plan (regenerable).

## Non-negotiables (from the plan §9.3)

- Reuse the attestor's byte-pinned crypto (`canonical.ts`, `verify-rsa-pss.ts`,
  and `canonical.cross.test.ts` — the Rust-parity test). Do NOT re-implement the
  canonical format.
- Two **separate deployables / processes / keys**: the attestor signing key and
  the claims **treasury dispensing key** must have separable blast radii. The
  attestor keeps serving the deployed on-chain program **unchanged** (its pubkey
  is compiled into the mainnet `.so`).
- Bit-exact ledger reconciliation vs on-chain-would-be asset_ids/amounts (M1).
- Claim rules identical to the contract (Appendix A conformance).
- The 136 AT-RISK owners load `status = manual_review` — excluded from self-serve
  claims, operator-queue only (they arrange delivery by email).
- `@solana/kit` for new Solana code (no `@solana/web3.js`).

## Milestones (dev→test loop each; checkpoint with operator per milestone)

| # | Milestone | Acceptance gate (tester validates independently) |
|---|---|---|
| **M0** | Workspaces scaffold + Postgres + CI + docs | build clean; **attestor's existing tests still pass (behavior unchanged)**; both services boot + `/health`; docker-compose up; CI green |
| M1 | Ledger + reconciliation | reconcile PASS bit-exact vs would-be on-chain; 136 AT-RISK = manual_review |
| M2 | Identity proofs (AR/ETH/vault) | Appendix A conformance + contract test vectors + canonical.cross parity |
| M3 | Claims API + replay defense | concurrency = no double-dispense; replay rejected; contract tests |
| M4 | Dispatch + custody | devnet dispenses ARIO+ANT+vault; >100k brake fires; idempotent |
| M5 | Frontend F2 adapter | UAT matrix green in browser; pages behaviorally identical |
| M6 | Transparency | signed ledger + anchored audit log + reserves, third-party verifiable |
| M7 | Ops + staging rehearsal + decommission | full staging rehearsal passes; runbooks complete |
| SEC | Audit → fix → verify | audit findings resolved + regression green → open PR to main |

## Loop protocol

1. Coordinator writes each milestone's spec + updates the acceptance gate here.
2. **Developer agent** builds on `feat/ar-io-claims`, writes its own tests,
   commits the milestone (`M<n>: <summary>`), writes impl notes to `SPEC.md`.
3. **Tester/UAT agent** (separate agent) independently validates against the
   gate above — runs the dev's tests AND writes adversarial/edge tests, tries to
   break it, runs UAT. Reports structured PASS/FAIL + defects.
4. FAIL → coordinator relays exact defects to the dev agent (same agent, context
   retained) → fix → re-test. **Cap 3 cycles**, else escalate to operator.
5. PASS → milestone done; coordinator checkpoints with operator; next milestone.
6. End: security-audit agent → dev fix → tester verify → **one big PR to main**.

## M0 — detailed spec

Goal: a clean multi-package workspace where the **claims** service and the
**attestor** service share one verified crypto lib, with CI + local infra —
**no business logic yet**.

Required:
- Convert the repo to yarn workspaces. Suggested layout (dev may adjust to
  achieve the goals): `packages/canonical` (extract `canonical.ts`,
  `verify-rsa-pss.ts`, the verification-pure parts of `attest.ts`, + their tests
  incl. `canonical.cross.test.ts`), `packages/attestor` (the existing Express
  service, importing `packages/canonical`), `packages/claims` (new skeleton).
- **Hard constraint:** the attestor's runtime behavior is unchanged and ALL its
  existing tests (`app.test.ts`, `attest.test.ts`, `integration.test.ts`,
  `canonical*.test.ts`, `verify-rsa-pss.test.ts`) pass after the move.
- `packages/claims`: skeleton only — TS, `@solana/kit`, an HTTP server
  (Fastify or Express) with `GET /health` → 200, `config.ts` (env-driven,
  `.env.example` only — NO secrets), a Postgres connection + a migration tool
  (choose: drizzle / node-pg-migrate / prisma) with an empty initial migration,
  and a placeholder test.
- Root: workspace `package.json`, shared `tsconfig.base.json`, lint/format
  (match the attestor's existing tooling), a `docker-compose.yml` bringing up
  Postgres + both services.
- CI: a GitHub Actions workflow running install → lint → typecheck → test across
  all workspaces (Postgres service container for claims).
- Docs: create `SPEC.md` (dev impl notes), `TEST_MATRIX.md` (seed with the UAT
  scenarios from `escrow-claim-runner.ts`: AR-token, AR-ANT, ETH-token, ETH-ANT,
  vault-active, vault-expired). Keep this `BUILD.md` as the coordinator source.

M0 is scaffold + safety of the existing attestor. Do not implement the ledger,
API, verification, or dispatch yet — those are M1–M4.
