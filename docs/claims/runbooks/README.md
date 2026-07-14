# ar-io-claims — Operator Runbooks

Operational runbooks for the centralized claim-dispenser service (Option B,
`packages/claims`). These are written so an on-call operator who has **not** read
the source can run the service safely. Read the [pivot plan](../../../../solana-ar-io/docs/CENTRALIZED_CLAIM_PIVOT_PLAN.md)
§4–§6 for the design; these runbooks are the *procedures*.

> **Golden rule of this service:** it dispenses **other people's assets** from a
> hot key on identity proof. Every runbook below exists to bound the blast radius
> of a bug, a compromise, or an operator mistake. When in doubt, **freeze the
> claim API and page** — a paused claim window is recoverable; a double-dispense
> or a drained hot key is not.

## Index

| # | Runbook | When |
|---|---|---|
| [01](01-deploy.md) | **Deploy** | standing the service up (staging then mainnet) |
| [02](02-key-ceremony.md) | **Key ceremony** | before deploy — mint the 5 distinct keys, sealed at rest |
| [03](03-hot-float-refill.md) | **Hot-float refill** | `float-low` alert — top up hot from cold |
| [04](04-big-claim-approval.md) | **Big-claim approval (>100k)** | `big-claim-queue-growing` — approve/reject the review queue |
| [05](05-ant-cold-batch-dispatch.md) | **ANT cold-batch dispatch** | approved ANT claims awaiting the cold authority |
| [06](06-transparency-cadence.md) | **Ledger-publish + audit-anchor cadence** | daily/on-change; keeps the service auditable |
| [07](07-incident-response.md) | **Incident response** | double-dispatch, key compromise, RPC-pool outage, anchor failure |
| [08](08-decommission.md) | **Decommission** (T-30d → teardown) | winding the service down at ~6 months |

## The append-only `audit_log` production invariant

**In production the `audit_log` table is APPEND-ONLY. Nothing ever deletes or
updates a row (except the one-time signature back-fill, which only fills a
previously-empty `signature`).** The tamper-evidence of the whole transparency
layer depends on it:

- every state transition appends a row whose `entry_hash = sha256(prev_hash ‖
  canonical_json(entry))` — a hash chain;
- the chain HEAD is anchored on-chain (Solana memo) on a cadence (runbook 06);
- a third party recomputes the chain and checks it still reproduces each anchored
  hash (`checkExtendsAnchor`). **A single deleted or edited row breaks the chain
  at that seq and every anchor after it — the service can no longer prove it
  didn't rewrite history.**

Enforce it operationally:

- The DB role the service connects with **must not** hold `DELETE`/`UPDATE` on
  `audit_log` beyond the signature back-fill. Grant `INSERT` + `SELECT`; run the
  back-fill (`signUnsignedAuditRows`) as a step of the anchor job, which only sets
  a NULL/empty signature.
- Never run test/cleanup scripts against the production DB (the dev DB's audit
  log has deletion gaps from test teardown — that is expected in dev, forbidden
  in prod).
- Back up with PITR; the anchor cadence is the external tamper-evidence.

If you ever must correct data, **append a compensating entry** — never edit
history.

## Observability & alerting

The service emits metrics + alerts via the existing pino stack. Three surfaces:

- **`GET /metrics`** — Prometheus text exposition (scrape from the ops network /
  behind the reverse proxy; it is not under `/v1` so it is **not** rate-limited).
- **`GET /metrics.json`** — the full JSON snapshot + firing `alerts[]` +
  `alertLevel` (`ok`/`warning`/`critical`).
- **`yarn ops:metrics`** — one-shot CLI: prints the snapshot + alerts as
  structured JSON and **exits non-zero (2) on any `critical` alert** (wire it to
  a cron / monitoring hook to page). `--prometheus` prints the exposition text.
- The **dispatch worker** also evaluates + logs firing alerts every tick.

### Metrics collected

dispatch success/failure/in-flight counts; hot-float balance/available/cap; the
reconciliation drift (`Σ dispatched − Σ claimed`, must be 0); reserves coverage
(holdings ≥ liabilities); claim rate (confirmed last hour / 24h, created last
hour); error rates (rejected/failed); anchor status (age of the last audit-head
anchor); the >100k / ANT operator review queue depth + oldest-item age; audit-log
head seq + unsigned-row backlog.

### Alert conditions (→ the runbook that handles each)

| Alert | Severity | Handle with |
|---|---|---|
| `reconciliation-mismatch` (drift ≠ 0) | **critical** | [07 incident](07-incident-response.md) — freeze + investigate |
| `reserves-shortfall` (holdings < liabilities) | **critical** | [03 refill](03-hot-float-refill.md) / [07](07-incident-response.md) |
| `dispatch-failure` (a claim is terminal `failed`) | **critical** | [07 incident](07-incident-response.md) |
| `float-low` (available < refill threshold) | warning | [03 hot-float refill](03-hot-float-refill.md) |
| `float-over-cap` (hot balance > cap) | warning | [03](03-hot-float-refill.md) — sweep excess to cold |
| `big-claim-queue-growing` / `-sla-breach` | warning | [04 big-claim approval](04-big-claim-approval.md) |
| `dispatch-stalled` (claim `dispatching` too long) | warning | [07](07-incident-response.md) — check worker + CONFIRM_RPC |
| `anchor-failure` / `anchor-unconfirmed` | warning | [06 transparency cadence](06-transparency-cadence.md) |
| `audit-unsigned-backlog` | warning | [06](06-transparency-cadence.md) — run the anchor job |

Thresholds are env-tunable: `ALERT_REVIEW_QUEUE_WARN`, `ALERT_REVIEW_SLA_SECONDS`,
`ALERT_DISPATCH_STALL_SECONDS`, `ALERT_ANCHOR_CADENCE_SECONDS`,
`ALERT_DISPATCH_FAILURE_CRITICAL`.

## Boot-time config validation (fails fast)

Both the API (`role: api`) and the dispatch worker (`role: worker`) run
`assertBootConfig` before taking traffic / moving money. It **aborts the boot**
on any of the documented misconfigs, so a bad deploy never silently runs:

- a **pooled / load-balanced `CONFIRM_RPC_URL`** (worker) — breaks exactly-once
  and can double-send;
- any two of the **five distinct keys** (attestor / treasury / ANT-cold / audit /
  ledger-publisher) sharing an address;
- **`NETWORK` inconsistent with the RPC host** (mainnet NETWORK on a devnet RPC,
  or vice-versa);
- a **bare `*_SEED_BASE64`** on `NETWORK=solana-mainnet` (keys must be sealed);
- missing `ARIO_MINT` / treasury signer (worker); missing explicit `DATABASE_URL`
  off localnet.

See [`.env.example`](../../../packages/claims/.env.example) for the full env list.
