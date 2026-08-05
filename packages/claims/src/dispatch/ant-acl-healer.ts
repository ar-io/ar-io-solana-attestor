//! ANT ACL auto-heal SWEEP (go-forward fix).
//!
//! Runs inside the dispatch worker each tick: finds confirmed ANT claims whose
//! `ario-ant` ACL / ownership hasn't been reconciled yet (`ant_acl_healed_at IS
//! NULL`) and heals them in-process with the treasury signer — permissionless,
//! idempotent, and completely off the money path. This is what makes every
//! future claimant's name show the RIGHT owner in arns.app with zero manual
//! steps (and it clears the pre-existing backlog on its first passes too).
//!
//! Fault-isolated: a heal failure NEVER touches ARIO dispatch. Per-claim errors
//! are retried up to `maxAttempts`, then parked (marked done + alert) so one bad
//! ANT can't wedge the sweep.

import { address, type Address, type TransactionSigner } from "@solana/kit";
import type { Pool } from "pg";
import type { SolanaRpc } from "../solana.js";
import type { SolanaChainGateway } from "./chain.js";
import { readAclHealSnapshot, applyHeal, verifyHealed, type HealParams } from "./ant-acl-execute.js";
import { planAclHeal } from "./ant-acl-reconcile.js";

export type HealOutcome = "healed" | "already" | "aborted" | "failed";
export interface HealOneResult {
  outcome: HealOutcome;
  signature?: string;
  note?: string;
}
export type HealOneFn = (params: HealParams) => Promise<HealOneResult>;

/** Default per-claim heal: read live state → plan → apply → re-verify. */
export function makeHealOne(rpc: SolanaRpc, gateway: SolanaChainGateway, treasury: TransactionSigner): HealOneFn {
  return async (params: HealParams): Promise<HealOneResult> => {
    const snapshot = await readAclHealSnapshot(rpc, params);
    const plan = planAclHeal(snapshot);
    if (plan.abortReason) return { outcome: "aborted", note: plan.abortReason };
    if (plan.alreadyHealed) return { outcome: "already" };
    const applied = await applyHeal(gateway, treasury, plan);
    const v = await verifyHealed(rpc, params);
    if (v.fullyHealed) return { outcome: "healed", signature: applied.signature, note: plan.actions.join(" | ") };
    return { outcome: "failed", signature: applied.signature, note: `applied but unverified: ${JSON.stringify(v)}` };
  };
}

export interface HealAlert {
  name: string;
  severity: "warning" | "critical";
  message: string;
  claimId: string;
}
export interface AntAclHealerDeps {
  pool: Pool;
  antProgram: Address;
  /** The escrow/old owner whose stale ACL owner entry is removed. */
  oldOwner: Address;
  /** Treasury address (fee-payer / permissionless caller). */
  treasuryAddress: Address;
  healOne: HealOneFn;
  /** Retry a failing claim this many times before parking it + alerting. */
  maxAttempts?: number;
  log?: (msg: string, extra?: object) => void;
  alert?: (a: HealAlert) => void;
}

export interface SweepSummary {
  scanned: number;
  healed: number;
  already: number;
  aborted: number;
  failed: number;
}

export class AntAclHealer {
  readonly #d: AntAclHealerDeps;
  readonly #maxAttempts: number;
  constructor(deps: AntAclHealerDeps) {
    this.#d = deps;
    this.#maxAttempts = deps.maxAttempts ?? 5;
  }

  /** One sweep pass: heal up to `limit` pending ANT claims. */
  async sweepOnce(limit = 3): Promise<SweepSummary> {
    const { rows } = await this.#d.pool.query<{ claim_id: string; claimant: string; ant_mint: string; ant_name: string | null; attempts: number }>(
      `SELECT c.claim_id::text AS claim_id, c.claimant, a.ant_mint, a.ant_name, c.ant_acl_heal_attempts AS attempts
         FROM claims c JOIN assets a ON a.asset_key = c.asset_key
        WHERE a.asset_type = 'ant' AND c.status = 'confirmed' AND a.ant_mint IS NOT NULL
          AND c.ant_acl_healed_at IS NULL
        ORDER BY c.confirmed_at NULLS FIRST
        LIMIT $1`,
      [limit],
    );

    const sum: SweepSummary = { scanned: rows.length, healed: 0, already: 0, aborted: 0, failed: 0 };
    for (const row of rows) {
      const params: HealParams = {
        antProgram: this.#d.antProgram,
        mint: address(row.ant_mint),
        oldOwner: this.#d.oldOwner,
        claimant: address(row.claimant),
        treasury: this.#d.treasuryAddress,
      };
      const tag = { claimId: row.claim_id, name: row.ant_name, mint: row.ant_mint };
      try {
        const r = await this.#d.healOne(params);
        switch (r.outcome) {
          case "healed":
            await this.#markDone(row.claim_id, `healed: ${r.note ?? ""}`.trim());
            sum.healed++;
            this.#d.log?.("ant acl healed", { ...tag, signature: r.signature });
            break;
          case "already":
            await this.#markDone(row.claim_id, "already-in-sync");
            sum.already++;
            break;
          case "aborted":
            // Not ours to heal (asset moved on / stale claimant). Park it — no
            // point retrying — but surface it.
            await this.#markDone(row.claim_id, `aborted: ${r.note ?? ""}`.trim());
            sum.aborted++;
            this.#d.log?.("ant acl heal aborted (parked)", { ...tag, reason: r.note });
            break;
          case "failed":
            await this.#recordFailure(row.claim_id, row.attempts, r.note ?? "verification failed", tag);
            sum.failed++;
            break;
        }
      } catch (e) {
        await this.#recordFailure(row.claim_id, row.attempts, (e as Error).message, tag);
        sum.failed++;
      }
    }
    return sum;
  }

  #markDone(claimId: string, note: string): Promise<unknown> {
    return this.#d.pool.query(`UPDATE claims SET ant_acl_healed_at = now(), ant_acl_heal_note = $2 WHERE claim_id = $1`, [claimId, note.slice(0, 500)]);
  }

  async #recordFailure(claimId: string, priorAttempts: number, note: string, tag: object): Promise<void> {
    const attempts = priorAttempts + 1;
    if (attempts >= this.#maxAttempts) {
      // Park it so the sweep can't loop forever on one ANT; alert the operator.
      await this.#d.pool.query(
        `UPDATE claims SET ant_acl_healed_at = now(), ant_acl_heal_attempts = $2, ant_acl_heal_note = $3 WHERE claim_id = $1`,
        [claimId, attempts, `GAVE UP after ${attempts}: ${note}`.slice(0, 500)],
      );
      this.#d.log?.("ant acl heal gave up (parked, needs operator)", { ...tag, attempts, note });
      this.#d.alert?.({ name: "ant-acl-heal-failed", severity: "warning", message: `ANT ACL heal gave up after ${attempts} attempts: ${note}`, claimId });
    } else {
      await this.#d.pool.query(`UPDATE claims SET ant_acl_heal_attempts = $2, ant_acl_heal_note = $3 WHERE claim_id = $1`, [claimId, attempts, note.slice(0, 500)]);
      this.#d.log?.("ant acl heal failed (will retry)", { ...tag, attempts, note });
    }
  }
}
