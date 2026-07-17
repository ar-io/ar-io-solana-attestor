//! Unit tests (no DB) for the operator wallet-signed ANT flow:
//!   * tx assembly — fee payer == treasury, memo present, and the txid is INVARIANT
//!     to the operator's authority co-signature (the whole design rests on this).
//!   * admin challenge auth — single-use nonce signed by ANT_COLD_ADDRESS.

import { strict as assert } from "node:assert";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import * as ed from "@noble/ed25519";
import bs58 from "bs58";
import {
  createKeyPairSignerFromPrivateKeyBytes,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type Address,
} from "@solana/kit";

import { buildAntTransferTx } from "./ant-operator.js";
import { makeLocalAuthority, operatorSignTx, signMessageBase64 } from "./ant-operator.testkit.js";
import {
  AntChallengeStore,
  adminChallengeMessage,
  decodeSignature,
  verifyAdminChallenge,
} from "../api/ant-admin.js";

const MINT = "DcNnMuFxwhgV4WY1HVSaSEgr92bv2b1vUvEKiNxWqHdF" as Address;

function decode(txBase64: string): ReturnType<ReturnType<typeof getTransactionDecoder>["decode"]> {
  return getTransactionDecoder().decode(new Uint8Array(getBase64Encoder().encode(txBase64)));
}
function isZero(sig: Uint8Array | null): boolean {
  return !sig || sig.every((b) => b === 0);
}

describe("ant-operator — tx assembly (fee payer = treasury, txid invariant)", () => {
  it("treasury is the fee payer; authority slot is EMPTY until the operator signs", async () => {
    const treasury = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(randomBytes(32)));
    const authority = await makeLocalAuthority(new Uint8Array(randomBytes(32)));
    const claimant = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(randomBytes(32)));
    const antMint = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(randomBytes(32)));

    const built = await buildAntTransferTx(treasury, {
      claimId: "claim-1",
      antMint: antMint.address,
      claimant: claimant.address,
      antColdAddress: authority.address,
      blockhash: bs58.encode(randomBytes(32)),
      lastValidBlockHeight: 1000n,
      includeMemo: true,
    });

    const tx = decode(built.txBase64);
    // Fee payer's signature == the txid, and it is the treasury key.
    assert.equal(getSignatureFromTransaction(tx), built.txid);
    assert.ok(!isZero(tx.signatures[treasury.address] ?? null), "treasury (fee payer) MUST be signed");
    assert.ok(isZero(tx.signatures[authority.address] ?? null), "authority slot MUST be empty pre-operator-sign");
  });

  it("the memo `ar.io-claim:<id>` is present (and absent when includeMemo=false)", async () => {
    const treasury = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(randomBytes(32)));
    const authority = await makeLocalAuthority(new Uint8Array(randomBytes(32)));
    const claimant = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(randomBytes(32)));
    const antMint = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(randomBytes(32)));
    const common = {
      antMint: antMint.address, claimant: claimant.address, antColdAddress: authority.address,
      blockhash: bs58.encode(randomBytes(32)), lastValidBlockHeight: 1000n,
    };

    const withMemo = await buildAntTransferTx(treasury, { ...common, claimId: "claim-memo", includeMemo: true });
    const raw = Buffer.from(withMemo.txBase64, "base64");
    assert.ok(raw.includes(Buffer.from("ar.io-claim:claim-memo", "utf8")), "memo bytes must be in the tx");

    const without = await buildAntTransferTx(treasury, { ...common, claimId: "claim-nomemo", includeMemo: false });
    const rawNo = Buffer.from(without.txBase64, "base64");
    assert.ok(!rawNo.includes(Buffer.from("ar.io-claim:claim-nomemo", "utf8")));
  });

  it("txid is INVARIANT to the operator's authority co-signature; authority sig verifies", async () => {
    const treasury = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(randomBytes(32)));
    const authority = await makeLocalAuthority(new Uint8Array(randomBytes(32)));
    const claimant = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(randomBytes(32)));
    const antMint = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(randomBytes(32)));

    const built = await buildAntTransferTx(treasury, {
      claimId: "claim-2", antMint: antMint.address, claimant: claimant.address,
      antColdAddress: authority.address, blockhash: bs58.encode(randomBytes(32)),
      lastValidBlockHeight: 1000n, includeMemo: true,
    });

    const signedBase64 = await operatorSignTx(built.txBase64, authority);
    const signed = decode(signedBase64);
    // The txid (fee-payer signature) is unchanged after the operator co-signs.
    assert.equal(getSignatureFromTransaction(signed), built.txid, "txid MUST NOT change when the operator co-signs");
    const authSig = signed.signatures[authority.address] as Uint8Array | null;
    assert.ok(!isZero(authSig), "authority slot now filled");
    const ok = await ed.verifyAsync(authSig as Uint8Array, signed.messageBytes as unknown as Uint8Array, bs58.decode(authority.address));
    assert.equal(ok, true, "authority signature verifies over the message bytes");
    // The wire bytes changed (a new signature was added), but the txid did not.
    assert.notEqual(signedBase64, built.txBase64);
  });
});

describe("ant-admin — challenge auth (single-use nonce signed by ANT_COLD_ADDRESS)", () => {
  it("accepts a fresh nonce signed by the authority; rejects a REPLAY (single-use)", async () => {
    const authority = await makeLocalAuthority(new Uint8Array(randomBytes(32)));
    const store = new AntChallengeStore();
    const { nonce } = store.issue();
    const sig = await signMessageBase64(adminChallengeMessage(nonce), authority.seed);

    await assert.doesNotReject(verifyAdminChallenge(store, authority.address, { nonce, sig }));
    // Replay of the SAME nonce fails — it was consumed.
    await assert.rejects(verifyAdminChallenge(store, authority.address, { nonce, sig }), /unknown, expired, or already used/);
  });

  it("rejects a signature by the WRONG key", async () => {
    const authority = await makeLocalAuthority(new Uint8Array(randomBytes(32)));
    const attacker = await makeLocalAuthority(new Uint8Array(randomBytes(32)));
    const store = new AntChallengeStore();
    const { nonce } = store.issue();
    const sig = await signMessageBase64(adminChallengeMessage(nonce), attacker.seed);
    await assert.rejects(verifyAdminChallenge(store, authority.address, { nonce, sig }), /does not verify/);
  });

  it("rejects an EXPIRED nonce", async () => {
    const authority = await makeLocalAuthority(new Uint8Array(randomBytes(32)));
    let now = 1_000_000;
    const store = new AntChallengeStore({ ttlMs: 1000, now: () => now });
    const { nonce } = store.issue();
    const sig = await signMessageBase64(adminChallengeMessage(nonce), authority.seed);
    now += 2000; // past the TTL
    await assert.rejects(verifyAdminChallenge(store, authority.address, { nonce, sig }), /unknown, expired, or already used/);
  });

  it("rejects an unknown nonce and a missing challenge", async () => {
    const authority = await makeLocalAuthority(new Uint8Array(randomBytes(32)));
    const store = new AntChallengeStore();
    const sig = await signMessageBase64(adminChallengeMessage("deadbeef"), authority.seed);
    await assert.rejects(verifyAdminChallenge(store, authority.address, { nonce: "deadbeef", sig }));
    await assert.rejects(verifyAdminChallenge(store, authority.address, {}));
  });

  it("decodeSignature accepts base64 / base58 / hex 64-byte sigs, rejects the wrong length", () => {
    const raw = new Uint8Array(randomBytes(64));
    assert.deepEqual(decodeSignature(Buffer.from(raw).toString("base64")), raw);
    assert.deepEqual(decodeSignature(bs58.encode(raw)), raw);
    assert.deepEqual(decodeSignature(Buffer.from(raw).toString("hex")), raw);
    assert.throws(() => decodeSignature(Buffer.from(randomBytes(32)).toString("base64")));
  });
});

describe("ant-admin — read session tokens (poll without a per-call wallet signature)", () => {
  it("mints a reusable read token that verifies until its TTL, then expires", () => {
    let now = 1_000_000;
    const store = new AntChallengeStore({ readTtlMs: 1000, now: () => now });
    const { readToken } = store.issueReadToken();
    // Reusable (NOT single-use) so polling doesn't re-prompt.
    assert.equal(store.verifyReadToken(readToken), true);
    assert.equal(store.verifyReadToken(readToken), true);
    now += 2000; // past the read TTL
    assert.equal(store.verifyReadToken(readToken), false);
  });

  it("rejects an unknown/empty read token, and read tokens are distinct from write nonces", () => {
    const store = new AntChallengeStore();
    assert.equal(store.verifyReadToken(undefined), false);
    assert.equal(store.verifyReadToken("deadbeef"), false);
    // A write nonce is not a read token and vice-versa (separate namespaces).
    const { nonce } = store.issue();
    assert.equal(store.verifyReadToken(nonce), false);
    const { readToken } = store.issueReadToken();
    assert.equal(store.consume(readToken), false);
  });

  it("B5: GC reaps expired nonces first — a live operator nonce survives a challenge flood", () => {
    let now = 0;
    const store = new AntChallengeStore({ ttlMs: 1000, maxKeys: 4, now: () => now });
    const stale = [store.issue(), store.issue(), store.issue(), store.issue()]; // fill the cap
    now = 2000; // all four are now expired
    const live = store.issue(); // GC must purge the 4 expired, NOT crowd out the fresh one
    store.issue(); // a couple more (flood) — still within maxKeys after the purge
    store.issue();
    now = 2100; // `live` (issued at 2000, ttl 1000) is still valid
    assert.equal(store.consume(live.nonce), true, "the live operator nonce survived the flood");
    assert.equal(store.consume(stale[0].nonce), false, "stale nonces are gone/invalid");
  });
});

describe("ant-admin — action-bound challenge (build sig can't authorize submit)", () => {
  it("a signature bound to one action does NOT verify for another", async () => {
    const authority = await makeLocalAuthority(new Uint8Array(randomBytes(32)));
    const store = new AntChallengeStore();
    const { nonce } = store.issue();
    const buildSig = await signMessageBase64(adminChallengeMessage(nonce, "build"), authority.seed);
    // Presented as a SUBMIT challenge -> message mismatch -> rejected.
    await assert.rejects(verifyAdminChallenge(store, authority.address, { nonce, sig: buildSig }, "submit"), /does not verify/);

    const { nonce: n2 } = store.issue();
    const submitSig = await signMessageBase64(adminChallengeMessage(n2, "submit"), authority.seed);
    await assert.doesNotReject(verifyAdminChallenge(store, authority.address, { nonce: n2, sig: submitSig }, "submit"));
  });
});
