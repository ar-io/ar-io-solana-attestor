//! FakeChainGateway — a deterministic, in-memory `ChainGateway` for driving the
//! dispatch worker's exactly-once state machine without a live validator.
//!
//! Excluded from the build (`*.testkit.ts`). Models the ONLY facts the worker
//! reasons about: a signature's landed/failed state, blockhash expiry (via
//! blockHeight vs lastValidBlockHeight), and the hot-ATA balance. Toggles let a
//! test reproduce every crash point:
//!   * crashOnBroadcast  — process dies before the tx is broadcast (tx never lands).
//!   * dropBroadcast     — broadcast returns but the tx never lands (network drop).
//!   * failOnLand        — the tx lands but errors on-chain.
//!   * forcePendingCount — the next N confirmSignature calls report `pending`
//!                         even for a landed tx (crash after land, before finalize).

import { Buffer } from "node:buffer";
import type { Address, IInstruction, TransactionSigner } from "@solana/kit";

import type { ChainGateway, ConfirmState, OutflowMatch, OutflowScanParams, SignedDispatch } from "./chain.js";

interface TxState {
  landed: boolean;
  err: boolean;
  lastValid: bigint;
}

export class FakeChainGateway implements ChainGateway {
  balance = 1_000_000_000_000n; // plenty of float by default
  blockHeight = 1000n;
  signCount = 0;
  broadcasts: string[] = [];

  crashOnBroadcast = false;
  dropBroadcast = false;
  failOnLand = false;
  forcePendingCount = 0;
  /** The exploit shape (adversarial item A): the confirm-RPC is lagging/pooled
   *  and MISREPORTS a LANDED tx as `expired` for the next N confirmSignature
   *  calls. The independent outflow scan (findConfirmedOutflow) must still see the
   *  landed tx and prevent a re-send. */
  expiredDespiteLandedCount = 0;
  /** When true, findConfirmedOutflow always returns null even for a landed tx
   *  (models a fully-adversarial RPC that ALSO hides history) — used to prove the
   *  hard re-sign cap bounds the blast radius. */
  hideOutflows = false;
  /** Hook fired at the START of signTransaction (before the worker persists) —
   *  lets a test flip DB state to exercise the persist-time FOR UPDATE guard. */
  onSign?: () => Promise<void>;

  #wireToSig = new Map<string, string>();
  #txs = new Map<string, TxState>();

  async getTokenBalance(_ata: Address): Promise<bigint> {
    void _ata;
    return this.balance;
  }
  async accountExists(_addr: Address): Promise<boolean> {
    void _addr;
    return true;
  }
  async getBlockHeight(): Promise<bigint> {
    return this.blockHeight;
  }

  async signTransaction(
    ixs: IInstruction[],
    _feePayer: TransactionSigner,
    _extra?: TransactionSigner[],
  ): Promise<SignedDispatch> {
    void ixs;
    void _feePayer;
    void _extra;
    if (this.onSign) await this.onSign();
    this.signCount += 1;
    const signature = `SIG${this.signCount}_${Math.random().toString(36).slice(2, 10)}`;
    const lastValidBlockHeight = this.blockHeight + 150n;
    const wireBase64 = Buffer.from(signature).toString("base64");
    this.#wireToSig.set(wireBase64, signature);
    this.#txs.set(signature, { landed: false, err: this.failOnLand, lastValid: lastValidBlockHeight });
    return { signature, blockhash: `BLK${this.signCount}`, lastValidBlockHeight, wireBase64 };
  }

  async broadcast(wireBase64: string): Promise<void> {
    if (this.crashOnBroadcast) throw new Error("simulated crash before broadcast");
    this.broadcasts.push(wireBase64);
    if (this.dropBroadcast) return;
    const sig = this.#wireToSig.get(wireBase64);
    const t = sig ? this.#txs.get(sig) : undefined;
    if (t) t.landed = true;
  }

  async confirmSignature(signature: string, lastValidBlockHeight: bigint): Promise<ConfirmState> {
    if (this.forcePendingCount > 0) {
      this.forcePendingCount -= 1;
      return "pending";
    }
    const t = this.#txs.get(signature);
    // Lagging/pooled-RPC misreport: a LANDED tx is reported provably-dead. The
    // recovery path must NOT double-send — its outflow scan catches the landed tx.
    if (t?.landed && !t.err && this.expiredDespiteLandedCount > 0) {
      this.expiredDespiteLandedCount -= 1;
      return "expired";
    }
    if (t?.landed) return t.err ? "failed" : "confirmed";
    if (this.blockHeight > lastValidBlockHeight) return "expired";
    return "pending";
  }

  async findConfirmedOutflow(params: OutflowScanParams): Promise<OutflowMatch | null> {
    if (this.hideOutflows) return null;
    const known = new Set(params.knownSignatures.filter(Boolean));
    // Authoritative, decoy-proof: return one of OUR recorded signatures that
    // actually landed (confirmed, no error).
    for (const sig of known) {
      const t = this.#txs.get(sig);
      if (t?.landed && !t.err) return { signature: sig };
    }
    return null;
  }

  // --- test observability ---
  /** Signatures that actually landed successfully (== on-chain transfers). */
  landedSignatures(): string[] {
    return [...this.#txs.entries()].filter(([, t]) => t.landed && !t.err).map(([s]) => s);
  }
  /** Mark a persisted-but-not-broadcast sig as landed (simulate a late land). */
  forceLand(signature: string): void {
    const t = this.#txs.get(signature);
    if (t) t.landed = true;
  }
}
