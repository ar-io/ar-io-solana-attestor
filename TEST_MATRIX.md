# ar-io-claims — UAT / Claim-Path Test Matrix

Seeded from the on-chain claim scenarios exercised by
`/home/vilenarios/source/solana-ar-io/migration/import/escrow-claim-runner.ts`
(the live localnet runner covering the attested Arweave claim paths plus
the vault lifecycle and cancel paths). Every centralized-claims
implementation must reproduce these behaviors identically — this is the
concrete, runnable side of the pivot plan's **Appendix A** conformance
checklist.

Status legend: **M0** = scaffold only (no claim logic yet); the
`Implemented in` column names the milestone that must make each row pass.

## Core UAT scenarios (the six the coordinator seeded)

| # | Scenario | Identity proof | Asset | Canonical builder | Expected behavior (must match on-chain) | On-chain reference ix | Implemented in |
|---|----------|----------------|-------|-------------------|------------------------------------------|-----------------------|----------------|
| 1 | **AR-token** | Arweave RSA-PSS-4096 (salt ∈ {0,32}) over canonical bytes; modulus byte-equals stored recipient (F-1) | ARIO token (liquid) | `buildEscrowClaimMessage` (`type: token`) | Verify RSA-PSS → dispense `amount` mARIO to `claimant`; asset terminates (single-use nonce) | `claim_tokens_arweave_attested` | M2 (verify) / M3 (API) / M4 (dispatch) |
| 2 | **AR-ANT** | Arweave RSA-PSS-4096; modulus byte-equals stored recipient | ANT (Metaplex Core NFT) | `buildAntEscrowClaimMessage` | Verify RSA-PSS → transfer **Owner AND UpdateAuthority** to `claimant` atomically | `claim_ant_arweave_attested` | M2 / M3 / M4 |
| 3 | **ETH-token** | Ethereum EIP-191 + keccak256; v∈{0,1,27,28}; **low-S enforced**; `secp256k1_recover` == stored 20 bytes | ARIO token (liquid) | `buildEscrowClaimMessage` (`type: token`) | Verify ECDSA → dispense `amount` mARIO to `claimant`; case-free 20-byte recipient compare | `claim_tokens_ethereum` | M2 / M3 / M4 |
| 4 | **ETH-ANT** | Ethereum ECDSA (as #3) | ANT | `buildAntEscrowClaimMessage` | Verify ECDSA → transfer Owner+UA atomically to `claimant` | `claim_ant_ethereum` | M2 / M3 / M4 |
| 5 | **vault-active** (remaining ≥ min_vault_duration) | Arweave or Ethereum | Time-locked vault | `buildEscrowClaimMessage` (`type: vault`) | ADR-027 branch A: **re-lock** — treasury signs `ario_core::vaulted_transfer(amount, remaining, revocable=false, recipient=claimant)`; unlock lands at the original `vault_end_timestamp`. (In the current runner's ADR-022 state, an active-vault claim is instead **rejected** before unlock — see note.) | `claim_vault_*` | M2 / M4 |
| 6 | **vault-expired** (remaining ≤ 0) | Arweave or Ethereum | Time-locked vault | `buildEscrowClaimMessage` (`type: vault`) | ADR-027 branch C: **liquid** — dispense `amount` mARIO to `claimant`; asset terminates. Runner proves this after time-travel past `vault_end_timestamp`. | `claim_vault_arweave_attested` | M2 / M4 |

### Vault third branch (from the pivot plan, not separately seeded)

| # | Scenario | Expected behavior | Implemented in |
|---|----------|-------------------|----------------|
| 5b | **vault early-liquidity window** (0 < remaining < min_vault_duration) | ADR-027 branch B: **liquid** (BD-113's deliberate early-liquidity window, preserved) | M2 / M4 |

## Adjacent paths the runner also exercises (operator/admin plane)

| # | Scenario | Expected behavior | On-chain reference | Implemented in |
|---|----------|-------------------|--------------------|----------------|
| 7 | **cancel-vault** | Depositor/operator cancels an unclaimed vault deposit → assets + rent return to depositor; asset terminates | `cancel_vault_deposit` | M1 (ledger) / admin plane M3+ |
| 8 | **cancel-ant** | Operator cancels an unclaimed ANT deposit → ANT returns to depositor | `cancel_ant_deposit` | M1 / M3+ |

## Cross-cutting invariants (apply to every row above)

| Invariant | Source | Implemented in |
|-----------|--------|----------------|
| Canonical bytes byte-equal the on-chain Rust builders (incl. `network: solana-mainnet`, F-1 `recipient` field, 64-hex nonce, **no trailing newline**) | `canonical.cross.test.ts` (already green in M0) | M0 (lib) / M2 (wired) |
| Nonce must match current; rotates on recipient update; single-use via claim termination | Appendix A | M2/M3 |
| `claimant` bound inside signed bytes; anyone may submit, only the bound claimant receives | Appendix A | M2/M3 |
| Protocol guard: `proof.protocol == recipient.protocol` | Appendix A | M2 |
| Double-claim impossible under concurrency (DB `one_live_claim_per_asset` + `SELECT … FOR UPDATE`) | Plan §6.1 | M3 |
| Replayed proof → `ALREADY_CLAIMED`; stale nonce → `NONCE_MISMATCH` | Plan §4.1/§6.1 | M3 |
| 136 AT-RISK owners load `status = manual_review` — excluded from self-serve, operator-queue only | Non-negotiables / Plan §4.5 | M1 |
| Ledger totals reconcile bit-exact vs would-be on-chain asset_ids/amounts (2,269 ANTs · 5,374 tokens · 111 vaults · 2,957 stake rows; Σ ≈ 48.3M ARIO) | Plan §3.2 | M1 |
| Exactly-once dispatch: signature persisted before broadcast + status-scan crash recovery; `ar.io-claim:<id>` memo | Plan §4.3/§6.1 | M4 |

## M0 status

No claim logic exists yet. The only executable rows in M0 are the
canonical-parity invariant (`canonical.cross.test.ts`, green) and the
claims `/health` placeholder. Rows 1–8 are the acceptance targets for
M1–M4 and are listed here so the tester can track coverage as each
milestone lands.

## M1 status — ledger + reconciliation (this milestone)

The two M1 cross-cutting rows above are now **implemented and green** on the
real mainnet frozen inputs:

- **Bit-exact reconciliation** — `yarn workspace @ar.io/claims reconcile:ledger`
  reproduces every would-be on-chain deposit from the AUTHORITATIVE solana-ar-io
  code and diffs the built ledger: **10,711/10,711 tuples matched, PASS**
  (ant=2269 · token seed 8031 · vault seed 411; Σ 73,277,178.58 ARIO). Manifest
  phase counters reproduce the published gate exactly: **2,269 ANT · 5,374 token
  · 111 vault · 2,957 stake = 10,711**, phase-2 token outflow 48,264,957.23 ARIO.
- **AT-RISK = 136 manual_review** — the 136 owners with no recoverable key load
  as `recipients.status = manual_review` (182 of their assets flagged
  `assets.status = manual_review`), excluded from the reconciled/claimable
  (`available`) set.

Reconciliation independence is unit-tested (`reconcile.test.ts`: catches
amount / type / recipient / missing / extra divergence) and the derivation
primitives have golden-vector tests (`ant-mint.test.ts` proves the noble/kit
ANT-mint == web3.js `Keypair.fromSeed`; `asset-id.test.ts` pins the seed
formats incl. the ETH case-stability lesson). The schema migrates up/down;
`build.db.test.ts` round-trips the persisted ledger. Rows 7/8 (cancel-*) are
custody/admin-plane behaviors that land with the admin endpoints in M3+; M1
only builds the ledger they operate on.

## M3 status — claims API + replay/double-claim defense (this milestone)

The M3 cross-cutting rows above are now **implemented and green** against real
Postgres with the real mainnet ledger (built by `build:ledger`). Rows 1–4 have
their **API path** (initiate/complete/lookup) landed; the on-chain dispense
(Owner+UA transfer, SPL transfer, `vaulted_transfer`) is still M4.

- **Double-claim impossible under concurrency** — `service.db.test.ts` fires 8
  parallel completes: (a) 8 DIFFERENT valid claims for one asset → **exactly 1
  verified, 7 clean ALREADY_CLAIMED**; (b) 8 completes of the SAME claim → 8
  successes but **one dispatch intent / one `claim.verified` audit row**
  (idempotent). Enforced by `SELECT … FOR UPDATE` on the claim then the asset row
  + the `available→claiming→claimed` state machine, backstopped by
  `one_live_claim_per_asset`.
- **Replay / stale-nonce** — single-use challenge nonce bound into the canonical:
  replay after success → ALREADY_CLAIMED / idempotent; expired challenge → 409
  CHALLENGE_EXPIRED (asset not consumed); wrong echoed `nonceHex` → NONCE_MISMATCH;
  a proof for asset A rejected against asset B (canonical binding), B untouched.
- **Idempotency** — `idempotencyKey` (UNIQUE) + the claimId make retried
  initiate/complete return the same result with no second dispatch intent.
- **Rate limiting** — per-IP over all `/v1` + per-identity, fixed-window
  (`rate-limit.test.ts`; HTTP 429 proven via `app.inject`).
- **audit_log** — one row per transition with a real sha256 hash chain (M6 signs).
- **manual_review exclusion** (M1 row) re-proven at the API: `GET /v1/claimable`
  returns `available` only; a manual_review recipient → `assets:[]`; a
  manual_review asset → 404.
- Rows 7/8 (cancel-*) + AT-RISK attach-pubkey remain the **admin plane** (a later
  slice); M3 shipped the public claim plane.

Endpoint shapes, the locking strategy, and the replay/idempotency model are in
`SPEC.md` → "M3". Full suite: **claims 199** (28 new) + attestor 11 + canonical 49
unchanged.

## M4 — dispatch + custody (money movement)

Verified in `packages/claims/src/dispatch/*.test.ts` (34 unit + 15 DB) + the
LIVE surfpool proof `scripts/m4-localnet-proof.ts`. See `SPEC.md` → "M4".

| # | Scenario | Where proven | Expected |
|---|----------|--------------|----------|
| D1 | TOKEN dispense (SPL transfer to claimant ATA) | live surfpool + fake DB | asset `claimed`, on-chain balance == amount, ONE signature |
| D2 | VAULT-liquid (expired) dispense | live surfpool + fake DB | SPL transfer of amount; `settlement=liquid` |
| D3 | VAULT-relock (still locked, long remaining) | fake DB | routed to operator (never silently liquid); over-max throws |
| D4 | ANT Owner+UA atomic transfer | live surfpool (MPL Core) + fake DB | Owner AND UpdateAuthority == claimant on-chain |
| D5 | **Exactly-once: crash AFTER land, before finalize** | fake DB | recovery confirms; signCount stays 1 (no re-send) |
| D6 | **Exactly-once: crash BEFORE broadcast + blockhash expiry** | fake DB | re-sign; EXACTLY ONE tx lands |
| D7 | Idempotent re-run of a confirmed claim | live surfpool + fake DB | `already_confirmed`, balance unchanged |
| D8 | Two concurrent workers, one claim | fake DB | single dispatch (row-lock serialized) |
| D9 | >100k big-claim brake | live surfpool + fake DB | `routed_to_review`, NOT dispensed until approved |
| D10 | Insufficient float | fake DB | `deferred_refill`, claim stays queued, nothing signed |
| D11 | ANT operator-gated (never auto-hot) | live surfpool + fake DB | `awaiting_approval`; dispensed only after approve, via `ant` signer |
| D12 | Encrypted-at-rest hot key | unit | seal/open round-trips; wrong passphrase / tamper fail closed; seed never on disk |
| D13 | Pluggable signer | unit | EncryptedKeypairSigner default; KMS/Squads stubs conform; separable-role guard |
| D14 | Reconcile-after-dispatch | fake DB | dispatched==claimed; catches tamper / double-dispense / missing sig+audit |

Residuals: vault RE-LOCK not exercised live (needs deployed ario-core +
ArioConfig + vault ATA); SPL Memo disabled in the surfnet proof (datasource
wouldn't clone the Memo program; product default on, made optional so it never
blocks a dispense). Both detailed in `SPEC.md` → "M4 caveats".

## Note on ADR-022 vs ADR-027 (vault settlement)

`escrow-claim-runner.ts` currently reflects the **ADR-022** on-chain
state, where the active re-lock path was disabled and an active-vault
claim is *rejected* before unlock. The paused mainnet program has since
been upgraded to **ADR-027** (three-branch settlement: re-lock / liquid /
liquid), which is what the pivot plan Appendix A and the centralized
service must implement. Where the two disagree (row 5), the matrix targets
ADR-027 and flags the runner's older behavior — the M2 identity-proof and
M4 dispatch work must build against ADR-027 and the mainnet checkpoint,
using the runner's scenarios as structural (not bug-for-bug) references.
