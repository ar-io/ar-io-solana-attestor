//! instructions: byte-format parity with the reference transfer logic
//! (solana-ar-io/migration/import/src/claim-transfers.ts) + Anchor discriminator.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { sha256 } from "@noble/hashes/sha2";
import { AccountRole, address, getAddressEncoder, type Address } from "@solana/kit";

import {
  anchorDiscriminator,
  claimMemoIx,
  createAtaIdempotentIx,
  encodeVaultedTransferData,
  getAssociatedTokenAddress,
  MPL_CORE_PROGRAM,
  mplCoreTransferV1Ix,
  mplCoreUpdateAuthorityIx,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  transferTokensIx,
} from "./instructions.js";

const A = (s: string): Address => address(s);
const OWNER = A("GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB");
const MINT = A("DcNnMuFxwhgV4WY1HVSaSEgr92bv2b1vUvEKiNxWqHdF");
const DEST = A("11111111111111111111111111111112");

describe("SPL token instructions", () => {
  it("Transfer ix = [3, amount u64 LE] with source/dest writable + authority signer", () => {
    const amount = 123_456_789n;
    const ix = transferTokensIx({ source: OWNER, destination: DEST, authority: OWNER, amount });
    assert.equal(ix.programAddress, TOKEN_PROGRAM);
    assert.equal(ix.data?.[0], 3);
    const view = new DataView((ix.data as Uint8Array).buffer, (ix.data as Uint8Array).byteOffset);
    assert.equal(view.getBigUint64(1, true), amount);
    assert.equal(ix.accounts?.[0].role, AccountRole.WRITABLE);
    assert.equal(ix.accounts?.[1].role, AccountRole.WRITABLE);
    assert.equal(ix.accounts?.[2].role, AccountRole.READONLY_SIGNER);
  });

  it("rejects an out-of-range u64 amount", () => {
    assert.throws(() => transferTokensIx({ source: OWNER, destination: DEST, authority: OWNER, amount: 2n ** 64n }), /u64 range/);
  });

  it("createIdempotent ATA ix = [1] with the 6-account ATA layout", () => {
    const ix = createAtaIdempotentIx({ payer: OWNER, ata: DEST, owner: OWNER, mint: MINT });
    assert.deepEqual(Array.from(ix.data as Uint8Array), [1]);
    assert.equal(ix.accounts?.length, 6);
    assert.equal(ix.accounts?.[0].role, AccountRole.WRITABLE_SIGNER);
    assert.equal(ix.accounts?.[4].address, SYSTEM_PROGRAM);
    assert.equal(ix.accounts?.[5].address, TOKEN_PROGRAM);
  });

  it("derives a deterministic, valid ATA", async () => {
    const ata1 = await getAssociatedTokenAddress(OWNER, MINT);
    const ata2 = await getAssociatedTokenAddress(OWNER, MINT);
    assert.equal(ata1, ata2);
    assert.notEqual(ata1, OWNER);
  });
});

describe("MPL Core ANT transfer (Owner + UA)", () => {
  it("TransferV1 data = [14, 0] with the 7-account layout (claim-transfers.ts parity)", () => {
    const ix = mplCoreTransferV1Ix({ asset: MINT, payer: OWNER, authority: OWNER, newOwner: DEST });
    assert.equal(ix.programAddress, MPL_CORE_PROGRAM);
    assert.deepEqual(Array.from(ix.data as Uint8Array), [14, 0]);
    assert.equal(ix.accounts?.length, 7);
    assert.equal(ix.accounts?.[0].address, MINT); // asset
    assert.equal(ix.accounts?.[1].address, MPL_CORE_PROGRAM); // collection none
    assert.equal(ix.accounts?.[4].address, DEST); // new owner
    assert.equal(ix.accounts?.[6].address, MPL_CORE_PROGRAM); // log wrapper none
  });

  it("UpdateV1 data = [15,0,0,1,1, newAuthority(32)] (moves UpdateAuthority)", () => {
    const ix = mplCoreUpdateAuthorityIx({ asset: MINT, payer: OWNER, authority: OWNER, newAuthority: DEST });
    const data = ix.data as Uint8Array;
    assert.deepEqual(Array.from(data.subarray(0, 5)), [15, 0, 0, 1, 1]);
    const encoded = new Uint8Array(getAddressEncoder().encode(DEST));
    assert.deepEqual(Array.from(data.subarray(5)), Array.from(encoded));
    assert.equal(data.length, 5 + 32);
    assert.equal(ix.accounts?.length, 6);
  });
});

describe("ario-core vaulted_transfer (vault re-lock)", () => {
  it("discriminator = sha256('global:vaulted_transfer')[..8]", () => {
    const disc = anchorDiscriminator("vaulted_transfer");
    const expected = sha256(new TextEncoder().encode("global:vaulted_transfer")).subarray(0, 8);
    assert.deepEqual(Array.from(disc), Array.from(expected));
  });

  it("data = disc(8) || amount u64 || lock i64 || revocable=0(bool), always non-revocable", () => {
    const amount = 500_000_000n;
    const lock = 2_592_000n; // 30 days
    const data = encodeVaultedTransferData(amount, lock, false);
    assert.equal(data.length, 8 + 8 + 8 + 1);
    const view = new DataView(data.buffer, data.byteOffset);
    assert.equal(view.getBigUint64(8, true), amount);
    assert.equal(view.getBigInt64(16, true), lock);
    assert.equal(data[24], 0);
  });

  it("rejects a zero / out-of-range amount", () => {
    assert.throws(() => encodeVaultedTransferData(0n, 100n, false), /out of range/);
  });
});

describe("memo", () => {
  it("encodes ar.io-claim:<claimId>", () => {
    const ix = claimMemoIx("abc-123");
    assert.equal(new TextDecoder().decode(ix.data as Uint8Array), "ar.io-claim:abc-123");
    assert.equal(ix.accounts?.length, 0);
  });
});
