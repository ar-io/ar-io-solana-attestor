# `ar-io-claims` — End-to-End Operations & Troubleshooting

The deep reference behind the `operate-ar-io-claims` skill. It covers standing the
service up, running it day-2, diagnosing and safely fixing anything that breaks,
incident response, and decommission. Every command, env var, status, alert, and
guard cited here is verified against `packages/claims/src` on branch
`feat/ar-io-claims`. Design detail lives in `packages/claims/SPEC.md`; the eight
tickable runbooks in `docs/claims/runbooks/`; the full env surface in
`packages/claims/.env.example`. Mainnet context:
`solana-ar-io/docs/MAINNET_ESCROW_CHECKPOINT_2026-07-09.md` and
`solana-ar-io/docs/CENTRALIZED_CLAIM_PIVOT_PLAN.md`.

> Run all `yarn` commands from `packages/claims`. Money is always integer `bigint`
> mARIO (1 ARIO = 1,000,000 mARIO). The service NEVER uses `@solana/web3.js`.

---

## 0. Facts you will need repeatedly

| Thing | Value |
|---|---|
| On-chain escrow (fallback, keep deployed) | `5HZhe9UqKL5zAsdz81nuuaxV41h8bFhudzxxBigAQndM` (`ario-ant-escrow`) |
| Attestor pubkey (mainnet, pinned in the `.so`, leave alone) | `7XtUnotZAeYZNzVSYV5nb7S9YH9qHXyVFM6NeNMu6efE` |
| Frozen inputs dir (`FROZEN_INPUTS_DIR`) | `/programs/ario-snapshot/output-mainnet-prod-remediation/` |
| Authority ATA (cold pool, ~80.07M ARIO) | `Cps8DpQipxMvaF4XXUvVAGxurCquPLpd72JjRST5JJcM` |
| AO process id (self-balance excluded) | `qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE` |
| Live SPL Memo program (`ANCHOR_MEMO_PROGRAM` default) | `Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo` |
| Dead memo program — must NEVER be used | `MemoSq4gq4qMz6H4dS7YEG2KDsF7hCkQqRr5dW5CtBc` |

Ledger totals (the `reconcile:ledger` oracle, `src/reconcile/reconcile.ts`
`EXPECTED_GATE` at `nowMs = 1783641600000`):

- Σ ledger = `73277178580427` mARIO (73.28M ARIO)
- phase-2 liquid token outflow `phase2TokenOutflowMario = 48264957232031` (~48.3M ARIO)
- `expectedVaultMario = 20629353000000`, `expectedStakeMario = 4382868348396`
- counts: ANTs `2269`, tokens `5374`, vaults `111`, stake `2957`, total `10711`,
  AT-RISK `136`; recipients 8347 (8136 frozen moduli + 136 AT-RISK + 75 ETH).
- Whale: recipient `-W8GMY…` ≈ 4.27M ARIO (auto-routes to `pending_review`).
- 136 AT-RISK ≈ 6.25M ARIO.

The five keys and their blast radius:

| Role | Held by | Compromise costs |
|---|---|---|
| `attestor` | attestor service (separate deploy, unchanged) | evidentiary only — claims re-verifies RSA-PSS itself |
| `treasury` (hot dispenser) | dispatch worker (sealed on host, KEK injected) | the float only (≤ 500k ARIO) |
| `ant-cold` (= existing migration authority) | operator, loaded per batch, discarded | the 2,269 ANTs |
| `audit` | anchor job (sealed) | can forge log sigs, not rewrite anchored history |
| `ledger-publisher` | publish + anchor jobs (sealed); also the anchor-memo fee-payer | can publish a bad ledger — caught by pinned-key verifiers |

Boot-config validation (`src/ops/config-validation.ts`, `assertBootConfig`, roles
`api`/`worker`/`ops`) fails FAST on: `NETWORK_INVALID`, `NETWORK_RPC_MISMATCH`,
`CORS_WILDCARD` (mainnet), `CONFIRM_RPC_POOLED` / `CONFIRM_RPC_MISSING` (worker),
`KEY_REUSE`, `MAINNET_BARE_SEED`, `DATABASE_URL_MISSING`, `ARIO_MINT_MISSING`,
`TREASURY_SIGNER_MISSING`.

---

## 1. Deploy / launch (the full ordered sequence)

Runbook: `01-deploy.md`, `02-key-ceremony.md`. Do **not** skip the staging rehearsal.

### 1.1 Merge the three PRs in order
1. **solana-ar-io #210 FIRST** — the non-behavioral `escrow-extract.ts` asset-id
   export the reconciler imports (`SOLANA_AR_IO_IMPORT_SRC`). Without it, the
   independent authoritative re-derivation drifts and `reconcile:ledger` FAILs.
2. **attestor #2** — this service.
3. **escrow-app #5** — the frontend F2 adapter (`VITE_CLAIMS_API_URL`); deposit pages
   stay gated off. Human browser + wallet UAT (Wander/ArConnect, MetaMask, Phantom)
   is a hard cutover gate.

### 1.2 Key ceremony (once, air-gapped, 4-eyes) — `02-key-ceremony.md`
The hot **treasury** key is the critical one. `encrypt:treasury-key` seals ANY
Ed25519 key (it reads `TREASURY_KEY_PASSPHRASE`, falling back to
`ANT_SIGNER_KEY_PASSPHRASE`); use it for treasury, and — if you want dedicated sealed
blobs — for ant-cold, audit, and ledger-publisher too.

```bash
# Treasury (hot dispenser). KEK from a secret manager, NOT stored with the blob.
TREASURY_KEY_PASSPHRASE='<strong-KEK>' \
  yarn encrypt:treasury-key --generate --out /secure/treasury.sealed.json
# prints only { ok, address } -> record as TREASURY_ADDRESS. Blob is mode 0600.
```

Repeat `--generate --out …` for `/secure/audit.sealed.json` and
`/secure/ledger-publisher.sealed.json`; record `AUDIT_PUBKEY_HEX` and
`LEDGER_PUBLISHER_PUBKEY_HEX` (32-byte hex). **ant-cold = the existing migration
authority** — no new key needed; supply it per-batch as `ANT_COLD_KEYPAIR_PATH`
(Solana keypair JSON) or a sealed blob. Leave the **attestor** key alone. All five
addresses MUST be distinct (boot `KEY_REUSE`). Re-key any sealed blob with
`--reseal <path>` + `TREASURY_KEY_PASSPHRASE_OLD`.

Verify the ceremony without moving money:
```bash
NETWORK=solana-mainnet CONFIRM_RPC_URL='<single-endpoint>' DATABASE_URL='…' ARIO_MINT='…' \
  TREASURY_KEY_SEALED_PATH=/secure/treasury.sealed.json TREASURY_KEY_PASSPHRASE='…' \
  TREASURY_ADDRESS='…' ANT_COLD_ADDRESS='…' AUDIT_PUBKEY_HEX='…' \
  LEDGER_PUBLISHER_PUBKEY_HEX='…' ATTESTOR_PUBKEY_BASE58='…' \
  yarn ops:metrics    # a KEY_REUSE / mismatch aborts here
```

### 1.3 Postgres + schema
Managed Postgres with PITR. The DB role holds `INSERT`+`SELECT` on `audit_log`
(append-only; no `DELETE`/`UPDATE` beyond signature back-fill). Then:
```bash
DATABASE_URL='…' yarn migrate:up
```

### 1.4 Build + reconcile the production ledger — the bit-exact gate
`build:ledger` writes `recipients` + `assets` from the frozen capture; the 136
AT-RISK owners load `status = manual_review`. `reconcile:ledger` independently
re-derives and diffs bit-exact. **Both CLIs read `FROZEN_INPUTS_DIR`,
`ANT_MINT_SECRET`, and `DATABASE_URL` — there is no `SNAPSHOT_DIR` argument** (the
frozen-capture dir is `FROZEN_INPUTS_DIR`).

```bash
FROZEN_INPUTS_DIR=/programs/ario-snapshot/output-mainnet-prod-remediation \
  ANT_MINT_SECRET='…' DATABASE_URL='…' yarn build:ledger

FROZEN_INPUTS_DIR=/programs/ario-snapshot/output-mainnet-prod-remediation \
  ANT_MINT_SECRET='…' RECONCILE_SOURCE=db DATABASE_URL='…' yarn reconcile:ledger
# exit 0 = PASS (bit-exact). exit 1 = FAIL — do NOT open claims. See §3.
```

`build:ledger` computes each frozen file's sha256 and asserts it equals the pinned
`KNOWN_GOOD_FINGERPRINTS` (MED-C); a divergence aborts. `reconcile:ledger` also
asserts the `EXPECTED_GATE` absolute mARIO pins.

### 1.5 Fund the hot dispenser
Move the initial float (default cap **500k ARIO** = `HOT_FLOAT_CAP_MARIO`
`500000000000`) from the cold authority ATA to the treasury ATA (ATA of
`TREASURY_ADDRESS` for `ARIO_MINT`), 4-eyes (runbook 03). Fund the dispenser SOL
(~15–20 SOL) for tx fees + idempotent-ATA-create rent. Do NOT overfund past cap
(`float-over-cap`). ANTs stay cold — never moved to the hot key.

### 1.6 Stand up API + worker + jobs
```bash
# API (role=api). LB health-checks GET /health/ready (503 when DB down); GET /health stays 200.
NETWORK=solana-mainnet DATABASE_URL='…' SOLANA_RPC_URL='…' \
  ARIO_MINT='…' TREASURY_ADDRESS='…' CORS_ORIGIN='https://claim.ar.io' \
  METRICS_AUTH_TOKEN='<bearer>' yarn start

# Dispatch worker — EXACTLY ONE instance (single-flight). role=worker.
NETWORK=solana-mainnet DATABASE_URL='…' CONFIRM_RPC_URL='<single consistent endpoint>' \
  ARIO_MINT='…' ARIO_CORE_PROGRAM='73YoECm6NKXpVRoe5f1Q9BcP5DJGPFUjnFy6AxBE5Nvh' \
  TREASURY_KEY_SEALED_PATH=/secure/treasury.sealed.json TREASURY_KEY_PASSPHRASE='…' \
  yarn dispatch:worker
```
`CORS_ORIGIN='*'` is refused on mainnet (`CORS_WILDCARD`). `METRICS_AUTH_TOKEN` is
required on a real network (else `/metrics*` return 403 `METRICS_FORBIDDEN`). The
worker boot reconciles `VAULT_MIN/MAX_DURATION_SECONDS` (defaults 14d/365d) against
the live on-chain `ArioConfig` and **aborts on mismatch** (`assertVaultDurationsMatchChain`);
disable with `VAULT_DURATION_RECONCILE=off` only for good reason.

### 1.7 Publish transparency + wire monitoring
```bash
LEDGER_PUBLISHER_KEY_SEALED_PATH=/secure/ledger-publisher.sealed.json \
  LEDGER_PUBLISHER_KEY_PASSPHRASE='…' DATABASE_URL='…' NETWORK=solana-mainnet \
  yarn publish:ledger --out ledger-artifact.$(date +%F).json --version $(date +%F)

AUDIT_KEY_SEALED_PATH=/secure/audit.sealed.json AUDIT_KEY_PASSPHRASE='…' \
  LEDGER_PUBLISHER_KEY_SEALED_PATH=/secure/ledger-publisher.sealed.json \
  LEDGER_PUBLISHER_KEY_PASSPHRASE='…' DATABASE_URL='…' NETWORK=solana-mainnet \
  SOLANA_RPC_URL='…' yarn anchor:audit-log
```
Upload the artifact JSON to Arweave/IPFS; announce the pinned publisher pubkey. Cron
`yarn ops:metrics` every 1–5 min (it **exits 2** on any critical alert → page) and
`yarn anchor:audit-log` daily. Keep the publisher key funded with a little SOL for
the memo tx.

### 1.8 Staging rehearsal (the gate — run twice green first)
```bash
NETWORK=solana-devnet SOLANA_RPC_URL='<devnet>' SOLANA_WS_URL='<wss>' \
  FUNDER_KEYPAIR='<funded devnet keypair>' DATABASE_URL='postgres://…/claims_rehearsal' \
  yarn rehearsal:staging
```

---

## 2. Day-2 operations

### 2.1 Hot-float refill / sweep — runbook 03
`float-low` = available < `FLOAT_REFILL_THRESHOLD_MARIO` (default cap/5 = 20% =
`100000000000`). `float-over-cap` = balance > cap.
```bash
yarn --silent ops:metrics | jq '.snapshot.float, {alerts: .alerts}'
# balanceMario / reservedMario / availableMario / capMario / refillNeeded / overCap
```
Refill = 4-eyes SPL transfer cold ATA → treasury ATA of `capMario − balanceMario`
(the service does NOT hold the cold key). Over-cap = sweep the excess back to cold
(signed by the treasury key). Never raise the cap to avoid refilling.

### 2.2 Big-claim (>100k) approval — runbook 04
`BIG_CLAIM_THRESHOLD_MARIO` default `100000000000` (100k ARIO; `0` is rejected at
boot — use `1` to route everything to review). A claim whose amount OR whose
recipient total exceeds it lands `pending_review` and is never auto-signed.
```bash
yarn --silent ops:metrics | jq '.snapshot.claims | {reviewQueueDepth, oldestReviewAgeSec}'
psql "$DATABASE_URL" -c "SELECT c.claim_id, c.claimant, a.asset_type, a.amount,
  r.protocol, r.source_address, c.verified_at FROM claims c
  JOIN assets a ON a.asset_key=c.asset_key JOIN recipients r ON r.recipient_id=c.recipient_id
  WHERE c.status='pending_review' AND c.approved_at IS NULL ORDER BY c.verified_at;"
```
A `pending_review` claim already passed identity verification — review is a
fraud/sanity/amount gate. Approve, then the worker dispatches next tick:
```bash
yarn dispatch:approve <claimId> --by '<operator>'
psql "$DATABASE_URL" -c "SELECT status, tx_signatures FROM claims WHERE claim_id='<claimId>';"
```
To reject, do NOT approve; escalate (there is no wired reject CLI — leave it
`pending_review` and record the decision out of band). Watch the outflow rate:
`jq '.snapshot.claims | {confirmedLastHour, confirmedLast24h}'`.

### 2.3 ANT cold-batch dispatch — runbook 05
ANTs are never dispensed from a hot key. Each ANT claim is approval-gated
(`ANT_REQUIRES_APPROVAL` default true), then waits `awaiting_ant_signer` until an
operator runs a batch with the cold authority loaded for just that run:
```bash
# find waiting ANTs
psql "$DATABASE_URL" -c "SELECT c.claim_id, a.ant_mint, c.claimant FROM claims c
  JOIN assets a ON a.asset_key=c.asset_key WHERE a.asset_type='ant'
  AND (c.status='dispatching' OR (c.status='pending_review' AND c.approved_at IS NOT NULL));"

# Option A — sealed cold blob:
ANT_COLD_KEY_SEALED_PATH=/secure/ant-cold.sealed.json ANT_COLD_KEY_PASSPHRASE='…' \
  DATABASE_URL='…' SOLANA_RPC_URL='…' CONFIRM_RPC_URL='<single>' ARIO_MINT='…' yarn dispatch:ants
# Option B — the migration authority's Solana keypair JSON:
ANT_COLD_KEYPAIR_PATH=/secure/authority-keypair.json \
  DATABASE_URL='…' SOLANA_RPC_URL='…' CONFIRM_RPC_URL='<single>' ARIO_MINT='…' yarn dispatch:ants
```
`dispatch:ants` calls `worker.runAntBatch(coldSigner)` — for each approved ANT it
signs `TransferV1` (Owner) + `UpdateV1` (UpdateAuthority) to the claimant in one tx
(ADR-013), confirms exactly-once, then the process exits and the cold key is gone
from memory. `runAntBatch` refuses a non-`ant` signer or one equal to the hot
dispenser. Exit 1 if any ANT dispatch outcome was `failed`.

### 2.4 AT-RISK (136) + locked-vault manual delivery
**AT-RISK owners** have no recoverable Arweave modulus → they load `manual_review`
and are hidden from self-serve (the API returns 404 `ASSET_NOT_FOUND`, byte-identical
to a nonexistent asset). Delivery is arranged out of band: the owner proves control
of their modulus/pubkey (signs a challenge), an operator verifies
`sha256(modulus) == address`, and then delivery proceeds.
> **Known gap:** there is **no admin `attach-pubkey` endpoint** — `src/api/routes.ts`
> exposes no admin routes at all (the pivot plan sketched a
> `POST /v1/admin/atrisk/{recipientId}/attach-pubkey`; it is unimplemented). Until
> one is built, an operator attaches the verified 512-byte `recipient_pubkey` and
> flips the asset from `manual_review` to `available` directly in the DB (append a
> compensating `audit_log` row), then the normal claim path opens (still subject to
> the >100k brake). This mutates the ledger outside `build:ledger`, so do it
> deliberately and re-check with `reconcile:dispatch` / `reconcile:ledger`. Do not
> shortcut the identity proof.

**Locked-vault manual delivery** — a still-locked vault settlement is routed to
`awaiting_manual_vault_delivery` (never auto-relocked via CPI, never looped in
review). List them and their absolute unlock dates:
```bash
yarn vault:manual-queue            # or --json
```
Each row's `deliverKind` is `relock` (hand-deliver a "transfer tokens locked" to the
absolute unlock == the escrow's original `vault_end_timestamp`) or deliver-UNLOCKED
(liquid) if the unlock has already passed. The `vault-manual-delivery-queue` warning
fires while any are queued.

### 2.5 Transparency cadence — runbook 06
Publish the signed ledger on every ledger change; anchor the audit-log head daily.
Both self-verify and the anchor job **refuses to anchor a broken chain**. Reserves:
`GET /v1/transparency/reserves` (or `jq '.snapshot.reserves'`) reports live holdings
vs liability; token/vault coverage is authoritative, ANT coverage under
`RESERVES_ANT_CHECK=sample` reports `"sampled-only"` (run a full `gpa` count weekly
on a dedicated RPC). Third parties verify pinned:
```bash
yarn verify:transparency artifact ledger-artifact.<date>.json --publisher <LEDGER_PUBLISHER_PUBKEY_HEX>
yarn verify:transparency audit --anchor-sig <txid> --anchor-address <publisher-addr> --rpc '<rpc>'
```

### 2.6 Metrics & alerts reference (`src/ops/alerts.ts`)
`yarn ops:metrics` prints `{ msg, alertLevel, alerts, snapshot }` (jq under
`.snapshot.*` and `.alerts`); the HTTP `/metrics.json` returns the snapshot flat
plus `alertLevel`+`alerts`; `/metrics` is Prometheus text. Exit 2 on critical.

| Alert | Severity | Means | Do |
|---|---|---|---|
| `reconciliation-mismatch` | critical | `dispatch.driftMario ≠ "0"` | freeze; §5, §3 |
| `reserves-shortfall` | critical | `!reserves.tokenVaultCovered` | top up from cold; runbook 03 |
| `dispatch-needs-operator` | critical | a claim hit the re-sign cap | §3.1 — verify on-chain first |
| `dispatch-failure` | critical | ≥1 terminal `failed` | inspect + re-drive; §3.4 |
| `float-low` / `float-over-cap` | warning | available < refill / balance > cap | runbook 03 |
| `big-claim-queue-growing` / `-sla-breach` | warning | queue ≥ `ALERT_REVIEW_QUEUE_WARN` (25) / oldest > SLA (24h) | runbook 04 |
| `dispatch-stalled` | warning | a `dispatching` claim > `ALERT_DISPATCH_STALL_SECONDS` (600s) | §3.2 |
| `anchor-failure` / `anchor-unconfirmed` | warning | last anchor > 2× cadence / unconfirmed | runbook 06 |
| `audit-unsigned-backlog` | warning | unsigned `audit_log` rows | re-run anchor job (back-fills) |
| `vault-manual-delivery-queue` | warning | locked vaults awaiting hand-delivery | §2.4 |

---

## 3. Troubleshooting / diagnose-and-fix playbook

First two commands for almost everything:
`yarn --silent ops:metrics | jq '{alertLevel, alerts}'` and `yarn reconcile:dispatch`.

### 3.1 Claim stuck `needs_operator` (the HIGH-A re-sign hard-cap freeze)
**Symptom:** critical `dispatch-needs-operator`; `claims.byStatus.needs_operator > 0`;
`error` on the row says "re-sign cap exceeded".
**Root cause:** the worker classified the persisted tx `expired` twice with no landed
outflow. `MAX_RESIGN_ATTEMPTS = 1`, so after one provably-dead re-sign it froze the
claim instead of sending again. **This is almost always a pooled/lagging
`CONFIRM_RPC_URL` misreporting a LANDED tx as not-found** — not a real non-delivery.
**Diagnose — did the transfer actually land?**
```bash
psql "$DATABASE_URL" -c "SELECT claim_id, claimant, status, dispatch_signature,
  tx_signatures FROM claims WHERE claim_id='<claimId>';"
```
Check every signature in `tx_signatures` on chain, and scan the dispenser +
claimant outflows for a confirmed tx carrying the memo `ar.io-claim:<claimId>` (the
worker's own `findConfirmedOutflow` matches by your recorded signature — decoy-proof).
- **It landed** → mark the claim confirmed and the asset claimed (the worker does this
  itself if you fix the confirm-RPC and re-drive; or do it via a compensating,
  audit-logged DB transition). Do NOT send another transfer.
- **It did NOT land** → fix `CONFIRM_RPC_URL` to a single consistent endpoint FIRST,
  then reset the claim to `verified` (clear `dispatch_signature`) so the worker
  re-dispatches once. `dispatch_resign_count` stays as the safety ceiling.
**Never** bypass the cap or loop the worker on a claim while the confirm-RPC is
pooled — that is exactly the double-send this guard prevents.

### 3.2 Dispatch stalled / claims stuck `dispatching` or `claiming`
**Symptom:** `dispatch-stalled`; `oldestDispatchingAgeSec` climbing; nothing confirms.
**Root cause:** the single worker is down, OR the confirm-RPC is lagging so
signatures never resolve.
**Fix:** confirm exactly ONE `dispatch:worker` is running and `CONFIRM_RPC_URL` is a
single healthy endpoint. On restart, recovery re-checks each persisted signature via
`confirmSignature` (confirmed → finalize; failed → `failed`; provably-dead → re-sign
once; still-pending+valid → wait). No resend happens unless a tx is provably dead.
Stale `claiming` challenges (challenge TTL passed, default 15 min
`CLAIM_CHALLENGE_TTL_MS`) are swept by `yarn reap:challenges` → `expired` (the asset
is NOT consumed).

### 3.3 `reconciliation-mismatch` (suspected double-dispense)
**Symptom:** critical `reconciliation-mismatch` (drift ≠ 0), or a manual report.
**Diagnose:**
```bash
yarn reconcile:dispatch   # prints e.g. "asset <k> has N confirmed claims (double-dispense!)"
```
Cross-check on chain: every dispense tx carries an `ar.io-claim:<claim_id>` memo.
**Root cause:** the layered guards (per-asset `FOR UPDATE`, `one_live_claim_per_asset`
index, persist-sig-before-broadcast, re-sign-only-after-provably-dead) make a genuine
double-send almost always a **pooled `CONFIRM_RPC_URL`**.
**Fix:** freeze (§5), fix the confirm-RPC, record the over-dispensed value as a float
loss, top up from cold, append a compensating `audit_log` entry, then un-freeze.

### 3.4 `dispatch-failure` (terminal `failed`)
**Symptom:** critical `dispatch-failure`; a claim is `failed`, asset still `claiming`.
**Root cause:** the on-chain tx failed (e.g. deterministic error). Never auto-retried.
**Fix:** inspect the signature on an explorer, fix the underlying cause (bad ATA,
insufficient SOL, program error), then re-drive deliberately (reset to `verified`).

### 3.5 `reserves-shortfall`
Holdings < outstanding liability. Top up the hot float from cold so
`tokenVaultCovered` is true again; if you cannot cover, freeze the API. If ANT
coverage looks off, run a full `RESERVES_ANT_CHECK=gpa` count — `sample` never
asserts `true`.

### 3.6 `float-low` / `float-over-cap` / deferred dispatches
A token/vault dispatch that would exceed available float leaves the claim queued
(`deferred_refill`, NOT failed) and raises refill-needed. Refill from cold
(runbook 03). Over-cap → sweep to cold.

### 3.7 Ledger-build fingerprint mismatch (MED-C)
**Symptom:** `build:ledger` / `reconcile:ledger` throws
"frozen-input fingerprint assertion FAILED".
**Root cause:** a byte of a frozen input changed (or the pinned set is stale). The
error lists the offending file (changed hash / missing pin / unexpected extra file).
**Fix:** INVESTIGATE which frozen file diverged and why **before** doing anything. A
legitimate re-freeze is the ONLY reason to update `KNOWN_GOOD_FINGERPRINTS` in
`src/ledger/inputs.ts`: regenerate with a one-off load and copy `inputs.fingerprints`
verbatim. `ALLOW_UNPINNED_FROZEN_INPUTS=1` bypasses the gate (loud stderr) — use ONLY
for that deliberate re-freeze, NEVER on the production claim path.

### 3.8 `reconcile:ledger` FAIL (incl. the #210-not-merged / ETH-casing case)
**Symptom:** exit 1 with an `amount_mismatch` / count diff.
**Root cause:** the two derivations disagree. Most common: **solana-ar-io #210 not
merged / a stale `escrow-extract.ts`** so `SOLANA_AR_IO_IMPORT_SRC` re-derives
different asset-ids (the ETH-casing seed-normalization bug changed 4 asset-ids), or a
real tamper the `EXPECTED_GATE` mARIO pins caught.
**Fix:** merge/point at the correct export, rebuild the ledger, re-reconcile.
**Never** relax the diff, the fingerprint gate, or the mARIO pins to force a PASS.

### 3.9 Confirm-RPC problems / the single-consistent-RPC requirement
Exactly-once rests on `confirmSignature` seeing a consistent view. A pooled URL is
refused at worker boot (`CONFIRM_RPC_POOLED`; heuristic `looksPooled` matches commas
or `lb`/`pool`/`round-robin`). If a provider silently load-balances behind one URL,
symptoms are §3.1/§3.2/§3.3. Fix: a single endpoint (or a read quorum) as
`CONFIRM_RPC_URL`; never a comma-list or LB hostname.

### 3.10 A claim wrongly rejected (vs a normal bad proof)
A single 401 (`RSA_SIGNATURE_INVALID` / `SIGNATURE_VERIFICATION_FAILED` /
`ETHEREUM_ADDRESS_MISMATCH`) or 422 (`PROTOCOL_MISMATCH`, `ECDSA_HIGH_S`,
`RECIPIENT_ID_MISMATCH`, `LOCK_DURATION_TOO_LONG`, …) is a **bad proof — expected**,
and the asset is untouched. A **systematic** failure (every proof of one protocol
failing, or a known-good golden vector failing) is a verification bug: the oracle is
`src/verify/arweave.golden.json` / `ethereum.golden.json` /
`ethereum.contract.golden.json`. If those go red, it is a code fix (§4), not an
operational one. A `manual_review` asset returning 404 is by design (AT-RISK hidden).

### 3.11 Wallet-extension signature-shape issue in the frontend
The canonical bytes are **server-built** and returned by `POST /v1/claims/initiate`
(`canonicalMessageHex` / `canonicalMessageBase64` + `nonceHex`). The wallet must sign
exactly those bytes; the API rebuilds the canonical from the ledger and never trusts
client-supplied message bytes. Arweave proof = 512-byte RSA-PSS signature
(base64url), optional modulus + `saltLength` (default 32); Ethereum = 65-byte
`signatureHex` (EIP-191, low-S enforced). A `complete` 202 means a valid proof was
presented — it is NOT caller-authentication; dispensing always goes to the claimant
bound inside the canonical. If a wallet emits a different signature encoding, fix it
in the escrow-app adapter, not by loosening verification.

### 3.12 Transparency verify failing for a third party
`verify:transparency` **refuses to print PASS unless pinned** (`--publisher <hex>`
for a ledger artifact; `--anchor-sig` + `--anchor-address` read the memo back from
chain for audit). An "unpinned → FAIL" is the tool working. Confirm the third party
pinned the ANNOUNCED publisher pubkey and the original anchor txid, not values from
the operator DB.

---

## 4. How to safely make a CODE fix on this system

This service moves ~48M ARIO + 2,269 NFTs. Treat every change to the money path as
high-risk.

1. **Classify first. Behavioral change → STOP and ask the human.** Behavioral =
   anything that alters amounts, who can claim, a status transition, a security gate,
   the canonical message, or the reconcile/fingerprint math. Only proceed unattended
   on non-behavioral refactors (typing, logging, tests, docs).
2. **Dev → test loop.** Work on `feat/ar-io-claims`. `yarn typecheck` +
   `yarn typecheck:tests`, then the full suite: `yarn test` (runs every
   `src/**/*.test.ts`).
3. **Re-run the money-path gates — ALL must stay green:**
   - the bit-exact ledger gate: `reconcile:ledger` (exit 0);
   - the exactly-once / double-send DB suites:
     `src/dispatch/worker.resign-guard.db.test.ts`,
     `src/dispatch/worker.adversarial.db.test.ts`,
     `src/dispatch/worker.db.test.ts`,
     `src/dispatch/chain.toctou.adversarial.test.ts`,
     `src/api/service.adversarial.db.test.ts`;
   - the canonical golden vectors: `src/verify/*.golden.json` +
     `src/verify/ethereum.contract-parity.test.ts`;
   - the transparency adversarial UAT: `src/transparency/adversarial.uat.test.ts`;
   - `reconcile:dispatch` on any exercised data (drift 0, no double-dispense).
4. **Never weaken a guard to make a test pass.** The guard IS the product: MED-C
   fingerprints, `EXPECTED_GATE` pins, `MAX_RESIGN_ATTEMPTS`, the two-lock +
   `one_live_claim_per_asset` index, `assertSeparableRoles`, `assertBootConfig`,
   `assertVaultDurationsMatchChain`, the pinned-key transparency verifiers.
5. **Re-verify the invariants** (skill §Invariants) hold after the change, and prove
   it end-to-end via `yarn rehearsal:staging` on devnet before any mainnet touch.
6. Commit with a descriptive mechanism-based message (no "option B / v3-plan"
   jargon). Never commit secrets or `.env`.

---

## 5. Incident response / freeze — runbook 07

**First move for any suspected fund-safety incident: FREEZE + PAGE.**

**Freeze (universal):** (1) stop the dispatch worker — the only process that moves
money; in-flight `dispatching` rows recover exactly-once on restart. (2) Take
`POST /v1/claims/*` out of rotation (LB off, or scale API to zero) — lookups +
transparency stay up. (3) Announce a maintenance window.

- **Suspected double-dispatch:** §3.3. Freeze → `reconcile:dispatch` → cross-check
  memos → root-cause the confirm-RPC → top up from cold → compensating audit entry.
- **Treasury (hot) key compromise:** worst case is the float (bounded by cap). Freeze
  → sweep the treasury ATA to cold immediately (race the attacker) → rotate: mint a
  new sealed treasury key, update `TREASURY_*` + `TREASURY_ADDRESS`, redeploy →
  reconcile + publish a fresh ledger.
- **ANT-cold / migration authority compromise:** highest value (2,269 ANTs + the cold
  pool). Follow the authority incident path (ADR-026 / Squads): freeze, move assets to
  a fresh authority / Squads vault. The service holds no persistent ANT key.
- **Audit / publisher key compromise:** can forge log sigs / publish a bad ledger but
  cannot rewrite anchored history. Rotate, re-anchor + re-publish under the new pinned
  key, announce the new pubkey.
- **RPC outage / confirm-RPC breaking exactly-once:** freeze the worker (do NOT let it
  classify `expired` off an inconsistent view) → point `CONFIRM_RPC_URL` at a single
  healthy endpoint (boot must pass, no `CONFIRM_RPC_POOLED`) → restart; recovery
  re-checks every `dispatching` sig. If a sig can't be resolved, investigate it on an
  explorer and finalize/fail it deliberately — never force it.
- **Anchor failure:** check the publisher key is SOL-funded and the RPC is up; run
  `yarn anchor:audit-log`. If it refuses ("audit chain invalid at seq …"), the
  append-only invariant was violated — STOP, investigate the DB, append a compensating
  entry, re-anchor; treat as a security issue (do not delete rows).

**The on-chain escrow is always the escape hatch.** `5HZhe9…` stays deployed; late or
edge claimants can be served on-chain (`batch-escrow.ts` from the frozen inputs). The
one pre-existing user 50-ARIO `EscrowToken` is claimable ONLY there — the centralized
ledger does not contain it.

After any incident: `reconcile:dispatch` clean, reserves ≥ liabilities, publish a
fresh signed ledger + anchor, write a post-mortem under `docs/`.

---

## 6. Decommission (~6 months) — runbook 08

Unclaimed assets are **held, not burned**; the on-chain escrow + attestor stay up.

**T-30d:** announce the close date + held-not-burned policy + a published grace
period (in-app banner + comms). Publish final stats and a fresh signed+anchored
ledger:
```bash
yarn --silent ops:metrics | jq '{claims:.snapshot.claims.byStatus, liabilities:.snapshot.liabilities, dispatch:.snapshot.dispatch}'
```

**T-0 — freeze the window:**
- Take `POST /v1/claims/*` out of rotation (keep lookups + transparency up).
- Stop the worker after the last in-flight `dispatching` resolves
  (`yarn reconcile:dispatch` shows no `dispatching` rows).
- Set remaining `available`/`pending_review` assets to `frozen`. Prefer an
  audit-logged admin transition; the runbook's raw SQL is the fallback:
  ```sql
  UPDATE assets SET status='frozen', updated_at=now()
   WHERE status IN ('available','pending_review');  -- leave 'claimed'/'cancelled' alone
  ```
  > **Code fact:** a `frozen` asset makes the API return **409 `ASSET_FROZEN`**
  > (`src/api/service.ts`); there is no `CLAIM_WINDOW_CLOSED` code in the current
  > build. If you want a distinct `CLAIM_WINDOW_CLOSED` response, that is a code
  > change (add the status→code mapping), not just a status flip.

**T-0 — sweep to cold:** transfer the full treasury ATA balance to cold (signed by
the treasury key); verify it reads 0. ANTs never left cold — confirm ownership.
`jq '.snapshot.float, .snapshot.reserves'` should show float 0 and cold holding
everything.

**Final report + teardown:** `reconcile:dispatch` PASS; per-asset disposition
(`SELECT status, count(*), COALESCE(SUM(amount),0) FROM assets GROUP BY status;`);
publish a final signed + Arweave-anchored report (pinned publisher pubkey + final
anchor txid); reserves ≥ residual liability at close. Reclaim SOL: the on-chain
escrow's rent is refundable to the depositor on claim/`cancel_*` — reclaim it and the
dispenser SOL **later, after the claim window** (the escrow program is NOT torn down
while anything is claimable there). Retire the treasury, audit, and publisher keys
**after** the final anchor (ant-cold/authority follows its own lifecycle → Squads per
ADR-026). Archive Postgres (PITR) + manifests, encrypted + cold; keep `audit_log`.
Late claims during the grace period are honored manually (identity proof off the
archived ledger → on-chain escrow deposit + claim, or supervised delivery).
