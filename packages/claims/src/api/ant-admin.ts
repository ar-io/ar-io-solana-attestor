//! Admin auth + wiring for the operator wallet-signed ANT dispatch endpoints
//! (ANT_OPERATOR_SIGNING_SPEC.md §7.3).
//!
//! Every admin route carries a FRESH, single-use challenge nonce SIGNED by the
//! ANT-authority key (ANT_COLD_ADDRESS) — the only party who can usefully act
//! anyway (it must sign the transfers). The nonce is domain-separated
//! (`ar.io-ant-admin:<nonce>`) so a challenge signature can never be replayed as a
//! transaction signature. Nonces are single-use with a short TTL.

import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import * as ed from "@noble/ed25519";
import bs58 from "bs58";
import type { Pool } from "pg";
import type { Address, TransactionSigner } from "@solana/kit";

import type { AntDispatchMode } from "../config.js";
import type { AntChainGateway } from "../dispatch/chain.js";
import { ApiError } from "./errors.js";

/** The admin actions a challenge signature may authorize (route-binding). */
export type AdminAction = "session" | "build" | "submit";

/** The bytes the operator wallet signs. With an `action` the message is
 *  `ar.io-ant-admin:<action>:<nonce>` — binding the ACTION means a {nonce,sig}
 *  captured for one route can't be redirected to another (build↔submit) within the
 *  nonce TTL. Without one it is the legacy `ar.io-ant-admin:<nonce>`. */
export const ADMIN_CHALLENGE_PREFIX = "ar.io-ant-admin:";

export function adminChallengeMessage(nonce: string, action?: AdminAction): Uint8Array {
  const body = action ? `${action}:${nonce}` : nonce;
  return new TextEncoder().encode(`${ADMIN_CHALLENGE_PREFIX}${body}`);
}

export interface Challenge {
  nonce: string;
  expiresAt: string;
}

export interface ReadSession {
  readToken: string;
  expiresAt: string;
}

/**
 * In-memory single-use challenge store (mirrors the rate-limiter's dependency-free
 * posture) + short-lived READ session tokens.
 *
 * WRITE auth: a nonce is valid until its TTL and is CONSUMED on first successful
 * verify (single-use) — a replay of the same nonce fails.
 *
 * READ auth: after a valid ANT-authority challenge, the operator is minted an
 * opaque, short-TTL, bearer READ token so status polling (`GET pending`,
 * `GET batch/:id`) does NOT prompt the wallet on every call (painful on Ledger).
 * The token is issued ONLY behind a valid ANT_COLD_ADDRESS challenge, so it is
 * implicitly bound to that authority; it grants READ-ONLY access and is never
 * accepted by the write routes. Bounded via lazy GC.
 */
export class AntChallengeStore {
  #ttlMs: number;
  #readTtlMs: number;
  #now: () => number;
  #live = new Map<string, number>(); // nonce -> expiresAtMs
  #readTokens = new Map<string, number>(); // readToken -> expiresAtMs
  #maxKeys: number;

  constructor(opts: { ttlMs?: number; readTtlMs?: number; now?: () => number; maxKeys?: number } = {}) {
    this.#ttlMs = opts.ttlMs ?? 120_000; // 2 min
    this.#readTtlMs = opts.readTtlMs ?? 300_000; // 5 min
    this.#now = opts.now ?? (() => Date.now());
    this.#maxKeys = opts.maxKeys ?? 10_000;
  }

  issue(): Challenge {
    const t = this.#now();
    this.#gc(t);
    const nonce = randomBytes(32).toString("hex");
    const expiresAtMs = t + this.#ttlMs;
    this.#live.set(nonce, expiresAtMs);
    return { nonce, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  /** Consume a nonce: true iff it was live+unused (and now removed). */
  consume(nonce: string): boolean {
    const exp = this.#live.get(nonce);
    if (exp === undefined) return false;
    this.#live.delete(nonce); // single-use regardless of expiry outcome
    return exp > this.#now();
  }

  /** Mint a short-lived READ-only bearer token (call only after a valid challenge). */
  issueReadToken(): ReadSession {
    const t = this.#now();
    this.#gc(t);
    const readToken = randomBytes(32).toString("hex");
    const expiresAtMs = t + this.#readTtlMs;
    this.#readTokens.set(readToken, expiresAtMs);
    return { readToken, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  /** True iff `token` is a live read token. NOT single-use (polling reuses it). */
  verifyReadToken(token: string | undefined): boolean {
    if (!token) return false;
    const exp = this.#readTokens.get(token);
    if (exp === undefined) return false;
    if (exp <= this.#now()) {
      this.#readTokens.delete(token);
      return false;
    }
    return true;
  }

  #gc(t: number): void {
    for (const map of [this.#live, this.#readTokens]) {
      if (map.size < this.#maxKeys) {
        if (map.size > this.#maxKeys / 2) {
          for (const [k, exp] of map) if (exp <= t) map.delete(k);
        }
        continue;
      }
      // B5: at the cap, evict EXPIRED entries FIRST — a `GET /challenge` flood must
      // not evict a LIVE operator nonce while dead ones sit in the map. Only if we
      // are STILL over the cap after purging expired do we drop oldest live entries.
      for (const [k, exp] of map) if (exp <= t) map.delete(k);
      if (map.size < this.#maxKeys) continue;
      for (const k of map.keys()) {
        map.delete(k);
        if (map.size <= this.#maxKeys / 2) break;
      }
    }
  }
}

/** Decode a signature that may arrive as base64, base58, or hex; require 64 bytes. */
export function decodeSignature(sig: string): Uint8Array {
  const attempts: (() => Uint8Array)[] = [
    () => new Uint8Array(Buffer.from(sig, "base64")),
    () => bs58.decode(sig),
    () => new Uint8Array(Buffer.from(sig.replace(/^0x/, ""), "hex")),
  ];
  for (const a of attempts) {
    try {
      const b = a();
      if (b.length === 64) return b;
    } catch {
      // try next encoding
    }
  }
  throw new ApiError(400, "INVALID_SIGNATURE", "signature must be a 64-byte ed25519 signature (base64/base58/hex)");
}

/**
 * Verify a challenge: the nonce must be live+single-use AND the signature must be a
 * valid ed25519 signature by ANT_COLD_ADDRESS over `ar.io-ant-admin:<nonce>`.
 * Throws ApiError(401) on any failure. Consumes the nonce (single-use) even on a
 * bad signature so a leaked nonce can't be brute-forced.
 */
export async function verifyAdminChallenge(
  store: AntChallengeStore,
  antColdAddress: string,
  input: { nonce?: string; sig?: string },
  action?: AdminAction,
): Promise<void> {
  if (typeof input.nonce !== "string" || typeof input.sig !== "string") {
    throw new ApiError(401, "ADMIN_UNAUTHORIZED", "a { nonce, sig } challenge is required");
  }
  if (!store.consume(input.nonce)) {
    throw new ApiError(401, "ADMIN_UNAUTHORIZED", "challenge nonce is unknown, expired, or already used");
  }
  let sigBytes: Uint8Array;
  let pubkey: Uint8Array;
  try {
    sigBytes = decodeSignature(input.sig);
    pubkey = bs58.decode(antColdAddress);
  } catch (e) {
    if (e instanceof ApiError) throw new ApiError(401, "ADMIN_UNAUTHORIZED", e.message);
    throw new ApiError(401, "ADMIN_UNAUTHORIZED", "malformed challenge material");
  }
  // The signature must be over THIS action's message — a build sig won't authorize
  // submit and vice-versa (when an action is bound).
  const ok = await ed.verifyAsync(sigBytes, adminChallengeMessage(input.nonce, action), pubkey);
  if (!ok) {
    throw new ApiError(401, "ADMIN_UNAUTHORIZED", "challenge signature does not verify for ANT_COLD_ADDRESS (or wrong action)");
  }
}

/**
 * Everything the admin ANT routes need. Wired only in a process that HOLDS the
 * treasury signer (the ops/worker process), NOT the public claim API — the public
 * API deliberately boots without treasury key material. Absent => admin routes 503.
 */
export interface AntAdminContext {
  pool: Pool;
  gateway: AntChainGateway;
  treasurySigner: TransactionSigner;
  treasuryAddress: Address;
  antColdAddress: Address;
  mode: AntDispatchMode;
  batchMax: number;
  reservationTtlMs: number;
  requireApproval: boolean;
  includeMemo: boolean;
  challengeStore: AntChallengeStore;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  alert?: (a: { name: string; severity: "critical" | "warning"; message: string; claimId: string }) => void;
}
