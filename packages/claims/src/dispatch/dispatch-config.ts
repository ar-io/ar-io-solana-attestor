//! Dispatch-worker configuration + signer loading (M4).
//!
//! Kept SEPARATE from the API `loadConfig` so the HTTP service boots without any
//! treasury key material — only the dispatch worker process reads these. Nothing
//! here is a secret at rest: the treasury key is a SEALED blob (crypto-box.ts)
//! whose passphrase is injected at runtime from a secret manager, never a file.

import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { address, type Address } from "@solana/kit";

import type { Config } from "../config.js";
import type { FloatPolicy } from "./float.js";
import type { VaultDurations } from "./worker.js";
import { EncryptedKeypairSigner, InMemoryKeypairSigner, type DispenserSigner, type SignerRegistry, type SignerRole } from "./signer.js";
import type { SealedKey } from "./crypto-box.js";

/** 100 ARIO = 100 * ONE_TOKEN(1e6). */
const ONE_TOKEN = 1_000_000n;

export interface DispatchConfig {
  mint: Address;
  /** ario-core program id (vault re-lock path). Optional. */
  arioCoreProgram?: Address;
  floatPolicy: FloatPolicy;
  vaultDurations: VaultDurations;
  antRequiresApproval: boolean;
  pollIntervalMs: number;
  /**
   * The RPC endpoint used for the exactly-once confirmation reads
   * (getSignatureStatuses + getBlockHeight). MUST be a SINGLE consistent
   * endpoint (or a read quorum), NOT a round-robin/load-balanced pool — a
   * lagging replica can report a landed tx as not-found and break the
   * "provably dead" expiry premise (see chain.ts + SPEC.md "M4 — operational
   * requirements"). Defaults to CONFIRM_RPC_URL, then SOLANA_RPC_URL.
   */
  confirmRpcUrl: string;
}

/** Heuristic warn if the confirm RPC looks like a multi-endpoint pool. */
export function assertSingleConfirmRpc(url: string, warn: (m: string) => void = (m) => console.warn(m)): void {
  const looksPooled = url.includes(",") || /(^|[^a-z])(lb|pool|round[-_]?robin)([^a-z]|$)/i.test(url);
  if (looksPooled) {
    warn(
      `[dispatch] WARNING: CONFIRM RPC "${url}" looks like a load-balanced/multi-endpoint pool. ` +
        `Exactly-once confirmation reads REQUIRE a single consistent endpoint (or read quorum). ` +
        `A lagging replica can misclassify a landed tx as dead. See SPEC.md "M4 — operational requirements".`,
    );
  }
}

/**
 * Build the hot-float policy from env alone (no ARIO_MINT / worker deps). Shared
 * by the worker config below and the read-only /metrics float gauge so both apply
 * the SAME cap + refill threshold. `bigClaimThresholdMario` comes from the API
 * config (the >100k brake).
 */
export function floatPolicyFromEnv(bigClaimThresholdMario: bigint, env: NodeJS.ProcessEnv = process.env): FloatPolicy {
  // 500,000 ARIO hot-float cap by default.
  const capMario = BigInt(env.HOT_FLOAT_CAP_MARIO ?? (500_000n * ONE_TOKEN).toString());
  // Refill signal when available float drops below 20% of the cap (§4.3).
  const refillThresholdMario = BigInt(env.FLOAT_REFILL_THRESHOLD_MARIO ?? (capMario / 5n).toString());
  return { capMario, bigClaimThresholdMario, refillThresholdMario };
}

export function loadDispatchConfig(base: Config, env: NodeJS.ProcessEnv = process.env): DispatchConfig {
  if (!env.ARIO_MINT) throw new Error("ARIO_MINT is required for the dispatch worker");
  const mint = address(env.ARIO_MINT);
  const arioCoreProgram = env.ARIO_CORE_PROGRAM ? address(env.ARIO_CORE_PROGRAM) : undefined;

  const floatPolicy = floatPolicyFromEnv(base.bigClaimThresholdMario, env);

  // ArioConfig.min/max_vault_duration — the operator sets these to the on-chain
  // values at cutover; the worker boot RECONCILES them against the live on-chain
  // ArioConfig and fails fast on mismatch (dispatch/ario-config.ts). Defaults: 14
  // days min, 365 days max.
  const vaultDurations: VaultDurations = {
    minVaultDuration: BigInt(env.VAULT_MIN_DURATION_SECONDS ?? (14 * 86_400).toString()),
    maxVaultDuration: BigInt(env.VAULT_MAX_DURATION_SECONDS ?? (365 * 86_400).toString()),
  };

  const confirmRpcUrl = env.CONFIRM_RPC_URL ?? env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";

  return {
    mint,
    arioCoreProgram,
    floatPolicy,
    vaultDurations,
    antRequiresApproval: (env.ANT_REQUIRES_APPROVAL ?? "true") !== "false",
    pollIntervalMs: parseInt(env.DISPATCH_POLL_INTERVAL_MS ?? "5000", 10),
    confirmRpcUrl,
  };
}

/**
 * Load a `DispenserSigner` for a role from env. Precedence:
 *   1. `<PREFIX>_KEY_SEALED_PATH` + `<PREFIX>_KEY_PASSPHRASE` -> EncryptedKeypairSigner
 *   2. `<PREFIX>_SEED_BASE64` (32-byte seed, base64) -> InMemoryKeypairSigner (localnet/tests only)
 * Prefixes: TREASURY (token role), ANT_SIGNER (ant role).
 */
export async function loadSigner(role: SignerRole, env: NodeJS.ProcessEnv = process.env): Promise<DispenserSigner | undefined> {
  const prefix = role === "token" ? "TREASURY" : "ANT_SIGNER";
  const sealedPath = env[`${prefix}_KEY_SEALED_PATH`];
  const passphrase = env[`${prefix}_KEY_PASSPHRASE`];
  if (sealedPath && passphrase) {
    const sealed = JSON.parse(readFileSync(sealedPath, "utf8")) as SealedKey;
    return EncryptedKeypairSigner.load(role, sealed, passphrase);
  }
  const seedB64 = env[`${prefix}_SEED_BASE64`];
  if (seedB64) {
    const seed = new Uint8Array(Buffer.from(seedB64, "base64"));
    return InMemoryKeypairSigner.fromSeed(role, seed);
  }
  return undefined;
}

export async function loadSignerRegistry(env: NodeJS.ProcessEnv = process.env): Promise<SignerRegistry> {
  const token = await loadSigner("token", env);
  if (!token) throw new Error("no treasury (token) signer configured — set TREASURY_KEY_SEALED_PATH + TREASURY_KEY_PASSPHRASE");
  // ANT custody is OPERATOR-SUPPLIED per approval batch (loadColdAntSigner), NOT a
  // persistent server key. A persistent `ant` signer is loaded ONLY if a
  // deployment explicitly opts in via ANT_SIGNER_* (production does NOT).
  const ant = await loadSigner("ant", env);
  return { token, ant };
}

/**
 * Load the OPERATOR-SUPPLIED cold ANT authority for a single approval batch
 * (custody decision: cold authority signed per batch — NOT a persistent server
 * key, NO bulk-move of the 2,269 ANTs). Precedence:
 *   1. ANT_COLD_KEY_SEALED_PATH + ANT_COLD_KEY_PASSPHRASE -> EncryptedKeypairSigner
 *   2. ANT_COLD_KEYPAIR_PATH -> a Solana CLI keypair JSON (64-byte array; the
 *      cold authority's own key file), first 32 bytes = the seed.
 * The caller runs `worker.runAntBatch(signer)` then discards the signer.
 */
export async function loadColdAntSigner(env: NodeJS.ProcessEnv = process.env): Promise<DispenserSigner> {
  const sealedPath = env.ANT_COLD_KEY_SEALED_PATH;
  const passphrase = env.ANT_COLD_KEY_PASSPHRASE;
  if (sealedPath && passphrase) {
    const sealed = JSON.parse(readFileSync(sealedPath, "utf8")) as SealedKey;
    return EncryptedKeypairSigner.load("ant", sealed, passphrase);
  }
  const keypairPath = env.ANT_COLD_KEYPAIR_PATH;
  if (keypairPath) {
    const arr = JSON.parse(readFileSync(keypairPath, "utf8")) as number[];
    if (!Array.isArray(arr) || arr.length < 32) throw new Error(`${keypairPath} is not a Solana keypair JSON (>=32 byte array)`);
    return InMemoryKeypairSigner.fromSeed("ant", new Uint8Array(arr.slice(0, 32)));
  }
  throw new Error(
    "no cold ANT signer: set ANT_COLD_KEY_SEALED_PATH + ANT_COLD_KEY_PASSPHRASE, or ANT_COLD_KEYPAIR_PATH",
  );
}
