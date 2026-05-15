//! Runtime configuration for the attestor service.
//!
//! Required env vars:
//!   ATTESTOR_SECRET_BASE58 — 32-byte Ed25519 secret seed, base58-encoded.
//!                            Generate with `yarn keygen`.
//!   NETWORK                — "solana-mainnet" | "solana-devnet" | "localnet".
//!                            Must match the on-chain program's NETWORK
//!                            constant; baked into the canonical message.
//!
//! Optional:
//!   PORT                  — HTTP port (default 3030)
//!   LOG_LEVEL             — pino log level (default "info")
//!   RATE_LIMIT_PER_MIN    — per-IP request budget per minute (default 30)

import bs58 from "bs58";

import { loadAttestorKeypair, type AttestorKeypair } from "./attest.js";

export interface Config {
  port: number;
  logLevel: string;
  rateLimitPerMinute: number;
  /** System-wide concurrent RSA-PSS verifications. Bounds CPU under
   *  DoS — rate limiter caps per-IP, but a botnet can fan out across
   *  IPs. Default 10 yields ~50ms p99 on a $5/mo VPS. F-2. */
  maxConcurrentVerifies: number;
  network: string;
  attestor: AttestorKeypair;
}

export function loadConfig(): Config {
  const secretBase58 = required("ATTESTOR_SECRET_BASE58");
  const network = required("NETWORK");

  const validNetworks = ["solana-mainnet", "solana-devnet", "localnet"];
  if (!validNetworks.includes(network)) {
    throw new Error(
      `NETWORK must be one of ${validNetworks.join(", ")}, got "${network}"`,
    );
  }

  const secretSeed = bs58.decode(secretBase58);
  if (secretSeed.length !== 32) {
    throw new Error(
      `ATTESTOR_SECRET_BASE58 must decode to 32 bytes, got ${secretSeed.length}`,
    );
  }
  const attestor = loadAttestorKeypair(secretSeed);

  return {
    port: parseInt(process.env.PORT ?? "3030", 10),
    logLevel: process.env.LOG_LEVEL ?? "info",
    rateLimitPerMinute: parseInt(process.env.RATE_LIMIT_PER_MIN ?? "30", 10),
    maxConcurrentVerifies: parseInt(process.env.MAX_CONCURRENT_VERIFIES ?? "10", 10),
    network,
    attestor,
  };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`missing required env var: ${name}`);
  }
  return v;
}
