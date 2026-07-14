//! Orchestrator (`verifyClaim`) dispatch + cross-protocol adversarial tests.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { verifyClaim, VerificationError } from "./index.js";
import type { AssetView, ClaimProof, RecipientView } from "./types.js";

function decodeHex(s: string): Uint8Array {
  const h = s.replace(/^0x/, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const AR = JSON.parse(
  readFileSync(resolve(import.meta.dirname ?? ".", "arweave.golden.json"), "utf8"),
) as Record<string, string>;
const ETH = JSON.parse(
  readFileSync(resolve(import.meta.dirname ?? ".", "ethereum.golden.json"), "utf8"),
) as {
  network: string;
  claimVectors: {
    addressHex: string;
    recipientId: string;
    addressLower: string;
    claimantBase58: string;
    nonceHex: string;
    assetType: "token" | "vault";
    assetIdHex: string;
    amount: string;
    sigHex: string;
  }[];
};

const NETWORK = "solana-mainnet";

function arRecipient(): RecipientView {
  const m = decodeHex(AR.modulusHex);
  return { protocol: 0, recipientPubkey: m, recipientId: AR.recipientId, sourceAddress: AR.recipientId };
}
function arAntAsset(): AssetView {
  return { assetType: "ant", assetKey: AR.antMintBase58, antMint: AR.antMintBase58, amount: null, nonce: decodeHex(AR.nonceHex), vaultEndTs: null };
}
const ev = ETH.claimVectors[0];
function ethRecipient(): RecipientView {
  return { protocol: 1, recipientPubkey: decodeHex(ev.addressHex), recipientId: ev.recipientId, sourceAddress: ev.addressLower };
}
function ethTokenAsset(): AssetView {
  return { assetType: ev.assetType, assetKey: ev.assetIdHex, antMint: null, amount: BigInt(ev.amount), nonce: decodeHex(ev.nonceHex), vaultEndTs: null };
}

describe("verifyClaim — protocol dispatch", () => {
  it("routes an arweave recipient to the RSA-PSS verifier (accepts)", () => {
    const res = verifyClaim({
      recipient: arRecipient(),
      asset: arAntAsset(),
      proof: { claimant: AR.claimantBase58, signature: decodeHex(AR.antSigSalt32Hex), saltLength: 32 },
      network: NETWORK,
    });
    assert.equal(res.protocol, 0);
    assert.equal(res.recipientId, AR.recipientId);
  });

  it("routes an ethereum recipient to the secp256k1 verifier (accepts)", () => {
    const res = verifyClaim({
      recipient: ethRecipient(),
      asset: ethTokenAsset(),
      proof: { claimant: ev.claimantBase58, signature: decodeHex(ev.sigHex) },
      network: ETH.network,
    });
    assert.equal(res.protocol, 1);
  });

  it("unknown protocol -> PROTOCOL_MISMATCH", () => {
    const r = arRecipient();
    (r as unknown as { protocol: number }).protocol = 7;
    assert.throws(
      () => verifyClaim({ recipient: r, asset: arAntAsset(), proof: { claimant: AR.claimantBase58, signature: decodeHex(AR.antSigSalt32Hex) }, network: NETWORK }),
      (e: unknown) => e instanceof VerificationError && e.code === "PROTOCOL_MISMATCH",
    );
  });
});

describe("verifyClaim — cross-protocol / length mismatch (20 vs 512)", () => {
  it("512-byte RSA signature against an ETH recipient -> SIGNATURE_VERIFICATION_FAILED", () => {
    // recipient.protocol=1 routes to ethereum verifier; a 512-byte sig is not 65.
    const proof: ClaimProof = { claimant: ev.claimantBase58, signature: decodeHex(AR.antSigSalt32Hex) };
    assert.throws(
      () => verifyClaim({ recipient: ethRecipient(), asset: ethTokenAsset(), proof, network: ETH.network }),
      (e: unknown) => e instanceof VerificationError && e.code === "SIGNATURE_VERIFICATION_FAILED",
    );
  });

  it("65-byte secp256k1 signature against an AR recipient -> SIGNATURE_VERIFICATION_FAILED", () => {
    // recipient.protocol=0 routes to arweave verifier; a 65-byte sig is not 512.
    const proof: ClaimProof = { claimant: AR.claimantBase58, signature: decodeHex(ev.sigHex), saltLength: 32 };
    assert.throws(
      () => verifyClaim({ recipient: arRecipient(), asset: arAntAsset(), proof, network: NETWORK }),
      (e: unknown) => e instanceof VerificationError && e.code === "SIGNATURE_VERIFICATION_FAILED",
    );
  });
});
