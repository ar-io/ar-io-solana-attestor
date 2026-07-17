# Operator ANT dispatch — reference frontend

**Reference only.** This directory is NOT compiled by the `@ar.io/claims` backend
tsconfig (it lives under `docs/`, outside `packages/claims/src`). It is a clean,
reviewable spec of the browser side of the operator wallet-signed ANT dispatch
flow — see `docs/claims/ANT_OPERATOR_SIGNING_SPEC.md` §8. Drop `AntAdminPanel.tsx`
into the rebuilt claim frontend as a gated `/admin/ants` route; it is not
browser-tested in this repo.

## What it does

The operator connects the ANT **authority** wallet (Phantom; Ledger-through-Phantom
works with no code change) and authorizes the pending ANT transfers. The treasury is
the fee payer, so the operator wallet needs **zero SOL** and the server already knows
every txid before the wallet co-signs.

**Signing count (correction).** A batch is **not** one prompt. Each money-moving
WRITE action is individually wallet-authorized — deliberately, so no action rides on
another's signature: a **build** challenge signature, a **submit** challenge
signature, and one **signAllTransactions** over the batch. That is **three** wallet
interactions per batch (plus one reused **session** signature for read polling). And
before the batch signature the operator **reviews** the decoded transfers (recipient,
mint, count) — no blind signing.

```
connect wallet
  → assert wallet.publicKey === ANT_COLD_ADDRESS      (refuse otherwise)
  → GET  /v1/admin/ant/challenge            → { nonce }
  → signMessage("ar.io-ant-admin:session:<nonce>")
  → POST /v1/admin/ant/session {nonce,sig}  → { readToken }    (once; for polling)
  → signMessage("ar.io-ant-admin:build:<nonce2>")
  → POST /v1/admin/ant/batch  {nonce,sig}   → { batchId, items:[{txBase64,txid,…}] }
  → REVIEW the decoded items (recipient / mint / count)         ← no blind signing
  → wallet.signAllTransactions(items)        ← SIGN-ONLY (never signAndSend)
  → signMessage("ar.io-ant-admin:submit:<nonce3>")
  → POST /v1/admin/ant/batch/:id/submit {nonce,sig,signedTxs}
  → poll GET /v1/admin/ant/batch/:id  (header x-ant-read-token) ← NO prompt, auto-poll
```

Challenge signatures are **action-bound** (`ar.io-ant-admin:<action>:<nonce>`), so a
`{nonce,sig}` captured for build can't be redirected to submit within the TTL.

## The one hard rule: sign-only, never send

Use `signAllTransactions` (or `signTransaction`) — **never**
`signAndSendTransaction`. The **server** broadcasts, which is what preserves the
exactly-once anchor (persist-signature-before-broadcast). Handing Phantom a
sendable path would break that guarantee. The panel deserializes the
server-built `txBase64`, has the wallet fill only the authority signature, and
re-serializes for the server to broadcast — the txid never changes.

## Auth

**Write routes** (`POST /session`, `POST /batch`, `POST /batch/:id/submit`) each
carry a fresh, single-use challenge nonce **signed by ANT_COLD_ADDRESS** in the
request **body**. The signed message is domain-separated (`ar.io-ant-admin:<nonce>`)
so a challenge signature can never be replayed as a transaction signature.

**Read routes** (`GET /pending`, `GET /batch/:id`) do **not** prompt the wallet.
The operator exchanges one signed challenge at `POST /session` for a short-lived,
read-only bearer token (default 5 min TTL, bound to the ANT authority) and sends it
in the `x-ant-read-token` header on every poll. Credentials are never placed in the
URL query string.

## Server-authoritative tx bytes (anti-redirect)

The server persists the exact transaction message it built and, on submit, accepts
**only** the operator's authority signature: it reconstructs the broadcast wire from
its own stored message + treasury signature + that authority signature, and verifies
the authority signature over the **stored** message. A tampered/redirected message
therefore fails in-process and is never broadcast — the client controls no broadcast
bytes. This means the panel can submit either the full signed wire or just the
authority signature; the server uses only the latter.

## Integration steps

1. Install peers: `@solana/wallet-adapter-react`, `@solana/wallet-adapter-react-ui`,
   `@solana/wallet-adapter-wallets`, `@solana/web3.js` (used **only** to
   (de)serialize the `VersionedTransaction` bytes for `signAllTransactions` — no
   RPC/send). Wrap the app in the usual `ConnectionProvider` / `WalletProvider` /
   `WalletModalProvider` with the Phantom adapter.
2. Provide build-time env:
   - `VITE_ANT_COLD_ADDRESS` — the ANT authority pubkey (base58). Must equal the
     connected wallet and the backend's `ANT_COLD_ADDRESS`.
   - `VITE_CLAIMS_API_BASE` — the claims API origin (e.g. `https://claim.ar.io`).
3. Render `<AntAdminPanel />` behind an operator-only route. Do not link it from
   the public claim UI.
4. Backend: run with `ANT_DISPATCH_MODE=operator-wallet` and `ANT_COLD_ADDRESS` set;
   the process serving `/v1/admin/ant/*` must hold the treasury signer + a chain
   gateway (the ops/worker process, not the public read API). Boot refuses any
   persistent server-held ANT key in this mode.

## Hardening (from the spec §8)

The authority is a browser-extension key, so its safety reduces to the safety of
the machine Phantom runs on. Use a **dedicated, clean browser profile or machine**
for this wallet only, no other extensions, and sign in short sessions. Treat it as
a **warm** key. Ledger is a drop-in upgrade later — the wallet-adapter flow is
identical, so no code change is needed.
