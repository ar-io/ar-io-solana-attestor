//! Diff the BUILT ledger (from Postgres or from the in-memory plan) against the
//! INDEPENDENT authoritative would-be-deposit set (src/reconcile/authoritative.ts)
//! and produce a bit-exact PASS/FAIL report. Compared tuple per asset:
//! (assetType, assetKey, amount, recipient bytes).

import type { Pool } from "pg";
import type { LedgerPlan } from "../ledger/types.js";
import type { AssetType, AuthoritativeResult } from "./authoritative.js";

export interface BuiltAsset {
  assetType: AssetType;
  assetKey: string;
  amount: bigint | null;
  recipientHex: string;
}

export interface Diff {
  assetKey: string;
  reason: "missing_in_built" | "extra_in_built" | "type_mismatch" | "amount_mismatch" | "recipient_mismatch";
  detail: string;
}

export interface ReconcileReport {
  pass: boolean;
  builtCount: number;
  authoritativeCount: number;
  matched: number;
  diffs: Diff[];
  builtSeedCounts: { ant: number; token: number; vault: number };
  authoritativeSeedCounts: { ant: number; token: number; vault: number };
  builtTotalMario: bigint;
  authoritativeTotalMario: bigint;
}

/** Build the comparison set from the in-memory plan (available assets only). */
export function builtSetFromPlan(plan: LedgerPlan): Map<string, BuiltAsset> {
  const srcToPub = new Map(
    plan.recipients.map((r) => [
      r.sourceAddress,
      r.recipientPubkey ? Buffer.from(r.recipientPubkey).toString("hex") : "",
    ]),
  );
  const out = new Map<string, BuiltAsset>();
  for (const a of plan.assets) {
    if (a.status !== "available") continue;
    out.set(a.assetKey, {
      assetType: a.assetType,
      assetKey: a.assetKey,
      amount: a.amount,
      recipientHex: srcToPub.get(a.recipientSource) ?? "",
    });
  }
  return out;
}

/** Build the comparison set from the persisted ledger (available assets only). */
export async function builtSetFromDb(pool: Pool): Promise<Map<string, BuiltAsset>> {
  const { rows } = await pool.query<{
    asset_key: string;
    asset_type: AssetType;
    amount: string | null;
    recipient_pubkey: Buffer | null;
  }>(
    `SELECT a.asset_key, a.asset_type, a.amount, r.recipient_pubkey
       FROM assets a JOIN recipients r ON r.recipient_id = a.recipient_id
      WHERE a.status = 'available'`,
  );
  const out = new Map<string, BuiltAsset>();
  for (const row of rows) {
    out.set(row.asset_key, {
      assetType: row.asset_type,
      assetKey: row.asset_key,
      amount: row.amount === null ? null : BigInt(row.amount),
      recipientHex: row.recipient_pubkey ? row.recipient_pubkey.toString("hex") : "",
    });
  }
  return out;
}

function seedCounts(entries: Iterable<{ assetType: AssetType }>): {
  ant: number;
  token: number;
  vault: number;
} {
  const c = { ant: 0, token: 0, vault: 0 };
  for (const e of entries) c[e.assetType]++;
  return c;
}

function sumMario(entries: Iterable<{ amount: bigint | null }>): bigint {
  let s = 0n;
  for (const e of entries) if (e.amount !== null) s += e.amount;
  return s;
}

export function reconcile(
  built: Map<string, BuiltAsset>,
  authoritative: AuthoritativeResult,
  maxDiffs = 50,
): ReconcileReport {
  const auth = authoritative.deposits;
  const diffs: Diff[] = [];
  let matched = 0;

  for (const [key, a] of auth) {
    const b = built.get(key);
    if (!b) {
      diffs.push({
        assetKey: key,
        reason: "missing_in_built",
        detail: `authoritative ${a.assetType} amount=${a.amount} not present as an available built asset`,
      });
      continue;
    }
    if (b.assetType !== a.assetType) {
      diffs.push({
        assetKey: key,
        reason: "type_mismatch",
        detail: `built=${b.assetType} authoritative=${a.assetType}`,
      });
    } else if ((b.amount ?? null) !== (a.amount ?? null)) {
      diffs.push({
        assetKey: key,
        reason: "amount_mismatch",
        detail: `built=${b.amount} authoritative=${a.amount}`,
      });
    } else if (b.recipientHex !== a.recipientHex) {
      diffs.push({
        assetKey: key,
        reason: "recipient_mismatch",
        detail: `built ${b.recipientHex.length / 2}B != authoritative ${a.recipientHex.length / 2}B (first16 built=${b.recipientHex.slice(0, 32)} auth=${a.recipientHex.slice(0, 32)})`,
      });
    } else {
      matched++;
    }
  }
  for (const [key, b] of built) {
    if (!auth.has(key)) {
      diffs.push({
        assetKey: key,
        reason: "extra_in_built",
        detail: `built ${b.assetType} amount=${b.amount} has no authoritative counterpart`,
      });
    }
  }

  const capped = diffs.slice(0, maxDiffs);
  return {
    pass: diffs.length === 0 && built.size === auth.size,
    builtCount: built.size,
    authoritativeCount: auth.size,
    matched,
    diffs: capped,
    builtSeedCounts: seedCounts(built.values()),
    authoritativeSeedCounts: authoritative.onchainSeedCounts,
    builtTotalMario: sumMario(built.values()),
    authoritativeTotalMario: sumMario(auth.values()),
  };
}

/**
 * The published M1 gate numbers are an EXTERNAL oracle (the frozen dry-run
 * capture in MAINNET_ESCROW_CHECKPOINT_2026-07-09.md) and are valid ONLY at the
 * instant they were captured. The vault/stake liquid-vs-vault split is
 * time-dependent (lock = unlock - now), so these counts hold iff the build's
 * `nowMs` equals `NOW_MS` below. `gateAppliesAt(nowMs)` makes that coupling
 * explicit and fail-loud: at any other pin the CLI SKIPS the hardcoded-number
 * oracle (loudly) and relies on the bit-exact builder-vs-authoritative diff,
 * which is nowMs-agnostic (both sides use the same pin). This prevents a silent
 * mismatch if a cutover re-pins nowMs.
 */
export const EXPECTED_GATE = {
  /** The reference instant these counts were captured at (2026-07-10T00:00:00Z). */
  nowMs: 1783641600000,
  ant: 2269,
  tokenEscrowed: 5374,
  vaultEscrowed: 111,
  stakeEscrowed: 2957,
  total: 10711,
  atRisk: 136,
  phase2TokenOutflowMario: 48264957232031n,
} as const;

/** True iff the published gate numbers apply at this `nowMs` pin. */
export function gateAppliesAt(nowMs: number): boolean {
  return nowMs === EXPECTED_GATE.nowMs;
}
