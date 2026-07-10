//! Proof-of-holdings / reserves (M6 deliverable #3, pivot plan §6.5.3).
//!
//! Reports the custodian's LIVE on-chain holdings against the OUTSTANDING
//! liability from the ledger, so anyone can check holdings >= liabilities:
//!
//!   RESERVE side  (read live via @solana/kit — never DB-asserted):
//!     * hot ARIO float      = SPL balance of the treasury dispenser ATA
//!     * cold reserve        = SPL balance of the cold reserve owner's ATA
//!     * ANT holdings        = ANTs whose on-chain Owner == the authority
//!                             (sampled from the outstanding ANT mints, or a full
//!                             getProgramAccounts count when the RPC allows it)
//!   LIABILITY side (from the ledger DB):
//!     * outstanding mARIO   = Σ token/vault amount not yet claimed/cancelled
//!     * outstanding ANTs    = count of ANT assets not yet claimed/cancelled
//!
//! Money is integer mARIO (bigint); serialized as decimal strings at the edge.

import { Buffer } from "node:buffer";
import type { Pool } from "pg";
import {
  getAddressDecoder,
  getAddressEncoder,
  type Address,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";

import type { ChainGateway } from "../dispatch/chain.js";
import { MPL_CORE_PROGRAM, getAssociatedTokenAddress } from "../dispatch/instructions.js";

export interface LedgerLiabilities {
  outstandingMario: bigint;
  claimedMario: bigint;
  totalMario: bigint;
  outstandingAnts: number;
  claimedAnts: number;
  totalAnts: number;
}

/**
 * Optional asset-key scope. Production omits it so the liability is measured over
 * the WHOLE ledger. A caller reporting a bounded tranche (per-batch ops) — or a
 * test sharing one Postgres with other suites — passes an explicit set so the
 * aggregate is measured against only its own rows and not poisoned by unrelated
 * ones. `null`/`undefined` == whole ledger; an empty array == no assets.
 */
export type AssetScope = readonly string[] | null | undefined;

function scopeParam(scope: AssetScope): string[] | null {
  return scope ? [...scope] : null;
}

/** Read the outstanding ARIO + ANT liability straight from the ledger tables. */
export async function readLiabilities(pool: Pool, scope?: AssetScope): Promise<LedgerLiabilities> {
  const r = await pool.query<{
    outstanding_mario: string;
    claimed_mario: string;
    total_mario: string;
    outstanding_ants: string;
    claimed_ants: string;
    total_ants: string;
  }>(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE asset_type IN ('token','vault') AND status NOT IN ('claimed','cancelled')),0)::text AS outstanding_mario,
       COALESCE(SUM(amount) FILTER (WHERE asset_type IN ('token','vault') AND status = 'claimed'),0)::text AS claimed_mario,
       COALESCE(SUM(amount) FILTER (WHERE asset_type IN ('token','vault') AND status <> 'cancelled'),0)::text AS total_mario,
       count(*) FILTER (WHERE asset_type = 'ant' AND status NOT IN ('claimed','cancelled'))::text AS outstanding_ants,
       count(*) FILTER (WHERE asset_type = 'ant' AND status = 'claimed')::text AS claimed_ants,
       count(*) FILTER (WHERE asset_type = 'ant' AND status <> 'cancelled')::text AS total_ants
     FROM assets
     WHERE ($1::text[] IS NULL OR asset_key = ANY($1::text[]))`,
    [scopeParam(scope)],
  );
  const row = r.rows[0];
  return {
    outstandingMario: BigInt(row.outstanding_mario),
    claimedMario: BigInt(row.claimed_mario),
    totalMario: BigInt(row.total_mario),
    outstandingAnts: Number(row.outstanding_ants),
    claimedAnts: Number(row.claimed_ants),
    totalAnts: Number(row.total_ants),
  };
}

const addrDecoder = getAddressDecoder();
const addrEncoder = getAddressEncoder();

/**
 * Read the on-chain Owner of an MPL Core asset. AssetV1 layout:
 * [key:u8][owner:Pubkey(32)][update_authority ...]. Returns null if absent.
 */
export async function readCoreOwner(rpc: Rpc<SolanaRpcApi>, asset: Address): Promise<Address | null> {
  const res = await rpc.getAccountInfo(asset, { encoding: "base64", dataSlice: { offset: 1, length: 32 } }).send();
  if (!res.value) return null;
  const raw = Buffer.from(res.value.data[0], "base64");
  if (raw.length < 32) return null;
  return addrDecoder.decode(raw) as Address;
}

export interface AntHoldingsSample {
  method: "sample" | "gpa";
  authority: string;
  /** How many outstanding ANT mints were checked on-chain. */
  checked: number;
  /** Of those, how many have Owner == authority. */
  matchingAuthority: number;
  /** Total outstanding ANT mints available to check. */
  outstandingTotal: number;
}

/** Sample up to `sampleSize` outstanding ANT mints and verify Owner == authority. */
export async function sampleAntHoldings(
  pool: Pool,
  rpc: Rpc<SolanaRpcApi>,
  authority: Address,
  sampleSize: number,
  scope?: AssetScope,
): Promise<AntHoldingsSample> {
  const scopeArr = scopeParam(scope);
  const r = await pool.query<{ ant_mint: string }>(
    `SELECT ant_mint FROM assets
      WHERE asset_type = 'ant' AND status NOT IN ('claimed','cancelled') AND ant_mint IS NOT NULL
        AND ($2::text[] IS NULL OR asset_key = ANY($2::text[]))
      ORDER BY asset_key LIMIT $1`,
    [sampleSize, scopeArr],
  );
  const total = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM assets
      WHERE asset_type = 'ant' AND status NOT IN ('claimed','cancelled')
        AND ($1::text[] IS NULL OR asset_key = ANY($1::text[]))`,
    [scopeArr],
  );
  let matching = 0;
  let checked = 0;
  for (const row of r.rows) {
    checked++;
    const owner = await readCoreOwner(rpc, row.ant_mint as Address);
    if (owner && owner === authority) matching++;
  }
  return {
    method: "sample",
    authority: authority as string,
    checked,
    matchingAuthority: matching,
    outstandingTotal: Number(total.rows[0].n),
  };
}

/**
 * Full ANT-under-owner count via getProgramAccounts + memcmp on the owner field
 * (offset 1). Heavy — many public RPCs disable gPA on large programs — so it is
 * opt-in; sampling is the default. Returns the count of MPL Core assets owned by
 * `authority`.
 */
export async function countCoreAssetsByOwner(rpc: Rpc<SolanaRpcApi>, authority: Address): Promise<number> {
  const ownerBytes = Buffer.from(addrEncoder.encode(authority));
  const res = await (rpc as unknown as {
    getProgramAccounts: (
      program: Address,
      cfg: unknown,
    ) => { send: () => Promise<unknown[]> };
  })
    .getProgramAccounts(MPL_CORE_PROGRAM, {
      encoding: "base64",
      dataSlice: { offset: 0, length: 0 },
      filters: [{ memcmp: { offset: 1, bytes: addrDecoder.decode(ownerBytes) as string, encoding: "base58" } }],
    })
    .send();
  return res.length;
}

export interface ReservesReport {
  network: string;
  generatedAt: string;
  mint: string;
  reserves: {
    hotDispenser: string;
    hotFloatMario: string;
    coldReserve: string | null;
    coldReserveMario: string;
    totalReserveMario: string;
    antHoldings: AntHoldingsSample | { method: "count"; authority: string; count: number } | null;
  };
  liabilities: {
    outstandingMario: string;
    claimedMario: string;
    totalLedgerMario: string;
    outstandingAnts: number;
    claimedAnts: number;
    totalAnts: number;
  };
  coverage: {
    /** totalReserve >= outstanding token/vault liability. */
    tokenVaultCovered: boolean;
    /** totalReserve - outstanding (mARIO; negative => shortfall). */
    surplusMario: string;
    /**
     * ANT coverage. A boolean ONLY under a full `gpa` count; under sampling it is
     * "sampled-only" (a partial sample proves the sampled few are owned, NOT that
     * holdings >= outstanding ANTs — it must NEVER read `true`); null when ANTs
     * were not checked.
     */
    antCovered: boolean | "sampled-only" | null;
  };
}

export interface ReservesInput {
  pool: Pool;
  gateway: ChainGateway;
  rpc?: Rpc<SolanaRpcApi>;
  network: string;
  mint: Address;
  hotDispenser: Address;
  /** Cold reserve OWNER address; its ATA balance is read live. */
  coldReserve?: Address;
  /** Authority whose ANT ownership is checked (defaults to hotDispenser). */
  antAuthority?: Address;
  /** 0 disables the ANT check; >0 samples that many; 'gpa' does a full count. */
  antCheck?: { mode: "off" } | { mode: "sample"; sampleSize: number } | { mode: "gpa" };
  /** Restrict the LEDGER-side liability aggregate to this asset-key set (per-batch
   *  reporting / test isolation). Omit for the whole ledger. See AssetScope. */
  assetScope?: AssetScope;
}

/** Compute the full reserves-vs-liabilities report. */
export async function computeReserves(input: ReservesInput): Promise<ReservesReport> {
  // Distinct-custody guard (mirrors keys.ts separation guards): summing the same
  // account as both hot float AND cold reserve DOUBLE-COUNTS one balance and can
  // report a false surplus that masks a real shortfall. Reject the misconfig.
  if (input.coldReserve && (input.coldReserve as string) === (input.hotDispenser as string)) {
    throw new Error(
      "reserves misconfig: coldReserve owner == hotDispenser — the same custody would be counted twice (false surplus). Use distinct addresses.",
    );
  }

  const hotAta = await getAssociatedTokenAddress(input.hotDispenser, input.mint);
  const [hotFloatMario, liabilities] = await Promise.all([
    input.gateway.getTokenBalance(hotAta),
    readLiabilities(input.pool, input.assetScope),
  ]);

  let coldReserveMario = 0n;
  if (input.coldReserve) {
    const coldAta = await getAssociatedTokenAddress(input.coldReserve, input.mint);
    // Defensive ATA dedupe: never add the hot ATA's balance a second time.
    if ((coldAta as string) !== (hotAta as string)) {
      coldReserveMario = await input.gateway.getTokenBalance(coldAta);
    }
  }
  const totalReserveMario = hotFloatMario + coldReserveMario;

  let antHoldings: ReservesReport["reserves"]["antHoldings"] = null;
  const antAuthority = input.antAuthority ?? input.hotDispenser;
  const antCheck = input.antCheck ?? { mode: "off" };
  if (input.rpc && antCheck.mode === "sample") {
    antHoldings = await sampleAntHoldings(input.pool, input.rpc, antAuthority, antCheck.sampleSize, input.assetScope);
  } else if (input.rpc && antCheck.mode === "gpa") {
    const count = await countCoreAssetsByOwner(input.rpc, antAuthority);
    antHoldings = { method: "count", authority: antAuthority as string, count };
  }

  const surplus = totalReserveMario - liabilities.outstandingMario;
  // ANT coverage may ONLY be asserted from a FULL count. A sample proves the
  // sampled few are owned, not that holdings >= outstanding ANTs -> "sampled-only".
  let antCovered: boolean | "sampled-only" | null = null;
  if (antHoldings) {
    if (antHoldings.method === "count") antCovered = antHoldings.count >= liabilities.outstandingAnts;
    else antCovered = "sampled-only";
  }

  return {
    network: input.network,
    generatedAt: new Date().toISOString(),
    mint: input.mint as string,
    reserves: {
      hotDispenser: input.hotDispenser as string,
      hotFloatMario: hotFloatMario.toString(),
      coldReserve: (input.coldReserve as string) ?? null,
      coldReserveMario: coldReserveMario.toString(),
      totalReserveMario: totalReserveMario.toString(),
      antHoldings,
    },
    liabilities: {
      outstandingMario: liabilities.outstandingMario.toString(),
      claimedMario: liabilities.claimedMario.toString(),
      totalLedgerMario: liabilities.totalMario.toString(),
      outstandingAnts: liabilities.outstandingAnts,
      claimedAnts: liabilities.claimedAnts,
      totalAnts: liabilities.totalAnts,
    },
    coverage: {
      tokenVaultCovered: totalReserveMario >= liabilities.outstandingMario,
      surplusMario: surplus.toString(),
      antCovered,
    },
  };
}
