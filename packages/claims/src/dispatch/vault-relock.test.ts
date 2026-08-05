//! Golden tests for the vault re-lock delivery builder (no network).

import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountRole, getAddressEncoder, type Address } from "@solana/kit";
import { buildVaultRelockIxs, decodeVaultCounterNextId, decodeVault } from "./vault-relock.js";
import { anchorDiscriminator } from "./instructions.js";

const A = (s: string) => s as Address;
const ARIO_CORE = A("73YoECm6NKXpVRoe5f1Q9BcP5DJGPFUjnFy6AxBE5Nvh");
const MINT = A("DcNnMuFxwhgV4WY1HVSaSEgr92bv2b1vUvEKiNxWqHdF");
const hot = A("H9QfodffCVtQiov99rwcxaqegLbrorbjNoDqk3ZFbEwt");
const claimant = A("DgLdEUQjfPpAufDNaPwLMK39wCCWJetEHPgXA8y2i7WQ");
const enc = getAddressEncoder();
const dv = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);

test("decodeVaultCounterNextId: absent → 0; present → value", () => {
  assert.equal(decodeVaultCounterNextId(null), 0n);
  const d = new Uint8Array(48);
  dv(d).setBigUint64(40, 7n, true);
  assert.equal(decodeVaultCounterNextId(d), 7n);
});

test("buildVaultRelockIxs: createAta(vault) + vaulted_transfer(amount,dur,revocable=false) + memo", async () => {
  const b = await buildVaultRelockIxs({
    readAccount: async () => null, // counter absent → nextId 0
    arioCoreProgram: ARIO_CORE, mint: MINT, sender: hot, claimant,
    amount: 5009520000n, lockDurationSeconds: 1987200n, memoIxs: [],
  });
  assert.equal(b.nextId, 0n);
  assert.equal(b.ixs.length, 2);
  // ix0: createIdempotent ATA for the vault PDA (data == [1])
  assert.deepEqual([...(b.ixs[0].data as Uint8Array)], [1]);
  // ix1: vaulted_transfer
  const vt = b.ixs[1];
  assert.equal(vt.programAddress, ARIO_CORE);
  assert.equal(vt.accounts?.length, 9);
  assert.equal(vt.accounts?.[0].role, AccountRole.WRITABLE); // config
  assert.equal(vt.accounts?.[6].role, AccountRole.WRITABLE_SIGNER); // sender
  const data = vt.data as Uint8Array;
  assert.deepEqual([...data.subarray(0, 8)], [...anchorDiscriminator("vaulted_transfer")]);
  assert.equal(dv(data).getBigUint64(8, true), 5009520000n); // amount
  assert.equal(dv(data).getBigInt64(16, true), 1987200n); // lock duration
  assert.equal(data[24], 0); // revocable = false
});

test("live counter next_id shifts the vault PDA", async () => {
  const counter = new Uint8Array(48);
  dv(counter).setBigUint64(40, 3n, true);
  const b0 = await buildVaultRelockIxs({ readAccount: async () => null, arioCoreProgram: ARIO_CORE, mint: MINT, sender: hot, claimant, amount: 100_000_000n, lockDurationSeconds: 1987200n });
  const b3 = await buildVaultRelockIxs({ readAccount: async () => counter, arioCoreProgram: ARIO_CORE, mint: MINT, sender: hot, claimant, amount: 100_000_000n, lockDurationSeconds: 1987200n });
  assert.equal(b3.nextId, 3n);
  assert.notEqual(b0.vault, b3.vault);
});

test("decodeVault reads owner / vault_id / amount / end_timestamp at correct offsets", () => {
  const d = new Uint8Array(80);
  d.set(new Uint8Array(enc.encode(claimant)), 8);
  dv(d).setBigUint64(40, 2n, true); // vault_id @ 40
  dv(d).setBigUint64(48, 5009521643n, true); // amount @ 48
  dv(d).setBigInt64(64, 1787919731n, true); // end_timestamp @ 64
  const v = decodeVault(d);
  assert.equal(v.owner, claimant);
  assert.equal(v.vaultId, 2n);
  assert.equal(v.amount, 5009521643n);
  assert.equal(v.endTimestamp, 1787919731n);
});
