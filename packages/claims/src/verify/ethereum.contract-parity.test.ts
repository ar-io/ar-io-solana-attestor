//! CONTRACT-ground-truth Ethereum parity (tester/UAT — M2).
//!
//! The dev's `ethereum.test.ts` uses an ethers v6 oracle. This file instead
//! pins the TS verifier against the DEPLOYED CONTRACT's own crypto: vectors in
//! `ethereum.contract.golden.json` were produced by a temporary test appended
//! to `ario-ant-escrow/src/verify/ethereum.rs` (then reverted) that used the
//! contract's OWN `build_ant_escrow_claim_message` / `build_escrow_claim_message`
//! + `verify_personal_sign` + its `libsecp256k1` dev-dep. Each vector was
//! self-validated inside Rust: the contract ACCEPTS `validSigHex`, and REJECTS
//! `highSSigHex` (EcdsaHighS) and `tamperedSigHex`.
//!
//! What this proves that the ethers oracle does not:
//!   1. `verifyPersonalSign` accepts EXACTLY a signature the contract accepts
//!      (over the contract's own EIP-191 wire format).
//!   2. TS `buildCanonicalFromLedger` reproduces the contract's canonical bytes
//!      BYTE-FOR-BYTE, live (independent of the golden-vector layer).
//!   3. A malleable high-S counterpart of a CONTRACT-signed sig is rejected
//!      (ECDSA_HIGH_S) — the malleability decision matches the contract's
//!      `is_s_low` on a real contract signature, not just an ethers one.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { deriveRecipientIdB64Url } from "@ar.io/attestor-canonical";

import { verifyEthereumProof, verifyPersonalSign } from "./ethereum.js";
import { verifyClaim } from "./index.js";
import { buildCanonicalFromLedger } from "./canonical-message.js";
import { VerificationError } from "./errors.js";
import type { AssetView, ClaimProof, RecipientView } from "./types.js";

interface Vector {
  name: string;
  shape: "ant" | "token" | "vault";
  addrHex: string;
  claimantBase58: string;
  nonceHex: string;
  antMintBase58: string | null;
  assetType: "token" | "vault" | null;
  assetIdHex: string | null;
  amount: string | null;
  canonicalHex: string;
  validSigHex: string;
  highSSigHex: string;
  tamperedSigHex: string;
}
interface Golden {
  network: string;
  claimantBase58: string;
  nonceHex: string;
  vectors: Vector[];
}

const G: Golden = JSON.parse(
  readFileSync(resolve(import.meta.dirname ?? ".", "ethereum.contract.golden.json"), "utf8"),
) as Golden;
const NETWORK = G.network;

function decodeHex(s: string): Uint8Array {
  const h = s.replace(/^0x/, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function recipientOf(v: Vector): RecipientView {
  const addr = decodeHex(v.addrHex);
  return {
    protocol: 1,
    recipientPubkey: addr,
    recipientId: deriveRecipientIdB64Url(addr),
    sourceAddress: "0x" + v.addrHex,
  };
}
function assetOf(v: Vector): AssetView {
  if (v.shape === "ant") {
    return {
      assetType: "ant",
      assetKey: v.antMintBase58!,
      antMint: v.antMintBase58!,
      amount: null,
      nonce: decodeHex(v.nonceHex),
      vaultEndTs: null,
    };
  }
  return {
    assetType: v.assetType!,
    assetKey: v.assetIdHex!,
    antMint: null,
    amount: BigInt(v.amount!),
    nonce: decodeHex(v.nonceHex),
    vaultEndTs: v.shape === "vault" ? 9_999_999_999 : null,
  };
}
function expectCode(fn: () => void, code: string) {
  assert.throws(fn, (e: unknown) => e instanceof VerificationError && e.code === code);
}

describe("ETH contract parity — verifyPersonalSign accepts contract-signed sigs", () => {
  for (const v of G.vectors) {
    it(`accepts the contract's own valid sig (${v.name})`, () => {
      assert.doesNotThrow(() =>
        verifyPersonalSign(decodeHex(v.canonicalHex), decodeHex(v.validSigHex), decodeHex(v.addrHex)),
      );
    });
  }
});

describe("ETH contract parity — TS canonical rebuild == contract bytes (live)", () => {
  for (const v of G.vectors) {
    it(`buildCanonicalFromLedger reproduces contract canonical (${v.name})`, () => {
      const rebuilt = buildCanonicalFromLedger({
        recipient: recipientOf(v),
        asset: assetOf(v),
        claimant: v.claimantBase58,
        nonce: decodeHex(v.nonceHex),
        network: NETWORK,
      });
      assert.equal(toHex(rebuilt), v.canonicalHex);
    });
  }
});

describe("ETH contract parity — verifyEthereumProof end-to-end", () => {
  for (const v of G.vectors) {
    it(`accepts + rebuilds exact contract canonical (${v.name})`, () => {
      const proof: ClaimProof = { claimant: v.claimantBase58, signature: decodeHex(v.validSigHex) };
      const res = verifyEthereumProof({
        recipient: recipientOf(v),
        asset: assetOf(v),
        proof,
        network: NETWORK,
      });
      assert.equal(res.protocol, 1);
      assert.equal(res.claimant, v.claimantBase58);
      assert.equal(toHex(res.canonicalMessage), v.canonicalHex);
    });

    it(`verifyClaim dispatch accepts (${v.name})`, () => {
      const res = verifyClaim({
        recipient: recipientOf(v),
        asset: assetOf(v),
        proof: { claimant: v.claimantBase58, signature: decodeHex(v.validSigHex) },
        network: NETWORK,
      });
      assert.equal(res.protocol, 1);
    });
  }
});

describe("ETH contract parity — contract-rejected sigs are rejected here too", () => {
  for (const v of G.vectors) {
    // The contract asserted EcdsaHighS on exactly this s'=n-s / v^1 counterpart.
    it(`rejects the contract's high-S counterpart -> ECDSA_HIGH_S (${v.name})`, () => {
      expectCode(
        () =>
          verifyEthereumProof({
            recipient: recipientOf(v),
            asset: assetOf(v),
            proof: { claimant: v.claimantBase58, signature: decodeHex(v.highSSigHex) },
            network: NETWORK,
          }),
        "ECDSA_HIGH_S",
      );
    });

    it(`rejects the contract's tampered sig (${v.name})`, () => {
      assert.throws(
        () =>
          verifyEthereumProof({
            recipient: recipientOf(v),
            asset: assetOf(v),
            proof: { claimant: v.claimantBase58, signature: decodeHex(v.tamperedSigHex) },
            network: NETWORK,
          }),
        (e: unknown) => e instanceof VerificationError,
      );
    });

    // Redirect/front-run proof: the contract binds `claimant` in the message,
    // so re-pointing it invalidates the contract-signed sig here as well.
    it(`rejects redirected claimant on a contract sig (${v.name})`, () => {
      assert.throws(
        () =>
          verifyEthereumProof({
            recipient: recipientOf(v),
            asset: assetOf(v),
            proof: {
              claimant: "GpRq5C5cAaR1nL2A8bJh9kE3yz6T2sP4MqVxKn9wB8jF",
              signature: decodeHex(v.validSigHex),
            },
            network: NETWORK,
          }),
        (e: unknown) => e instanceof VerificationError,
      );
    });
  }
});
