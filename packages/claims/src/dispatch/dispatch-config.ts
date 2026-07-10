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
}

export function loadDispatchConfig(base: Config, env: NodeJS.ProcessEnv = process.env): DispatchConfig {
  if (!env.ARIO_MINT) throw new Error("ARIO_MINT is required for the dispatch worker");
  const mint = address(env.ARIO_MINT);
  const arioCoreProgram = env.ARIO_CORE_PROGRAM ? address(env.ARIO_CORE_PROGRAM) : undefined;

  // 500,000 ARIO hot-float cap by default.
  const capMario = BigInt(env.HOT_FLOAT_CAP_MARIO ?? (500_000n * ONE_TOKEN).toString());
  // Refill signal when available float drops below 20% of the cap (§4.3).
  const refillThresholdMario = BigInt(env.FLOAT_REFILL_THRESHOLD_MARIO ?? (capMario / 5n).toString());

  const floatPolicy: FloatPolicy = {
    capMario,
    bigClaimThresholdMario: base.bigClaimThresholdMario,
    refillThresholdMario,
  };

  // Live ArioConfig.min/max_vault_duration — the operator sources these from the
  // on-chain ArioConfig at cutover. Defaults: 14 days min, 365 days max.
  const vaultDurations: VaultDurations = {
    minVaultDuration: BigInt(env.VAULT_MIN_DURATION_SECONDS ?? (14 * 86_400).toString()),
    maxVaultDuration: BigInt(env.VAULT_MAX_DURATION_SECONDS ?? (365 * 86_400).toString()),
  };

  return {
    mint,
    arioCoreProgram,
    floatPolicy,
    vaultDurations,
    antRequiresApproval: (env.ANT_REQUIRES_APPROVAL ?? "true") !== "false",
    pollIntervalMs: parseInt(env.DISPATCH_POLL_INTERVAL_MS ?? "5000", 10),
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
  const ant = await loadSigner("ant", env);
  return { token, ant };
}
