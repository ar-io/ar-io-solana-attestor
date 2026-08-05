//! ANT ACL / ownership heal — PURE PLANNER (M?/hardening).
//!
//! Turns an on-chain state snapshot for ONE ANT into the exact ordered
//! instruction list that brings its `ario-ant` ACL + `AntConfig` into agreement
//! with the live MPL Core owner. All instructions are permissionless and paid by
//! the treasury; see `ant-acl-instructions.ts` for why this is needed (raw
//! `TransferV1` dispatch bypasses the ACL).
//!
//! This module is PURE + sync so it is fully unit-testable with no network: the
//! executor (separate) does the async reads/derivations, hands this a snapshot,
//! then signs+sends the returned ixs with the treasury signer. It NEVER touches
//! the money path (no ARIO moves; only ACL metadata).

import type { Address, IInstruction } from "@solana/kit";
import {
  arioAntReconcileIx,
  recordAclOwnerIx,
  removeAclOwnerIx,
  registerAclConfigIx,
  addAclPageIx,
} from "./ant-acl-instructions.js";

/** A resolved page location (PDA + its u64 index). */
export interface PageRef {
  pageIdx: bigint;
  pagePda: Address;
}

/** Everything the planner needs, all resolved by the executor from live reads. */
export interface AclHealSnapshot {
  antProgram: Address;
  mint: Address;
  /** The address the ANT was escrowed under (its ACL owner entry to remove). */
  oldOwner: Address;
  /** The intended new owner (our DB claimant). MUST equal the live MPL owner. */
  claimant: Address;
  /** Treasury — pays rent + is the permissionless caller/payer on every ix. */
  treasury: Address;

  antConfigPda: Address;
  antControllersPda: Address;

  /** Live MPL Core owner (ground truth). `null` if the asset account is unreadable. */
  mplOwner: Address | null;
  /** Current `AntControllers.controllers`. */
  controllers: Address[];
  /** Current `AntConfig.last_known_owner`. */
  lastKnownOwner: Address;

  /** Old owner's ACL: config PDA + the page holding the stale (mint, Owner) entry, if any. */
  oldOwnerAcl: { aclConfigPda: Address; entryPage: PageRef | null };

  /** New owner's ACL: existence, whether (mint, Owner) is already recorded, and the page to append to. */
  newOwnerAcl: {
    exists: boolean;
    aclConfigPda: Address;
    hasOwnerEntry: boolean;
    /** Where a fresh record goes: a page + whether it must be `add_acl_page`d first. */
    targetPage: PageRef & { needsCreate: boolean };
  };
}

export interface AclHealPlan {
  ixs: IInstruction[];
  /** Human-readable step list (for dry-run + audit). */
  actions: string[];
  /** True when the ACL + AntConfig already match ground truth — no tx needed. */
  alreadyHealed: boolean;
  /** Set when the heal must NOT proceed (asset not owned by the claimant). */
  abortReason?: string;
}

/**
 * Plan the heal for one ANT. Ordering within the returned single tx:
 *   remove_acl_owner(old) → [register_acl_config + add_acl_page] → record_acl_owner(new) → reconcile
 * Each step is emitted only when actually needed, so re-runs converge to a
 * no-op (`alreadyHealed`). HARD GUARD: refuses unless the live MPL owner IS the
 * claimant — we only ever record the true on-chain owner (and `record_acl_owner`
 * would fail on-chain otherwise anyway).
 */
export function planAclHeal(s: AclHealSnapshot): AclHealPlan {
  if (s.mplOwner === null) {
    return { ixs: [], actions: [], alreadyHealed: false, abortReason: `asset ${s.mint} account unreadable (not an MPL Core asset?)` };
  }
  if (s.mplOwner !== s.claimant) {
    return {
      ixs: [],
      actions: [],
      alreadyHealed: false,
      abortReason: `live MPL owner ${s.mplOwner} != intended claimant ${s.claimant} — refusing to heal (asset moved on / stale claimant)`,
    };
  }

  const ixs: IInstruction[] = [];
  const actions: string[] = [];

  // 1. Remove the stale old-owner reverse-index entry (valid: old no longer owns it).
  if (s.oldOwnerAcl.entryPage) {
    ixs.push(
      removeAclOwnerIx({
        antProgram: s.antProgram,
        asset: s.mint,
        antConfig: s.antConfigPda,
        aclConfig: s.oldOwnerAcl.aclConfigPda,
        aclPage: s.oldOwnerAcl.entryPage.pagePda,
        payer: s.treasury,
      }),
    );
    actions.push(`remove_acl_owner(old=${s.oldOwner}, page=${s.oldOwnerAcl.entryPage.pageIdx})`);
  }

  // 2. Record the new owner (bootstrap AclConfig/AclPage as needed).
  if (!s.newOwnerAcl.hasOwnerEntry) {
    if (!s.newOwnerAcl.exists) {
      ixs.push(registerAclConfigIx({ antProgram: s.antProgram, user: s.claimant, aclConfig: s.newOwnerAcl.aclConfigPda, payer: s.treasury }));
      actions.push(`register_acl_config(new=${s.claimant})`);
    }
    if (s.newOwnerAcl.targetPage.needsCreate) {
      ixs.push(addAclPageIx({ antProgram: s.antProgram, aclConfig: s.newOwnerAcl.aclConfigPda, aclPage: s.newOwnerAcl.targetPage.pagePda, payer: s.treasury }));
      actions.push(`add_acl_page(new, page=${s.newOwnerAcl.targetPage.pageIdx})`);
    }
    ixs.push(
      recordAclOwnerIx({
        antProgram: s.antProgram,
        asset: s.mint,
        antConfig: s.antConfigPda,
        aclConfig: s.newOwnerAcl.aclConfigPda,
        aclPage: s.newOwnerAcl.targetPage.pagePda,
        payer: s.treasury,
      }),
    );
    actions.push(`record_acl_owner(new=${s.claimant}, page=${s.newOwnerAcl.targetPage.pageIdx})`);
  }

  // 3. Reconcile AntConfig/AntControllers. `reconcile` only does anything while
  //    `last_known_owner != owner` (it then clears controllers + updates the
  //    owner). So it's needed when last_known_owner is still stale, or when the
  //    OLD owner lingers as a controller. A controller that is the claimant is
  //    healthy (their own name) and must NOT trigger a futile reconcile.
  const reconcileNeeded = s.lastKnownOwner !== s.claimant || s.controllers.includes(s.oldOwner);
  if (reconcileNeeded) {
    ixs.push(
      arioAntReconcileIx({
        antProgram: s.antProgram,
        asset: s.mint,
        antConfig: s.antConfigPda,
        antControllers: s.antControllersPda,
        caller: s.treasury,
      }),
    );
    actions.push(`reconcile (controllers=${s.controllers.length}, last_known_owner→claimant)`);
  }

  return { ixs, actions, alreadyHealed: ixs.length === 0 };
}
