//! INDEPENDENT ADVERSARIAL suite for the ANT admin challenge auth (§7.3), by the
//! TESTER agent. Attacks the challenge/verify core directly (no HTTP): every admin
//! ANT route funnels through `verifyAdminChallenge` + `AntChallengeStore`, so this
//! is the auth surface. All rejections must be ApiError(401) and every nonce must
//! be single-use.

import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import bs58 from "bs58";
import * as ed from "@noble/ed25519";

import { AntChallengeStore, adminChallengeMessage, verifyAdminChallenge } from "./ant-admin.js";
import { ApiError } from "./errors.js";

/** A local ed25519 keypair standing in for the ANT authority. */
async function makeKey(): Promise<{ seed: Uint8Array; address: string }> {
  const seed = new Uint8Array(randomBytes(32));
  const pub = await ed.getPublicKeyAsync(seed);
  return { seed, address: bs58.encode(pub) };
}
async function signB64(msg: Uint8Array, seed: Uint8Array): Promise<string> {
  return Buffer.from(await ed.signAsync(msg, seed)).toString("base64");
}
async function expect401(fn: () => Promise<unknown>, label: string): Promise<void> {
  await assert.rejects(fn, (e: unknown) => {
    assert.ok(e instanceof ApiError, `${label}: expected ApiError, got ${e}`);
    assert.equal((e as ApiError).status, 401, `${label}: expected 401`);
    return true;
  }, label);
}

describe("ANT admin challenge auth ADVERSARIAL (tester)", () => {
  it("S3-happy: a fresh nonce signed by ANT_COLD_ADDRESS verifies exactly once", async () => {
    const auth = await makeKey();
    const store = new AntChallengeStore();
    const { nonce } = store.issue();
    const sig = await signB64(adminChallengeMessage(nonce), auth.seed);
    await verifyAdminChallenge(store, auth.address, { nonce, sig }); // ok
    // Immediately replayed -> the nonce was consumed -> 401.
    await expect401(() => verifyAdminChallenge(store, auth.address, { nonce, sig }), "replay after success");
  });

  it("S3a: no challenge (missing nonce and/or sig) -> 401", async () => {
    const auth = await makeKey();
    const store = new AntChallengeStore();
    await expect401(() => verifyAdminChallenge(store, auth.address, {}), "empty");
    const { nonce } = store.issue();
    await expect401(() => verifyAdminChallenge(store, auth.address, { nonce }), "nonce only, no sig");
    await expect401(() => verifyAdminChallenge(store, auth.address, { sig: "AA==" }), "sig only, no nonce");
  });

  it("S3b: a nonce signed by the WRONG key (not ANT_COLD_ADDRESS) -> 401, and the nonce is consumed", async () => {
    const auth = await makeKey();
    const attacker = await makeKey();
    const store = new AntChallengeStore();
    const { nonce } = store.issue();
    const wrongSig = await signB64(adminChallengeMessage(nonce), attacker.seed);
    await expect401(() => verifyAdminChallenge(store, auth.address, { nonce, sig: wrongSig }), "wrong signer");
    // Nonce must be burned even on a bad sig (no brute-force of a leaked nonce).
    const rightSig = await signB64(adminChallengeMessage(nonce), auth.seed);
    await expect401(() => verifyAdminChallenge(store, auth.address, { nonce, sig: rightSig }), "nonce consumed after bad sig");
  });

  it("S3c: a replayed / already-used nonce -> 401", async () => {
    const auth = await makeKey();
    const store = new AntChallengeStore();
    const { nonce } = store.issue();
    const sig = await signB64(adminChallengeMessage(nonce), auth.seed);
    await verifyAdminChallenge(store, auth.address, { nonce, sig });
    await expect401(() => verifyAdminChallenge(store, auth.address, { nonce, sig }), "reused nonce");
  });

  it("S3d: an EXPIRED nonce -> 401 (deterministic clock)", async () => {
    const auth = await makeKey();
    let t = 1_000_000;
    const store = new AntChallengeStore({ ttlMs: 1000, now: () => t });
    const { nonce } = store.issue();
    const sig = await signB64(adminChallengeMessage(nonce), auth.seed);
    t += 1001; // past TTL
    await expect401(() => verifyAdminChallenge(store, auth.address, { nonce, sig }), "expired nonce");
  });

  it("S3e: a valid signature over a DIFFERENT nonce/message -> 401", async () => {
    const auth = await makeKey();
    const store = new AntChallengeStore();
    const issued = store.issue();
    const other = store.issue();
    // Sign the OTHER nonce's message, present it against `issued.nonce`.
    const sigOverOther = await signB64(adminChallengeMessage(other.nonce), auth.seed);
    await expect401(() => verifyAdminChallenge(store, auth.address, { nonce: issued.nonce, sig: sigOverOther }), "sig over wrong message");
  });

  it("S3f: a raw-message signature (missing the ar.io-ant-admin domain prefix) -> 401 (no cross-protocol replay)", async () => {
    const auth = await makeKey();
    const store = new AntChallengeStore();
    const { nonce } = store.issue();
    // Sign the bare nonce bytes WITHOUT the domain prefix.
    const bareSig = await signB64(new TextEncoder().encode(nonce), auth.seed);
    await expect401(() => verifyAdminChallenge(store, auth.address, { nonce, sig: bareSig }), "un-prefixed message");
  });

  it("S3g: an unknown (never-issued) nonce -> 401", async () => {
    const auth = await makeKey();
    const store = new AntChallengeStore();
    const bogus = randomBytes(32).toString("hex");
    const sig = await signB64(adminChallengeMessage(bogus), auth.seed);
    await expect401(() => verifyAdminChallenge(store, auth.address, { nonce: bogus, sig }), "never-issued nonce");
  });

  it("S3h: a garbage signature blob -> 401 (not a 500)", async () => {
    const auth = await makeKey();
    const store = new AntChallengeStore();
    const { nonce } = store.issue();
    await expect401(() => verifyAdminChallenge(store, auth.address, { nonce, sig: "!!!not-a-signature!!!" }), "garbage sig");
  });
});
