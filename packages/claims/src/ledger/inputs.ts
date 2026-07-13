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

/**
 * KNOWN-GOOD fingerprints of the FROZEN inputs (MED-C). The loader already
 * COMPUTES these per file; without a pinned baseline to compare against, a
 * tampered frozen INPUT (e.g. an insider inflating a vault/stake `amountMario`)
 * sails through — the ledger builder AND the "independent" authoritative
 * reconciler both read the same poisoned file, so the bit-exact diff still
 * matches. Pinning the sha256 here and asserting it at load time is the fail-
 * closed tripwire: any byte change to a frozen input aborts the build/reconcile.
 *
 * Values captured from the canonical frozen dir
 * `/programs/ario-snapshot/output-mainnet-prod-remediation` on 2026-07-13.
 * The `ants/` entry is NOT a file hash — it is the loader's digest of the sorted
 * (processId, Owner) pairs across the per-ANT files (see below).
 *
 * REGENERATE (only if the frozen inputs are ever LEGITIMATELY re-frozen): run a
 * one-off load and copy `inputs.fingerprints` verbatim, e.g.
 *   node --import tsx -e "import('./src/ledger/inputs.ts').then(m=> \
 *     console.log(m.loadFrozenInputs(process.env.FROZEN_INPUTS_DIR)).fingerprints)"
 * or set ALLOW_UNPINNED_FROZEN_INPUTS=1 to bypass the assertion for a one-off
 * (a loud stderr warning is printed; never use it on the production claim path).
 * These are content hashes only — they do NOT depend on ANT_MINT_SECRET.
 */
export const KNOWN_GOOD_FINGERPRINTS: Readonly<Record<string, string>> = {
  "address-map.json": "37afcf0597c41f31ffa850caefab528dca012fe30f0d0c687a4dde3c7eba013f",
  "escrow-recipient-modulus.json": "452760ea0639325a5c3a7741d30ae0b9d803332b98172268ee9f89cfc9831238",
  "escrow-recipient-AT-RISK.json": "9e944a648a7fd3471bf1874c2ce1a4e7b759b976d220df705da37b910b73f004",
  "snapshot-summary.json": "a0db150107daa57a85c516ef617ad356b835eb0dead2c96008e64d76e7411d8c",
  "raw-vaults.json": "99e0027c20cad50f597810bfae27d4d49c061ba384c1f3ee84a7d94d838f6301",
  "delivery-escrow-plan.json": "e57f198f2010a368046c579da9c404e42644887f92057084d709945999577e7d",
  "ants/": "613dbeab4f9b478a0878ef7ce6d132c70f011889d823c01fc788a053b6ad24b2",
} as const;

/**
 * Fail-closed comparison of freshly-COMPUTED input fingerprints against the
 * pinned KNOWN-GOOD set. Throws on the FIRST divergence (a changed hash, a
 * missing pinned key, or an unexpected extra key). Pure + exported so the
 * tamper-detection is unit-testable without staging the ~20MB frozen dir.
 * Set ALLOW_UNPINNED_FROZEN_INPUTS=1 to bypass (loud warning) after a
 * legitimate re-freeze.
 */
export function assertKnownGoodFingerprints(
  computed: Record<string, string>,
  expected: Readonly<Record<string, string>> = KNOWN_GOOD_FINGERPRINTS,
): void {
  if (process.env.ALLOW_UNPINNED_FROZEN_INPUTS === "1") {
    process.stderr.write(
      "[inputs] WARNING: ALLOW_UNPINNED_FROZEN_INPUTS=1 — frozen-input fingerprint " +
        "assertion BYPASSED. Only valid for a deliberate re-freeze; never on the " +
        "production claim path.\n",
    );
    return;
  }
  const problems: string[] = [];
  for (const [name, exp] of Object.entries(expected)) {
    const got = computed[name];
    if (got === undefined) {
      problems.push(`missing computed fingerprint for pinned input "${name}"`);
    } else if (got !== exp) {
      problems.push(`fingerprint mismatch for "${name}": got ${got}, expected ${exp}`);
    }
  }
  for (const name of Object.keys(computed)) {
    if (!(name in expected)) {
      problems.push(`unexpected input "${name}" not in the pinned known-good set`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      "frozen-input fingerprint assertion FAILED — a frozen input has been " +
        "tampered with or the pinned set is stale (MED-C fail-closed):\n  " +
        problems.join("\n  ") +
        "\nIf the inputs were LEGITIMATELY re-frozen, update KNOWN_GOOD_FINGERPRINTS " +
        "in src/ledger/inputs.ts (or set ALLOW_UNPINNED_FROZEN_INPUTS=1 for a one-off).",
    );
  }
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

  // Fail-closed tripwire: the computed fingerprints MUST match the pinned
  // known-good set, else a tampered frozen input would pass reconcile silently
  // (both builder and authoritative reconciler read the same poisoned file).
  assertKnownGoodFingerprints(fingerprints);

  return { dir, addressMap, modulus, atRisk, balances, vaults, ants, plan, fingerprints };
}
