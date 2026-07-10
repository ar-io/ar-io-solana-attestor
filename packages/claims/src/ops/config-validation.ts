//! Boot-time configuration validation (M7 ops hardening).
//!
//! Fails FAST (before the service takes traffic or the worker moves money) on the
//! misconfigs that would otherwise be silent-but-fatal in production:
//!
//!   1. Single-consistent CONFIRM RPC — exactly-once dispatch relies on the
//!      confirmation reads (getSignatureStatuses + getBlockHeight) hitting ONE
//!      consistent endpoint. A load-balanced / round-robin pool can misclassify a
//!      landed tx as dead and DOUBLE-SEND (M4 carry-forward). Pooled-looking →
//!      ERROR (the runtime `assertSingleConfirmRpc` only warns; boot is strict).
//!   2. The FIVE distinct keys — attestor, treasury, ANT-cold, audit,
//!      ledger-publisher must have separable blast radii. Any two sharing an
//!      address is a fatal key-reuse (guards enforce it at use-time; boot catches
//!      it earlier from whatever public addresses env exposes).
//!   3. Required env per role (api / worker / ops).
//!   4. Network sanity — NETWORK must be valid AND consistent with the RPC host
//!      (mainnet NETWORK on a devnet RPC, or vice-versa, is a deploy-target
//!      mistake). On mainnet, bare `*_SEED_BASE64` key material is rejected (keys
//!      must be sealed at rest).
//!
//! Pure over an env map (no I/O) so it unit-tests deterministically and can run in
//! CI. `assertBootConfig` throws a single aggregated error listing every problem.

import bs58 from "bs58";
import { Buffer } from "node:buffer";

export type Role = "api" | "worker" | "ops";
export type ProblemLevel = "error" | "warning";

export interface ConfigProblem {
  level: ProblemLevel;
  code: string;
  message: string;
}

export interface BootValidationResult {
  ok: boolean;
  errors: ConfigProblem[];
  warnings: ConfigProblem[];
}

const VALID_NETWORKS = ["solana-mainnet", "solana-devnet", "localnet"] as const;

/** Heuristic: does a URL look like a multi-endpoint / load-balanced pool? */
export function looksPooled(url: string): boolean {
  return url.includes(",") || /(^|[^a-z])(lb|pool|round[-_]?robin)([^a-z]|$)/i.test(url);
}

/** Normalize a key to a base58 address for cross-comparison (hex → base58). */
function toAddress(label: string, value: string): { label: string; address: string } | { label: string; error: string } {
  const v = value.trim();
  // 64-hex → 32-byte pubkey → base58.
  if (/^[0-9a-fA-F]{64}$/.test(v)) {
    return { label, address: bs58.encode(Buffer.from(v, "hex")) };
  }
  // Otherwise assume it's already a base58 address; sanity-check it decodes to 32 bytes.
  try {
    const dec = bs58.decode(v);
    if (dec.length !== 32) return { label, error: `${label} is not a 32-byte address (got ${dec.length} bytes)` };
    return { label, address: v };
  } catch {
    return { label, error: `${label} is not valid hex or base58` };
  }
}

/** Gather every key/identity address env exposes, labeled by role. */
function gatherKeyAddresses(env: NodeJS.ProcessEnv): { addrs: { label: string; address: string }[]; errors: ConfigProblem[] } {
  const sources: [string, string | undefined][] = [
    ["treasury", env.TREASURY_ADDRESS],
    ["attestor", env.ATTESTOR_PUBKEY_BASE58 ?? env.ATTESTOR_PUBKEY_HEX],
    ["audit", env.AUDIT_PUBKEY_HEX ?? env.AUDIT_ADDRESS],
    ["ledger-publisher", env.LEDGER_PUBLISHER_PUBKEY_HEX ?? env.LEDGER_PUBLISHER_ADDRESS],
    ["ant-cold", env.ANT_COLD_ADDRESS],
  ];
  const addrs: { label: string; address: string }[] = [];
  const errors: ConfigProblem[] = [];
  for (const [label, value] of sources) {
    if (!value) continue;
    const r = toAddress(label, value);
    if ("error" in r) errors.push({ level: "error", code: "KEY_ADDRESS_INVALID", message: r.error });
    else addrs.push(r);
  }
  return { addrs, errors };
}

export function validateBootConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: { role?: Role } = {},
): BootValidationResult {
  const role = opts.role ?? "api";
  const errors: ConfigProblem[] = [];
  const warnings: ConfigProblem[] = [];
  const err = (code: string, message: string): void => void errors.push({ level: "error", code, message });
  const warn = (code: string, message: string): void => void warnings.push({ level: "warning", code, message });

  // -- Network sanity -------------------------------------------------------
  const network = env.NETWORK ?? "localnet";
  if (!(VALID_NETWORKS as readonly string[]).includes(network)) {
    err("NETWORK_INVALID", `NETWORK must be one of ${VALID_NETWORKS.join(", ")}, got "${network}"`);
  }
  const rpc = env.SOLANA_RPC_URL;
  const confirmRpc = env.CONFIRM_RPC_URL ?? rpc;
  const isMainnet = network === "solana-mainnet";
  const isDevnet = network === "solana-devnet";
  const hostHints = `${rpc ?? ""} ${confirmRpc ?? ""}`.toLowerCase();
  if (isMainnet && (hostHints.includes("devnet") || hostHints.includes("testnet"))) {
    err("NETWORK_RPC_MISMATCH", `NETWORK=solana-mainnet but an RPC URL points at devnet/testnet (${hostHints.trim()})`);
  }
  if (isDevnet && hostHints.includes("mainnet")) {
    err("NETWORK_RPC_MISMATCH", `NETWORK=solana-devnet but an RPC URL points at mainnet (${hostHints.trim()})`);
  }

  // -- Single-consistent CONFIRM RPC (fatal for the worker; warn elsewhere) --
  if (confirmRpc && looksPooled(confirmRpc)) {
    const msg =
      `CONFIRM RPC "${confirmRpc}" looks like a load-balanced / multi-endpoint pool. ` +
      "Exactly-once dispatch REQUIRES a single consistent endpoint (or a read quorum) — " +
      "a lagging replica can misclassify a landed tx as dead and DOUBLE-SEND.";
    if (role === "worker") err("CONFIRM_RPC_POOLED", msg);
    else warn("CONFIRM_RPC_POOLED", msg);
  }
  if (role === "worker" && !confirmRpc) {
    err("CONFIRM_RPC_MISSING", "the dispatch worker needs CONFIRM_RPC_URL (or SOLANA_RPC_URL) set to a single consistent endpoint");
  }

  // -- The FIVE distinct keys ----------------------------------------------
  const { addrs, errors: addrErrors } = gatherKeyAddresses(env);
  errors.push(...addrErrors);
  const seen = new Map<string, string>();
  for (const { label, address } of addrs) {
    const clash = seen.get(address);
    if (clash) {
      err(
        "KEY_REUSE",
        `the ${label} key reuses the ${clash} address (${address}); attestor / treasury / ANT-cold / audit / ledger-publisher MUST be five distinct keys (separable blast radii)`,
      );
    } else {
      seen.set(address, label);
    }
  }

  // -- Mainnet: no bare seeds at rest --------------------------------------
  if (isMainnet) {
    for (const bare of ["TREASURY_SEED_BASE64", "ANT_SIGNER_SEED_BASE64", "AUDIT_SEED_BASE64", "LEDGER_PUBLISHER_SEED_BASE64"]) {
      if (env[bare]) {
        err("MAINNET_BARE_SEED", `${bare} is set on NETWORK=solana-mainnet — production keys MUST be sealed at rest (…_KEY_SEALED_PATH + …_KEY_PASSPHRASE), not a bare seed`);
      }
    }
  }

  // -- Required env by role -------------------------------------------------
  if (role === "api" || role === "worker") {
    // DATABASE_URL has a dev default in config.ts; on a real network it MUST be explicit.
    if (!env.DATABASE_URL && network !== "localnet") {
      err("DATABASE_URL_MISSING", `DATABASE_URL must be set explicitly on NETWORK=${network} (the localnet default is dev-only)`);
    }
  }
  if (role === "worker") {
    if (!env.ARIO_MINT) err("ARIO_MINT_MISSING", "the dispatch worker needs ARIO_MINT (the ARIO SPL mint)");
    else {
      const r = toAddress("ARIO_MINT", env.ARIO_MINT);
      if ("error" in r) err("ARIO_MINT_INVALID", r.error);
    }
    const hasSealed = env.TREASURY_KEY_SEALED_PATH && env.TREASURY_KEY_PASSPHRASE;
    const hasBare = env.TREASURY_SEED_BASE64;
    if (!hasSealed && !hasBare) {
      err("TREASURY_SIGNER_MISSING", "the dispatch worker needs a treasury signer: TREASURY_KEY_SEALED_PATH + TREASURY_KEY_PASSPHRASE (production) or TREASURY_SEED_BASE64 (localnet/tests)");
    }
  }
  if (role === "ops") {
    // Publish/anchor CLIs need the publisher key + (for reserves) the treasury/mint.
    const pubSealed = env.LEDGER_PUBLISHER_KEY_SEALED_PATH && env.LEDGER_PUBLISHER_KEY_PASSPHRASE;
    if (!pubSealed && !env.LEDGER_PUBLISHER_SEED_BASE64) {
      warn("PUBLISHER_KEY_MISSING", "publish/anchor need the LEDGER_PUBLISHER key (…_KEY_SEALED_PATH + …_KEY_PASSPHRASE, or …_SEED_BASE64 for localnet)");
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export class BootConfigError extends Error {
  readonly problems: ConfigProblem[];
  constructor(errors: ConfigProblem[]) {
    super(
      "boot config validation failed:\n" +
        errors.map((e) => `  [${e.code}] ${e.message}`).join("\n"),
    );
    this.name = "BootConfigError";
    this.problems = errors;
  }
}

/**
 * Validate and THROW on any error (fail-fast at boot). Warnings are returned so
 * the caller can log them via pino. `log` receives each warning as it's found.
 */
export function assertBootConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: { role?: Role; log?: (level: ProblemLevel, code: string, message: string) => void } = {},
): BootValidationResult {
  const result = validateBootConfig(env, opts);
  if (opts.log) {
    for (const w of result.warnings) opts.log("warning", w.code, w.message);
    for (const e of result.errors) opts.log("error", e.code, e.message);
  }
  if (!result.ok) throw new BootConfigError(result.errors);
  return result;
}
