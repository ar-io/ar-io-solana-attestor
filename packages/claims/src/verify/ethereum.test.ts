//! Ethereum secp256k1 / EIP-191 verification tests.
//!
//! Ground truth = `ethereum.golden.json`, produced by ethers v6
//! `Wallet.signMessage` (the exact library the escrow frontend signs with) and
//! independently pinning the EIP-191 wire format the contract's
//! `verify/ethereum.rs` implements.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { getPublicKey } from "@noble/secp256k1";

import {
  verifyEthereumProof,
  verifyPersonalSign,
  eip191Hash,
  deriveEthereumAddress,
} from "./ethereum.js";
import { VerificationError } from "./errors.js";
import type { AssetView, ClaimProof, RecipientView } from "./types.js";

interface ClaimVector {
  name: string;
  addressLower: string;
  addressHex: string;
  recipientId: string;
  claimantBase58: string;
  nonceHex: string;
  assetType?: "token" | "vault";
  assetIdHex?: string;
  amount?: string;
  antMintBase58?: string;
  canonicalHex: string;
  sigHex: string;
  eip191HashHex: string;
}
interface Golden {
  network: string;
  wellKnownKeys: Record<string, string>;
  claimVectors: ClaimVector[];
  personalSignVectors: {
    addressLower: string;
    addressHex: string;
    message: string;
    sigHex: string;
    eip191HashHex: string;
  }[];
}

const GOLDEN: Golden = JSON.parse(
  readFileSync(resolve(import.meta.dirname ?? ".", "ethereum.golden.json"), "utf8"),
) as Golden;
const NETWORK = GOLDEN.network;

/** secp256k1 curve order n (big-endian) — for building malleable high-S sigs. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

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
function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function bigToBe32(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function recipientOf(v: ClaimVector): RecipientView {
  return {
    protocol: 1,
    recipientPubkey: decodeHex(v.addressHex),
    recipientId: v.recipientId,
    sourceAddress: v.addressLower,
  };
}
function assetOf(v: ClaimVector): AssetView {
  if (v.antMintBase58) {
    return {
      assetType: "ant",
      assetKey: v.antMintBase58,
      antMint: v.antMintBase58,
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
    vaultEndTs: v.assetType === "vault" ? 9_999_999_999 : null,
  };
}

// ---------------------------------------------------------------------------
// EIP-191 wire format + address derivation parity
// ---------------------------------------------------------------------------

describe("eip191Hash == ethers hashMessage (wire-format parity)", () => {
  for (const v of GOLDEN.personalSignVectors) {
    it(`personal_sign hash matches for "${v.message}"`, () => {
      assert.equal("0x" + toHex(eip191Hash(utf8(v.message))), v.eip191HashHex);
    });
  }
  for (const v of GOLDEN.claimVectors) {
    it(`canonical-message hash matches for: ${v.name}`, () => {
      assert.equal("0x" + toHex(eip191Hash(decodeHex(v.canonicalHex))), v.eip191HashHex);
    });
  }
});

describe("deriveEthereumAddress == well-known private-key addresses", () => {
  for (const [priv, addr] of Object.entries(GOLDEN.wellKnownKeys)) {
    it(`privkey ${priv.slice(0, 6)}… -> ${addr}`, () => {
      const pub = getPublicKey(decodeHex(priv), false); // 65-byte uncompressed
      assert.equal("0x" + toHex(deriveEthereumAddress(pub)), addr);
    });
  }
});

// ---------------------------------------------------------------------------
// verifyPersonalSign — low-level, over arbitrary + full canonical messages
// ---------------------------------------------------------------------------

describe("verifyPersonalSign accepts ethers-produced signatures", () => {
  for (const v of GOLDEN.personalSignVectors) {
    it(`accepts "${v.message}" for ${v.addressLower}`, () => {
      assert.doesNotThrow(() =>
        verifyPersonalSign(utf8(v.message), decodeHex(v.sigHex), decodeHex(v.addressHex)),
      );
    });
  }
  for (const v of GOLDEN.claimVectors) {
    it(`accepts full canonical for: ${v.name}`, () => {
      assert.doesNotThrow(() =>
        verifyPersonalSign(decodeHex(v.canonicalHex), decodeHex(v.sigHex), decodeHex(v.addressHex)),
      );
    });
  }
});

// ---------------------------------------------------------------------------
// verifyEthereumProof — end-to-end (rebuild canonical from ledger, verify)
// ---------------------------------------------------------------------------

describe("verifyEthereumProof — golden accepts + canonical rebuild parity", () => {
  for (const v of GOLDEN.claimVectors) {
    it(`accepts and rebuilds exact canonical for: ${v.name}`, () => {
      const proof: ClaimProof = {
        claimant: v.claimantBase58,
        signature: decodeHex(v.sigHex),
      };
      const res = verifyEthereumProof({
        recipient: recipientOf(v),
        asset: assetOf(v),
        proof,
        network: NETWORK,
      });
      assert.equal(res.protocol, 1);
      assert.equal(res.claimant, v.claimantBase58);
      // Server rebuilt EXACTLY the signed bytes (never client-supplied).
      assert.equal(toHex(res.canonicalMessage), v.canonicalHex);
    });
  }
});

// ---------------------------------------------------------------------------
// Adversarial / negative
// ---------------------------------------------------------------------------

describe("verifyEthereumProof — adversarial rejections", () => {
  const base = GOLDEN.claimVectors[0]; // token escrow, privkey=1

  function proofOf(sigHex = base.sigHex): ClaimProof {
    return { claimant: base.claimantBase58, signature: decodeHex(sigHex) };
  }
  function expectCode(fn: () => void, code: string) {
    assert.throws(fn, (e: unknown) => e instanceof VerificationError && e.code === code);
  }

  it("wrong recipient address -> ETHEREUM_ADDRESS_MISMATCH", () => {
    const r = recipientOf(base);
    r.recipientPubkey = decodeHex(base.addressHex);
    r.recipientPubkey[0] ^= 0x01; // flip one byte
    expectCode(
      () => verifyEthereumProof({ recipient: r, asset: assetOf(base), proof: proofOf(), network: NETWORK }),
      "ETHEREUM_ADDRESS_MISMATCH",
    );
  });

  it("tampered message (off-by-one amount) -> ETHEREUM_ADDRESS_MISMATCH", () => {
    // Server rebuilds canonical from ledger amount+1; sig was over the original.
    const asset = assetOf(base);
    asset.amount = BigInt(base.amount!) + 1n;
    expectCode(
      () => verifyEthereumProof({ recipient: recipientOf(base), asset, proof: proofOf(), network: NETWORK }),
      "ETHEREUM_ADDRESS_MISMATCH",
    );
  });

  it("tampered claimant -> ETHEREUM_ADDRESS_MISMATCH (front-run proof)", () => {
    const proof = proofOf();
    proof.claimant = "GpRq5C5cAaR1nL2A8bJh9kE3yz6T2sP4MqVxKn9wB8jF"; // different wallet
    expectCode(
      () => verifyEthereumProof({ recipient: recipientOf(base), asset: assetOf(base), proof, network: NETWORK }),
      "ETHEREUM_ADDRESS_MISMATCH",
    );
  });

  it("malleable high-S signature -> ECDSA_HIGH_S", () => {
    // Build the malleable counterpart: s' = n - s, v' = v ^ 1. ethers emits
    // low-S, so the counterpart is guaranteed high-S.
    const sig = decodeHex(base.sigHex);
    const s = BigInt("0x" + toHex(sig.subarray(32, 64)));
    const sHigh = SECP256K1_N - s;
    const tampered = new Uint8Array(sig);
    tampered.set(bigToBe32(sHigh), 32);
    tampered[64] = sig[64] === 27 ? 28 : sig[64] === 28 ? 27 : sig[64] ^ 1;
    expectCode(
      () => verifyEthereumProof({ recipient: recipientOf(base), asset: assetOf(base), proof: proofOf(toHex(tampered)), network: NETWORK }),
      "ECDSA_HIGH_S",
    );
  });

  it("invalid recovery id (v=5) -> INVALID_RECOVERY_ID", () => {
    const sig = decodeHex(base.sigHex);
    sig[64] = 5;
    expectCode(
      () => verifyEthereumProof({ recipient: recipientOf(base), asset: assetOf(base), proof: proofOf(toHex(sig)), network: NETWORK }),
      "INVALID_RECOVERY_ID",
    );
  });

  it("wrong signature length (64) -> SIGNATURE_VERIFICATION_FAILED", () => {
    expectCode(
      () => verifyEthereumProof({ recipient: recipientOf(base), asset: assetOf(base), proof: { claimant: base.claimantBase58, signature: decodeHex(base.sigHex).subarray(0, 64) }, network: NETWORK }),
      "SIGNATURE_VERIFICATION_FAILED",
    );
  });

  it("empty signature -> SIGNATURE_VERIFICATION_FAILED", () => {
    expectCode(
      () => verifyEthereumProof({ recipient: recipientOf(base), asset: assetOf(base), proof: { claimant: base.claimantBase58, signature: new Uint8Array(0) }, network: NETWORK }),
      "SIGNATURE_VERIFICATION_FAILED",
    );
  });

  it("unrecoverable signature (r=0) -> SIGNATURE_VERIFICATION_FAILED", () => {
    const sig = decodeHex(base.sigHex);
    sig.fill(0, 0, 32); // r = 0
    sig[63] = 1; // s = 1 (low-S, so it reaches the recover step)
    sig[64] = 0;
    expectCode(
      () => verifyEthereumProof({ recipient: recipientOf(base), asset: assetOf(base), proof: proofOf(toHex(sig)), network: NETWORK }),
      "SIGNATURE_VERIFICATION_FAILED",
    );
  });

  it("protocol mismatch (arweave recipient routed to ETH verifier) -> PROTOCOL_MISMATCH", () => {
    const r = recipientOf(base);
    (r as RecipientView).protocol = 0;
    expectCode(
      () => verifyEthereumProof({ recipient: r, asset: assetOf(base), proof: proofOf(), network: NETWORK }),
      "PROTOCOL_MISMATCH",
    );
  });

  it("length mismatch (512-byte modulus as ETH recipient) -> SIGNATURE_VERIFICATION_FAILED", () => {
    const r = recipientOf(base);
    r.recipientPubkey = new Uint8Array(512).fill(0xab); // an RSA modulus, not a 20B addr
    expectCode(
      () => verifyEthereumProof({ recipient: r, asset: assetOf(base), proof: proofOf(), network: NETWORK }),
      "SIGNATURE_VERIFICATION_FAILED",
    );
  });

  it("replayed/mismatched nonce echo -> NONCE_MISMATCH", () => {
    const proof = proofOf();
    proof.nonce = new Uint8Array(32).fill(0xff); // != asset nonce
    expectCode(
      () => verifyEthereumProof({ recipient: recipientOf(base), asset: assetOf(base), proof, network: NETWORK }),
      "NONCE_MISMATCH",
    );
  });

  it("single-bit signature tamper -> rejected", () => {
    const sig = decodeHex(base.sigHex);
    sig[10] ^= 0x01; // flip a bit in r
    assert.throws(
      () => verifyEthereumProof({ recipient: recipientOf(base), asset: assetOf(base), proof: proofOf(toHex(sig)), network: NETWORK }),
      (e: unknown) => e instanceof VerificationError,
    );
  });
});
