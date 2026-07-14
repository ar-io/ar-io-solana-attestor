---
name: operate-ar-io-claims
description: >-
  Use when deploying, launching, operating, monitoring, reconciling, or
  debugging/fixing the `ar-io-claims` centralized custodial claim-dispenser
  service (packages/claims in ar-io-solana-attestor) — the AO->Solana migration
  "Option B" that dispenses ~48M ARIO + 2,269 ANTs to users who prove wallet
  ownership. Triggers: "deploy/run the claims service", "dispatch worker stuck",
  "needs_operator / reconciliation-mismatch / reserves-shortfall / float-low
  alert", "reconcile FAIL", "fingerprint mismatch", "double-dispense",
  "big-claim approval", "ANT cold batch", "AT-RISK delivery", "publish/anchor
  the ledger", "fix a bug in the claims money path".
---

# Operating `ar-io-claims`

## What this is
`packages/claims` (`@ar.io/claims`) is a **centralized custodial dispenser** that
replaces the trustless on-chain `ario-ant-escrow`. It reproduces bit-for-bit what
`batch-escrow.ts` would have deposited, then dispenses to claimants who present a
valid identity proof (Arweave RSA-PSS / Ethereum secp256k1). A valid proof **is**
the authorization. Node 20+, TypeScript, Fastify, Postgres, `@solana/kit` (never
web3.js). Money is always integer `bigint` mARIO. Deep reference:
[`docs/claims/OPERATIONS.md`](../../../docs/claims/OPERATIONS.md); 8 runbooks in
[`docs/claims/runbooks/`](../../../docs/claims/runbooks/); design in
`packages/claims/SPEC.md`.

**Current state (2026-07, branch `feat/ar-io-claims`).** Three OPEN PRs, merge in
order: **solana-ar-io #210** (non-behavioral `escrow-extract.ts` asset-id export —
**must merge FIRST**, the reconciler imports it) → **attestor #2** (this service) →
**escrow-app #5** (frontend F2 adapter, `VITE_CLAIMS_API_URL`). The on-chain escrow
`5HZhe9UqKL5zAsdz81nuuaxV41h8bFhudzxxBigAQndM` **stays deployed** (never `--final`,
never closed) as the fallback — it also holds one pre-existing user 50-ARIO
`EscrowToken` claimable ONLY there. Frozen inputs:
`/programs/ario-snapshot/output-mainnet-prod-remediation/` (env `FROZEN_INPUTS_DIR`).
Five distinct keys: **attestor** (`7XtUnotZAeYZNzVSYV5nb7S9YH9qHXyVFM6NeNMu6efE`,
already deployed, leave alone), **treasury** (hot dispenser, the critical one, holds
≤500k ARIO float), **ant-cold** (= existing migration authority, per-batch), **audit**,
**ledger-publisher**.

## System map & verified operator CLIs
Pipeline: **ledger** (`src/ledger/`, `src/reconcile/`) → **verify** (`src/verify/`) →
**API** (`src/api/`) → **dispatch/custody** (`src/dispatch/`) → **transparency**
(`src/transparency/`) → **ops** (`src/ops/`). All commands run from
`packages/claims`. Every name below is verified against `package.json` + `src/cli/`:

| yarn script | purpose | key flags / env |
|---|---|---|
| `migrate:up` / `migrate:down` | schema; down is guarded | down: needs `ALLOW_DESTRUCTIVE_DOWN=1` AND `NETWORK != solana-mainnet` |
| `build:ledger` | build ledger from frozen inputs → Postgres | env `FROZEN_INPUTS_DIR`,`ANT_MINT_SECRET`,`DATABASE_URL`; refuses live-rebuild unless `ALLOW_LIVE_LEDGER_REBUILD=1` |
| `reconcile:ledger` | **bit-exact** independent re-derivation gate | env `FROZEN_INPUTS_DIR`,`ANT_MINT_SECRET`,`RECONCILE_SOURCE`(db/plan),`DATABASE_URL`; **exit 0 = PASS, 1 = FAIL** |
| `encrypt:treasury-key` | seal any Ed25519 key (AES-256-GCM) | `--generate`/`--seed-base64`, `--out <p>`, `--reseal`; env `TREASURY_KEY_PASSPHRASE`(+`_OLD`) |
| `start` | the API (`dist/index.js`) | role=api boot-config |
| `dispatch:worker` | the ONE exactly-once dispenser (run a single instance) | `--once`; role=worker boot-config; `CONFIRM_RPC_URL` must be single-endpoint |
| `dispatch:approve <claimId>` | operator approves a `pending_review` claim | `--by <op>` |
| `dispatch:ants` | cold-signer batch for approved ANT claims | env `ANT_COLD_KEY_SEALED_PATH`+`ANT_COLD_KEY_PASSPHRASE` OR `ANT_COLD_KEYPAIR_PATH` |
| `reconcile:dispatch` | post-dispatch conservation + no-double-dispense check | **exit 0 = clean, 1 = discrepancy** |
| `vault:manual-queue` | list AT-RISK/locked-vault manual deliveries + absolute unlock dates | `--json` |
| `reap:challenges` | sweep expired `claiming` challenges → `expired` | maintenance |
| `publish:ledger` | sign + persist the Merkle ledger manifest | `--out <f>`, `--version <v>`; env `LEDGER_PUBLISHER_*` |
| `anchor:audit-log` | anchor the audit-log head on-chain (Solana memo) | `--ledger-root`, `--dry-run`; env `AUDIT_*`,`LEDGER_PUBLISHER_*` |
| `verify:transparency` | third-party proof check | subcommands `artifact <f>` / `audit` / `audit-log <f>`; `--publisher`,`--anchor-sig`,`--anchor-address`,`--rpc`; **exit 1 on FAIL/unpinned** |
| `ops:metrics` | one-shot metrics + alerts JSON | `--prometheus`; **exit 2 when a critical alert fires** |
| `rehearsal:staging` | full 14-phase devnet dress rehearsal | env `NETWORK`,`SOLANA_RPC_URL`,`SOLANA_WS_URL`,`FUNDER_KEYPAIR`,`DATABASE_URL` |

Alerts (exact names, `src/ops/alerts.ts`): **critical** `reconciliation-mismatch`,
`reserves-shortfall`, `dispatch-needs-operator`, `dispatch-failure`; **warning**
`float-low`, `float-over-cap`, `big-claim-queue-growing`, `big-claim-queue-sla-breach`,
`dispatch-stalled`, `anchor-failure`, `anchor-unconfirmed`, `audit-unsigned-backlog`,
`vault-manual-delivery-queue`.

Claim status machine: `claiming` → `verified` | `pending_review` | `rejected` |
`expired`; then dispatch → `dispatching` → `confirmed` | `failed` | `needs_operator`
| `awaiting_manual_vault_delivery`. Asset status: `available` → `claiming` →
`claimed`; plus `pending_review`, `manual_review` (AT-RISK, hidden as 404), `frozen`,
`cancelled`.

## Invariants that must ALWAYS hold
1. **Conservation:** Σ dispensed ≤ Σ liability; `reconcile:dispatch` drift
   (`Σ settlement_amount − Σ asset.amount` over confirmed token/vault) MUST be `0`.
2. **Exactly-once:** ≤ 1 on-chain tx lands per claim. Guaranteed by
   persist-signature-before-broadcast + re-sign-only-after-provably-dead, hard cap
   `MAX_RESIGN_ATTEMPTS = 1`.
3. **≤ 1 won claim per asset:** two DB locks (claim-row then asset-row) + partial
   unique index `one_live_claim_per_asset`. Any state ≠ `available` reads as
   already-claimed.
4. **AT-RISK / `manual_review` NEVER self-serve:** hidden as 404 `ASSET_NOT_FOUND`,
   excluded from lookup; delivered manually only after out-of-band identity proof.
5. **Reserves ≥ liabilities:** on-chain holdings (hot float + cold + ANTs) cover
   outstanding ledger; `reserves-shortfall` is critical.
6. **Money is integer bigint mARIO** end to end (`NUMERIC(20,0)`, decimal strings
   on the wire — never a JS `number`).
7. **Frozen-input fingerprints must match** the pinned `KNOWN_GOOD_FINGERPRINTS`
   (MED-C) at ledger build/reconcile; and the `EXPECTED_GATE` absolute mARIO pins
   (`phase2TokenOutflowMario=48264957232031`, `expectedVaultMario=20629353000000`,
   `expectedStakeMario=4382868348396` at `nowMs=1783641600000`).
8. **Single consistent `CONFIRM_RPC_URL`** — a pooled/lagging confirm-RPC can
   misclassify a landed tx as dead → double-send. Boot refuses a pooled URL for the
   worker (`CONFIRM_RPC_POOLED`).
9. **Five distinct keys** (`KEY_REUSE` at boot); ANT signer ≠ hot dispenser
   (`assertSeparableRoles`).

## Diagnose-and-fix decision tree
Start with `yarn --silent ops:metrics | jq '{alertLevel, alerts}'` and
`yarn reconcile:dispatch`. Then:

- **claim stuck `needs_operator`** (critical `dispatch-needs-operator`): the re-sign
  hard-cap froze it after repeated `expired` with no landed outflow → **almost always
  a pooled/lagging `CONFIRM_RPC_URL`**. DO NOT blindly re-drive. Scan the dispenser +
  claimant on-chain history for a confirmed tx memo `ar.io-claim:<claimId>`. If it
  landed → mark confirmed. If not → fix the confirm-RPC to a single endpoint, then
  re-drive. → OPERATIONS §Troubleshooting.
- **dispatch stalled / claims stuck `dispatching`** (`dispatch-stalled`): worker down,
  or confirm-RPC lagging. Check the single worker is running + `CONFIRM_RPC_URL`.
  Recovery on restart re-checks each persisted signature (no resend unless provably
  dead). Run `reap:challenges` for stale `claiming`.
- **`reconciliation-mismatch`** (critical, drift ≠ 0) → **freeze immediately**
  (stop worker + take `/v1/claims/*` out of rotation), run `reconcile:dispatch` (it
  prints `... has N confirmed claims (double-dispense!)`), cross-check the memo on
  chain, then top up float from cold and fix RPC before un-freezing.
- **`reserves-shortfall`** (critical) → top up the hot float from cold (4-eyes,
  runbook 03) so holdings ≥ liabilities; freeze if you cannot cover.
- **`dispatch-failure`** (critical, terminal `failed`) → the on-chain tx failed and
  the asset is HELD (never auto-retried). Inspect the signature, fix root cause,
  re-drive deliberately.
- **`float-low` / `float-over-cap`** → refill / sweep (runbook 03).
- **ledger-build fingerprint mismatch (MED-C)** → a frozen input changed. INVESTIGATE
  which file diverged *before* touching anything. Only re-pin `KNOWN_GOOD_FINGERPRINTS`
  (or use `ALLOW_UNPINNED_FROZEN_INPUTS=1`) after a **deliberate, verified** re-freeze.
- **`reconcile:ledger` FAIL** → most common cause is #210 not merged / stale
  `escrow-extract.ts` (ETH-casing or asset-id drift). Rebuild off the merged export;
  never weaken the diff to make it pass.
- **claim wrongly rejected** → distinguish a normal bad proof (401/422 — expected)
  from a *systematic* verification bug (all proofs of one protocol failing). The
  latter is a code issue; the golden vectors (`src/verify/*.golden.json`) are the
  oracle.
- **frontend wallet signature-shape issue** → the canonical bytes are server-built
  and returned by `initiate`; the wallet must sign exactly those. → OPERATIONS.
- **third-party `verify:transparency` fails** → it refuses to print PASS unless
  pinned (`--publisher` / on-chain anchor). Confirm they pinned the announced key.

Full symptom→command→root-cause→fix tables: **OPERATIONS §Troubleshooting**.

## Guardrails a fixer must NEVER cross
- **Never weaken or disable a security gate** to make something pass: the MED-C
  fingerprint gate, the `EXPECTED_GATE` mARIO pins, exactly-once / the `MAX_RESIGN_ATTEMPTS`
  cap, the two-lock + `one_live_claim_per_asset` index, key separation, or the
  `CONFIRM_RPC_POOLED` boot check.
- **After ANY money-path change**, re-run the full suite (`yarn test`), the bit-exact
  `reconcile:ledger` gate, and the double-send / exactly-once DB tests
  (`worker.resign-guard.db.test.ts`, `worker.adversarial.db.test.ts`,
  `chain.toctou.adversarial.test.ts`) — all must stay green.
- **A behavioral change (money amounts, who can claim, a status transition, a gate) →
  STOP and ask the human.** Non-behavioral refactors only otherwise.
- **Never commit secrets** (sealed keys, KEKs, `.env`). Keys are sealed at rest;
  bare `*_SEED_BASE64` is rejected on mainnet.
- **Never point the confirm-RPC at a load-balanced pool.** Never bulk-move the 2,269
  ANTs to a hot key. Never `--final` or close the on-chain escrow. Never mark an
  AT-RISK asset self-serve claimable.

## Pointers
- [`docs/claims/OPERATIONS.md`](../../../docs/claims/OPERATIONS.md) — deploy → day-2 →
  troubleshoot → safe-code-fix → incident → decommission.
- Runbooks: `01-deploy` `02-key-ceremony` `03-hot-float-refill` `04-big-claim-approval`
  `05-ant-cold-batch-dispatch` `06-transparency-cadence` `07-incident-response`
  `08-decommission` in [`docs/claims/runbooks/`](../../../docs/claims/runbooks/).
- `packages/claims/SPEC.md` (design + milestone log), `packages/claims/.env.example`
  (every env var), `docs/claims/BUILD.md`.
