//! Hot-float manager (M4, pivot plan §4.3).
//!
//! The hot dispenser ATA holds a bounded ARIO float (target ≤ 500k ≈ 1% of
//! liabilities). This module:
//!   * tracks the LIVE float balance (read from chain) minus the amount already
//!     committed to in-flight dispatches (verified/dispatching token+vault claims),
//!   * refuses a dispatch that would exceed the available float (the worker then
//!     leaves the claim queued and raises a refill-needed signal),
//!   * enforces the 500k cap (an over-cap balance is an operator misconfig — the
//!     hot key must never hold more than the cap),
//!   * enforces the >100k per-claim brake here too, DEFENSIVELY: a claim over the
//!     threshold is never auto-dispensed even if it somehow reached the worker
//!     without going through M3's pending_review routing (belt & suspenders).
//!
//! All amounts are integer mARIO (bigint).

import type { Pool, PoolClient } from "pg";
import type { Address } from "@solana/kit";
import type { ChainGateway } from "./chain.js";

export interface FloatPolicy {
  /** Hard cap on the hot float (mARIO). Balance must never exceed this. */
  capMario: bigint;
  /** Per-claim brake (mARIO): amount over this needs operator approval. */
  bigClaimThresholdMario: bigint;
  /** Raise refillNeeded when available float drops below this (mARIO). */
  refillThresholdMario: bigint;
}

export interface FloatStatus {
  /** Live hot ATA balance (mARIO). */
  balanceMario: bigint;
  /** mARIO committed to in-flight (verified + dispatching) token/vault dispatches. */
  reservedMario: bigint;
  /** balanceMario - reservedMario, floored at 0. */
  availableMario: bigint;
  capMario: bigint;
  /** available < refillThreshold => top up from cold (operator). */
  refillNeeded: boolean;
  /** balance > cap => operator overfunded the hot key (policy violation). */
  overCap: boolean;
}

/** Reason a dispatch is not permitted right now (null => permitted). */
export type FloatDenial =
  | { reason: "insufficient_float"; needMario: bigint; availableMario: bigint }
  | { reason: "exceeds_brake"; amountMario: bigint; thresholdMario: bigint };

export interface FloatManagerOptions {
  /**
   * Restrict the in-flight `reserved()` sum to this set of asset keys. Production
   * leaves it UNSET so the float is measured against EVERY in-flight token/vault
   * dispatch (the correct, conservative semantics — the hot ATA is one shared
   * pool). It exists so a caller that operates a bounded tranche of the ledger
   * (per-batch ops), or a test that shares one Postgres with other suites, can
   * measure the reserved draw against only its own assets and not be poisoned by
   * unrelated in-flight rows. Empty array == "no assets" (reserved is 0).
   */
  reservedAssetScope?: readonly string[];
}

export class FloatManager {
  #policy: FloatPolicy;
  #reservedAssetScope?: readonly string[];
  constructor(policy: FloatPolicy, opts: FloatManagerOptions = {}) {
    this.#policy = policy;
    this.#reservedAssetScope = opts.reservedAssetScope;
  }

  get policy(): FloatPolicy {
    return this.#policy;
  }

  /**
   * Sum mARIO already committed to in-flight dispatches — claims that will draw
   * down the hot ATA but haven't confirmed yet (so the balance hasn't dropped).
   * settlement_amount (actual mARIO to move) is preferred; falls back to the
   * asset amount. ANTs contribute 0. Optionally exclude one claim (the one being
   * evaluated) so we don't double-count it. When `reservedAssetScope` is set, the
   * sum is restricted to those asset keys (see FloatManagerOptions).
   */
  async reserved(db: Pool | PoolClient, excludeClaimId?: string): Promise<bigint> {
    // NULL scope => global (production). A non-null scope (possibly empty) filters
    // to exactly those asset keys — an empty scope yields 0 by construction.
    const scope = this.#reservedAssetScope ? [...this.#reservedAssetScope] : null;
    const r = await db.query<{ total: string | null }>(
      `SELECT COALESCE(SUM(COALESCE(c.settlement_amount, a.amount)), 0)::text AS total
         FROM claims c JOIN assets a ON a.asset_key = c.asset_key
        WHERE c.status IN ('verified', 'dispatching')
          AND a.asset_type IN ('token', 'vault')
          AND ($1::uuid IS NULL OR c.claim_id <> $1::uuid)
          AND ($2::text[] IS NULL OR a.asset_key = ANY($2::text[]))`,
      [excludeClaimId ?? null, scope],
    );
    return BigInt(r.rows[0].total ?? "0");
  }

  /** Compute the live float status (balance from chain, reserved from DB). */
  async status(db: Pool | PoolClient, gateway: ChainGateway, hotAta: Address): Promise<FloatStatus> {
    const [balanceMario, reservedMario] = await Promise.all([
      gateway.getTokenBalance(hotAta),
      this.reserved(db),
    ]);
    const availableMario = balanceMario > reservedMario ? balanceMario - reservedMario : 0n;
    return {
      balanceMario,
      reservedMario,
      availableMario,
      capMario: this.#policy.capMario,
      refillNeeded: availableMario < this.#policy.refillThresholdMario,
      overCap: balanceMario > this.#policy.capMario,
    };
  }

  /**
   * Decide whether a token/vault dispatch of `amountMario` may proceed given the
   * available float and the brake. Returns null when permitted, else the denial.
   * `approved` short-circuits the brake (operator approved a pending_review claim).
   */
  check(args: {
    amountMario: bigint;
    availableMario: bigint;
    approved: boolean;
  }): FloatDenial | null {
    const { amountMario, availableMario, approved } = args;
    if (!approved && this.#policy.bigClaimThresholdMario > 0n && amountMario > this.#policy.bigClaimThresholdMario) {
      return { reason: "exceeds_brake", amountMario, thresholdMario: this.#policy.bigClaimThresholdMario };
    }
    if (amountMario > availableMario) {
      return { reason: "insufficient_float", needMario: amountMario, availableMario };
    }
    return null;
  }
}
