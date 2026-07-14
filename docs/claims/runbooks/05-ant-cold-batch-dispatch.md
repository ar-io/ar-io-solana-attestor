# Runbook 05 — ANT cold-batch dispatch

**Trigger:** approved ANT claims are waiting (`awaiting_ant_signer`), or on a
scheduled ANT-dispatch cadence.

ANTs (Metaplex Core NFTs) are **never** dispensed from a hot key and are **not**
bulk-moved to the server. The 2,269 unmapped ANTs stay under the **cold
authority**. Each ANT claim is operator-approval-gated, and the cold key is loaded
**per batch, at runtime, then discarded** — there is no persistent server-side ANT
key. `runAntBatch` refuses a non-`ant`-role signer or one whose address equals the
hot dispenser.

## Lifecycle of an ANT claim

1. User claims → `completeClaim` verifies the identity proof → claim `verified`.
2. Worker sees an ANT + `antRequiresApproval` (default) → routes to
   `pending_review` → outcome `awaiting_approval`. **An NFT is never
   auto-dispensed.**
3. Operator approves ([runbook 04](04-big-claim-approval.md)): `yarn
   dispatch:approve <claimId>`.
4. Approved but no cold key loaded → the worker holds it: `awaiting_ant_signer`.
5. **This runbook:** operator runs the cold batch, which dispenses every approved
   ANT with the cold authority, then discards the key.

## Run the batch

Find the waiting ANTs:
```bash
psql "$DATABASE_URL" -c "
  SELECT c.claim_id, a.ant_mint, c.claimant
    FROM claims c JOIN assets a ON a.asset_key=c.asset_key
   WHERE a.asset_type='ant'
     AND (c.status='dispatching' OR (c.status='pending_review' AND c.approved_at IS NOT NULL));"
```

Load the cold ANT authority **for this batch only** and dispatch:
```bash
# Option A — a sealed blob (preferred):
ANT_COLD_KEY_SEALED_PATH=/secure/ant-cold.sealed.json ANT_COLD_KEY_PASSPHRASE='<KEK>' \
  DATABASE_URL='...' SOLANA_RPC_URL='...' CONFIRM_RPC_URL='<single endpoint>' ARIO_MINT='...' \
  yarn dispatch:ants

# Option B — the authority's Solana keypair JSON (e.g. the migration authority):
ANT_COLD_KEYPAIR_PATH=/secure/authority-keypair.json \
  DATABASE_URL='...' SOLANA_RPC_URL='...' CONFIRM_RPC_URL='<single endpoint>' ARIO_MINT='...' \
  yarn dispatch:ants
```

`dispatch:ants` calls `worker.runAntBatch(coldSigner)`, which for each approved ANT
signs `TransferV1` (Owner) + `UpdateV1` (UpdateAuthority) to the claimant **in one
tx** (ADR-013), confirms it exactly-once, then the process exits and the cold key
is gone from memory. **One `runAntBatch` dispenses ALL approved ANTs in the batch**
(proven in the staging rehearsal: a single batch handed out two ANTs at once).

## Verify

```bash
psql "$DATABASE_URL" -c "
  SELECT c.claim_id, c.status, c.tx_signatures FROM claims c
    JOIN assets a ON a.asset_key=c.asset_key
   WHERE a.asset_type='ant' AND c.confirmed_at > now() - interval '1 hour';"
```
For high-value ANTs, read the on-chain asset and confirm **both** Owner AND
UpdateAuthority == the claimant (the rehearsal asserts this on-chain).

## Discipline

- Load the cold key **only** for the batch run; never leave it in a long-lived
  env / process. The `dispatch:ants` process is short-lived by design.
- Keep the hot **dispatch worker** running separately (token-only registry) — it
  never touches the ANT key. `assertSeparableRoles` / `runAntBatch` guarantee the
  cold ANT signer is not the hot dispenser.
- Batch cadence is an operator choice (ANT claim frequency is low). Between an
  approval and the batch, the claim sits `awaiting_ant_signer` — that is expected,
  not an error.
