import { describe, it } from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { sha256 } from "@noble/hashes/sha2";

import {
  buildAntEscrowClaimMessage,
  buildEscrowClaimMessage,
  deriveRecipientIdB64Url,
} from "./canonical.js";

/// 32-byte test pubkey from a fixed seed pattern. Same value can be
/// reproduced on the Rust side for byte-equivalence checks.
function fixedBytes(b: number, len = 32): Uint8Array {
  return new Uint8Array(len).fill(b);
}

/// Stable Arweave-shaped recipient bytes for tests. 512 bytes of 0xAB.
const RECIPIENT_AB512 = fixedBytes(0xAB, 512);

describe("buildAntEscrowClaimMessage", () => {
  it("produces the documented format with the recipient binding line", () => {
    const antMint = fixedBytes(0xAA);
    const claimant = fixedBytes(0xBB);
    const nonce = fixedBytes(0xCC);
    const network = "localnet";
    const out = buildAntEscrowClaimMessage({
      antMint,
      claimant,
      nonce,
      network,
      recipientPubkey: RECIPIENT_AB512,
    });
    const text = new TextDecoder().decode(out);

    const recipientId = deriveRecipientIdB64Url(RECIPIENT_AB512);
    const expectedNonceHex = "cc".repeat(32);
    const expected =
      `ar.io ant-escrow claim\n` +
      `network: localnet\n` +
      `recipient: ${recipientId}\n` +
      `ant: ${bs58.encode(antMint)}\n` +
      `claimant: ${bs58.encode(claimant)}\n` +
      `nonce: ${expectedNonceHex}`;

    assert.equal(text, expected);
  });

  it("produces no trailing newline", () => {
    const out = buildAntEscrowClaimMessage({
      antMint: fixedBytes(1),
      claimant: fixedBytes(2),
      nonce: fixedBytes(3),
      network: "localnet",
      recipientPubkey: RECIPIENT_AB512,
    });
    assert.notEqual(out[out.length - 1], 0x0a);
  });

  it("uses lowercase hex for nonce", () => {
    const nonce = new Uint8Array(32);
    nonce[0] = 0xAB;
    nonce[1] = 0xCD;
    const text = new TextDecoder().decode(
      buildAntEscrowClaimMessage({
        antMint: fixedBytes(0),
        claimant: fixedBytes(0),
        nonce,
        network: "localnet",
        recipientPubkey: RECIPIENT_AB512,
      }),
    );
    assert.match(text, /\nnonce: abcd0+$/);
  });

  it("uses base58 for the pubkeys", () => {
    const antMint = fixedBytes(0x42);
    const claimant = fixedBytes(0x55);
    const text = new TextDecoder().decode(
      buildAntEscrowClaimMessage({
        antMint,
        claimant,
        nonce: fixedBytes(0),
        network: "solana-mainnet",
        recipientPubkey: RECIPIENT_AB512,
      }),
    );
    assert.ok(text.includes(`\nant: ${bs58.encode(antMint)}\n`));
    assert.ok(text.includes(`\nclaimant: ${bs58.encode(claimant)}\n`));
  });

  it("rejects 31-byte ant mint", () => {
    assert.throws(() =>
      buildAntEscrowClaimMessage({
        antMint: new Uint8Array(31),
        claimant: fixedBytes(0),
        nonce: fixedBytes(0),
        network: "localnet",
        recipientPubkey: RECIPIENT_AB512,
      }),
    );
  });

  it("rejects 33-byte claimant", () => {
    assert.throws(() =>
      buildAntEscrowClaimMessage({
        antMint: fixedBytes(0),
        claimant: new Uint8Array(33),
        nonce: fixedBytes(0),
        network: "localnet",
        recipientPubkey: RECIPIENT_AB512,
      }),
    );
  });

  it("rejects wrong-length nonce", () => {
    assert.throws(() =>
      buildAntEscrowClaimMessage({
        antMint: fixedBytes(0),
        claimant: fixedBytes(0),
        nonce: new Uint8Array(8),
        network: "localnet",
        recipientPubkey: RECIPIENT_AB512,
      }),
    );
  });

  it("rejects empty recipientPubkey", () => {
    // F-1 regression: an empty recipient binding is meaningless and
    // would let the attestor issue attestations without binding to
    // any specific recipient identity.
    assert.throws(() =>
      buildAntEscrowClaimMessage({
        antMint: fixedBytes(0),
        claimant: fixedBytes(0),
        nonce: fixedBytes(0),
        network: "localnet",
        recipientPubkey: new Uint8Array(0),
      }),
    );
  });

  it("changes output when network changes", () => {
    const args = {
      antMint: fixedBytes(1),
      claimant: fixedBytes(2),
      nonce: fixedBytes(3),
      recipientPubkey: RECIPIENT_AB512,
    };
    const a = buildAntEscrowClaimMessage({ ...args, network: "solana-mainnet" });
    const b = buildAntEscrowClaimMessage({ ...args, network: "solana-devnet" });
    assert.notDeepEqual(a, b);
  });

  it("changes output when recipientPubkey changes (F-1 regression)", () => {
    const args = {
      antMint: fixedBytes(1),
      claimant: fixedBytes(2),
      nonce: fixedBytes(3),
      network: "solana-mainnet",
    };
    const a = buildAntEscrowClaimMessage({ ...args, recipientPubkey: fixedBytes(0xAA, 512) });
    const b = buildAntEscrowClaimMessage({ ...args, recipientPubkey: fixedBytes(0xBB, 512) });
    assert.notDeepEqual(a, b);
  });
});

describe("buildEscrowClaimMessage", () => {
  it("rejects empty recipientPubkey", () => {
    assert.throws(() =>
      buildEscrowClaimMessage({
        assetType: "token",
        assetId: fixedBytes(0),
        amount: 100n,
        claimant: fixedBytes(0),
        nonce: fixedBytes(0),
        network: "localnet",
        recipientPubkey: new Uint8Array(0),
      }),
    );
  });

  it("changes output when recipientPubkey changes (F-1 regression)", () => {
    const args = {
      assetType: "token" as const,
      assetId: fixedBytes(1),
      amount: 1000n,
      claimant: fixedBytes(2),
      nonce: fixedBytes(3),
      network: "solana-mainnet",
    };
    const a = buildEscrowClaimMessage({ ...args, recipientPubkey: fixedBytes(0xAA, 512) });
    const b = buildEscrowClaimMessage({ ...args, recipientPubkey: fixedBytes(0xBB, 512) });
    assert.notDeepEqual(a, b);
  });
});

describe("deriveRecipientIdB64Url", () => {
  it("produces a 43-char base64url string for any input", () => {
    // sha256 → 32 bytes → base64url (no pad) → 43 chars.
    assert.equal(deriveRecipientIdB64Url(new Uint8Array([1, 2, 3])).length, 43);
    assert.equal(deriveRecipientIdB64Url(RECIPIENT_AB512).length, 43);
  });

  it("matches sha256(input).base64url", () => {
    const input = new Uint8Array([0x01, 0x02, 0x03]);
    const expected = Buffer.from(sha256(input)).toString("base64url");
    assert.equal(deriveRecipientIdB64Url(input), expected);
  });

  it("produces only url-safe base64 characters", () => {
    for (let i = 0; i < 16; i++) {
      const input = fixedBytes(i, 64);
      const out = deriveRecipientIdB64Url(input);
      assert.match(out, /^[A-Za-z0-9_-]+$/);
    }
  });
});
