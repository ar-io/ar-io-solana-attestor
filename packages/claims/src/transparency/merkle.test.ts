//! Unit tests for the Merkle commitment (M6). No DB, no chain.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { sha256 } from "@noble/hashes/sha2";

import {
  fromHex,
  hashLeaf,
  hashNode,
  merkleProof,
  merkleRoot,
  toHex,
  verifyMerkleProof,
} from "./merkle.js";

function leaves(n: number): Uint8Array[] {
  return Array.from({ length: n }, (_, i) => hashLeaf(new TextEncoder().encode(`leaf-${i}`)));
}

describe("merkle: hashing", () => {
  it("hex round-trips", () => {
    const b = new Uint8Array([0, 1, 254, 255]);
    assert.equal(toHex(b), "0001feff");
    assert.deepEqual([...fromHex("0001feff")], [...b]);
  });

  it("domain separation: leaf and node prefixes differ", () => {
    const data = new Uint8Array([1, 2, 3]);
    const l = hashLeaf(data);
    // A node over two 3-byte inputs can never equal a leaf hash of the same
    // bytes, because the prefixes (0x00 vs 0x01) differ.
    const asNode = hashNode(new Uint8Array([1]), new Uint8Array([2, 3]));
    assert.notEqual(toHex(l), toHex(asNode));
    // hashLeaf matches the documented sha256(0x00 || data).
    assert.equal(toHex(l), toHex(sha256(new Uint8Array([0x00, 1, 2, 3]))));
  });
});

describe("merkle: root + proofs", () => {
  it("single leaf: root == leaf hash, empty proof", () => {
    const ls = leaves(1);
    assert.equal(toHex(merkleRoot(ls)), toHex(ls[0]));
    assert.deepEqual(merkleProof(ls, 0), []);
    assert.ok(verifyMerkleProof(ls[0], [], toHex(ls[0])));
  });

  it("empty set: 32 zero bytes", () => {
    assert.equal(toHex(merkleRoot([])), "00".repeat(32));
  });

  for (const n of [2, 3, 4, 5, 7, 8, 16, 33]) {
    it(`every index proves membership for n=${n}`, () => {
      const ls = leaves(n);
      const root = toHex(merkleRoot(ls));
      for (let i = 0; i < n; i++) {
        const proof = merkleProof(ls, i);
        assert.ok(verifyMerkleProof(ls[i], proof, root), `index ${i} should verify`);
        // proof depth is ceil(log2(n)) at most.
        assert.ok(proof.length <= Math.ceil(Math.log2(Math.max(n, 2))) + 1);
      }
    });
  }

  it("tamper: a modified leaf fails against the committed root", () => {
    const ls = leaves(7);
    const root = toHex(merkleRoot(ls));
    const proof = merkleProof(ls, 3);
    const tampered = hashLeaf(new TextEncoder().encode("leaf-3-EVIL"));
    assert.equal(verifyMerkleProof(tampered, proof, root), false);
  });

  it("tamper: a modified sibling in the proof fails", () => {
    const ls = leaves(6);
    const root = toHex(merkleRoot(ls));
    const proof = merkleProof(ls, 2);
    assert.ok(proof.length > 0);
    const evil = proof.map((p, idx) => (idx === 0 ? { ...p, hashHex: "ff".repeat(32) } : p));
    assert.equal(verifyMerkleProof(ls[2], evil, root), false);
  });

  it("removing a leaf changes the root (silent deletion detectable)", () => {
    const full = leaves(10);
    const missingOne = full.slice(0, 9);
    assert.notEqual(toHex(merkleRoot(full)), toHex(merkleRoot(missingOne)));
  });

  it("promote-on-odd is deterministic (same leaves => same root)", () => {
    const a = leaves(7);
    const b = leaves(7);
    assert.equal(toHex(merkleRoot(a)), toHex(merkleRoot(b)));
  });
});
