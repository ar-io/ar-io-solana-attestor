//! Binary Merkle tree over the published ledger (M6 transparency).
//!
//! Third-party verifiability rests on this being a STANDARD, second-preimage-
//! resistant Merkle commitment that anyone can re-derive with a few lines of
//! code and `sha256`. Two design choices make it forgery-resistant:
//!
//!   * DOMAIN SEPARATION. A leaf is hashed `sha256(0x00 || data)`; an internal
//!     node is `sha256(0x01 || left || right)`. Because the two prefixes differ,
//!     a leaf hash can never be reinterpreted as an internal node — closing the
//!     classic Merkle second-preimage / duplicate-node forgery (CVE-2012-2459).
//!   * PROMOTE (not duplicate) on an odd row. When a level has an odd count the
//!     last node is carried up unchanged rather than hashed with a copy of
//!     itself, so no ambiguous duplicate pair ever exists.
//!
//! A membership proof is the ordered list of sibling hashes from a leaf up to
//! the root, each tagged with the side it sits on. A promoted node simply
//! contributes no proof element at that level. Verification folds the proof over
//! the leaf hash and compares the result to the committed root — no tree, no DB,
//! no trust in the operator required.

import { sha256 } from "@noble/hashes/sha2";

const LEAF_PREFIX = 0x00;
const NODE_PREFIX = 0x01;

/** Side of a sibling relative to the node being proven. */
export type ProofSide = "left" | "right";

export interface ProofStep {
  /** Sibling hash, hex-encoded. */
  hashHex: string;
  /** Which side the sibling is on (the node being folded is on the other side). */
  side: ProofSide;
}

/** hex-encode bytes (lowercase, no prefix). */
export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** decode a lowercase/uppercase hex string to bytes. */
export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`odd-length hex: ${hex.length}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`invalid hex at ${i * 2}`);
    out[i] = byte;
  }
  return out;
}

/** Leaf hash: sha256(0x00 || data). */
export function hashLeaf(data: Uint8Array): Uint8Array {
  const buf = new Uint8Array(1 + data.length);
  buf[0] = LEAF_PREFIX;
  buf.set(data, 1);
  return sha256(buf);
}

/** Internal-node hash: sha256(0x01 || left || right). */
export function hashNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  const buf = new Uint8Array(1 + left.length + right.length);
  buf[0] = NODE_PREFIX;
  buf.set(left, 1);
  buf.set(right, 1 + left.length);
  return sha256(buf);
}

/** The Merkle root of an ordered leaf-hash list. Empty list => 32 zero bytes. */
export function merkleRoot(leafHashes: Uint8Array[]): Uint8Array {
  if (leafHashes.length === 0) return new Uint8Array(32);
  let level = leafHashes;
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) next.push(hashNode(level[i], level[i + 1]));
      else next.push(level[i]); // PROMOTE the odd tail unchanged
    }
    level = next;
  }
  return level[0];
}

/**
 * Membership proof for `index` in the ordered leaf-hash list: the sibling hashes
 * from the leaf up to (but excluding) the root. A promoted node adds no step.
 */
export function merkleProof(leafHashes: Uint8Array[], index: number): ProofStep[] {
  if (index < 0 || index >= leafHashes.length) {
    throw new Error(`index ${index} out of range (0..${leafHashes.length - 1})`);
  }
  const proof: ProofStep[] = [];
  let level = leafHashes;
  let idx = index;
  while (level.length > 1) {
    const isRightChild = idx % 2 === 1;
    const siblingIdx = isRightChild ? idx - 1 : idx + 1;
    if (siblingIdx < level.length) {
      proof.push({
        hashHex: toHex(level[siblingIdx]),
        side: isRightChild ? "left" : "right",
      });
    }
    // else: this node is the promoted odd tail — no sibling at this level.
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) next.push(hashNode(level[i], level[i + 1]));
      else next.push(level[i]);
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/** Fold a membership proof over a leaf hash and compare to the committed root. */
export function verifyMerkleProof(
  leafHash: Uint8Array,
  proof: ProofStep[],
  rootHex: string,
): boolean {
  let acc = leafHash;
  for (const step of proof) {
    const sib = fromHex(step.hashHex);
    acc = step.side === "left" ? hashNode(sib, acc) : hashNode(acc, sib);
  }
  return toHex(acc) === rootHex.toLowerCase();
}
