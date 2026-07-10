//! Unit tests for the published, signed ledger artifact (M6). No DB, no chain.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { keypairFromSeed } from "./keys.js";
import {
  buildLedgerArtifact,
  canonicalLeafBytes,
  proveMembership,
  verifyLedgerArtifact,
  verifyMembership,
  type LedgerArtifact,
  type LedgerLeaf,
} from "./ledger-artifact.js";

const PUB = keypairFromSeed("publisher", new Uint8Array(32).fill(7));
const OTHER = keypairFromSeed("publisher", new Uint8Array(32).fill(9));

function sampleLeaves(): LedgerLeaf[] {
  return [
    { recipientId: "recA", protocol: 0, assetKey: "z-ant-mint", assetType: "ant", amount: null, antMint: "z-ant-mint", vaultEndTs: null, status: "available" },
    { recipientId: "recA", protocol: 0, assetKey: "aa-token", assetType: "token", amount: "1234567890", antMint: null, vaultEndTs: null, status: "available" },
    { recipientId: "recB", protocol: 1, assetKey: "mm-vault", assetType: "vault", amount: "5000000000", antMint: null, vaultEndTs: 1795000000, status: "available" },
    { recipientId: "recC", protocol: 0, assetKey: "bb-atrisk", assetType: "token", amount: "6250000000000", antMint: null, vaultEndTs: null, status: "manual_review" },
  ];
}

function build(): LedgerArtifact {
  return buildLedgerArtifact({
    leaves: sampleLeaves(),
    network: "solana-mainnet",
    ledgerVersion: "test-v1",
    // Pin the timestamp so signature determinism is over identical bytes.
    generatedAt: "2026-07-10T00:00:00.000Z",
    publisher: PUB,
  });
}

describe("ledger artifact: build + verify", () => {
  it("builds a signed artifact, sorted by assetKey, with correct totals", () => {
    const art = build();
    assert.equal(art.manifest.entryCount, 4);
    assert.equal(art.manifest.availableCount, 3);
    assert.equal(art.manifest.manualReviewCount, 1);
    // Σ token/vault amounts (ant excluded).
    assert.equal(art.manifest.totalClaimableMario, (1234567890n + 5000000000n + 6250000000000n).toString());
    // Sorted by assetKey.
    assert.deepEqual(art.leaves.map((l) => l.assetKey), ["aa-token", "bb-atrisk", "mm-vault", "z-ant-mint"]);
  });

  it("verifies against the publisher pubkey", () => {
    const art = build();
    const v = verifyLedgerArtifact(art, art.publisherPubkeyHex);
    assert.ok(v.ok, v.issues.join("; "));
    assert.ok(v.rootMatches && v.signatureValid && v.countMatches && v.digestMatches);
  });

  it("determinism: same leaves + key => same root + signature", () => {
    assert.equal(build().manifest.rootHex, build().manifest.rootHex);
    assert.equal(build().signatureHex, build().signatureHex);
  });

  it("wrong publisher pubkey => signature invalid", () => {
    const art = build();
    const v = verifyLedgerArtifact({ ...art, publisherPubkeyHex: Buffer.from(OTHER.publicKey).toString("hex") });
    assert.equal(v.signatureValid, false);
    assert.equal(v.ok, false);
  });
});

describe("ledger artifact: tamper detection", () => {
  it("altering a leaf amount breaks the root => verify FAIL", () => {
    const art = build();
    const tampered: LedgerArtifact = {
      ...art,
      leaves: art.leaves.map((l) => (l.assetKey === "aa-token" ? { ...l, amount: "9999999999" } : l)),
    };
    const v = verifyLedgerArtifact(tampered, art.publisherPubkeyHex);
    assert.equal(v.rootMatches, false);
    assert.equal(v.ok, false);
  });

  it("removing a leaf breaks count + root => verify FAIL", () => {
    const art = build();
    const tampered: LedgerArtifact = { ...art, leaves: art.leaves.slice(1) };
    const v = verifyLedgerArtifact(tampered, art.publisherPubkeyHex);
    assert.equal(v.ok, false);
    assert.ok(v.issues.some((i) => i.includes("root mismatch") || i.includes("entryCount")));
  });

  it("changing a status (e.g. hiding manual_review) breaks the root", () => {
    const art = build();
    const tampered: LedgerArtifact = {
      ...art,
      leaves: art.leaves.map((l) => (l.status === "manual_review" ? { ...l, status: "available" } : l)),
    };
    assert.equal(verifyLedgerArtifact(tampered, art.publisherPubkeyHex).rootMatches, false);
  });
});

describe("ledger artifact: membership", () => {
  it("proves membership for every asset and self-verifies", () => {
    const art = build();
    for (const l of art.leaves) {
      const m = proveMembership(art, l.assetKey);
      assert.ok(verifyMembership(m, art.manifest.rootHex), `membership for ${l.assetKey}`);
    }
  });

  it("a tampered leaf in a membership proof fails against the trusted root", () => {
    const art = build();
    const m = proveMembership(art, "mm-vault");
    m.leaf.amount = "999"; // user-side tamper of the claimed content
    assert.equal(verifyMembership(m, art.manifest.rootHex), false);
  });

  it("unknown asset => throws (not in the committed ledger)", () => {
    const art = build();
    assert.throws(() => proveMembership(art, "not-a-real-asset"));
  });

  it("canonical leaf bytes are stable + key-order independent", () => {
    const l = sampleLeaves()[1];
    const a = canonicalLeafBytes(l);
    const b = canonicalLeafBytes({ ...l });
    assert.deepEqual([...a], [...b]);
  });
});
