//! Arweave RSA-PSS-4096 verification tests.
//!
//! Ground truth = `arweave.golden.json`: a real 4096-bit key signs the
//! byte-pinned canonical claim message (salt 0 and 32). Reuses the byte-pinned
//! `@ar.io/attestor-canonical` crypto (no re-implementation).

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { deriveRecipientIdB64Url } from "@ar.io/attestor-canonical";

import { verifyArweaveProof } from "./arweave.js";
import { VerificationError } from "./errors.js";
import type { AssetView, ClaimProof, RecipientView } from "./types.js";

interface Golden {
  network: string;
  antMintBase58: string;
  claimantBase58: string;
  nonceHex: string;
  tokenAssetIdHex: string;
  tokenAmount: string;
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
const NETWORK = G.network;

function decodeHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const MODULUS = decodeHex(G.modulusHex);
const NONCE = decodeHex(G.nonceHex);

function recipient(): RecipientView {
  return {
    protocol: 0,
    recipientPubkey: MODULUS,
    recipientId: G.recipientId,
    sourceAddress: G.recipientId, // for AR, source_address == recipient_id
  };
}
function antAsset(): AssetView {
  return {
    assetType: "ant",
    assetKey: G.antMintBase58,
    antMint: G.antMintBase58,
    amount: null,
    nonce: NONCE,
    vaultEndTs: null,
  };
}
function tokenAsset(): AssetView {
  return {
    assetType: "token",
    assetKey: G.tokenAssetIdHex,
    antMint: null,
    amount: BigInt(G.tokenAmount),
    nonce: NONCE,
    vaultEndTs: null,
  };
}
function expectCode(fn: () => void, code: string) {
  assert.throws(fn, (e: unknown) => e instanceof VerificationError && e.code === code);
}

// ---------------------------------------------------------------------------
// Positive
// ---------------------------------------------------------------------------

describe("verifyArweaveProof — golden accepts", () => {
  it("ANT claim, salt 32, rebuilds exact canonical", () => {
    const res = verifyArweaveProof({
      recipient: recipient(),
      asset: antAsset(),
      proof: { claimant: G.claimantBase58, signature: decodeHex(G.antSigSalt32Hex), saltLength: 32 },
      network: NETWORK,
    });
    assert.equal(res.protocol, 0);
    assert.equal(res.recipientId, G.recipientId);
    assert.equal(toHex(res.canonicalMessage), G.antCanonicalHex);
  });

  it("ANT claim, salt 0", () => {
    assert.doesNotThrow(() =>
      verifyArweaveProof({
        recipient: recipient(),
        asset: antAsset(),
        proof: { claimant: G.claimantBase58, signature: decodeHex(G.antSigSalt0Hex), saltLength: 0 },
        network: NETWORK,
      }),
    );
  });

  it("token claim, salt 32 (default), rebuilds exact canonical", () => {
    const res = verifyArweaveProof({
      recipient: recipient(),
      asset: tokenAsset(),
      proof: { claimant: G.claimantBase58, signature: decodeHex(G.tokenSigSalt32Hex) }, // salt defaults 32
      network: NETWORK,
    });
    assert.equal(toHex(res.canonicalMessage), G.tokenCanonicalHex);
  });

  it("accepts when the client echoes the correct modulus (F-1 defense-in-depth)", () => {
    assert.doesNotThrow(() =>
      verifyArweaveProof({
        recipient: recipient(),
        asset: antAsset(),
        proof: {
          claimant: G.claimantBase58,
          signature: decodeHex(G.antSigSalt32Hex),
          saltLength: 32,
          providedModulus: MODULUS,
        },
        network: NETWORK,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Adversarial / negative
// ---------------------------------------------------------------------------

describe("verifyArweaveProof — adversarial rejections", () => {
  it("wrong modulus (sig valid for a different key) -> RSA_SIGNATURE_INVALID", () => {
    // A consistent-but-wrong recipient: modulus of all 0xAB, with its OWN
    // matching recipientId so the F-1 id binding passes and RSA verify is what
    // actually fails (the sig was made for the real key).
    const wrong = new Uint8Array(512).fill(0xab);
    const wrongId = deriveRecipientIdB64Url(wrong);
    const r: RecipientView = { protocol: 0, recipientPubkey: wrong, recipientId: wrongId, sourceAddress: wrongId };
    expectCode(
      () => verifyArweaveProof({ recipient: r, asset: antAsset(), proof: { claimant: G.claimantBase58, signature: decodeHex(G.antSigSalt32Hex), saltLength: 32 }, network: NETWORK }),
      "RSA_SIGNATURE_INVALID",
    );
  });

  it("tampered message (off-by-one amount) -> RSA_SIGNATURE_INVALID", () => {
    const asset = tokenAsset();
    asset.amount = BigInt(G.tokenAmount) + 1n;
    expectCode(
      () => verifyArweaveProof({ recipient: recipient(), asset, proof: { claimant: G.claimantBase58, signature: decodeHex(G.tokenSigSalt32Hex) }, network: NETWORK }),
      "RSA_SIGNATURE_INVALID",
    );
  });

  it("tampered claimant -> RSA_SIGNATURE_INVALID (front-run proof)", () => {
    expectCode(
      () => verifyArweaveProof({ recipient: recipient(), asset: antAsset(), proof: { claimant: "GpRq5C5cAaR1nL2A8bJh9kE3yz6T2sP4MqVxKn9wB8jF", signature: decodeHex(G.antSigSalt32Hex), saltLength: 32 }, network: NETWORK }),
      "RSA_SIGNATURE_INVALID",
    );
  });

  it("salt mismatch (salt-32 sig verified as salt 0) -> RSA_SIGNATURE_INVALID", () => {
    expectCode(
      () => verifyArweaveProof({ recipient: recipient(), asset: antAsset(), proof: { claimant: G.claimantBase58, signature: decodeHex(G.antSigSalt32Hex), saltLength: 0 }, network: NETWORK }),
      "RSA_SIGNATURE_INVALID",
    );
  });

  it("unsupported salt length (16) -> UNSUPPORTED_SALT_LENGTH", () => {
    expectCode(
      () => verifyArweaveProof({ recipient: recipient(), asset: antAsset(), proof: { claimant: G.claimantBase58, signature: decodeHex(G.antSigSalt32Hex), saltLength: 16 }, network: NETWORK }),
      "UNSUPPORTED_SALT_LENGTH",
    );
  });

  it("wrong signature length (511) -> SIGNATURE_VERIFICATION_FAILED", () => {
    expectCode(
      () => verifyArweaveProof({ recipient: recipient(), asset: antAsset(), proof: { claimant: G.claimantBase58, signature: decodeHex(G.antSigSalt32Hex).subarray(0, 511), saltLength: 32 }, network: NETWORK }),
      "SIGNATURE_VERIFICATION_FAILED",
    );
  });

  it("empty signature -> SIGNATURE_VERIFICATION_FAILED", () => {
    expectCode(
      () => verifyArweaveProof({ recipient: recipient(), asset: antAsset(), proof: { claimant: G.claimantBase58, signature: new Uint8Array(0), saltLength: 32 }, network: NETWORK }),
      "SIGNATURE_VERIFICATION_FAILED",
    );
  });

  it("oversized signature (1024 bytes) -> SIGNATURE_VERIFICATION_FAILED", () => {
    expectCode(
      () => verifyArweaveProof({ recipient: recipient(), asset: antAsset(), proof: { claimant: G.claimantBase58, signature: new Uint8Array(1024).fill(1), saltLength: 32 }, network: NETWORK }),
      "SIGNATURE_VERIFICATION_FAILED",
    );
  });

  it("protocol mismatch (ethereum recipient routed to AR verifier) -> PROTOCOL_MISMATCH", () => {
    const r = recipient();
    (r as RecipientView).protocol = 1;
    expectCode(
      () => verifyArweaveProof({ recipient: r, asset: antAsset(), proof: { claimant: G.claimantBase58, signature: decodeHex(G.antSigSalt32Hex), saltLength: 32 }, network: NETWORK }),
      "PROTOCOL_MISMATCH",
    );
  });

  it("length mismatch (20-byte address as AR modulus) -> SIGNATURE_VERIFICATION_FAILED", () => {
    const r = recipient();
    r.recipientPubkey = new Uint8Array(20).fill(7); // an ETH address, not a modulus
    expectCode(
      () => verifyArweaveProof({ recipient: r, asset: antAsset(), proof: { claimant: G.claimantBase58, signature: decodeHex(G.antSigSalt32Hex), saltLength: 32 }, network: NETWORK }),
      "SIGNATURE_VERIFICATION_FAILED",
    );
  });

  it("recipient_id inconsistent with modulus -> RECIPIENT_ID_MISMATCH", () => {
    const r = recipient();
    r.recipientId = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 43 chars, wrong
    r.sourceAddress = r.recipientId;
    expectCode(
      () => verifyArweaveProof({ recipient: r, asset: antAsset(), proof: { claimant: G.claimantBase58, signature: decodeHex(G.antSigSalt32Hex), saltLength: 32 }, network: NETWORK }),
      "RECIPIENT_ID_MISMATCH",
    );
  });

  it("source_address inconsistent with modulus -> RECIPIENT_ID_MISMATCH", () => {
    const r = recipient();
    r.sourceAddress = "some-other-arweave-address-000000000000000"; // 43 chars
    expectCode(
      () => verifyArweaveProof({ recipient: r, asset: antAsset(), proof: { claimant: G.claimantBase58, signature: decodeHex(G.antSigSalt32Hex), saltLength: 32 }, network: NETWORK }),
      "RECIPIENT_ID_MISMATCH",
    );
  });

  it("client echoes a wrong modulus -> MODULUS_MISMATCH", () => {
    const wrong = new Uint8Array(512).fill(0xcd);
    expectCode(
      () => verifyArweaveProof({ recipient: recipient(), asset: antAsset(), proof: { claimant: G.claimantBase58, signature: decodeHex(G.antSigSalt32Hex), saltLength: 32, providedModulus: wrong }, network: NETWORK }),
      "MODULUS_MISMATCH",
    );
  });

  it("replayed/mismatched nonce echo -> NONCE_MISMATCH", () => {
    expectCode(
      () => verifyArweaveProof({ recipient: recipient(), asset: antAsset(), proof: { claimant: G.claimantBase58, signature: decodeHex(G.antSigSalt32Hex), saltLength: 32, nonce: new Uint8Array(32).fill(0xff) }, network: NETWORK }),
      "NONCE_MISMATCH",
    );
  });
});
