//! Chain gateway — the worker's ONLY door to Solana (M4).
//!
//! Abstracts the `@solana/kit` RPC + transaction machinery behind an interface
//! so (a) the exactly-once dispatch logic in worker.ts is unit-testable against a
//! deterministic fake (`FakeChainGateway` in the tests), and (b) the send path is
//! split into SIGN -> persist -> BROADCAST -> CONFIRM, which is what makes
//! dispensing exactly-once WITHOUT durable nonces (pivot plan §4.3):
//!
//!   signTransaction()  builds + signs, returns the deterministic signature +
//!                      the blockhash/lastValidBlockHeight it was signed against.
//!                      The worker PERSISTS this BEFORE broadcasting.
//!   broadcast()        sends the already-signed wire bytes. Safe to call twice
//!                      (same signature => the network dedups).
//!   confirmSignature() polls getSignatureStatuses; on recovery this tells the
//!                      worker whether the persisted tx landed.
//!   getBlockHeight()   + the persisted lastValidBlockHeight answers "can the
//!                      persisted tx still land?" — if height passed and the sig
//!                      is not found, the tx is permanently dead => safe to re-sign.
//!
//! No `@solana/web3.js`.

import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Blockhash,
  type IInstruction,
  type Rpc,
  type SolanaRpcApi,
  type TransactionSigner,
} from "@solana/kit";

/** Result of signing — everything the worker must persist before broadcast. */
export interface SignedDispatch {
  /** base58 tx signature (the idempotency anchor). */
  signature: string;
  /** blockhash the tx was signed against. */
  blockhash: string;
  /** lastValidBlockHeight for the blockhash (expiry check on recovery). */
  lastValidBlockHeight: bigint;
  /** base64 wire bytes to broadcast (and re-broadcast — same sig). */
  wireBase64: string;
}

export type ConfirmState = "confirmed" | "failed" | "pending" | "expired";

export interface ChainGateway {
  /** SPL token balance of `ata` in mARIO; 0n if the account does not exist. */
  getTokenBalance(ata: Address): Promise<bigint>;
  /** Does the account exist on-chain? */
  accountExists(addr: Address): Promise<boolean>;
  /** Current block height (for blockhash-expiry checks). */
  getBlockHeight(): Promise<bigint>;
  /**
   * Build + sign a tx over `instructions` with `feePayer` as fee payer and
   * signer. (In M4 every dispense's authority == its fee payer, so one signer
   * covers the tx; extra signers are supported for future multi-signer paths.)
   * Returns the deterministic signature + the blockhash it committed to.
   */
  signTransaction(
    instructions: IInstruction[],
    feePayer: TransactionSigner,
    extraSigners?: TransactionSigner[],
  ): Promise<SignedDispatch>;
  /** Broadcast already-signed wire bytes. Idempotent (same signature dedups). */
  broadcast(wireBase64: string): Promise<void>;
  /**
   * Resolve a signature's on-chain fate. `lastValidBlockHeight` lets a
   * not-yet-found sig be classified `expired` (permanently dead => re-sign OK)
   * vs `pending` (still landable => re-broadcast the same bytes).
   */
  confirmSignature(signature: string, lastValidBlockHeight: bigint): Promise<ConfirmState>;
}

type KitRpc = Rpc<SolanaRpcApi>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Live kit-backed gateway. */
export class SolanaChainGateway implements ChainGateway {
  #rpc: KitRpc;
  /** Bounded wait for an inline confirmation before returning `pending`. */
  #confirmTimeoutMs: number;
  #confirmPollMs: number;
  constructor(rpc: KitRpc, opts: { confirmTimeoutMs?: number; confirmPollMs?: number } = {}) {
    this.#rpc = rpc;
    this.#confirmTimeoutMs = opts.confirmTimeoutMs ?? 30_000;
    this.#confirmPollMs = opts.confirmPollMs ?? 600;
  }

  async getTokenBalance(ata: Address): Promise<bigint> {
    try {
      const res = await this.#rpc.getTokenAccountBalance(ata).send();
      return BigInt(res.value.amount);
    } catch {
      return 0n; // account absent / not a token account
    }
  }

  async accountExists(addr: Address): Promise<boolean> {
    const res = await this.#rpc.getAccountInfo(addr, { encoding: "base64" }).send();
    return res.value !== null;
  }

  async getBlockHeight(): Promise<bigint> {
    return this.#rpc.getBlockHeight().send();
  }

  async signTransaction(
    instructions: IInstruction[],
    feePayer: TransactionSigner,
    extraSigners: TransactionSigner[] = [],
  ): Promise<SignedDispatch> {
    const { value: latest } = await this.#rpc
      .getLatestBlockhash({ commitment: "confirmed" })
      .send();

    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
          m,
        ),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );

    // extraSigners are additional TransactionSigners whose signatures the
    // message needs (they must already appear as signer accounts in an ix).
    void extraSigners;
    const signed = await signTransactionMessageWithSigners(message);
    const signature = getSignatureFromTransaction(signed);
    return {
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
      wireBase64: getBase64EncodedWireTransaction(signed),
    };
  }

  async broadcast(wireBase64: string): Promise<void> {
    // Preflight ON: surfaces a bad tx before it burns the blockhash, and lets a
    // forked SVM clone referenced programs on simulate. The persist already
    // happened, so this cannot race it.
    await this.#rpc
      .sendTransaction(wireBase64 as Parameters<KitRpc["sendTransaction"]>[0], {
        encoding: "base64",
        preflightCommitment: "confirmed",
      })
      .send();
  }

  /** One raw status lookup (no polling) — used to classify a signature's fate. */
  async #statusOnce(signature: string, lastValidBlockHeight: bigint): Promise<ConfirmState> {
    const statuses = await this.#rpc
      .getSignatureStatuses([signature as Parameters<KitRpc["getSignatureStatuses"]>[0][number]], {
        searchTransactionHistory: true,
      })
      .send();
    const st = statuses.value[0];
    if (st) {
      if (st.err) return "failed";
      const c = st.confirmationStatus;
      if (c === "confirmed" || c === "finalized") return "confirmed";
      return "pending"; // processed but not yet confirmed
    }
    // Not found. If the blockhash can no longer be used, the tx is dead.
    const height = await this.getBlockHeight();
    if (height > lastValidBlockHeight) return "expired";
    return "pending";
  }

  async confirmSignature(signature: string, lastValidBlockHeight: bigint): Promise<ConfirmState> {
    const deadline = Date.now() + this.#confirmTimeoutMs;
    for (;;) {
      const state = await this.#statusOnce(signature, lastValidBlockHeight);
      // Definitive outcomes short-circuit; `pending` keeps polling until a
      // bounded deadline, after which the worker leaves the claim `dispatching`
      // and a later tick recovers it (exactly-once is preserved either way).
      if (state !== "pending") return state;
      if (Date.now() >= deadline) return "pending";
      await sleep(this.#confirmPollMs);
    }
  }
}

export type { Address, Blockhash };
