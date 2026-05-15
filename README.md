# ar.io ANT escrow attestor

Single-purpose off-chain service that verifies Arweave RSA-PSS-4096
signatures and re-signs the same canonical message with Ed25519, so the
Solana escrow program can verify the (cheap) Ed25519 signature
on-chain instead of the (impossibly expensive on Solana BPF) RSA-PSS.

## Why

Solana's `sol_big_mod_exp` syscall is feature-gated and blocked on every
public Solana cluster (devnet, testnet, mainnet); RSA-PSS-4096
verification entirely in software on Solana BPF would not fit in the
1.4 M CU per-transaction limit. Off-chain verification + Ed25519
attestation is currently the only practical path.

The escrow protocol still wants to allow Arweave-wallet holders to claim
escrowed assets without a Solana wallet. This service plugs the gap:

```
[user / browser]                      [attestor service]              [Solana program]
   sign canonical message
   with Arweave wallet (RSA-PSS)
        |
        v
   POST /attest  ─────────────► verify RSA-PSS via node:crypto
                                 sign canonical with Ed25519
                                 return Ed25519 sig + pubkey
        v
   build Solana tx with:
     1. Ed25519Program ix
        (native sigverify, ~720 CU)
     2. claim_*_attested ix
        (introspects ix #1)        ─►  reconstruct canonical message
                                       from escrow state, confirm
                                       Ed25519Program checked the
                                       attestor's sig over those bytes,
                                       release the asset
```

Only the Arweave claim path uses the attestor. Ethereum claims continue
to use Solana's native `secp256k1_recover` syscall directly.

## API

### POST /attest

```json
{
  "antMintBase58":           "...",   // 32-byte Solana pubkey
  "claimantBase58":          "...",   // 32-byte Solana pubkey
  "nonceHex":                "...",   // 64-char hex
  "rsaModulusBase64Url":     "...",   // 512-byte RSA-4096 modulus
  "rsaSignatureBase64Url":   "...",   // 512-byte RSA-PSS signature
  "saltLength":              32       // 0 or 32 (Arweave wallet defaults)
}
```

Response (200):

```json
{
  "attestorPubkeyBase58":           "...",  // 32-byte Ed25519 pubkey
  "attestationSignatureBase64Url":  "...",  // 64-byte Ed25519 sig
  "canonicalMessageBase64Url":      "..."   // bytes that were signed
}
```

Errors:

| Status | error code              | meaning                                          |
|--------|-------------------------|--------------------------------------------------|
| 400    | `MISSING_FIELD`         | Required body field absent                       |
| 401    | `RSA_SIGNATURE_INVALID` | RSA-PSS sig didn't verify                        |
| 422    | `INVALID_FIELD_VALUE`   | Wrong length, malformed encoding, etc.           |
| 422    | `UNSUPPORTED_SALT_LENGTH` | Salt length other than 0 or 32                 |
| 429    | (no body)               | Rate limited                                     |
| 500    | `INTERNAL`              | Unexpected exception (see server logs)           |

### GET /health

Returns `{ ok, network, attestorPubkeyBase58 }`. Use to verify a running
service matches the program-baked attestor pubkey constant.

## Configuration

| Env var                    | Required | Default     | Notes                                                     |
|----------------------------|----------|-------------|-----------------------------------------------------------|
| `ATTESTOR_SECRET_BASE58`   | yes      | —           | 32-byte Ed25519 seed, base58. Generate with `yarn keygen`.|
| `NETWORK`                  | yes      | —           | `solana-mainnet`, `solana-devnet`, or `localnet`. Must match what the on-chain program was compiled with. |
| `PORT`                     | no       | `3030`      | HTTP port                                                 |
| `LOG_LEVEL`                | no       | `info`      | pino log level                                            |
| `RATE_LIMIT_PER_MIN`       | no       | `30`        | Per-IP request budget per minute                          |
| `MAX_CONCURRENT_VERIFIES`  | no       | `10`        | System-wide cap on in-flight RSA-PSS verifies. Bounds CPU under DoS — fast-rejects with 503 when full. F-2. |

## Quickstart (local)

```bash
yarn install
yarn keygen
# Copy the SECRET line into a .env file (or your shell environment).

ATTESTOR_SECRET_BASE58=... NETWORK=localnet yarn dev
```

The `keygen` command also prints the public key — that goes into the
`ATTESTOR_PUBKEY` constant in
`ar-io-solana-contracts/programs/ario-ant-escrow/src/state.rs` and
gets baked into the program at deploy time.

## Test

```bash
yarn test
```

Runs 35 tests across:
- RSA-PSS verifier (real keypairs, sign-and-verify round-trip, tampering, wrong modulus, salt-length edge cases)
- Canonical message builder (byte-format, no trailing newline, base58 / hex encoding)
- Ed25519 attest sign-and-verify
- Full HTTP round-trip (Express in-process, real RSA keypair → real Ed25519 verify)

## Production deploy

### Recommended stack

- **Container runtime:** Docker / containerd
- **Orchestrator:** any (ECS, k8s, Nomad, even a single VPS with systemd)
- **TLS:** terminated at a reverse proxy (Cloudflare, ALB, nginx). The
  service speaks plain HTTP internally.
- **Secret manager:** AWS Secrets Manager / GCP Secret Manager / Vault.
  Inject `ATTESTOR_SECRET_BASE58` as an environment variable at task
  start; never commit it.
- **Logs:** JSON to stdout (pino default). Ship to your existing
  observability stack.

### REQUIRED operational hardening (F-2)

The service ships with three layers of in-process protection:

1. **Per-IP rate limit** — `RATE_LIMIT_PER_MIN` requests / minute / IP
   (default 30).
2. **System-wide concurrency cap** — `MAX_CONCURRENT_VERIFIES` parallel
   RSA-PSS verifies (default 10). Excess requests fast-reject with HTTP
   503 `BUSY` so upstream load balancers shed load instead of queueing.
3. **Anomaly logging** — every successful attestation tracked under
   `(arweave_address, escrow_key)`; if the same tuple hits the
   attestor 5+ times in a rolling minute, a `level: warn` log line
   fires with `msg: "anomaly: repeated attestations for same (arweave,
   escrow) tuple"`. Wire this to PagerDuty / Slack — it's a strong
   signal of nonce / claimant brute-forcing.

These are NOT sufficient on their own against a determined attacker
distributing across thousands of IPs (botnet, residential proxies,
IPv6 fan-out). The following operational layers are **REQUIRED** for
any deployment that holds real value:

1. **WAF in front of the service.** Cloudflare WAF, AWS WAF, fastly —
   any one. Configure to challenge or block clients that exceed sane
   per-session call rates and to reject obviously-bot traffic
   (UA fingerprinting, ASN reputation, etc).
2. **Per-session auth or proof-of-humanity.** Recommended: a short-lived
   API token minted from a captcha challenge (Turnstile / hCaptcha)
   that the frontend embeds in the `/attest` request. Without this,
   an attacker who solves one captcha can amortize across millions of
   attestation attempts.
3. **Alarm on the structured anomaly log line.** Sustained anomaly
   warnings on the same (arweave_address, escrow_key) — investigate
   immediately. Most likely a determined attacker probing for a
   nonce/claimant bypass.
4. **Cap RSA-PSS CPU at the box level.** `MAX_CONCURRENT_VERIFIES`
   limits in-process; cgroup CPU / k8s requests cap at the container
   level. Pick numbers that leave headroom for legitimate traffic at
   p99 (typical legitimate p99 is ~50ms per request).

### Sizing

Single attestor instance handles thousands of attestations/sec on a
$5/month VPS. RSA-PSS verify in `node:crypto` is hardware-accelerated
(~1-5 ms per request). Memory footprint: ~50 MB.

For redundancy across AZs, run two replicas behind a load balancer —
the service is stateless, no session affinity required.

## Operations

### Key rotation

If the attestor's Ed25519 key is suspected compromised:

1. `yarn keygen` to generate a fresh keypair (offline / air-gapped
   machine recommended).
2. Submit a `BPFLoaderUpgradeable` upgrade to the
   `ario-ant-escrow` program with the new `ATTESTOR_PUBKEY` constant.
3. Once the upgrade lands, swap the service's `ATTESTOR_SECRET_BASE58`
   env var to the new seed and restart.
4. Decommission the old key.

The whole procedure is ~30 minutes and requires no protocol downtime
beyond the ~1 second the service is restarting.

### Initial deploy — replacing the test ATTESTOR_PUBKEY

The on-chain `ATTESTOR_PUBKEY` constant
(`contracts/programs/ario-ant-escrow/src/state.rs`) ships with a
deterministic test value (`AKnL4NN...`) derived from public seed
`[1u8; 32]` so localnet integration tests work without external
setup. **This MUST be replaced before deploying to any cluster that
holds real value** — anyone reading the source could otherwise mint
valid attestations and drain escrows.

A guardrail script enforces this at deploy time:

```bash
contracts/scripts/check-attestor-pubkey.sh --strict
```

It exits 1 (with a clear runbook) if `state.rs` still has the test
value. `contracts/scripts/devnet-deploy.sh` invokes it
automatically in its Phase-0 environment check, so the canonical
deploy flow can't accidentally ship the test pubkey. Run it manually
before any other deployment path.

### Backup

The Ed25519 seed must be backed up to a cold store (e.g., paper wallet
in a safe, sealed offline drive). Without it, key rotation is the only
recovery path — losing the seed means producing a new pubkey constant
and pushing a program upgrade.

### Monitoring

Alarm on:
- `5xx` rate > 1% (sustained)
- p99 latency > 1 second (typical p50 is 5-15 ms)
- Sustained traffic at the rate limit (suggests attack or misconfigured
  client retries)

The `/health` endpoint is the canonical liveness check and also returns
the running attestor pubkey for ops verification against the deployed
program constant.

### Logs

Each successful attestation logs (JSON):
```json
{
  "level": 30,
  "time": 1730000000000,
  "arweaveAddress": "abc...",
  "antMintBase58": "...",
  "claimantBase58": "...",
  "saltLength": 32,
  "elapsedMs": 7,
  "msg": "attestation issued"
}
```

The RSA modulus and signature are NEVER logged (no PII, but no upside
to retention). Canonical message bytes are NOT logged either; the
combination of (antMint, claimant, nonce) tags is sufficient for audit.

Retention: 90 days covers the migration window with buffer.
