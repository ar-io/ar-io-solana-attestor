# Runbook 02 — Key ceremony (the five distinct keys)

Run this **once, before deploy**, in a clean-room / 4-eyes ceremony. It mints the
five load-bearing keys, seals the three the service holds at rest, and records the
public addresses that boot-validation and the transparency verifiers pin.

## The five keys (separable blast radii — non-negotiable)

| Role | Purpose | Held by | Compromise = |
|---|---|---|---|
| **attestor** | signs Arweave attestations for the *on-chain* escrow program | the **attestor** service (unchanged, separate deploy) | Arweave attestations forgeable — **but** the claims service re-verifies RSA-PSS itself, so attestor theft is evidentiary-only here |
| **treasury** (hot dispenser) | signs SPL transfers + vault settlements | the **dispatch worker** (sealed on host, KEK injected) | the **float only** (≤ cap) — never the cold pool |
| **ANT-cold** | signs MPL Core `TransferV1`+`UpdateV1` for ANT claims | the **operator**, loaded per approval batch, then discarded | the 2,269 ANTs — mitigated by operator-in-the-loop batches |
| **audit** | Ed25519-signs each `audit_log.entry_hash` | the **anchor job** (sealed) | can forge log signatures but **not** rewrite anchored history |
| **ledger-publisher** | signs the published ledger manifest **and** the on-chain anchor memo tx | publish + anchor jobs (sealed) | can publish a bad ledger / anchor — caught by the pinned-key verifiers |

**All five MUST be distinct addresses.** `assertBootConfig` refuses to boot if any
two collide (`KEY_REUSE`). The transparency guards (`assertTransparencyKeys*`)
enforce audit ≠ publisher ≠ treasury ≠ attestor independently.

## Ceremony steps

Do this on an air-gapped or hardened host. Passphrases (KEKs) come from a secret
manager (Bitwarden / cloud KMS), **never** the same store as the sealed blobs.

### 1. Treasury (hot dispenser)

```bash
cd packages/claims
TREASURY_KEY_PASSPHRASE='<KEK-from-secret-manager>' \
  yarn encrypt:treasury-key --generate --out /secure/treasury.sealed.json
# prints: { "ok": true, "address": "<TREASURY_ADDRESS>", ... }
```

Record the printed `address` as **`TREASURY_ADDRESS`** (public). Store
`treasury.sealed.json` on the worker host (mode 0600); store the KEK separately.

### 2. ANT-cold authority

The 2,269 unmapped ANTs stay under the **existing migration authority** (the cold
key). You do **not** mint a new ANT key unless you want a dedicated one — the
ANT-cold signer supplied to `dispatch:ants` can be that authority's keypair
(`ANT_COLD_KEYPAIR_PATH`, a Solana keypair JSON) or a sealed blob
(`ANT_COLD_KEY_SEALED_PATH` + `ANT_COLD_KEY_PASSPHRASE`). Record its public
address as **`ANT_COLD_ADDRESS`**. It must differ from the treasury.

To seal a dedicated ANT-cold key:
```bash
TREASURY_KEY_PASSPHRASE='<ANT-COLD-KEK>' \
  yarn encrypt:treasury-key --generate --out /secure/ant-cold.sealed.json
```
(Open it at batch time with `ANT_COLD_KEY_SEALED_PATH` + `ANT_COLD_KEY_PASSPHRASE`.)

### 3. Audit key + 4. Ledger-publisher key (Ed25519 transparency keys)

Seal both with the same tool (crypto-box is passphrase-based; set the KEK for the
role you are sealing):

```bash
TREASURY_KEY_PASSPHRASE='<AUDIT-KEK>' \
  yarn encrypt:treasury-key --generate --out /secure/audit.sealed.json
TREASURY_KEY_PASSPHRASE='<PUBLISHER-KEK>' \
  yarn encrypt:treasury-key --generate --out /secure/ledger-publisher.sealed.json
```

Derive each public key's hex for pinning (the verifiers need it):
```bash
# audit: at runtime the service opens audit.sealed.json with AUDIT_KEY_PASSPHRASE.
# Record AUDIT_PUBKEY_HEX and LEDGER_PUBLISHER_PUBKEY_HEX (32-byte pubkey hex).
```
The printed `address` is base58; the `_PUBKEY_HEX` is the 32-byte pubkey in hex
(publish/verify accept either — see runbook 06 / `verify:transparency`).

### 5. Attestor key — leave it alone

The attestor already runs with its compiled-in mainnet pubkey (`7XtUnotZ…`). Do
**not** rotate it here. Record its public key as `ATTESTOR_PUBKEY_BASE58` (or
`_HEX`) so boot-validation can prove the claims keys don't reuse it.

## Record card (fill in, store in the runbook vault)

```
TREASURY_ADDRESS            = ...
ANT_COLD_ADDRESS            = ...
AUDIT_PUBKEY_HEX            = ...
LEDGER_PUBLISHER_PUBKEY_HEX = ...
ATTESTOR_PUBKEY_BASE58      = ...  (from the attestor deploy)
```

## Verify the ceremony

Set the five public addresses + the sealed paths/KEKs in the target env, then:

```bash
# boot-validation must pass with all five distinct (role=worker is the strictest):
NETWORK=solana-mainnet CONFIRM_RPC_URL='<single-endpoint>' \
  DATABASE_URL='...' ARIO_MINT='...' \
  TREASURY_KEY_SEALED_PATH=/secure/treasury.sealed.json TREASURY_KEY_PASSPHRASE='...' \
  TREASURY_ADDRESS='...' ANT_COLD_ADDRESS='...' \
  AUDIT_PUBKEY_HEX='...' LEDGER_PUBLISHER_PUBKEY_HEX='...' ATTESTOR_PUBKEY_BASE58='...' \
  yarn ops:metrics   # boots config-validation; a KEY_REUSE / mismatch aborts
```

## Rotation

- **Treasury:** mint a new sealed key, move the float to the new address, update
  `TREASURY_*` + `TREASURY_ADDRESS`, redeploy the worker, sweep the old key to
  zero. Because the hot key only ever holds the float, rotation is low-blast.
- **Audit / publisher:** minting a new key changes the pinned pubkey. Publish a
  new signed ledger + anchor under the new key and **announce the new pinned
  pubkey** (verifiers pin it). The old anchors remain valid under the old key.
- **ANT-cold:** it is the migration authority; rotation follows the ADR-026
  authority-transfer path (→ Squads), not this service.
- Never reuse a retired key's address for a different role.
