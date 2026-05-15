import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as ed25519 from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2";

import { loadAttestorKeypair, signAttestation } from "./attest.js";

ed25519.etc.sha512Sync = (...m) => sha512(ed25519.etc.concatBytes(...m));

describe("loadAttestorKeypair", () => {
  it("derives the public key from a 32-byte seed", () => {
    const seed = randomBytes(32);
    const kp = loadAttestorKeypair(seed);
    assert.equal(kp.secretKey.length, 32);
    assert.equal(kp.publicKey.length, 32);
    // Re-deriving from the same seed gives the same pubkey.
    const kp2 = loadAttestorKeypair(seed);
    assert.deepEqual(kp.publicKey, kp2.publicKey);
  });

  it("rejects seed of wrong length", () => {
    assert.throws(() => loadAttestorKeypair(randomBytes(31)));
    assert.throws(() => loadAttestorKeypair(randomBytes(33)));
    assert.throws(() => loadAttestorKeypair(new Uint8Array(0)));
  });
});

describe("signAttestation", () => {
  it("produces a 64-byte signature that ed25519.verify accepts", () => {
    const seed = randomBytes(32);
    const kp = loadAttestorKeypair(seed);
    const message = new TextEncoder().encode(
      "ar.io ant-escrow claim\nnetwork: localnet\nant: foo",
    );
    const sig = signAttestation(kp, message);
    assert.equal(sig.length, 64);
    assert.equal(ed25519.verify(sig, message, kp.publicKey), true);
  });

  it("differs for different messages", () => {
    const seed = randomBytes(32);
    const kp = loadAttestorKeypair(seed);
    const sig1 = signAttestation(kp, new TextEncoder().encode("a"));
    const sig2 = signAttestation(kp, new TextEncoder().encode("b"));
    assert.notDeepEqual(sig1, sig2);
  });

  it("verification rejects when message is tampered", () => {
    const seed = randomBytes(32);
    const kp = loadAttestorKeypair(seed);
    const message = new TextEncoder().encode("original");
    const sig = signAttestation(kp, message);
    const tampered = new TextEncoder().encode("modified");
    assert.equal(ed25519.verify(sig, tampered, kp.publicKey), false);
  });

  it("verification rejects under wrong pubkey", () => {
    const seedA = randomBytes(32);
    const seedB = randomBytes(32);
    const kpA = loadAttestorKeypair(seedA);
    const kpB = loadAttestorKeypair(seedB);
    const message = new TextEncoder().encode("hello");
    const sig = signAttestation(kpA, message);
    assert.equal(ed25519.verify(sig, message, kpB.publicKey), false);
  });
});
