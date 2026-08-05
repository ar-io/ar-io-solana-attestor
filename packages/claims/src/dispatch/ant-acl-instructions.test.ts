//! Golden tests for the ario-ant ACL / reconcile instruction builders.
//! The discriminators are pinned to the values extracted from the deployed
//! `ario-ant` program's generated client (`@ar.io/solana-contracts`), which
//! double-checks BOTH our `anchorDiscriminator()` helper AND that we targeted
//! the right Anchor instruction names. Account roles + data layouts are pinned
//! against the Rust account structs in `programs/ario-ant/src/{acl,lib}.rs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountRole, getAddressEncoder, type Address } from "@solana/kit";
import {
  arioAntReconcileIx,
  recordAclOwnerIx,
  removeAclOwnerIx,
  registerAclConfigIx,
  addAclPageIx,
  deriveAntConfigPda,
  deriveAclPagePda,
  ARIO_ANT_PROGRAM_MAINNET,
  decodeAclConfig,
  decodeAclPageEntries,
  decodeAntControllers,
  decodeMplCoreOwner,
  ACL_ROLE_OWNER,
} from "./ant-acl-instructions.js";
import { anchorDiscriminator } from "./instructions.js";

const P = ARIO_ANT_PROGRAM_MAINNET;
const A = (s: string) => s as Address;
const asset = A("CXG2t4bvC2SMeiuh3eSk7DLzac7rMp56BqDVFPTUe7G");
const claimant = A("GuGsC1UK8TfRwYfENT5mTErAtD1cytAJDs3B6VLRZXxS");
const treasury = A("H9QfodffCVtQiov99rwcxaqegLbrorbjNoDqk3ZFbEwt");
const someone = A("11111111111111111111111111111112");

// Discriminators extracted from the deployed program's generated client.
const DISC: Record<string, number[]> = {
  reconcile: [61, 24, 197, 180, 195, 169, 138, 105],
  record_acl_owner: [238, 178, 16, 156, 233, 241, 137, 144],
  remove_acl_owner: [138, 86, 140, 220, 115, 63, 131, 138],
  register_acl_config: [252, 165, 232, 44, 104, 143, 114, 62],
  add_acl_page: [92, 11, 219, 215, 119, 102, 233, 25],
};

test("anchorDiscriminator matches the deployed program's IDL discriminators", () => {
  for (const [name, bytes] of Object.entries(DISC)) {
    assert.deepEqual([...anchorDiscriminator(name)], bytes, `disc mismatch for ${name}`);
  }
});

test("reconcile ix: accounts + roles + data (Reconcile struct, lib.rs)", () => {
  const ix = arioAntReconcileIx({ antProgram: P, asset, antConfig: someone, antControllers: someone, caller: treasury });
  assert.equal(ix.programAddress, P);
  assert.deepEqual(ix.accounts?.map((a) => a.role), [
    AccountRole.READONLY, AccountRole.WRITABLE, AccountRole.WRITABLE, AccountRole.READONLY_SIGNER,
  ]);
  assert.deepEqual([...(ix.data as Uint8Array)], DISC.reconcile);
});

test("record/remove_acl_owner ix: 6 accounts, RecordAclOwner struct (acl.rs)", () => {
  const args = { antProgram: P, asset, antConfig: someone, aclConfig: someone, aclPage: someone, payer: treasury };
  for (const [ix, disc] of [
    [recordAclOwnerIx(args), DISC.record_acl_owner],
    [removeAclOwnerIx(args), DISC.remove_acl_owner],
  ] as const) {
    assert.deepEqual(ix.accounts?.map((a) => a.role), [
      AccountRole.READONLY, AccountRole.READONLY, AccountRole.WRITABLE, AccountRole.WRITABLE,
      AccountRole.WRITABLE_SIGNER, AccountRole.READONLY,
    ]);
    assert.deepEqual([...(ix.data as Uint8Array)], disc);
  }
});

test("register_acl_config ix: data = disc || user(32); 3 accounts", () => {
  const ix = registerAclConfigIx({ antProgram: P, user: claimant, aclConfig: someone, payer: treasury });
  assert.deepEqual(ix.accounts?.map((a) => a.role), [
    AccountRole.WRITABLE, AccountRole.WRITABLE_SIGNER, AccountRole.READONLY,
  ]);
  const data = ix.data as Uint8Array;
  assert.equal(data.length, 40);
  assert.deepEqual([...data.subarray(0, 8)], DISC.register_acl_config);
});

test("add_acl_page ix: 4 accounts, disc only", () => {
  const ix = addAclPageIx({ antProgram: P, aclConfig: someone, aclPage: someone, payer: treasury });
  assert.deepEqual(ix.accounts?.map((a) => a.role), [
    AccountRole.WRITABLE, AccountRole.WRITABLE, AccountRole.WRITABLE_SIGNER, AccountRole.READONLY,
  ]);
  assert.deepEqual([...(ix.data as Uint8Array)], DISC.add_acl_page);
});

test("PDA derivations are deterministic + page index is u64-LE seeded", async () => {
  const c1 = await deriveAntConfigPda(P, asset);
  const c2 = await deriveAntConfigPda(P, asset);
  assert.equal(c1, c2);
  const p0 = await deriveAclPagePda(P, claimant, 0n);
  const p1 = await deriveAclPagePda(P, claimant, 1n);
  assert.notEqual(p0, p1);
});

test("decoders round-trip synthetic account bytes", () => {
  // AclConfig: disc(8) user(32) page_count(2) total_entries(5)
  const cfg = new Uint8Array(56);
  cfg.set(new Uint8Array(32).fill(7), 8);
  new DataView(cfg.buffer).setBigUint64(40, 2n, true);
  new DataView(cfg.buffer).setBigUint64(48, 5n, true);
  const dc = decodeAclConfig(cfg);
  assert.equal(dc.pageCount, 2n);
  assert.equal(dc.totalEntries, 5n);

  // AclPage with 1 owner entry for `asset`
  const enc = getAddressEncoder();
  const page = new Uint8Array(52 + 33);
  new DataView(page.buffer).setUint32(48, 1, true);
  page.set(new Uint8Array(enc.encode(asset)), 52);
  page[52 + 32] = ACL_ROLE_OWNER;
  const entries = decodeAclPageEntries(page);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].asset, asset);
  assert.equal(entries[0].role, ACL_ROLE_OWNER);

  // AntControllers with 0 controllers (post-reconcile)
  const ctrls = new Uint8Array(44);
  new DataView(ctrls.buffer).setUint32(40, 0, true);
  assert.equal(decodeAntControllers(ctrls).length, 0);

  // MPL Core owner: key byte 1 + owner bytes
  const mpl = new Uint8Array(33);
  mpl[0] = 1;
  mpl.set(new Uint8Array(enc.encode(claimant)), 1);
  assert.equal(decodeMplCoreOwner(mpl), claimant);
});
