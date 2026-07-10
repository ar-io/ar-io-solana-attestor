//! crypto-box: AES-256-GCM seal/open round-trip + fail-closed on bad key/tamper.

import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import { openSecret, sealSecret, secretsEqual } from "./crypto-box.js";

describe("crypto-box seal/open", () => {
  const seed = new Uint8Array(randomBytes(32));
  const pass = "correct horse battery staple";

  it("round-trips a 32-byte seed", () => {
    const sealed = sealSecret(seed, pass);
    assert.equal(sealed.v, 1);
    assert.equal(sealed.kdf, "scrypt");
    const opened = openSecret(sealed, pass);
    assert.ok(secretsEqual(opened, seed));
  });

  it("produces a fresh salt+iv each seal (no deterministic reuse)", () => {
    const a = sealSecret(seed, pass);
    const b = sealSecret(seed, pass);
    assert.notEqual(a.salt, b.salt);
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.ct, b.ct);
  });

  it("the sealed blob never contains the plaintext seed", () => {
    const sealed = sealSecret(seed, pass);
    const hay = JSON.stringify(sealed);
    const seedHex = Buffer.from(seed).toString("hex");
    const seedB64 = Buffer.from(seed).toString("base64");
    assert.ok(!hay.includes(seedHex));
    assert.ok(!hay.includes(seedB64));
  });

  it("wrong passphrase fails closed (throws, no seed leak)", () => {
    const sealed = sealSecret(seed, pass);
    assert.throws(() => openSecret(sealed, "wrong passphrase!!"), /failed to open sealed treasury key/);
  });

  it("any ciphertext tamper fails the GCM auth tag", () => {
    const sealed = sealSecret(seed, pass);
    const raw = Buffer.from(sealed.ct, "base64");
    raw[0] ^= 0xff;
    const tampered = { ...sealed, ct: raw.toString("base64") };
    assert.throws(() => openSecret(tampered, pass), /failed to open/);
  });

  it("salt tamper (wrong KDF key) fails closed", () => {
    const sealed = sealSecret(seed, pass);
    const raw = Buffer.from(sealed.salt, "base64");
    raw[0] ^= 0xff;
    assert.throws(() => openSecret({ ...sealed, salt: raw.toString("base64") }, pass), /failed to open/);
  });

  it("rejects a non-32-byte seed", () => {
    assert.throws(() => sealSecret(new Uint8Array(31), pass), /must be 32 bytes/);
  });

  it("rejects a too-short passphrase", () => {
    assert.throws(() => sealSecret(seed, "short"), /at least 8 chars/);
  });

  it("rejects an unsupported envelope version", () => {
    const sealed = sealSecret(seed, pass);
    assert.throws(() => openSecret({ ...sealed, v: 2 as 1 }, pass), /unsupported sealed-key format/);
  });
});
