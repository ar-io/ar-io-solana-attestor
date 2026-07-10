# Runbook 04 — Big-claim approval (>100k)

**Trigger:** `big-claim-queue-growing` / `big-claim-queue-sla-breach` alerts, or a
routine sweep of the review queue.

Claims over the brake (default **100k ARIO**, `BIG_CLAIM_THRESHOLD_MARIO`) — or for
any recipient whose *total* entitlement exceeds it (e.g. the 4.27M `-W8GMY…`
whale) — are **not** auto-dispensed. `completeClaim` routes them to
`pending_review`; the worker never signs them until an operator approves. This
caps the damage of any verification bug or attestor-path issue at
`threshold × review-latency`. The **136 AT-RISK owners** are a separate,
operator-only path (they never self-serve; see §AT-RISK).

## Work the queue

```bash
# Depth + oldest age (published SLA default 24h):
yarn --silent ops:metrics | jq '.snapshot.claims | {reviewQueueDepth, oldestReviewAgeSec}'

# The pending_review claims (identity, asset, amount, verified proof already on file):
psql "$DATABASE_URL" -c "
  SELECT c.claim_id, c.claimant, a.asset_type, a.amount, r.protocol, r.source_address,
         c.verified_at
    FROM claims c JOIN assets a ON a.asset_key=c.asset_key
    JOIN recipients r ON r.recipient_id=c.recipient_id
   WHERE c.status='pending_review' AND c.approved_at IS NULL
   ORDER BY c.verified_at;"
```

A `pending_review` claim has **already passed identity verification** (the RSA-PSS
/ ECDSA proof is on file and was checked). The review is a **fraud / sanity /
amount** gate, not a re-verification. Confirm:

- the amount + recipient match the frozen ledger entitlement (cross-check against
  the published ledger / `escrow-recipient-modulus.json` provenance);
- nothing anomalous (a burst from one identity, a mismatch vs the snapshot);
- for very large claims, any additional off-chain / legal / sanctions checks your
  policy requires.

## Approve

```bash
yarn dispatch:approve <claimId>          # sets approved_at + audit-logs the approval
```

Approval flips `approved_at`; the running worker picks it up on its next tick and
dispenses it (token/vault via the hot float — ensure the float covers it,
[runbook 03](03-hot-float-refill.md); ANT via the cold batch,
[runbook 05](05-ant-cold-batch-dispatch.md)). Confirm:

```bash
psql "$DATABASE_URL" -c "SELECT status, tx_signatures FROM claims WHERE claim_id='<claimId>';"
# status -> confirmed, a tx signature recorded
```

## Reject

If the claim should not be honored (fraud, sanctions, wrong entitlement), reject
it instead of approving. There is a rejection path in the admin plane; if not yet
wired for your deployment, leave it `pending_review` and escalate — **never**
approve a claim you would reject. Record the decision + rationale in the ops log.

## Second brake: the outflow rate-limiter

Independent of the per-claim brake, watch the aggregate: a spike in confirmed
volume (`yarn --silent ops:metrics | jq '.snapshot.claims | {confirmedLastHour, confirmedLast24h}'`)
is a signal to slow down and review even sub-threshold claims. If confirmed volume
looks anomalous, **freeze the API** (runbook 08 §freeze) and investigate before
approving more.

## AT-RISK owners (136 wallets, ~6.25M ARIO)

These load `manual_review` and are **hidden** from self-serve lookup/claim (the API
returns a 404 indistinguishable from a nonexistent asset). They arrange delivery
by email. The flow: the owner proves control of their modulus/pubkey (signs a
challenge), an operator verifies `sha256(modulus) == address`, attaches the key via
the admin `attach-pubkey` endpoint, and only then does the normal claim path open —
still subject to this >100k review. Do **not** shortcut the identity proof for an
AT-RISK owner.
