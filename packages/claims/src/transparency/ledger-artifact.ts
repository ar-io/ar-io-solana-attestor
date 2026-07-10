//! Published, signed ledger artifact (M6 deliverable #1, pivot plan §6.5.1).
//!
//! A deterministic, third-party-verifiable commitment to the recipient->asset
//! ledger. Anyone can (a) confirm their asset is in the committed set and
//! (b) detect a silent alteration or removal — WITHOUT trusting the operator:
//!
//!   * Each asset becomes a canonical LEAF (recipient_id, protocol, asset_key,
//!     asset_type, amount, ant_mint, vault_end_ts, status). No secrets: no nonce,
//!     no modulus — the plan is explicit that recipient_id is already a
//!     sha256-derived public handle.
//!   * Leaves are sorted by asset_key (globally unique) so the tree is
//!     reproducible byte-for-byte from the leaf set alone.
//!   * The Merkle ROOT (merkle.ts: domain-separated, promote-on-odd) is placed
//!     in a MANIFEST together with counts + totals + input fingerprints, and the
//!     manifest is signed by the published LEDGER-PUBLISHER key.
//!
//! Tamper-evidence: the signed manifest binds the root. Recomputing the root
//! from a tampered leaf set yields a different root => the publisher signature no
//! longer matches => the verifier flags it. A membership proof lets a user check
//! a single asset against the signed root with ~log2(N) sibling hashes.

import { canonicalJson } from "../api/audit.js";
import { verifyEd25519, type TransparencyKeypair } from "./keys.js";
import {
  fromHex,
  hashLeaf,
  merkleProof,
  merkleRoot,
  toHex,
  verifyMerkleProof,
  type ProofStep,
} from "./merkle.js";

/** Format version of the leaf serialization — bumping it changes the root. */
export const LEDGER_LEAF_FORMAT = "ar.io-claims-ledger-leaf/v1" as const;
export const LEDGER_MANIFEST_VERSION = "ar.io-claims-ledger/v1" as const;

/** One committed ledger entry (public fields only). */
export interface LedgerLeaf {
  recipientId: string;
  /** 0 = arweave, 1 = ethereum. */
  protocol: number;
  assetKey: string;
  assetType: "ant" | "token" | "vault";
  /** mARIO decimal string; null for ANTs. */
  amount: string | null;
  antMint: string | null;
  /** absolute unlock unix seconds; null unless a vault. */
  vaultEndTs: number | null;
  status: string;
}

export interface LedgerManifest {
  manifestVersion: string;
  leafFormat: string;
  network: string;
  /** Operator-supplied version tag (e.g. an ISO date or a monotonic label). */
  ledgerVersion: string;
  /** ISO-8601 generation timestamp. */
  generatedAt: string;
  entryCount: number;
  availableCount: number;
  manualReviewCount: number;
  /** Σ amount over token/vault leaves (mARIO decimal string). */
  totalClaimableMario: string;
  /** Merkle root, hex. */
  rootHex: string;
  /** sha256 of the canonical leaf array, hex (whole-set integrity, redundant w/ root). */
  leavesDigestHex: string;
  /** sha256 fingerprints of the frozen inputs the ledger was built from. */
  inputFingerprints: Record<string, string>;
}

export interface LedgerArtifact {
  manifest: LedgerManifest;
  /** Ed25519 signature over canonicalJson(manifest), hex. */
  signatureHex: string;
  /** Publisher Ed25519 public key, hex. */
  publisherPubkeyHex: string;
  /** The committed leaf set, sorted by assetKey (the tree's inputs). */
  leaves: LedgerLeaf[];
}

/** Canonical leaf bytes — the exact preimage hashed into a Merkle leaf. */
export function canonicalLeafBytes(leaf: LedgerLeaf): Uint8Array {
  // Fixed key set + deterministic ordering via canonicalJson (keys sorted).
  const obj = {
    recipientId: leaf.recipientId,
    protocol: leaf.protocol,
    assetKey: leaf.assetKey,
    assetType: leaf.assetType,
    amount: leaf.amount,
    antMint: leaf.antMint,
    vaultEndTs: leaf.vaultEndTs,
    status: leaf.status,
  };
  return new TextEncoder().encode(canonicalJson(obj));
}

function sortLeaves(leaves: LedgerLeaf[]): LedgerLeaf[] {
  return [...leaves].sort((a, b) => (a.assetKey < b.assetKey ? -1 : a.assetKey > b.assetKey ? 1 : 0));
}

/** Merkle commitment (root + per-leaf hashes) over an UNSORTED leaf set. */
export function commitLedger(leaves: LedgerLeaf[]): {
  sortedLeaves: LedgerLeaf[];
  leafHashes: Uint8Array[];
  rootHex: string;
  leavesDigestHex: string;
} {
  const sortedLeaves = sortLeaves(leaves);
  const leafHashes = sortedLeaves.map((l) => hashLeaf(canonicalLeafBytes(l)));
  const rootHex = toHex(merkleRoot(leafHashes));
  // Whole-set digest: sha256 of the canonical leaf array (integrity of the file
  // as a whole, independent of the tree shape).
  const leavesJson = canonicalJson(sortedLeaves.map((l) => JSON.parse(new TextDecoder().decode(canonicalLeafBytes(l)))));
  const leavesDigestHex = toHex(hashLeaf(new TextEncoder().encode(leavesJson)));
  return { sortedLeaves, leafHashes, rootHex, leavesDigestHex };
}

export interface BuildArtifactInput {
  leaves: LedgerLeaf[];
  network: string;
  ledgerVersion: string;
  generatedAt?: string;
  inputFingerprints?: Record<string, string>;
  publisher: TransparencyKeypair;
}

/** Build + sign a published-ledger artifact. */
export function buildLedgerArtifact(input: BuildArtifactInput): LedgerArtifact {
  const { sortedLeaves, rootHex, leavesDigestHex } = commitLedger(input.leaves);

  let totalClaimable = 0n;
  let availableCount = 0;
  let manualReviewCount = 0;
  for (const l of sortedLeaves) {
    if (l.amount !== null) totalClaimable += BigInt(l.amount);
    if (l.status === "available") availableCount++;
    if (l.status === "manual_review") manualReviewCount++;
  }

  const manifest: LedgerManifest = {
    manifestVersion: LEDGER_MANIFEST_VERSION,
    leafFormat: LEDGER_LEAF_FORMAT,
    network: input.network,
    ledgerVersion: input.ledgerVersion,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    entryCount: sortedLeaves.length,
    availableCount,
    manualReviewCount,
    totalClaimableMario: totalClaimable.toString(),
    rootHex,
    leavesDigestHex,
    inputFingerprints: input.inputFingerprints ?? {},
  };

  const manifestBytes = new TextEncoder().encode(canonicalJson(manifest));
  const signature = input.publisher.sign(manifestBytes);
  return {
    manifest,
    signatureHex: toHex(signature),
    publisherPubkeyHex: toHex(input.publisher.publicKey),
    leaves: sortedLeaves,
  };
}

export interface ArtifactVerification {
  ok: boolean;
  rootMatches: boolean;
  signatureValid: boolean;
  countMatches: boolean;
  digestMatches: boolean;
  recomputedRootHex: string;
  issues: string[];
}

/**
 * Independently verify an artifact: recompute the root + whole-set digest from
 * the leaves, confirm they match the manifest, and verify the publisher
 * signature over the manifest. `expectedPublisherPubkeyHex` pins the key so a
 * verifier does not trust the pubkey embedded in the (potentially swapped)
 * artifact.
 */
export function verifyLedgerArtifact(
  artifact: LedgerArtifact,
  expectedPublisherPubkeyHex?: string,
): ArtifactVerification {
  const issues: string[] = [];
  const { rootHex, leavesDigestHex } = commitLedger(artifact.leaves);

  const rootMatches = rootHex === artifact.manifest.rootHex.toLowerCase();
  if (!rootMatches) issues.push(`root mismatch: recomputed ${rootHex} != manifest ${artifact.manifest.rootHex}`);

  const digestMatches = leavesDigestHex === artifact.manifest.leavesDigestHex.toLowerCase();
  if (!digestMatches) issues.push("leaves digest mismatch");

  const countMatches = artifact.leaves.length === artifact.manifest.entryCount;
  if (!countMatches) issues.push(`entryCount ${artifact.manifest.entryCount} != leaves ${artifact.leaves.length}`);

  const pubHex = (expectedPublisherPubkeyHex ?? artifact.publisherPubkeyHex).toLowerCase();
  if (expectedPublisherPubkeyHex && pubHex !== artifact.publisherPubkeyHex.toLowerCase()) {
    issues.push("artifact publisher pubkey != expected publisher pubkey");
  }
  const manifestBytes = new TextEncoder().encode(canonicalJson(artifact.manifest));
  const signatureValid = verifyEd25519(manifestBytes, fromHex(artifact.signatureHex), fromHex(pubHex));
  if (!signatureValid) issues.push("publisher signature invalid over manifest");

  return {
    ok: rootMatches && signatureValid && countMatches && digestMatches && (!expectedPublisherPubkeyHex || pubHex === artifact.publisherPubkeyHex.toLowerCase()),
    rootMatches,
    signatureValid,
    countMatches,
    digestMatches,
    recomputedRootHex: rootHex,
    issues,
  };
}

export interface MembershipProof {
  assetKey: string;
  leaf: LedgerLeaf;
  leafHashHex: string;
  proof: ProofStep[];
  rootHex: string;
}

/** Build a membership proof for one asset against the artifact's committed set. */
export function proveMembership(artifact: LedgerArtifact, assetKey: string): MembershipProof {
  const { sortedLeaves, leafHashes, rootHex } = commitLedger(artifact.leaves);
  const index = sortedLeaves.findIndex((l) => l.assetKey === assetKey);
  if (index < 0) throw new Error(`asset ${assetKey} not in the committed ledger`);
  return {
    assetKey,
    leaf: sortedLeaves[index],
    leafHashHex: toHex(leafHashes[index]),
    proof: merkleProof(leafHashes, index),
    rootHex,
  };
}

/**
 * Verify a membership proof against a TRUSTED root (the one from the verified,
 * signed manifest). Recomputes the leaf hash from the leaf content, so a
 * tampered leaf will not fold to the committed root.
 */
export function verifyMembership(m: MembershipProof, trustedRootHex: string): boolean {
  const leafHash = hashLeaf(canonicalLeafBytes(m.leaf));
  if (toHex(leafHash) !== m.leafHashHex.toLowerCase()) return false;
  return verifyMerkleProof(leafHash, m.proof, trustedRootHex);
}
