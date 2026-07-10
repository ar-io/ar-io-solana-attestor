# Runbook 08 — Decommission (executable checklist)

Winds the service down at ~6 months (pivot plan §11). Unclaimed assets are **held,
not burned**; the on-chain escrow program stays as the fallback. This is an
executable checklist — tick each box.

> **Announce the unclaimed-asset policy NOW, not at T-0.** The on-chain design
> signaled long (5-year) claimability; a hard 6-month cutoff is a *policy
> regression* users must hear about repeatedly. Unclaimed ARIO/vault balances +
> ANTs return to the community/protocol treasury and are **held**, with late-claim
> support honored manually for a published grace period.

## T-30d — comms + final stats

- [ ] Publish an **in-app banner** + comms: final call, the exact close date, and
      the held-not-burned unclaimed-asset policy + grace period.
- [ ] Publish **final claim stats**: total claimed vs. outstanding, by asset type.
      Source of truth:
      ```bash
      yarn ops:metrics | jq '{claims: .claims.byStatus, liabilities: .liabilities, dispatch: .dispatch}'
      ```
- [ ] Publish a fresh signed ledger + anchor (runbook 06) so the pre-close state
      is externally fixed.

## T-0 — freeze the claim window

- [ ] **Freeze the API.** Set every remaining `available` asset to `frozen` so the
      API returns `CLAIM_WINDOW_CLOSED` + a support contact:
      ```sql
      -- production: run as the append-only-respecting admin path, or:
      UPDATE assets SET status='frozen', updated_at=now()
       WHERE status IN ('available','pending_review');   -- leave 'claimed'/'cancelled' alone
      ```
      (Prefer the admin `cancel`/freeze endpoints so each transition is
      **audit-logged** — do not bypass the audit log.)
- [ ] **Stop the dispatch worker** after the last in-flight `dispatching` claim
      resolves (let recovery finalize them first — `yarn reconcile:dispatch`
      should show no `dispatching` rows).
- [ ] Take `POST /v1/claims/*` out of rotation (keep lookups + transparency read
      endpoints up for verification).

## T-0 — sweep the hot float + ANTs back to cold

- [ ] **Sweep the hot float** to the cold authority/reserve: transfer the full
      treasury ATA balance to cold, signed by the treasury key (reverse of
      [runbook 03](03-hot-float-refill.md)). Verify the treasury ATA reads 0.
- [ ] **ANTs**: the unmapped ANTs never left the cold authority, so there is
      nothing to sweep. Confirm ownership is intact (spot-check on-chain / the
      reserves ANT count).
- [ ] Confirm the float is 0 and the cold reserve holds everything:
      `yarn ops:metrics | jq '.snapshot.float, .snapshot.reserves'`.

## Final reconciliation + accounting report

- [ ] **Reconcile**: `yarn reconcile:dispatch` → PASS (Σ dispatched == Σ claimed,
      no double-dispense, every confirmed claim has a tx signature).
- [ ] **Per-asset disposition**: for every asset, `claimed → tx sig` or
      `frozen/unclaimed`. Totals vs. the launch ledger must balance:
      ```sql
      SELECT status, count(*), COALESCE(SUM(amount),0) AS mario FROM assets GROUP BY status;
      ```
- [ ] **Publish the final report**: per-asset disposition + totals + the incident
      log (if any), **signed** (publisher key) and **anchored** to Arweave — the
      permanent record. Include the pinned publisher pubkey + the final anchor
      txid.
- [ ] Reserves ≥ residual liability at close (the held unclaimed set is now a cold
      liability, not a service one).

## Teardown

- [ ] **Do NOT tear down the on-chain escrow program.** It stays deployed as the
      fallback so late claimants can still be served on the trustless path from the
      frozen inputs (`batch-escrow.ts`). Keep the **attestor** running as long as
      any on-chain escrow remains claimable.
- [ ] **Retire the service keys**: revoke/retire the treasury, audit, and
      publisher keys (the ANT-cold/authority key follows the authority lifecycle,
      not this service). Post the **final audit-log anchor** first — after
      teardown you can no longer append.
- [ ] **Archive** the Postgres (PITR snapshot) + the manifests + the artifacts,
      **encrypted + cold**. The audit_log is the tamper-evident history — keep it.
- [ ] Post the post-mortem in `docs/`.

## Late claims (during the grace period)

Honored **manually**: the operator verifies the identity proof off the archived
ledger and either runs a one-off on-chain escrow deposit + claim for that
recipient (trustless), or a supervised manual delivery, per the announced policy.
This is why the escrow program + attestor stay up.
