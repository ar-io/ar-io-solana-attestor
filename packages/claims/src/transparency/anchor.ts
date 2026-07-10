//! On-chain anchoring of the audit-log head + ledger root (M6 deliverable #2).
//!
//! Rewriting the hash-chained audit log after the fact requires rewriting an
//! external, immutable record too: we periodically post the current chain HEAD
//! (and, optionally, the published ledger ROOT) as a Solana Memo transaction
//! signed by the SEPARATE publisher/anchor key. A verifier reads the memo back
//! FROM CHAIN, then confirms the live log still extends that anchored head
//! (audit-chain linkage up to the anchored seq reproduces the anchored hash).
//!
//! Memo program: the SPL Memo program that is actually deployed on
//! devnet/mainnet is `Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo` (executable,
//! verified live). NOTE: the address in dispatch/instructions.ts
//! (`MemoSq4gq…`, the "v2" id) resolves to NO account on devnet OR mainnet —
//! see SPEC.md M6 findings — so anchoring uses the live program and lets the
//! operator override via `ANCHOR_MEMO_PROGRAM`.
//!
//! No `@solana/web3.js`.

import bs58 from "bs58";
import {
  AccountRole,
  address,
  createKeyPairSignerFromPrivateKeyBytes,
  type Address,
  type IInstruction,
  type Rpc,
  type SolanaRpcApi,
  type TransactionSigner,
} from "@solana/kit";

import { SolanaChainGateway, type ChainGateway } from "../dispatch/chain.js";
import { MEMO_PROGRAM } from "../dispatch/instructions.js";

/**
 * The SPL Memo program actually deployed on devnet + mainnet (verified live).
 * Single source of truth with the dispatch worker's memo program (they must
 * agree — the M4 "v2" id was dead on both clusters).
 */
export const LIVE_MEMO_PROGRAM = MEMO_PROGRAM;

export type AnchorKind = "audit-head" | "ledger-root";

/** Memo payload for an audit-log head anchor (colon-delimited, compact). */
export function auditHeadMemo(seq: string, entryHashHex: string, network: string): string {
  return `ar.io-audit-anchor:v1:${network}:${seq}:${entryHashHex}`;
}
/** Memo payload for a published-ledger root anchor. */
export function ledgerRootMemo(ledgerVersion: string, rootHex: string, network: string): string {
  return `ar.io-ledger-root:v1:${network}:${ledgerVersion}:${rootHex}`;
}

export interface ParsedAnchorMemo {
  kind: AnchorKind;
  network: string;
  /** audit-head: the seq; ledger-root: the ledgerVersion. */
  ref: string;
  /** audit-head: entry_hash hex; ledger-root: root hex. */
  hashHex: string;
}

/** Parse either anchor memo shape; returns null if not an ar.io anchor memo. */
export function parseAnchorMemo(memo: string): ParsedAnchorMemo | null {
  const parts = memo.split(":");
  if (parts.length !== 5 || parts[1] !== "v1") return null;
  if (parts[0] === "ar.io-audit-anchor") {
    return { kind: "audit-head", network: parts[2], ref: parts[3], hashHex: parts[4] };
  }
  if (parts[0] === "ar.io-ledger-root") {
    return { kind: "ledger-root", network: parts[2], ref: parts[3], hashHex: parts[4] };
  }
  return null;
}

/** Build a Memo instruction carrying `memoText`, attributed to `signer`. */
export function memoIx(memoText: string, signer: Address, memoProgram: Address = LIVE_MEMO_PROGRAM): IInstruction {
  return {
    programAddress: memoProgram,
    // The Memo program treats passed signer accounts as the memo's signers; the
    // anchor key (fee payer) is the sole signer, binding the memo to the key.
    accounts: [{ address: signer, role: AccountRole.READONLY_SIGNER }],
    data: new TextEncoder().encode(memoText),
  };
}

export interface AnchorResult {
  signature: string;
  memo: string;
  memoProgram: string;
  blockhash: string;
  lastValidBlockHeight: bigint;
  confirmed: boolean;
}

/** Create a kit TransactionSigner for the publisher/anchor key from its seed. */
export async function publisherSigner(seed: Uint8Array): Promise<TransactionSigner> {
  return createKeyPairSignerFromPrivateKeyBytes(seed);
}

/**
 * Submit an anchor memo tx and confirm it. Uses the SIGN -> broadcast -> confirm
 * split of the M4 chain gateway (the anchor key pays + signs). Returns the
 * landed signature so the anchor can be recorded and independently re-read.
 */
export async function submitAnchor(opts: {
  gateway: ChainGateway;
  signer: TransactionSigner;
  memoText: string;
  memoProgram?: Address;
}): Promise<AnchorResult> {
  const memoProgram = opts.memoProgram ?? LIVE_MEMO_PROGRAM;
  const ix = memoIx(opts.memoText, opts.signer.address, memoProgram);
  const signed = await opts.gateway.signTransaction([ix], opts.signer);
  await opts.gateway.broadcast(signed.wireBase64);
  const state = await opts.gateway.confirmSignature(signed.signature, signed.lastValidBlockHeight);
  return {
    signature: signed.signature,
    memo: opts.memoText,
    memoProgram: memoProgram as string,
    blockhash: signed.blockhash,
    lastValidBlockHeight: signed.lastValidBlockHeight,
    confirmed: state === "confirmed",
  };
}

/** Convenience: submit an anchor given a kit RPC + the anchor key seed. */
export async function anchorMemoWithRpc(opts: {
  rpc: Rpc<SolanaRpcApi>;
  seed: Uint8Array;
  memoText: string;
  memoProgram?: string;
}): Promise<AnchorResult> {
  const gateway = new SolanaChainGateway(opts.rpc);
  const signer = await publisherSigner(opts.seed);
  return submitAnchor({
    gateway,
    signer,
    memoText: opts.memoText,
    memoProgram: opts.memoProgram ? address(opts.memoProgram) : undefined,
  });
}

export interface FetchedAnchor {
  memo: string;
  slot: bigint;
  err: unknown;
  /** Fee payer of the anchor tx (accountKeys[0]) — the key that authorized it. */
  feePayer: string;
  /** All required signers of the anchor tx (first numRequiredSignatures keys). */
  signers: string[];
}

/**
 * Read an anchor memo back FROM CHAIN by signature — the verifier does NOT trust
 * the operator's DB. Decodes the Memo instruction's data (utf-8) from the
 * confirmed transaction, and returns the tx's fee payer + signers so the verifier
 * can confirm the anchor was authorized by the KNOWN publisher/anchor key (memo
 * content alone is forgeable by any funded key — see `anchorSignedBy`).
 */
export async function fetchAnchorMemo(
  rpc: Rpc<SolanaRpcApi>,
  signature: string,
  memoProgram: string = LIVE_MEMO_PROGRAM as string,
): Promise<FetchedAnchor | null> {
  // Cast: kit's getTransaction typing is deep; we read a stable subset.
  const res = (await (rpc as unknown as {
    getTransaction: (
      sig: string,
      cfg: { maxSupportedTransactionVersion: number; encoding: string; commitment: string },
    ) => { send: () => Promise<unknown> };
  })
    .getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      encoding: "json",
      commitment: "confirmed",
    })
    .send()) as
    | {
        slot: bigint;
        meta: { err: unknown; logMessages?: string[] } | null;
        transaction: {
          message: {
            accountKeys: string[];
            header?: { numRequiredSignatures: number };
            instructions: { programIdIndex: number; data: string }[];
          };
        };
      }
    | null;

  if (!res) return null;
  const { message } = res.transaction;
  const numSigners = message.header?.numRequiredSignatures ?? 1;
  const signers = message.accountKeys.slice(0, numSigners);
  const feePayer = message.accountKeys[0];
  const base = { slot: res.slot, err: res.meta?.err ?? null, feePayer, signers };
  for (const ix of message.instructions) {
    if (message.accountKeys[ix.programIdIndex] === memoProgram) {
      const bytes = bs58.decode(ix.data);
      return { memo: new TextDecoder().decode(bytes), ...base };
    }
  }
  // Fallback: scan the program logs for the memo text.
  for (const line of res.meta?.logMessages ?? []) {
    const m = line.match(/Memo \(len \d+\): "(.*)"$/);
    if (m) return { memo: m[1], ...base };
  }
  return null;
}

/**
 * Confirm an anchor tx was authorized by the KNOWN publisher/anchor key. The memo
 * BODY is attacker-controllable (any funded key can post a memo carrying a
 * rewritten head), so the ONLY thing that binds an anchor to the operator is the
 * on-chain SIGNER. A third-party verifier pins the expected anchor address (the
 * base58 of the published publisher key) and requires it to have signed the tx.
 */
export function anchorSignedBy(fetched: FetchedAnchor, expectedAnchorAddress: string): boolean {
  return fetched.signers.includes(expectedAnchorAddress) || fetched.feePayer === expectedAnchorAddress;
}

/** base58 Solana address of an Ed25519 public key (the anchor/publisher address). */
export function addressFromPublicKey(publicKey: Uint8Array): string {
  return bs58.encode(publicKey);
}
