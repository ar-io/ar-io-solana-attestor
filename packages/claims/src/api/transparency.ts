//! Transparency HTTP handlers (M6, pivot plan §4.1 ops/transparency + §6.5).
//!
//!   GET /v1/transparency/ledger[?full=1]        — signed ledger manifest (+leaves)
//!   GET /v1/transparency/ledger/proof?assetKey=  — membership proof vs signed root
//!   GET /v1/transparency/log[?sinceSeq=&limit=]  — audit-log pages + chain head
//!   GET /v1/transparency/anchors[?kind=&limit=]  — recorded on-chain anchors
//!   GET /v1/transparency/reserves                — live holdings vs liability
//!
//! Read-only. Business rules live in the transparency modules; this is transport
//! + shaping. Money is emitted as decimal strings (never JS numbers).

import type { Pool } from "pg";
import type { Rpc, SolanaRpcApi } from "@solana/kit";

import { ApiError } from "./errors.js";
import type { ChainGateway } from "../dispatch/chain.js";
import { proveMembership, verifyMembership } from "../transparency/ledger-artifact.js";
import {
  getAnchors,
  getLatestPublishedLedger,
  getPublishedLedgerById,
  type AnchorRecord,
  type StoredLedger,
} from "../transparency/store.js";
import { getAuditHead, loadAuditRows } from "../transparency/audit-chain.js";
import { computeReserves } from "../transparency/reserves.js";
import type { TransparencyConfig } from "../transparency/config.js";

/** GET /v1/transparency/ledger — the signed manifest (+leaves when full). */
export async function getPublishedLedger(pool: Pool, opts: { full?: boolean; id?: string } = {}): Promise<unknown> {
  const latest: StoredLedger | null = opts.id
    ? await getPublishedLedgerById(pool, opts.id)
    : await getLatestPublishedLedger(pool);
  if (!latest) throw new ApiError(404, "NO_LEDGER_PUBLISHED", "no ledger has been published yet");
  const { artifact } = latest;
  const base = {
    id: latest.id,
    publishedAt: latest.createdAt,
    manifest: artifact.manifest,
    signatureHex: artifact.signatureHex,
    publisherPubkeyHex: artifact.publisherPubkeyHex,
  };
  return opts.full ? { ...base, leaves: artifact.leaves } : base;
}

/** GET /v1/transparency/ledger/proof?assetKey= — membership proof + self-check. */
export async function getLedgerProof(pool: Pool, assetKey: string, id?: string): Promise<unknown> {
  if (!assetKey) throw new ApiError(400, "INVALID_REQUEST", "assetKey is required");
  const latest = id ? await getPublishedLedgerById(pool, id) : await getLatestPublishedLedger(pool);
  if (!latest) throw new ApiError(404, "NO_LEDGER_PUBLISHED", "no ledger has been published yet");
  let membership;
  try {
    membership = proveMembership(latest.artifact, assetKey);
  } catch {
    throw new ApiError(404, "ASSET_NOT_IN_LEDGER", `asset ${assetKey} is not in the committed ledger`);
  }
  return {
    ledgerVersion: latest.artifact.manifest.ledgerVersion,
    rootHex: latest.artifact.manifest.rootHex,
    signatureHex: latest.artifact.signatureHex,
    publisherPubkeyHex: latest.artifact.publisherPubkeyHex,
    assetKey: membership.assetKey,
    leaf: membership.leaf,
    leafHashHex: membership.leafHashHex,
    proof: membership.proof,
    // Convenience self-check against the manifest root (a third party re-runs it).
    verifiesAgainstRoot: verifyMembership(membership, latest.artifact.manifest.rootHex),
  };
}

/**
 * Clamp a caller-supplied limit into `[1, max]`, defaulting a missing/non-finite
 * value (e.g. `parseInt("abc") == NaN`) to `def`. Without this a bad `?limit=`
 * query flows through as `NaN` and reaches the SQL as `LIMIT NaN` -> a 500.
 */
function clampLimit(limit: number | undefined, def: number, max: number): number {
  const n = limit === undefined || !Number.isFinite(limit) ? def : Math.floor(limit);
  return Math.min(Math.max(n, 1), max);
}

/** GET /v1/transparency/log — audit-log page + current head. */
export async function getAuditLog(pool: Pool, opts: { sinceSeq?: string; limit?: number } = {}): Promise<unknown> {
  const limit = clampLimit(opts.limit, 200, 1000);
  const rows = await loadAuditRows(pool, { sinceSeq: opts.sinceSeq ?? "0", limit });
  const head = await getAuditHead(pool);
  return {
    head,
    count: rows.length,
    entries: rows.map((r) => ({
      seq: r.seq,
      prevHashHex: r.prevHash.toString("hex"),
      entryHashHex: r.entryHash.toString("hex"),
      signatureHex: r.signature.toString("hex"),
      entry: r.entry,
    })),
  };
}

/** GET /v1/transparency/anchors — recorded on-chain anchors. */
export async function getAnchorList(
  pool: Pool,
  opts: { kind?: "audit-head" | "ledger-root"; limit?: number } = {},
): Promise<{ anchors: AnchorRecord[] }> {
  const anchors = await getAnchors(pool, { kind: opts.kind, limit: clampLimit(opts.limit, 50, 500) });
  return { anchors };
}

export interface ReservesDeps {
  pool: Pool;
  gateway: ChainGateway;
  rpc: Rpc<SolanaRpcApi>;
  tconfig: TransparencyConfig;
  network: string;
}

/** GET /v1/transparency/reserves — live holdings vs ledger liability. */
export async function getReserves(deps: ReservesDeps): Promise<unknown> {
  const { tconfig } = deps;
  if (!tconfig.mint || !tconfig.hotDispenser) {
    throw new ApiError(
      503,
      "RESERVES_NOT_CONFIGURED",
      "reserves endpoint needs ARIO_MINT + TREASURY_ADDRESS configured",
    );
  }
  return computeReserves({
    pool: deps.pool,
    gateway: deps.gateway,
    rpc: deps.rpc,
    network: deps.network,
    mint: tconfig.mint,
    hotDispenser: tconfig.hotDispenser,
    coldReserve: tconfig.coldReserve,
    antAuthority: tconfig.antAuthority,
    antCheck: tconfig.antCheck,
  });
}

/** Compact transparency status for /health/ready (best-effort). */
export async function getTransparencyStatus(
  pool: Pool,
): Promise<{ ledgerRootHash: string | null; auditLogHead: { seq: string; entryHashHex: string } | null }> {
  const [latest, head] = await Promise.all([getLatestPublishedLedger(pool), getAuditHead(pool)]);
  return {
    ledgerRootHash: latest ? latest.rootHex : null,
    auditLogHead: head,
  };
}
