//! AR RSA-PSS + F-1 binding cross-check (tester/UAT — M2).
//!
//! Independently confirms the two claims item-2 properties:
//!   1. The claims service and the ATTESTOR share ONE accept-set: the exact
//!      `verifyRsaPss` primitive the attestor uses accepts the golden signature
//!      (salt 0 and 32), and the SHA-256/MGF1/4096-bit params are the attestor's.
//!   2. The F-1 binding is a single hash identity that a client-supplied modulus
//!      cannot bypass: b64url(sha256(modulus)) is simultaneously the stored
//!      recipient_id, the Arweave source address (deriveArweaveAddress), and the
//!      canonical `recipient:` field (deriveRecipientIdB64Url) — all the same
//!      function of the STORED modulus, never a client value.

import { strict as assert } from "node:assert";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  deriveArweaveAddress,
  deriveRecipientIdB64Url,
  verifyRsaPss,
} from "@ar.io/attestor-canonical";

interface Golden {
  network: string;
  modulusHex: string;
  recipientId: string;
  antCanonicalHex: string;
  antSigSalt32Hex: string;
  antSigSalt0Hex: string;
  tokenCanonicalHex: string;
  tokenSigSalt32Hex: string;
}
const G: Golden = JSON.parse(
  readFileSync(resolve(import.meta.dirname ?? ".", "arweave.golden.json"), "utf8"),
) as Golden;

function decodeHex(s: string): Buffer {
  return Buffer.from(s, "hex");
}
const MODULUS = decodeHex(G.modulusHex);

describe("AR: claims reuses the attestor's exact RSA-PSS accept-set", () => {
  it("modulus is a 4096-bit / 512-byte key", () => {
    assert.equal(MODULUS.length, 512);
  });

  it("attestor verifyRsaPss accepts the golden ANT sig (salt 32)", () => {
    assert.equal(
      verifyRsaPss(decodeHex(G.antCanonicalHex), decodeHex(G.antSigSalt32Hex), MODULUS, 32),
      true,
    );
  });

  it("attestor verifyRsaPss accepts the golden ANT sig (salt 0)", () => {
    assert.equal(
      verifyRsaPss(decodeHex(G.antCanonicalHex), decodeHex(G.antSigSalt0Hex), MODULUS, 0),
      true,
    );
  });

  it("attestor verifyRsaPss accepts the golden token sig (salt 32)", () => {
    assert.equal(
      verifyRsaPss(decodeHex(G.tokenCanonicalHex), decodeHex(G.tokenSigSalt32Hex), MODULUS, 32),
      true,
    );
  });

  it("salt-32 sig checked as salt-0 does NOT verify (PSS salt is not auto-recovered)", () => {
    assert.equal(
      verifyRsaPss(decodeHex(G.antCanonicalHex), decodeHex(G.antSigSalt32Hex), MODULUS, 0),
      false,
    );
  });

  it("a one-byte tamper of the signed message does NOT verify", () => {
    const canon = decodeHex(G.antCanonicalHex);
    canon[10] ^= 0x01;
    assert.equal(verifyRsaPss(canon, decodeHex(G.antSigSalt32Hex), MODULUS, 32), false);
  });
});

describe("AR: F-1 identity — one hash of the STORED modulus, three roles", () => {
  it("deriveRecipientIdB64Url(modulus) == deriveArweaveAddress(modulus) == stored recipient_id", () => {
    const idFromCanonical = deriveRecipientIdB64Url(MODULUS);
    const idFromRsaLib = deriveArweaveAddress(MODULUS);
    assert.equal(idFromCanonical, idFromRsaLib);
    assert.equal(idFromCanonical, G.recipientId);
    assert.equal(idFromCanonical.length, 43); // 32-byte sha256 -> 43 b64url chars
  });

  it("a substituted modulus hashes to a DIFFERENT id (binding is discriminating)", () => {
    const attackerModulus = Buffer.alloc(512, 0xab);
    assert.notEqual(deriveRecipientIdB64Url(attackerModulus), G.recipientId);
  });
});
