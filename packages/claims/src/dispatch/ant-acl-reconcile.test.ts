//! Unit tests for the pure ACL heal planner (no network).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "@solana/kit";
import { planAclHeal, type AclHealSnapshot } from "./ant-acl-reconcile.js";
import { ARIO_ANT_PROGRAM_MAINNET } from "./ant-acl-instructions.js";

const A = (s: string) => s as Address;
const mint = A("CXG2t4bvC2SMeiuh3eSk7DLzac7rMp56BqDVFPTUe7G");
const claimant = A("GuGsC1UK8TfRwYfENT5mTErAtD1cytAJDs3B6VLRZXxS");
const oldOwner = A("45ZuEb1Jk7pbjshD1BVasBekAXhimdWuJjyswQzMyTB1");
const treasury = A("H9QfodffCVtQiov99rwcxaqegLbrorbjNoDqk3ZFbEwt");
const pda = (n: number) => A(`1111111111111111111111111111111${n}`);

function base(overrides: Partial<AclHealSnapshot> = {}): AclHealSnapshot {
  return {
    antProgram: ARIO_ANT_PROGRAM_MAINNET,
    mint,
    oldOwner,
    claimant,
    treasury,
    antConfigPda: pda(2),
    antControllersPda: pda(3),
    mplOwner: claimant,
    controllers: [],
    lastKnownOwner: claimant,
    oldOwnerAcl: { aclConfigPda: pda(4), entryPage: null },
    newOwnerAcl: {
      exists: true,
      aclConfigPda: pda(5),
      hasOwnerEntry: true,
      targetPage: { pageIdx: 0n, pagePda: pda(6), needsCreate: false },
    },
    ...overrides,
  };
}

test("fresh claimant, stale old entry, controllers present → full heal in order", () => {
  const p = planAclHeal(
    base({
      controllers: [oldOwner],
      lastKnownOwner: oldOwner,
      oldOwnerAcl: { aclConfigPda: pda(4), entryPage: { pageIdx: 0n, pagePda: pda(7) } },
      newOwnerAcl: { exists: false, aclConfigPda: pda(5), hasOwnerEntry: false, targetPage: { pageIdx: 0n, pagePda: pda(6), needsCreate: true } },
    }),
  );
  assert.equal(p.abortReason, undefined);
  assert.equal(p.alreadyHealed, false);
  assert.deepEqual(p.actions.map((a) => a.split("(")[0].trim()), [
    "remove_acl_owner",
    "register_acl_config",
    "add_acl_page",
    "record_acl_owner",
    "reconcile",
  ]);
  assert.equal(p.ixs.length, 5);
});

test("already fully healed → no tx", () => {
  const p = planAclHeal(base());
  assert.equal(p.alreadyHealed, true);
  assert.equal(p.ixs.length, 0);
});

test("ACL fine but controllers still present → reconcile only", () => {
  const p = planAclHeal(base({ controllers: [oldOwner] }));
  assert.equal(p.ixs.length, 1);
  assert.deepEqual(p.actions.map((a) => a.split(" ")[0]), ["reconcile"]);
});

test("new config exists with room, old entry present → remove + record + reconcile (no bootstrap)", () => {
  const p = planAclHeal(
    base({
      lastKnownOwner: oldOwner,
      oldOwnerAcl: { aclConfigPda: pda(4), entryPage: { pageIdx: 0n, pagePda: pda(7) } },
      newOwnerAcl: { exists: true, aclConfigPda: pda(5), hasOwnerEntry: false, targetPage: { pageIdx: 1n, pagePda: pda(6), needsCreate: false } },
    }),
  );
  assert.deepEqual(p.actions.map((a) => a.split("(")[0].trim()), ["remove_acl_owner", "record_acl_owner", "reconcile"]);
});

test("abort: live owner is not the claimant (asset moved on / stale claimant)", () => {
  const p = planAclHeal(base({ mplOwner: oldOwner }));
  assert.match(p.abortReason ?? "", /refusing to heal/);
  assert.equal(p.ixs.length, 0);
});

test("abort: asset account unreadable", () => {
  const p = planAclHeal(base({ mplOwner: null }));
  assert.match(p.abortReason ?? "", /unreadable/);
});
