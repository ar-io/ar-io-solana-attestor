import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as nodeSign, createPrivateKey } from "node:crypto";

import {
  RSA_4096_BYTES,
  RsaPssError,
  deriveArweaveAddress,
  modulusToKeyObject,
  verifyRsaPss,
} from "./verify-rsa-pss.js";

/// Generate a real RSA-4096 keypair using Node's crypto, return both
/// the JWK form (so we can extract the raw modulus bytes) and the
/// PEM-formatted private key for signing.
function freshRsa4096(): {
  privateKeyPem: string;
  modulus: Buffer;
} {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 4096,
    publicExponent: 0x10001,
  });
  const jwk = publicKey.export({ format: "jwk" });
  if (typeof jwk.n !== "string") {
    throw new Error("expected n in JWK export");
  }
  const modulus = Buffer.from(jwk.n, "base64url");
  // Node sometimes strips a leading zero byte; pad to exactly 512.
  let padded = modulus;
  if (modulus.length === RSA_4096_BYTES - 1) {
    padded = Buffer.concat([Buffer.from([0]), modulus]);
  } else if (modulus.length !== RSA_4096_BYTES) {
    throw new Error(`unexpected modulus length: ${modulus.length}`);
  }
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }) as string,
    modulus: padded,
  };
}

function pssSign(message: Buffer, privateKeyPem: string, saltLength: number): Buffer {
  const key = createPrivateKey(privateKeyPem);
  return nodeSign(
    "sha256",
    message,
    {
      key,
      // @ts-expect-error — Node's typings don't expose RSA_PKCS1_PSS_PADDING constant
      padding: 6, // crypto.constants.RSA_PKCS1_PSS_PADDING
      saltLength,
    },
    // @ts-expect-error: the overload is satisfied at runtime
  );
}

describe("verifyRsaPss", () => {
  it("accepts a valid signature with default salt length 32", () => {
    const { privateKeyPem, modulus } = freshRsa4096();
    const message = Buffer.from("hello escrow attestor");
    const signature = pssSign(message, privateKeyPem, 32);
    assert.equal(verifyRsaPss(message, signature, modulus, 32), true);
  });

  it("accepts a valid signature with salt length 0", () => {
    const { privateKeyPem, modulus } = freshRsa4096();
    const message = Buffer.from("zero salt is also legal in PSS");
    const signature = pssSign(message, privateKeyPem, 0);
    assert.equal(verifyRsaPss(message, signature, modulus, 0), true);
  });

  it("rejects when message has been tampered", () => {
    const { privateKeyPem, modulus } = freshRsa4096();
    const message = Buffer.from("original message");
    const signature = pssSign(message, privateKeyPem, 32);
    const tampered = Buffer.from("modified message");
    assert.equal(verifyRsaPss(tampered, signature, modulus, 32), false);
  });

  it("rejects when signature has a bit flipped", () => {
    const { privateKeyPem, modulus } = freshRsa4096();
    const message = Buffer.from("test");
    const signature = pssSign(message, privateKeyPem, 32);
    // Flip a bit deep in the signature (avoiding the high-bit area
    // where NaN-like behavior could mask the failure)
    signature[200] ^= 0x40;
    assert.equal(verifyRsaPss(message, signature, modulus, 32), false);
  });

  it("rejects when the wrong modulus is used", () => {
    const { privateKeyPem } = freshRsa4096();
    const { modulus: otherModulus } = freshRsa4096();
    const message = Buffer.from("test");
    const signature = pssSign(message, privateKeyPem, 32);
    assert.equal(verifyRsaPss(message, signature, otherModulus, 32), false);
  });

  it("rejects when salt length doesn't match what was signed", () => {
    const { privateKeyPem, modulus } = freshRsa4096();
    const message = Buffer.from("test");
    // Signed with salt 32 — verify with salt 0 should fail
    const signature = pssSign(message, privateKeyPem, 32);
    assert.equal(verifyRsaPss(message, signature, modulus, 0), false);
  });

  it("throws on signature of wrong length", () => {
    const { modulus } = freshRsa4096();
    const tooShort = Buffer.alloc(64);
    assert.throws(() => verifyRsaPss(Buffer.from("x"), tooShort, modulus, 32), RsaPssError);
  });

  it("throws on modulus of wrong length", () => {
    const tooShort = Buffer.alloc(64);
    const sig = Buffer.alloc(RSA_4096_BYTES);
    assert.throws(() => verifyRsaPss(Buffer.from("x"), sig, tooShort, 32), RsaPssError);
  });

  it("throws on out-of-range salt length", () => {
    const { modulus } = freshRsa4096();
    const sig = Buffer.alloc(RSA_4096_BYTES);
    assert.throws(() => verifyRsaPss(Buffer.from("x"), sig, modulus, 64), RsaPssError);
    assert.throws(() => verifyRsaPss(Buffer.from("x"), sig, modulus, -1), RsaPssError);
  });
});

describe("modulusToKeyObject", () => {
  it("imports a valid 4096-bit modulus", () => {
    const { modulus } = freshRsa4096();
    const key = modulusToKeyObject(modulus);
    assert.equal(key.asymmetricKeyType, "rsa");
  });

  it("rejects a modulus of wrong length", () => {
    assert.throws(() => modulusToKeyObject(Buffer.alloc(64)), RsaPssError);
  });
});

describe("deriveArweaveAddress", () => {
  it("produces a 43-character base64url string", () => {
    const { modulus } = freshRsa4096();
    const addr = deriveArweaveAddress(modulus);
    assert.equal(addr.length, 43);
    assert.match(addr, /^[A-Za-z0-9_-]+$/);
  });

  it("is deterministic for a given modulus", () => {
    const { modulus } = freshRsa4096();
    assert.equal(deriveArweaveAddress(modulus), deriveArweaveAddress(modulus));
  });

  it("differs across moduli", () => {
    const a = freshRsa4096();
    const b = freshRsa4096();
    assert.notEqual(deriveArweaveAddress(a.modulus), deriveArweaveAddress(b.modulus));
  });

  it("rejects modulus of wrong length", () => {
    assert.throws(() => deriveArweaveAddress(Buffer.alloc(64)), RsaPssError);
  });
});
