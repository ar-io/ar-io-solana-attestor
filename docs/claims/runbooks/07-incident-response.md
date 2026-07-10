# Runbook 07 — Incident response

**First move for any suspected fund-safety incident: FREEZE the claim API and
PAGE.** A paused claim window is recoverable; a double-dispense or a drained hot
key is not. Freezing does not touch custody — it just stops new dispenses.

## Freeze (the universal first step)

Stop new claims from being verified/dispensed while you investigate:

1. **Stop the dispatch worker** (the only process that moves money). No worker =
   no dispense. In-flight `dispatching` rows are safe — they recover exactly-once
   when the worker restarts.
2. **Take the claim API out of rotation** (LB off `/v1/claims/*`, or scale the API
   to zero). Lookups can stay up; it's `complete` + dispatch you must stop.
3. Announce a brief maintenance window.

Un-freeze only after the incident is understood and closed.

---

## Suspected double-dispatch (an asset dispensed twice)

**Symptom:** `reconciliation-mismatch` (critical), or a manual report.

1. **Freeze** (above).
2. **Confirm with reconcile** — it is the backstop that flags exactly this:
   ```bash
   yarn reconcile:dispatch        # flags: "asset <k> has N confirmed claims (double-dispense!)"
   ```
   and cross-check on-chain: every dispense tx carries an `ar.io-claim:<claim_id>`
   memo, so you can attribute each treasury outflow to a claim and find the two
   that map to one asset.
3. **Root-cause.** The design makes this near-impossible (per-asset `FOR UPDATE`
   lock + `one_live_claim_per_asset` index + persist-sig-before-broadcast +
   re-sign-only-after-provably-dead). A real double-send almost always means the
   **CONFIRM RPC was a pool** and a lagging replica misclassified a landed tx as
   dead → re-sign. Verify `CONFIRM_RPC_URL` is a single consistent endpoint (boot-
   validation should have caught a pooled URL — check it wasn't bypassed).
4. **Remediate.** The over-dispensed value is a loss to the float; record it, top
   up from cold if needed to keep reserves ≥ liabilities, and fix the RPC config
   before un-freezing. Append a compensating audit entry (never edit history).

## Key compromise

### Treasury (hot) key
Worst case = the **float + any in-flight** (bounded by the cap). Act fast:
1. **Freeze.** Stop the worker so the compromised key isn't used further.
2. **Sweep** the treasury ATA to cold immediately (any funded signer can send;
   but you need the key — if the attacker also has it, race them: send the balance
   to cold first).
3. **Rotate** ([runbook 02 §rotation](02-key-ceremony.md#rotation)): mint a new
   sealed treasury key, update `TREASURY_*` + `TREASURY_ADDRESS`, redeploy.
4. Reconcile + publish a fresh ledger; note the incident in the final report.

### ANT-cold / migration authority key
Highest-value (the 2,269 ANTs + the cold pool). This is the migration authority —
follow the **authority incident** path (ADR-026 / Squads), not just this service:
freeze, move assets to a fresh authority / Squads vault, and treat every ANT as
potentially at-risk until re-secured. The service holds **no** persistent ANT key,
so a service-box compromise does **not** expose it.

### Audit / publisher key
Can forge log signatures / publish a bad ledger, but **cannot rewrite anchored
history**. Rotate the key, re-anchor + re-publish under the new pinned key, and
**announce the new pinned pubkey**. Old anchors remain valid under the old key.

### API box (no KMS/KEK grant)
DoS + read of public-ish ledger data; **cannot move funds** (the KEK is injected
separately; the box can't decrypt the sealed keys). Rebuild the box, rotate the
KEK out of caution.

## RPC-pool outage / confirm-RPC breaking exactly-once

**Symptom:** `dispatch-stalled` (claims stuck `dispatching`), confirm errors, or —
worst — a suspected double-send.

Exactly-once **relies on a single consistent confirm endpoint**. If the confirm
RPC is a pool or is flapping:
1. **Freeze the worker.** Do NOT let it keep classifying `expired` off an
   inconsistent view — that is the double-send path.
2. Point `CONFIRM_RPC_URL` at a **single healthy endpoint** (or a read quorum).
   Boot-validation must pass (no `CONFIRM_RPC_POOLED`).
3. Restart the worker. Recovery re-checks every `dispatching` sig via
   `getSignatureStatuses` on the now-consistent endpoint: confirmed → finalize;
   provably-dead → re-sign; still-pending → wait. No double-send.
4. If a `dispatching` claim can't be resolved (endpoint can't tell you if it
   landed), **do not force it** — leave it, investigate the specific signature on
   an explorer, and finalize/fail it deliberately.

## Anchor failure

**Symptom:** `anchor-failure` / `anchor-unconfirmed` / `audit-unsigned-backlog`.

Not a fund-safety incident, but it erodes tamper-evidence — fix promptly:
1. Check the anchor key is **funded** (the memo tx needs SOL) and the RPC is up.
2. Run `yarn anchor:audit-log`. If it **refuses** (`audit chain invalid at seq
   …`), the append-only invariant was violated — **stop and investigate the DB**
   (a deleted/edited audit row). Do not "fix" by deleting more; append a
   compensating entry and re-anchor from a clean point, and treat the root cause
   (whatever wrote to `audit_log`) as a security issue.
3. Confirm the new anchor with the pinned-signer verifier (runbook 06 §2).

## Big-claim queue growing / anomalous volume

`big-claim-queue-growing` or a spike in `confirmedLastHour`: this may be organic
(a marketing push) or an attack probing verification. Work the queue
([runbook 04](04-big-claim-approval.md)); if volume looks anomalous, **freeze**
and review before approving more. The per-claim brake + the manual queue are the
throttle — use them.

## After any incident

- Reconcile clean (`yarn reconcile:dispatch`), confirm reserves ≥ liabilities.
- Publish a fresh signed ledger + anchor; the anchor is the external record that
  history wasn't rewritten during the incident.
- Write a post-mortem in `docs/`; if funds were lost, record the amount + the
  compensating action.
- **The on-chain escrow is always the escape hatch:** if the service can't be made
  safe, freeze it and resume the trustless on-chain path from the frozen inputs
  (`batch-escrow.ts`). It stays deployed for exactly this reason.
