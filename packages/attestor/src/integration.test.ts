//! Full-stack integration test: spin up the Express service in-process,
//! POST a real RSA-PSS-signed claim, verify the returned Ed25519 sig
//! against the attestor's published pubkey.
//!
//! This is the test that proves the whole architecture works end-to-end
//! on the off-chain side. The on-chain side has its own integration
//! test in `contracts/programs/ario-ant-escrow/tests/integration.rs`.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  createPrivateKey,
  sign as nodeSign,
  randomBytes,
} from "node:crypto";
import bs58 from "bs58";
import * as ed25519 from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2";
import type { Server } from "node:http";

import { buildAntEscrowClaimMessage, RSA_4096_BYTES } from "@ar.io/attestor-canonical";

ed25519.etc.sha512Sync = (...m) => sha512(ed25519.etc.concatBytes(...m));

function freshRsa4096(): { privateKeyPem: string; modulus: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 4096,
    publicExponent: 0x10001,
  });
  const jwk = publicKey.export({ format: "jwk" });
  if (typeof jwk.n !== "string") throw new Error("jwk.n missing");
  const modulus = Buffer.from(jwk.n, "base64url");
  let padded = modulus;
  if (modulus.length === RSA_4096_BYTES - 1) {
    padded = Buffer.concat([Buffer.from([0]), modulus]);
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
      // @ts-expect-error: padding constant
      padding: 6, // crypto.constants.RSA_PKCS1_PSS_PADDING
      saltLength,
    },
    // @ts-expect-error: overload satisfied at runtime
  );
}

describe("/attest end-to-end", () => {
  let server: Server;
  let port: number;
  let attestorPubkey: Uint8Array;
  const attestorSeed = randomBytes(32);

  before(async () => {
    process.env.ATTESTOR_SECRET_BASE58 = bs58.encode(attestorSeed);
    process.env.NETWORK = "localnet";
    process.env.PORT = "0"; // OS picks a free port
    process.env.LOG_LEVEL = "silent";
    process.env.RATE_LIMIT_PER_MIN = "10000"; // don't fight the test

    // Defer-import so the env vars are read at module init time.
    const { default: app } = await import("./app.js");
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (addr === null || typeof addr === "string") {
          throw new Error("expected AddressInfo");
        }
        port = addr.port;
        resolve();
      });
    });

    attestorPubkey = ed25519.getPublicKey(attestorSeed);
  });

  after(() => {
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("GET /health returns the attestor pubkey", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.network, "localnet");
    const decoded = bs58.decode(body.attestorPubkeyBase58);
    assert.deepEqual(decoded, attestorPubkey);
  });

  it("POST /attest happy path: RSA sig in, Ed25519 sig out", async () => {
    const { privateKeyPem, modulus } = freshRsa4096();
    const antMint = randomBytes(32);
    const claimant = randomBytes(32);
    const nonce = randomBytes(32);

    const canonical = buildAntEscrowClaimMessage({
      antMint,
      claimant,
      nonce,
      network: "localnet",
      recipientPubkey: modulus,
    });

    const rsaSignature = pssSign(Buffer.from(canonical), privateKeyPem, 32);

    const res = await fetch(`http://127.0.0.1:${port}/attest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        antMintBase58: bs58.encode(antMint),
        claimantBase58: bs58.encode(claimant),
        nonceHex: Buffer.from(nonce).toString("hex"),
        rsaModulusBase64Url: modulus.toString("base64url"),
        rsaSignatureBase64Url: rsaSignature.toString("base64url"),
        saltLength: 32,
      }),
    });
    const body = (await res.json()) as Record<string, string>;
    assert.equal(res.status, 200, JSON.stringify(body));

    // Returned canonical message should match what we built locally
    const returnedCanonical = Buffer.from(body.canonicalMessageBase64Url, "base64url");
    assert.deepEqual(new Uint8Array(returnedCanonical), canonical);

    // Ed25519 sig must verify under the attestor's pubkey over the canonical bytes
    const ed25519Sig = Buffer.from(body.attestationSignatureBase64Url, "base64url");
    const returnedPubkey = bs58.decode(body.attestorPubkeyBase58);
    assert.deepEqual(returnedPubkey, attestorPubkey);
    assert.equal(ed25519.verify(ed25519Sig, canonical, returnedPubkey), true);
  });

  it("POST /attest rejects an invalid RSA signature with 401", async () => {
    const { modulus } = freshRsa4096();
    const antMint = randomBytes(32);
    const claimant = randomBytes(32);
    const nonce = randomBytes(32);
    // Random bytes that are NOT a valid signature
    const fakeSig = randomBytes(RSA_4096_BYTES);

    const res = await fetch(`http://127.0.0.1:${port}/attest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        antMintBase58: bs58.encode(antMint),
        claimantBase58: bs58.encode(claimant),
        nonceHex: Buffer.from(nonce).toString("hex"),
        rsaModulusBase64Url: modulus.toString("base64url"),
        rsaSignatureBase64Url: fakeSig.toString("base64url"),
        saltLength: 32,
      }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "RSA_SIGNATURE_INVALID");
  });

  it("POST /attest rejects sig produced over wrong canonical message", async () => {
    const { privateKeyPem, modulus } = freshRsa4096();
    const antMint = randomBytes(32);
    const claimant = randomBytes(32);
    const nonce = randomBytes(32);

    // Sign over A
    const wrongMessage = buildAntEscrowClaimMessage({
      antMint: randomBytes(32), // different mint
      claimant,
      nonce,
      network: "localnet",
      recipientPubkey: modulus,
    });
    const sig = pssSign(Buffer.from(wrongMessage), privateKeyPem, 32);

    // But submit claim params for B
    const res = await fetch(`http://127.0.0.1:${port}/attest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        antMintBase58: bs58.encode(antMint), // different from what was signed
        claimantBase58: bs58.encode(claimant),
        nonceHex: Buffer.from(nonce).toString("hex"),
        rsaModulusBase64Url: modulus.toString("base64url"),
        rsaSignatureBase64Url: sig.toString("base64url"),
        saltLength: 32,
      }),
    });
    assert.equal(res.status, 401);
  });

  it("POST /attest rejects unsupported salt length 16", async () => {
    const { privateKeyPem, modulus } = freshRsa4096();
    const antMint = randomBytes(32);
    const claimant = randomBytes(32);
    const nonce = randomBytes(32);
    const canonical = buildAntEscrowClaimMessage({
      antMint,
      claimant,
      nonce,
      network: "localnet",
      recipientPubkey: modulus,
    });
    const sig = pssSign(Buffer.from(canonical), privateKeyPem, 16);

    const res = await fetch(`http://127.0.0.1:${port}/attest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        antMintBase58: bs58.encode(antMint),
        claimantBase58: bs58.encode(claimant),
        nonceHex: Buffer.from(nonce).toString("hex"),
        rsaModulusBase64Url: modulus.toString("base64url"),
        rsaSignatureBase64Url: sig.toString("base64url"),
        saltLength: 16,
      }),
    });
    assert.equal(res.status, 422);
  });

  it("POST /attest rejects malformed body with 400", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/attest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });
});
