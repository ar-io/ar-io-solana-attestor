//! Ledger-state canonical rebuild tests.
//!
//! Proves `buildCanonicalFromLedger` reproduces the FROZEN deployed-contract
//! byte format for BOTH message shapes by re-using the SAME golden vectors the
//! canonical package pins to Rust (`canonical.cross.golden.json`). Then proves
//! the anti-replay binding (every field change flips the bytes) and input
//! hygiene.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import bs58 from "bs58";
import { deriveRecipientIdB64Url } from "@ar.io/attestor-canonical";

import { buildCanonicalFromLedger } from "./canonical-message.js";
import { VerificationError } from "./errors.js";
import type { AssetView, RecipientView } from "./types.js";

interface AntVector {
  name: string;
  antMintBase58: string;
  claimantBase58: string;
  nonceHex: string;
  canonicalHex: string;
}
interface EscrowVector {
  name: string;
  assetType: "token" | "vault";
  assetIdHex: string;
  amount: string;
  claimantBase58: string;
  nonceHex: string;
  canonicalHex: string;
}
interface Golden {
  network: string;
  recipientPubkeyHex: string;
  ant: AntVector[];
  escrow: EscrowVector[];
}

// Reuse the canonical package's Rust-pinned golden vectors directly.
const GOLDEN: Golden = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname ?? ".", "..", "..", "..", "canonical", "src", "canonical.cross.golden.json"),
    "utf8",
  ),
) as Golden;
const NETWORK = GOLDEN.network;

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

const MODULUS = decodeHex(GOLDEN.recipientPubkeyHex);
const REC_ID = deriveRecipientIdB64Url(MODULUS);
function recipient(): RecipientView {
  return { protocol: 0, recipientPubkey: MODULUS, recipientId: REC_ID, sourceAddress: REC_ID };
}

// ---------------------------------------------------------------------------
// Byte-parity with the frozen contract format (Appendix A line 1 + 2)
// ---------------------------------------------------------------------------

describe("buildCanonicalFromLedger == frozen contract golden (ANT shape)", () => {
  for (const v of GOLDEN.ant) {
    it(`ANT byte-equals golden: ${v.name}`, () => {
      const asset: AssetView = {
        assetType: "ant",
        assetKey: v.antMintBase58,
        antMint: v.antMintBase58,
        amount: null,
        nonce: decodeHex(v.nonceHex),
        vaultEndTs: null,
      };
      const out = buildCanonicalFromLedger({
        recipient: recipient(),
        asset,
        claimant: v.claimantBase58,
        nonce: decodeHex(v.nonceHex),
        network: NETWORK,
      });
      assert.equal(toHex(out), v.canonicalHex);
    });
  }
});

describe("buildCanonicalFromLedger == frozen contract golden (token/vault shape)", () => {
  for (const v of GOLDEN.escrow) {
    it(`escrow byte-equals golden: ${v.name}`, () => {
      const asset: AssetView = {
        assetType: v.assetType,
        assetKey: v.assetIdHex,
        antMint: null,
        amount: BigInt(v.amount),
        nonce: decodeHex(v.nonceHex),
        vaultEndTs: v.assetType === "vault" ? 9_999_999_999 : null,
      };
      const out = buildCanonicalFromLedger({
        recipient: recipient(),
        asset,
        claimant: v.claimantBase58,
        nonce: decodeHex(v.nonceHex),
        network: NETWORK,
      });
      assert.equal(toHex(out), v.canonicalHex);
    });
  }
});

// ---------------------------------------------------------------------------
// Anti-replay binding: every bound field changes the bytes
// ---------------------------------------------------------------------------

describe("canonical binds (recipient, asset, amount, claimant, nonce)", () => {
  const v = GOLDEN.escrow[0];
  const baseAsset: AssetView = {
    assetType: v.assetType,
    assetKey: v.assetIdHex,
    antMint: null,
    amount: BigInt(v.amount),
    nonce: decodeHex(v.nonceHex),
    vaultEndTs: null,
  };
  const base = () =>
    buildCanonicalFromLedger({ recipient: recipient(), asset: baseAsset, claimant: v.claimantBase58, nonce: decodeHex(v.nonceHex), network: NETWORK });

  it("different recipient modulus -> different bytes (F-1)", () => {
    const r = recipient();
    r.recipientPubkey = new Uint8Array(512).fill(0xcd);
    r.recipientId = deriveRecipientIdB64Url(r.recipientPubkey);
    const out = buildCanonicalFromLedger({ recipient: r, asset: baseAsset, claimant: v.claimantBase58, nonce: decodeHex(v.nonceHex), network: NETWORK });
    assert.notEqual(toHex(out), toHex(base()));
  });

  it("different asset_id -> different bytes", () => {
    const a = { ...baseAsset, assetKey: "00".repeat(32) };
    const out = buildCanonicalFromLedger({ recipient: recipient(), asset: a, claimant: v.claimantBase58, nonce: decodeHex(v.nonceHex), network: NETWORK });
    assert.notEqual(toHex(out), toHex(base()));
  });

  it("different amount -> different bytes", () => {
    const a = { ...baseAsset, amount: BigInt(v.amount) + 1n };
    const out = buildCanonicalFromLedger({ recipient: recipient(), asset: a, claimant: v.claimantBase58, nonce: decodeHex(v.nonceHex), network: NETWORK });
    assert.notEqual(toHex(out), toHex(base()));
  });

  it("different asset_type (token vs vault) -> different bytes", () => {
    const a: AssetView = { ...baseAsset, assetType: "vault" };
    const out = buildCanonicalFromLedger({ recipient: recipient(), asset: a, claimant: v.claimantBase58, nonce: decodeHex(v.nonceHex), network: NETWORK });
    assert.notEqual(toHex(out), toHex(base()));
  });

  it("different claimant -> different bytes", () => {
    const out = buildCanonicalFromLedger({ recipient: recipient(), asset: baseAsset, claimant: "Hk6RfBp4FpvF2hYBmJ9kqyL5dE3xR8wPzN7sV6cTqL2A", nonce: decodeHex(v.nonceHex), network: NETWORK });
    assert.notEqual(toHex(out), toHex(base()));
  });

  it("different nonce -> different bytes", () => {
    const out = buildCanonicalFromLedger({ recipient: recipient(), asset: baseAsset, claimant: v.claimantBase58, nonce: new Uint8Array(32).fill(9), network: NETWORK });
    assert.notEqual(toHex(out), toHex(base()));
  });

  it("different network -> different bytes", () => {
    const out = buildCanonicalFromLedger({ recipient: recipient(), asset: baseAsset, claimant: v.claimantBase58, nonce: decodeHex(v.nonceHex), network: "solana-devnet" });
    assert.notEqual(toHex(out), toHex(base()));
  });
});

// ---------------------------------------------------------------------------
// Input hygiene
// ---------------------------------------------------------------------------

describe("buildCanonicalFromLedger — input validation", () => {
  const good: AssetView = { assetType: "token", assetKey: "ab".repeat(32), antMint: null, amount: 1n, nonce: new Uint8Array(32), vaultEndTs: null };
  const claimant = bs58.encode(new Uint8Array(32).fill(1));
  function expectInvalid(fn: () => void) {
    assert.throws(fn, (e: unknown) => e instanceof VerificationError && e.code === "INVALID_INPUT");
  }

  it("rejects nonce != 32 bytes", () => {
    expectInvalid(() => buildCanonicalFromLedger({ recipient: recipient(), asset: good, claimant, nonce: new Uint8Array(31), network: NETWORK }));
  });
  it("rejects claimant not decoding to 32 bytes", () => {
    expectInvalid(() => buildCanonicalFromLedger({ recipient: recipient(), asset: good, claimant: bs58.encode(new Uint8Array(31)), nonce: new Uint8Array(32), network: NETWORK }));
  });
  it("rejects non-base58 claimant", () => {
    expectInvalid(() => buildCanonicalFromLedger({ recipient: recipient(), asset: good, claimant: "0OIl+/not-base58", nonce: new Uint8Array(32), network: NETWORK }));
  });
  it("rejects ant asset missing antMint", () => {
    const a: AssetView = { assetType: "ant", assetKey: "x", antMint: null, amount: null, nonce: new Uint8Array(32), vaultEndTs: null };
    expectInvalid(() => buildCanonicalFromLedger({ recipient: recipient(), asset: a, claimant, nonce: new Uint8Array(32), network: NETWORK }));
  });
  it("rejects token asset missing amount", () => {
    const a: AssetView = { assetType: "token", assetKey: "ab".repeat(32), antMint: null, amount: null, nonce: new Uint8Array(32), vaultEndTs: null };
    expectInvalid(() => buildCanonicalFromLedger({ recipient: recipient(), asset: a, claimant, nonce: new Uint8Array(32), network: NETWORK }));
  });
  it("rejects amount out of u64 range", () => {
    const a: AssetView = { ...good, amount: 0x1_0000_0000_0000_0000n };
    expectInvalid(() => buildCanonicalFromLedger({ recipient: recipient(), asset: a, claimant, nonce: new Uint8Array(32), network: NETWORK }));
  });
  it("rejects assetKey not 64 hex chars", () => {
    const a: AssetView = { ...good, assetKey: "abcd" };
    expectInvalid(() => buildCanonicalFromLedger({ recipient: recipient(), asset: a, claimant, nonce: new Uint8Array(32), network: NETWORK }));
  });
});
