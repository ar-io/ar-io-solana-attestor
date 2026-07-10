//! signer: encrypted-hot-key load/unlock, in-memory signer, separable roles.

import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import { sealSecret } from "./crypto-box.js";
import {
  EncryptedKeypairSigner,
  InMemoryKeypairSigner,
  KmsSigner,
  SquadsSigner,
  assertSeparableRoles,
} from "./signer.js";

describe("EncryptedKeypairSigner", () => {
  const seed = new Uint8Array(randomBytes(32));
  const pass = "unlock me please";

  it("loads from a sealed blob and yields a stable kit signer", async () => {
    const sealed = sealSecret(seed, pass);
    const s = await EncryptedKeypairSigner.load("token", sealed, pass);
    assert.equal(s.kind, "encrypted-hot-key");
    assert.equal(s.role, "token");
    const signer1 = await s.getSigner();
    const signer2 = await s.getSigner();
    assert.equal(signer1.address, s.address);
    assert.equal(signer1, signer2); // cached
  });

  it("fails at load on a wrong passphrase (fail-fast at boot)", async () => {
    const sealed = sealSecret(seed, pass);
    await assert.rejects(EncryptedKeypairSigner.load("token", sealed, "not the passphrase"), /failed to open/);
  });

  it("in-memory signer derives the same address as the encrypted one for the same seed", async () => {
    const enc = await EncryptedKeypairSigner.load("token", sealSecret(seed, pass), pass);
    const mem = await InMemoryKeypairSigner.fromSeed("token", seed);
    assert.equal(enc.address, mem.address);
  });
});

describe("assertSeparableRoles", () => {
  it("passes when token + ant signers differ", async () => {
    const token = await InMemoryKeypairSigner.fromSeed("token", new Uint8Array(randomBytes(32)));
    const ant = await InMemoryKeypairSigner.fromSeed("ant", new Uint8Array(randomBytes(32)));
    assert.doesNotThrow(() => assertSeparableRoles({ token, ant }));
  });

  it("throws when the ANT signer IS the hot token dispenser (blast-radius guard)", async () => {
    const seed = new Uint8Array(randomBytes(32));
    const token = await InMemoryKeypairSigner.fromSeed("token", seed);
    const ant = await InMemoryKeypairSigner.fromSeed("ant", seed); // same key!
    assert.throws(() => assertSeparableRoles({ token, ant }), /must NOT be the hot token dispenser/);
  });

  it("passes with no ANT signer (token-only worker)", async () => {
    const token = await InMemoryKeypairSigner.fromSeed("token", new Uint8Array(randomBytes(32)));
    assert.doesNotThrow(() => assertSeparableRoles({ token }));
  });
});

describe("remote-backend stubs", () => {
  it("KMS / Squads signers conform to the interface but throw until wired", () => {
    const kms = new KmsSigner("token", "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB" as never, "arn:kms:key");
    const sq = new SquadsSigner("ant", "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB" as never, "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB" as never);
    assert.equal(kms.kind, "kms");
    assert.equal(sq.kind, "squads");
    assert.rejects(async () => kms.getSigner(), /not implemented/);
    assert.rejects(async () => sq.getSigner(), /not implemented/);
  });
});
