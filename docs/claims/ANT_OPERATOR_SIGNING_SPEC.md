# Spec — Operator wallet-signed ANT dispatch (Phantom / Ledger)

Status: **draft for review** · Author: deploy session 2026-07-16 · Scope: `packages/claims` backend + the (in-rebuild) operator frontend.

## 1. Goal

Let the 2,269 ANTs dispense to verified claimants **without the ANT authority key ever living on the server**, and **without an SSH/CLI ritual**. The operator connects the ANT-authority wallet (Phantom, ideally a Ledger behind it), **reviews** a batch, and authorizes it. The server prepares and broadcasts; the operator's wallet is the only thing that can authorize an ANT transfer.

> **Signing count (as-built):** a batch is authorized by **three** distinct wallet interactions — a `build` challenge signature, a `signAllTransactions` over the batch, and a `submit` challenge signature — **not** a single prompt. Each money-moving WRITE action is individually wallet-authorized (action-bound challenge, so a captured `{nonce,sig}` can't be redirected build↔submit), and the operator reviews the decoded transfers before signing (no blind-signing). Read/status polling uses a short-lived read-session token (one reused signature), so it never re-prompts.

This replaces the server-side `dispatch:ants` CLI (which loads a cold keypair on the box) with an operator-in-the-loop wallet flow. It is **not** fully hands-off — it is deliberately human-gated, because the ANT authority is the one key whose compromise is unbounded and irreversible (all 2,269 ANTs + the migration authority). ARIO/vault dispensing stays fully automated on the server; this changes **only** the ANT path.

Non-goals: changing who can claim, the claim rules, the ARIO money path, or the AT-RISK manual-delivery carve-out. None of those move.

## 2. Why this shape (security model)

| Property | How this delivers it |
|---|---|
| ANT authority never on the box | The private key stays in Phantom/Ledger. The server holds **no** ANT signer (removes `ANT_COLD_KEYPAIR_PATH` / sealed-blob usage from production). |
| Server breach cannot move ANTs | An MPL Core `TransferV1`/`UpdateV1` is invalid without the authority signature, which only the operator's wallet can produce. |
| No SOL on the operator wallet | The **treasury** (hot dispenser) is the transaction **fee payer**; the operator wallet signs only as the ANT **authority**, never pays. See §5. |
| Exactly-once preserved | Reuses the existing persist-signature-before-broadcast anchor and recovery (`#signPersistBroadcastConfirm`, `#recover`). See §6. |
| Only the real authority can drive it | Admin endpoints require a challenge signed by the ANT-authority pubkey (§7.3) — the same key that must sign the transfers anyway. |

Key point that makes the whole design clean: **a Solana transaction id is its fee-payer signature, and that signature is invariant to the other signers.** So with the treasury as fee payer, the server knows and persists the final txid *before* the operator's wallet ever co-signs — the exactly-once anchor holds unchanged.

## 3. What exists today (reused, not rebuilt)

- `src/dispatch/instructions.ts` — `mplCoreTransferV1Ix`, `mplCoreUpdateAuthorityIx`, `claimMemoIx` (`ar.io-claim:<claimId>`). ANTs are standalone MPL Core assets (no collection).
- `src/dispatch/worker.ts` — the exactly-once state machine: `#dispatchFresh` → `#signPersistBroadcastConfirm` (sign → **persist** → broadcast → confirm), and `#recover` (re-check persisted signature; `findConfirmedOutflow` scans by the claim's *own* signatures + memo, decoy-proof; `MAX_RESIGN_ATTEMPTS = 1`; freeze `needs_operator` rather than loop).
- `src/dispatch/chain.ts` — `SignResult { signature, blockhash, lastValidBlockHeight, wireBase64 }`, `broadcast`, `confirmSignature`, `findConfirmedOutflow`.
- DB: `claims.dispatch_signature`, `dispatch_last_valid_bh`, `tx_signatures[]`, `dispatch_resign_count`, `approved_at`; partial unique index `one_live_claim_per_asset`; append-only `audit_log`.
- Boot guard `assertSeparableRoles` (ANT authority ≠ hot token dispenser).

The change is: **relocate the signing step out of the server and into the operator's wallet**, keeping every guard around it.

## 4. Flow overview

```
Operator browser (Phantom/Ledger = ANT authority)          Claims backend                         Solana
  │                                                            │
  │ 1. connect wallet, GET /v1/admin/ant/challenge ───────────►│  (nonce)
  │ ◄── nonce                                                  │
  │ 2. sign nonce, POST /v1/admin/ant/batch  (authz) ─────────►│  verify sig == ANT_COLD_ADDRESS
  │                                                            │  reserve eligible ANT claims (build-lock)
  │                                                            │  build 1 tx / claim:
  │                                                            │    [TransferV1, UpdateV1, memo]
  │                                                            │    feePayer = treasury, blockhash=fresh
  │                                                            │    treasury co-signs (fee-payer sig = txid)
  │ ◄── { batchId, txs:[{claimId, txBase64(partially signed), txid}], lastValidBlockHeight } 
  │ 3. wallet.signAllTransactions(txs)  ← ONE prompt           │
  │ 4. POST /v1/admin/ant/batch/:id/submit {signedTxs} ───────►│  for each: verify authority sig present,
  │                                                            │    txid unchanged → persistDispatching
  │                                                            │    (FOR UPDATE re-check) → broadcast ──────► tx lands
  │                                                            │    → confirmSignature → confirmed
  │ ◄── per-claim outcomes (confirmed / dispatching / failed)  │
  │ 5. poll GET /v1/admin/ant/batch/:id ──────────────────────►│  (confirm job finalizes stragglers via #recover)
```

## 5. Fee-payer decision — treasury pays (recommended)

Two options; **A is recommended.**

**A. Treasury is fee payer, operator wallet is authority-only.**
- Tx assembly: `setTransactionMessageFeePayerSigner(treasury)`, instructions require the ANT authority as an additional signer. Server signs the fee-payer slot → obtains the **txid** immediately. Operator wallet later fills the authority signature slot; txid is unchanged.
- Operator wallet needs **zero SOL**. Fees come from the treasury SOL you already fund (ANT transfers create no ATA, so cost is ~base fee only — trivial).
- Does **not** weaken key separation: the treasury pays the fee but has **no authority** over the ANT; a treasury compromise still cannot move an ANT (needs the Phantom signature). `assertSeparableRoles` still holds (authority address ≠ treasury address).

**B. Operator wallet is fee payer.** Simpler tx (single signer) but the operator wallet must hold SOL, and the server can't learn the txid until the wallet signs (persist must move to submit-time only). Use only if you specifically want the treasury off ANT txs entirely.

Rest of this spec assumes **A**.

## 6. Exactly-once, preserved

The anchor is unchanged: **persist the signature before broadcasting; never re-sign unless the prior tx is provably dead and never landed.**

- **Persist point:** at **submit** (§7.2 step 4), per tx: reuse the semantics of `#persistDispatching` — under the claim-row `FOR UPDATE` lock, re-check `status ∈ {verified, pending_review+approved}` and asset `available`, then flip → `dispatching` and store `dispatch_signature = txid`, `dispatch_last_valid_bh`. Only then `broadcast`. If the state moved (a concurrent path won the asset), **abort that tx, never broadcast** — identical to today.
- **Wallet must sign-only, not sign-and-send.** Use `signTransaction` / `signAllTransactions` (never `signAndSendTransaction`) so the **server** controls broadcast and keeps persist-before-broadcast. This is mandatory; enforce by never handing Phantom a sendable path.
- **Build-time reservation (prevents two batches double-including a claim):** at build, mark eligible claims with `ant_batch_id` + `ant_reserved_at` via `SELECT … FOR UPDATE SKIP LOCKED`. A claim already reserved by a live batch is excluded. Reservation auto-expires (e.g. 10 min) so an abandoned batch frees its claims.
- **Abandoned / expired batch self-heals:** if the operator never submits, claims stay reserved→expire back to `verified/approved`; nothing was broadcast. If submitted but a tx never lands (blockhash expiry), the persisted txid + `dispatch_last_valid_bh` drive `#recover`: `findConfirmedOutflow` (scan by the claim's own signatures + `ar.io-claim:<claimId>` memo) confirms if it actually landed, else re-dispatch **once**, else freeze `needs_operator`. No double-send.
- **Confirmation:** submit confirms inline (like `#signPersistBroadcastConfirm` step 4); a lightweight periodic **confirm job** sweeps `dispatching` ANT claims through `#recover` to finalize stragglers. `CONFIRM_RPC_URL` must stay the single consistent endpoint (existing `CONFIRM_RPC_POOLED` guard).
- **No-double-dispense invariants unchanged:** two-lock (claim then asset) + `one_live_claim_per_asset`. AT-RISK `manual_review` ANTs (31) remain excluded — they are never offered to this flow.

## 7. Backend changes (`packages/claims`)

### 7.1 New module `src/dispatch/ant-operator.ts`
Refactor `#buildAntIxs` + `#signPersistBroadcastConfirm` so the sign step is pluggable:
- `buildAntBatch(pool, treasurySigner, { max }) → { batchId, items:[{claimId, assetKey, antMint, claimant, txBase64, txid, lastValidBlockHeight}] }` — selects eligible ANT claims (`asset_type='ant'` AND (`verified` OR `pending_review`+`approved_at`), not AT-RISK, not already reserved), builds one tx per claim with treasury as fee payer, treasury co-signs, reserves the claims.
- `submitAntBatch(pool, gateway, batchId, signedTxs[]) → results[]` — per tx: assert the authority signature is present and `txid` matches the reserved one; run the `#persistDispatching` re-check under lock; `broadcast`; `confirmSignature`; finalize. Returns per-claim outcomes.

`runAntBatch(coldAntSigner)` (the CLI path) stays for break-glass/fallback but is **off by default** in production.

### 7.2 New HTTP routes (`src/api/routes.ts`, admin-scoped)
1. `GET  /v1/admin/ant/challenge` → `{ nonce, expiresAt }` (single-use, short TTL).
2. `POST /v1/admin/ant/batch` (authz §7.3) `{ nonce, sig, max? }` → build a batch, return the partially-signed txs. Idempotent per live reservation.
3. `POST /v1/admin/ant/batch/:batchId/submit` (authz) `{ signedTxs:[base64] }` → persist+broadcast+confirm, return outcomes.
4. `GET  /v1/admin/ant/batch/:batchId` (authz) → batch status (per-claim state + signatures).
5. `GET  /v1/admin/ant/pending` (authz) → count/list of ANT claims awaiting dispatch (for the dashboard badge).

### 7.3 Admin auth
Require every admin route to carry a fresh challenge-nonce **signed by the ANT-authority key** (`ANT_COLD_ADDRESS`); verify server-side via `@noble/ed25519`. Rationale: the only party who can usefully act is the authority holder anyway — bind the endpoint to that key rather than inventing a second secret. Optionally also require `METRICS_AUTH_TOKEN`-style bearer as a coarse gate. All admin actions write to `audit_log` (who=authority pubkey, what=batchId + claimIds + txids).

### 7.4 Data model (migration `..._ant_operator.sql`)
Add to `claims`: `ant_batch_id uuid null`, `ant_reserved_at timestamptz null`. New table `ant_batches(batch_id uuid pk, created_at, created_by_pubkey, claim_count, status, submitted_at)`. No change to money columns. Append-only discipline preserved.

### 7.5 Config
- `ANT_REQUIRES_APPROVAL=false` (decided) — the signing session is the only gate; the operator signs whatever is verified. (ANTs never hit the ARIO big-claim brake anyway — their `amount` is null.)
- `ANT_BATCH_MAX=50` (decided, configurable) — max txs offered per build/sign session.
- `ANT_DISPATCH_MODE = operator-wallet | cli-cold` (default `operator-wallet` in prod). Guards which path is live; boot refuses a persistent server ANT key when `operator-wallet`.

## 8. Frontend (operator admin view — folds into the rebuild)

A gated `/admin/ants` route (not linked from the public claim UI):
1. **Connect wallet** via the Solana wallet adapter (Phantom; Ledger-through-Phantom supported). Verify `wallet.publicKey === ANT_COLD_ADDRESS`; refuse otherwise ("connect the ANT authority wallet").
2. **Authenticate:** `GET …/challenge` then `wallet.signMessage("ar.io-ant-admin:<action>:<nonce>")` per WRITE action. A `session` signature is exchanged once at `POST …/session` for a short-lived read token so **status polling never re-prompts** (`x-ant-read-token` header).
3. **Show pending:** `GET …/pending` — how many ANTs are waiting, oldest age.
4. **Build → review → sign → submit:** sign a `build` challenge → `POST …/batch` → receive N partially-signed txs → **review the decoded transfers (recipient / mint / count)** → `wallet.signAllTransactions(txs)` (sign-only; Ledger steps through, the intended friction) → sign a `submit` challenge → `POST …/batch/:id/submit`. Three wallet interactions total per batch (build sig, batch sig, submit sig).
5. **Result:** live per-claim status (confirmed / still-confirming / failed) with the txid and a Solana explorer link; poll `GET …/batch/:id`.

UX notes: batch cap `ANT_BATCH_MAX=50` txs/session; sessions are periodic (sign the accumulated backlog), not live. One ANT per tx (ANT transfers create no ATA, base fee is trivial), which keeps the per-claim `dispatch_signature` model intact. Submit/confirm is per-tx and independent, so a partially-signed or partially-landed batch is safe.

**Hot-wallet hardening (Phantom, no Ledger — decided).** The authority is now a browser-extension key, so its safety reduces to the safety of the machine Phantom runs on: a compromised laptop/extension can drain all 2,269 ANTs during (or exfiltrate the key outside of) a signing session. Mitigations: use a **dedicated, clean browser profile or machine** for this wallet only; no other extensions; sign in short sessions. Treat it as a **warm** key. Ledger is a drop-in later — the wallet-adapter flow is identical, so upgrading requires no code change and is the recommended hardening once live.

## 9. Failure modes

| Scenario | Handling |
|---|---|
| Operator abandons after build | Reservation expires (~10 min) → claims return to `verified/approved`; nothing broadcast. |
| Blockhash expires before submit | Submit rejects stale txs (lastValidBlockHeight passed); operator re-builds. Nothing persisted/broadcast for those. |
| Submitted, tx never lands | `#recover`: outflow-scan confirms if landed, else re-sign once, else `needs_operator`. No double-send. |
| Wrong wallet connected | Frontend refuses (pubkey ≠ authority); backend challenge-verify also fails. |
| Double submit / double click | `txid` idempotency + `#persistDispatching` lock + `one_live_claim_per_asset` → at most one broadcast per claim. |
| Two operator sessions at once | Build reservation via `FOR UPDATE SKIP LOCKED` — a claim is in at most one live batch. |
| Confirm-RPC lag/pool | Existing `CONFIRM_RPC_POOLED` boot refusal + `MAX_RESIGN_ATTEMPTS=1` freeze. |
| AT-RISK ANT | Never eligible (excluded by `manual_review`); manual delivery only. |

## 10. Tests (mirror the existing adversarial DB suites)
New `*.db.test.ts` under `src/dispatch/`: happy-path batch build→sign(sim)→submit→confirm; **double-submit** of the same batch → one dispatch; **replayed** signed tx → rejected; **wrong-authority** signature → rejected; **blockhash-expiry** → re-dispatch once, no double; **concurrent operator + running ARIO worker** never collide on an asset; abandoned-batch reservation release. Simulate wallet signing with a local keypair standing in for `ANT_COLD_ADDRESS` (as `fake-chain.testkit.ts` does for the gateway). All existing exactly-once suites must stay green.

## 11. Rollout
1. Build behind `ANT_DISPATCH_MODE=cli-cold` (default) so nothing changes until ready.
2. Land backend + migration + tests; devnet rehearsal (`rehearsal:staging`) extended with an operator-wallet ANT leg (sim keypair).
3. Frontend admin view in the rebuild; test on devnet with a throwaway authority.
4. Flip prod to `ANT_DISPATCH_MODE=operator-wallet`, keep `cli-cold` as documented break-glass.

## 12. Decisions (locked 2026-07-16)
- **Fee payer: treasury** (option A). Operator wallet holds no SOL; treasury pays the (trivial) ANT fee.
- **Authority wallet: Phantom** (no Ledger for now). See §8 hot-wallet hardening — Ledger is a drop-in upgrade later with **no** code change (same wallet-adapter flow).
- **`ANT_REQUIRES_APPROVAL=false`.** The signing session **is** the human gate; no redundant per-claim `dispatch:approve` step. Verified ANT claims flow straight into the next batch.
- **Batch cap: 50 tx/session** (`ANT_BATCH_MAX`, configurable). Submit/confirm is **per-tx and independent**, so a partial batch is safe: whatever lands is confirmed, the rest recover normally. If Phantom proves flaky at 50, drop the cap — no code change.
