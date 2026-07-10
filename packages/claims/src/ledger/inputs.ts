//! Frozen-input loaders for the M1 ledger build.
//!
//! All inputs live in the mainnet capture dir
//! `/programs/ario-snapshot/output-mainnet-prod-remediation/` (override with
//! FROZEN_INPUTS_DIR). Everything here is a pure read of on-disk JSON — no RPC,
//! no GraphQL. Mirrors batch-escrow's own loaders:
//!   - balances  <- snapshot-summary.json (balance>0), AO self-balance excluded
//!   - vaults    <- raw-vaults.json
//!   - ants      <- ants/<processId>.json (ant-mint-map.json / failed-ants.json skipped)
//!   - modulus   <- escrow-recipient-modulus.json (frozen RSA moduli, base64url)
//!   - at-risk   <- escrow-recipient-AT-RISK.json
//!   - addr-map  <- address-map.json (normalized proxy; ETH case-insensitive)
//!   - plan      <- delivery-escrow-plan.json (stake/withdrawal)

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeNormalizedAddressMap } from "./normalize.js";
import type { PlanArtifact } from "./stake-extract.js";

/**
 * The AR.IO AO process id. Its OWN balance is the protocol reward reserve, not
 * a claimable user balance — excluded from token escrow (mirrors batch-escrow +
 * the snapshot's transformBalances). Env-overridable.
 */
export const AO_PROCESS_ID =
  process.env.AO_PROCESS_ID || "qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE";

export interface AntSnapshot {
  processId: string;
  Owner: string;
}

export interface AoVault {
  balance: number;
  startTimestamp: number;
  endTimestamp: number;
  controller?: string;
}
/** owner -> { vaultId -> vault } */
export type AoVaults = Record<string, Record<string, AoVault>>;

interface SnapshotSummaryEntry {
  balance: number;
}

export interface FrozenInputs {
  dir: string;
  /** normalized address-map: presence => MAPPED (delivered directly, not escrowed). */
  addressMap: Record<string, string>;
  /** Arweave address -> base64url RSA modulus (512-byte). */
  modulus: Record<string, string>;
  /** owners with no recoverable key (manual_review). */
  atRisk: Set<string>;
  /** address -> mARIO balance (positive, AO self-balance excluded). */
  balances: Record<string, number>;
  vaults: AoVaults;
  ants: AntSnapshot[];
  plan: PlanArtifact;
  fingerprints: Record<string, string>;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

export function loadFrozenInputs(dir: string): FrozenInputs {
  const req = (name: string): string => {
    const p = join(dir, name);
    if (!existsSync(p)) {
      throw new Error(`frozen input missing: ${p}`);
    }
    return p;
  };

  const fingerprints: Record<string, string> = {};

  const addrMapPath = req("address-map.json");
  const rawAddressMap = readJson<Record<string, string>>(addrMapPath);
  fingerprints["address-map.json"] = sha256File(addrMapPath);
  const addressMap = makeNormalizedAddressMap(rawAddressMap);

  const modulusPath = req("escrow-recipient-modulus.json");
  const modulus = readJson<Record<string, string>>(modulusPath);
  fingerprints["escrow-recipient-modulus.json"] = sha256File(modulusPath);

  const atRiskPath = req("escrow-recipient-AT-RISK.json");
  const atRiskArr = readJson<string[]>(atRiskPath);
  fingerprints["escrow-recipient-AT-RISK.json"] = sha256File(atRiskPath);
  const atRisk = new Set(atRiskArr);

  // Balances: snapshot-summary.json (batch-escrow's fallback source; the frozen
  // dir has no ao-state.json). Positive only; AO self-balance excluded.
  const summaryPath = req("snapshot-summary.json");
  const summary = readJson<Record<string, SnapshotSummaryEntry>>(summaryPath);
  fingerprints["snapshot-summary.json"] = sha256File(summaryPath);
  const balances: Record<string, number> = {};
  for (const [addr, entry] of Object.entries(summary)) {
    if (entry && entry.balance > 0) balances[addr] = entry.balance;
  }
  if (AO_PROCESS_ID in balances) delete balances[AO_PROCESS_ID];

  const vaultsPath = req("raw-vaults.json");
  const vaults = readJson<AoVaults>(vaultsPath);
  fingerprints["raw-vaults.json"] = sha256File(vaultsPath);

  const planPath = req("delivery-escrow-plan.json");
  const plan = readJson<PlanArtifact>(planPath);
  fingerprints["delivery-escrow-plan.json"] = sha256File(planPath);

  // ANTs: one file per processId; skip the two diagnostic files.
  const antsDir = join(dir, "ants");
  if (!existsSync(antsDir)) {
    throw new Error(`ANT snapshots directory not found: ${antsDir}`);
  }
  const files = readdirSync(antsDir).filter(
    (f) =>
      f.endsWith(".json") &&
      f !== "ant-mint-map.json" &&
      f !== "failed-ants.json",
  );
  const ants: AntSnapshot[] = [];
  for (const f of files) {
    const raw = readJson<AntSnapshot>(join(antsDir, f));
    ants.push({ processId: raw.processId, Owner: raw.Owner });
  }
  // Fingerprint the ANT set by its count + a hash of the sorted (processId,Owner)
  // pairs — hashing 3k files individually is noise; this pins the exact input.
  const antDigest = createHash("sha256");
  for (const a of [...ants].sort((x, y) => (x.processId < y.processId ? -1 : 1))) {
    antDigest.update(`${a.processId}\t${a.Owner}\n`);
  }
  fingerprints["ants/"] = antDigest.digest("hex");

  return { dir, addressMap, modulus, atRisk, balances, vaults, ants, plan, fingerprints };
}
