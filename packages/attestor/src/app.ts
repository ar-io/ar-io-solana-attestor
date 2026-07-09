//! Express application factory. Separated from index.ts so that
//! integration tests can import the app, mount it on a random port,
//! and tear it down cleanly between tests.
//!
//! Endpoint contract documented inline at each handler.

import express, { type Express, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import pino from "pino";
import bs58 from "bs58";

import { loadConfig, type Config } from "./config.js";
import {
  buildAntEscrowClaimMessage,
  buildEscrowClaimMessage,
  RSA_4096_BYTES,
  RsaPssError,
  deriveArweaveAddress,
  verifyRsaPss,
  signAttestation,
} from "@ar.io/attestor-canonical";

const config: Config = loadConfig();
const log = pino({ level: config.logLevel });

const app: Express = express();
app.use(express.json({ limit: "16kb" }));
app.use(
  rateLimit({
    windowMs: 60_000,
    limit: config.rateLimitPerMinute,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

// =========================================
// F-2: in-process CPU bound + anomaly detection
// =========================================
//
// The per-IP rate limit caps how often any single IP can hit /attest,
// but a distributed attacker (botnet, residential proxy pool, IPv6
// fan-out) can amortize that across thousands of IPs. RSA-PSS-4096
// verify takes ~5ms of CPU per request on a small VPS; without a
// system-wide cap, the box CPU-saturates and rejects honest traffic.
// The semaphore below caps concurrent in-flight verifies — fast
// reject (503) when full, so the rate limiter and the upstream WAF
// see backpressure and shed load early.
//
// Anomaly detection: track repeat (arweaveAddress, antMint) tuples
// over a rolling window and emit a `level: 40` (warn) log when the
// same address attempts the same escrow more than N times per
// minute. Operationally that's a strong signal someone is brute-
// forcing nonces / claimants for a specific escrow.

let inFlightVerifies = 0;

function tryAcquireVerifySlot(): boolean {
  if (inFlightVerifies >= config.maxConcurrentVerifies) return false;
  inFlightVerifies += 1;
  return true;
}
function releaseVerifySlot(): void {
  inFlightVerifies = Math.max(0, inFlightVerifies - 1);
}

interface AnomalyState {
  count: number;
  firstSeenMs: number;
}
const ANOMALY_WINDOW_MS = 60_000;
const ANOMALY_THRESHOLD = 5;
/**
 * Soft GC threshold — when the map is over this size, run expiry-based
 * cleanup on every call. Cheap (≤ ANOMALY_MAX_ENTRIES entry walk).
 */
const ANOMALY_GC_THRESHOLD = 10_000;
/**
 * Hard cap — if expiry-based GC didn't reclaim enough (e.g. attacker
 * fires unique-key requests faster than ANOMALY_WINDOW_MS so every
 * entry is still "fresh"), FIFO-evict oldest entries down to this cap.
 * At ~150 bytes per entry, 50k entries ≈ 7.5 MB of resident state.
 */
const ANOMALY_MAX_ENTRIES = 50_000;
const anomalyByKey: Map<string, AnomalyState> = new Map();

/**
 * Track repeated attestation attempts for the same (arweaveAddress,
 * escrowKey) tuple inside a rolling minute. Returns true when the
 * tuple has crossed `ANOMALY_THRESHOLD` so the caller can emit a
 * structured warn log.
 *
 * SECURITY: the GC pass MUST run before the early-return branches.
 * The previous version of this function only invoked cleanup on the
 * "existing non-expired key" path, which is exactly the path an
 * attacker never takes: streams of unique (or expired) keys all hit
 * the insert-and-return branch above, so the map grew unbounded until
 * the Node heap OOM'd. Because `assetIdHex` (token/vault) and
 * `antMintBase58` (ANT) are attacker-controlled fields in /attest
 * requests with valid attacker-generated RSA-PSS proofs, this was a
 * remotely triggerable memory-exhaustion DoS against the attestor.
 *
 * The fix: GC runs on every call once the map is over the soft
 * threshold; if expiry-based GC isn't enough (all entries still
 * within the window), FIFO-evict the oldest entries down to the hard
 * cap. Map iteration is insertion-ordered, so `keys()` yields oldest
 * first.
 */
function checkAnomaly(arweaveAddress: string, escrowKey: string): boolean {
  const key = `${arweaveAddress}:${escrowKey}`;
  const now = Date.now();

  // Bound memory FIRST, before any insert path. Runs on every call
  // once the map crosses ANOMALY_GC_THRESHOLD; the iteration cost is
  // amortised against the unbounded growth it prevents.
  if (anomalyByKey.size > ANOMALY_GC_THRESHOLD) {
    for (const [k, v] of anomalyByKey) {
      if (now - v.firstSeenMs > ANOMALY_WINDOW_MS) anomalyByKey.delete(k);
    }
    // Hard cap: if expiry-based GC didn't reclaim enough (every entry
    // still inside ANOMALY_WINDOW_MS), evict oldest. Map iteration
    // visits keys in insertion order, so the first N are the oldest.
    //
    // The eviction target is `ANOMALY_MAX_ENTRIES - 1`, not
    // `ANOMALY_MAX_ENTRIES`: the next branch below MAY insert one new
    // entry, so we reserve a slot for it. Post-condition: after this
    // function returns, `size <= ANOMALY_MAX_ENTRIES`.
    if (anomalyByKey.size >= ANOMALY_MAX_ENTRIES) {
      const excess = anomalyByKey.size - (ANOMALY_MAX_ENTRIES - 1);
      let deleted = 0;
      for (const k of anomalyByKey.keys()) {
        anomalyByKey.delete(k);
        deleted += 1;
        if (deleted >= excess) break;
      }
    }
  }

  const cur = anomalyByKey.get(key);
  if (!cur || now - cur.firstSeenMs > ANOMALY_WINDOW_MS) {
    anomalyByKey.set(key, { count: 1, firstSeenMs: now });
    return false;
  }
  cur.count += 1;
  return cur.count >= ANOMALY_THRESHOLD;
}

/**
 * Test-only exports. The leading underscore signals "do not import
 * from production code" — they exist so the unit test in
 * `app.test.ts` can exercise the GC path and assert the memory bound.
 */
export const _checkAnomalyForTest = checkAnomaly;
export const _anomalyByKeyForTest = anomalyByKey;
export const _ANOMALY_THRESHOLD_FOR_TEST = ANOMALY_THRESHOLD;
export const _ANOMALY_GC_THRESHOLD_FOR_TEST = ANOMALY_GC_THRESHOLD;
export const _ANOMALY_MAX_ENTRIES_FOR_TEST = ANOMALY_MAX_ENTRIES;

/// GET /health — ops endpoint. Returns the attestor's public key (for
/// verification that the running service matches the program-baked
/// constant) and the network it's signing for.
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    network: config.network,
    attestorPubkeyBase58: bs58.encode(config.attestor.publicKey),
  });
});

/// POST /attest — main attestation endpoint.
///
/// Body shape is discriminated by `claimKind`:
///
/// 1. `claimKind: "ant"` (default if omitted, for back-compat) —
///    ANT escrow claims (`claim_ant_arweave_attested`).
///    Required fields:
///      antMintBase58:           string  // 32-byte ANT pubkey
///      claimantBase58:          string  // 32-byte recipient pubkey
///      nonceHex:                string  // 64-char hex
///      rsaModulusBase64Url:     string  // 512-byte RSA-4096 modulus
///      rsaSignatureBase64Url:   string  // 512-byte RSA-PSS signature
///      saltLength:              number  // 0 or 32
///
/// 2. `claimKind: "token"` or `"vault"` — token / vault escrow claims
///    (`claim_tokens_arweave_attested` / `claim_vault_arweave_attested`).
///    Required fields:
///      claimKind:               "token" | "vault"
///      assetIdHex:              string  // 64-char hex (32 bytes)
///      amount:                  string  // u64 as decimal string (avoids JS u53 limit)
///      claimantBase58:          string  // 32-byte recipient pubkey
///      nonceHex:                string  // 64-char hex
///      rsaModulusBase64Url:     string
///      rsaSignatureBase64Url:   string
///      saltLength:              number  // 0 or 32
///
/// Response 200 (same for both shapes):
///   attestorPubkeyBase58:           string  // 32-byte Ed25519 pubkey
///   attestationSignatureBase64Url:  string  // 64-byte Ed25519 sig
///   canonicalMessageBase64Url:      string  // bytes that were signed
///
/// Errors:
///   400 MISSING_FIELD            // required body field absent
///   401 RSA_SIGNATURE_INVALID    // RSA-PSS sig didn't verify
///   422 INVALID_FIELD_VALUE      // wrong length, malformed encoding, etc.
///   422 UNSUPPORTED_SALT_LENGTH  // salt not 0 or 32
///   422 UNSUPPORTED_CLAIM_KIND   // claimKind not in known set
///   429 (no body)                // rate-limited
app.post("/attest", (req: Request, res: Response) => {
  const t0 = process.hrtime.bigint();

  const body = req.body as Record<string, unknown>;

  // Common fields shared by all claim shapes.
  const claimantBase58 = stringField(body, "claimantBase58");
  const nonceHex = stringField(body, "nonceHex");
  const rsaModulusB64u = stringField(body, "rsaModulusBase64Url");
  const rsaSignatureB64u = stringField(body, "rsaSignatureBase64Url");
  const saltLength = numberField(body, "saltLength");

  if (
    claimantBase58 === null ||
    nonceHex === null ||
    rsaModulusB64u === null ||
    rsaSignatureB64u === null ||
    saltLength === null
  ) {
    res.status(400).json({
      error: "MISSING_FIELD",
      detail:
        "required (all): claimantBase58, nonceHex, rsaModulusBase64Url, rsaSignatureBase64Url, saltLength; plus claim-kind-specific fields",
    });
    return;
  }

  if (saltLength !== 0 && saltLength !== 32) {
    res.status(422).json({
      error: "UNSUPPORTED_SALT_LENGTH",
      detail: "saltLength must be 0 or 32 (Arweave wallet defaults)",
    });
    return;
  }

  // Decode common binary fields
  let claimant: Uint8Array;
  let nonce: Uint8Array;
  let rsaModulus: Buffer;
  let rsaSignature: Buffer;
  try {
    claimant = bs58.decode(claimantBase58);
    if (claimant.length !== 32) throw new Error("claimant not 32 bytes");
    nonce = decodeHex(nonceHex);
    if (nonce.length !== 32) throw new Error("nonce not 32 bytes");
    rsaModulus = Buffer.from(rsaModulusB64u, "base64url");
    if (rsaModulus.length !== RSA_4096_BYTES) {
      throw new Error(`rsaModulus not ${RSA_4096_BYTES} bytes`);
    }
    rsaSignature = Buffer.from(rsaSignatureB64u, "base64url");
    if (rsaSignature.length !== RSA_4096_BYTES) {
      throw new Error(`rsaSignature not ${RSA_4096_BYTES} bytes`);
    }
  } catch (err) {
    res.status(422).json({
      error: "INVALID_FIELD_VALUE",
      detail: (err as Error).message,
    });
    return;
  }

  // Discriminate claim kind. Back-compat: missing claimKind ⇒ "ant".
  const claimKindRaw = stringField(body, "claimKind") ?? "ant";
  let canonical: Uint8Array;
  let antMintBase58Logged = ""; // for log line below

  if (claimKindRaw === "ant") {
    const antMintBase58 = stringField(body, "antMintBase58");
    if (antMintBase58 === null) {
      res.status(400).json({
        error: "MISSING_FIELD",
        detail: "claimKind=ant requires antMintBase58",
      });
      return;
    }
    let antMint: Uint8Array;
    try {
      antMint = bs58.decode(antMintBase58);
      if (antMint.length !== 32) throw new Error("antMint not 32 bytes");
    } catch (err) {
      res.status(422).json({
        error: "INVALID_FIELD_VALUE",
        detail: (err as Error).message,
      });
      return;
    }
    canonical = buildAntEscrowClaimMessage({
      antMint,
      claimant,
      nonce,
      network: config.network,
      // F-1: bind the modulus into the canonical so an attacker can't
      // substitute their own (modulus, signature) pair to claim an
      // escrow whose stored recipient is someone else's modulus.
      recipientPubkey: rsaModulus,
    });
    antMintBase58Logged = antMintBase58;
  } else if (claimKindRaw === "token" || claimKindRaw === "vault") {
    const assetIdHex = stringField(body, "assetIdHex");
    const amountStr = stringField(body, "amount");
    if (assetIdHex === null || amountStr === null) {
      res.status(400).json({
        error: "MISSING_FIELD",
        detail: "claimKind=token|vault requires assetIdHex and amount",
      });
      return;
    }
    let assetId: Uint8Array;
    let amount: bigint;
    try {
      assetId = decodeHex(assetIdHex);
      if (assetId.length !== 32) throw new Error("assetId not 32 bytes");
      amount = BigInt(amountStr);
      if (amount < 0n || amount > 0xFFFF_FFFF_FFFF_FFFFn) {
        throw new Error(`amount must fit in u64, got ${amountStr}`);
      }
    } catch (err) {
      res.status(422).json({
        error: "INVALID_FIELD_VALUE",
        detail: (err as Error).message,
      });
      return;
    }
    canonical = buildEscrowClaimMessage({
      assetType: claimKindRaw,
      assetId,
      amount,
      claimant,
      nonce,
      network: config.network,
      // F-1: same binding as the ANT escrow path above.
      recipientPubkey: rsaModulus,
    });
  } else {
    res.status(422).json({
      error: "UNSUPPORTED_CLAIM_KIND",
      detail: `claimKind must be "ant", "token", or "vault" (got "${claimKindRaw}")`,
    });
    return;
  }

  // F-2: bound concurrent CPU. Semaphore + fast-reject under load.
  if (!tryAcquireVerifySlot()) {
    log.warn(
      { inFlightVerifies, max: config.maxConcurrentVerifies },
      "verify slot exhausted — rejecting with 503",
    );
    res.status(503).json({
      error: "BUSY",
      detail: "attestor at capacity; retry shortly",
    });
    return;
  }

  // Verify RSA-PSS over canonical
  let valid: boolean;
  try {
    valid = verifyRsaPss(
      Buffer.from(canonical),
      rsaSignature,
      rsaModulus,
      saltLength,
    );
  } catch (err) {
    releaseVerifySlot();
    if (err instanceof RsaPssError) {
      res.status(422).json({ error: err.code, detail: err.message });
    } else {
      log.error({ err }, "verifyRsaPss threw unexpected");
      res.status(500).json({ error: "INTERNAL", detail: "see server logs" });
    }
    return;
  }
  releaseVerifySlot();
  if (!valid) {
    res.status(401).json({
      error: "RSA_SIGNATURE_INVALID",
      detail: "the RSA-PSS signature does not verify under the given modulus",
    });
    return;
  }

  // Sign attestation with Ed25519
  const attestationSig = signAttestation(config.attestor, canonical);

  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const arweaveAddress = deriveArweaveAddress(rsaModulus);

  // F-2 anomaly detection: same (arweave address, escrow key) hitting
  // the attestor repeatedly inside a rolling minute is a strong signal
  // of nonce / claimant brute-forcing or replay attempts. Emit a warn
  // log with structured tags so existing log-based alerts pick it up.
  // The escrow key is `antMint` for ANT claims, `assetIdHex` for
  // token/vault claims — either uniquely identifies the target.
  const escrowKey =
    antMintBase58Logged || (body["assetIdHex"] as string | undefined) || "?";
  const anomalous = checkAnomaly(arweaveAddress, escrowKey);
  if (anomalous) {
    log.warn(
      {
        arweaveAddress,
        escrowKey,
        claimKind: claimKindRaw,
        threshold: ANOMALY_THRESHOLD,
        windowMs: ANOMALY_WINDOW_MS,
      },
      "anomaly: repeated attestations for same (arweave, escrow) tuple",
    );
  }

  log.info(
    {
      arweaveAddress,
      claimKind: claimKindRaw,
      antMintBase58: antMintBase58Logged || undefined,
      claimantBase58,
      saltLength,
      elapsedMs: Math.round(elapsedMs),
    },
    "attestation issued",
  );

  res.json({
    attestorPubkeyBase58: bs58.encode(config.attestor.publicKey),
    attestationSignatureBase64Url: Buffer.from(attestationSig).toString(
      "base64url",
    ),
    canonicalMessageBase64Url: Buffer.from(canonical).toString("base64url"),
  });
});

// ---- helpers ----

function stringField(body: Record<string, unknown>, key: string): string | null {
  const v = body[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function numberField(body: Record<string, unknown>, key: string): number | null {
  const v = body[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function decodeHex(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error("hex string must be even length");
  // Strict pre-check rejects negative numbers in mid-string (parseInt
  // would silently coerce "-c" to -12 and Uint8Array would store it
  // as 244, producing garbage instead of erroring). F-3 fix.
  if (!/^[0-9a-fA-F]*$/.test(s)) {
    throw new Error("hex string contains non-hex characters");
  }
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export default app;
export { config };
