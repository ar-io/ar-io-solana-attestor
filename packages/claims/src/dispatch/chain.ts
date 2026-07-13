//! Chain gateway — the worker's ONLY door to Solana (M4).
//!
//! Abstracts the `@solana/kit` RPC + transaction machinery behind an interface
//! so (a) the exactly-once dispatch logic in worker.ts is unit-testable against a
//! deterministic fake (`FakeChainGateway` in the tests), and (b) the send path is
//! split into SIGN -> persist -> BROADCAST -> CONFIRM, which is what makes
//! dispensing exactly-once WITHOUT durable nonces (pivot plan §4.3):
//!
//!   signTransaction()  builds + signs against a FRESH blockhash and returns the
//!                      resulting signature (+ that blockhash/lastValidBlockHeight).
//!                      The worker PERSISTS the signature BEFORE broadcasting. NOTE:
//!                      a RETRY re-signs with a *new* blockhash, so it yields a
//!                      DIFFERENT signature — the guarantee is NOT "recompute the
//!                      same sig", it is persist-sig-before-broadcast +
//!                      re-sign-only-after-the-old-sig-is-PROVABLY-dead.
//!   broadcast()        sends the already-signed wire bytes. Safe to call twice
//!                      with the same bytes (identical signature => network dedups).
//!   confirmSignature() polls getSignatureStatuses; on recovery this tells the
//!                      worker whether the persisted signature landed.
//!   getBlockHeight()   + the persisted lastValidBlockHeight answers "can the
//!                      persisted tx still land?" — height sampled BEFORE the
//!                      status read (see #statusOnce) makes a not-found past
//!                      lastValidBlockHeight PROVABLY dead => safe to re-sign.
//!
//! OPERATIONAL REQUIREMENT (exactly-once depends on it): the RPC passed here for
//! the confirmation reads (getSignatureStatuses + getBlockHeight) MUST be a
//! SINGLE consistent endpoint (or a read quorum), NOT a round-robin/load-balanced
//! pool. A lagging replica can report a landed tx as not-found and break the
//! "provably dead" premise. See SPEC.md "M4 — operational requirements".
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

/** A confirmed dispenser outflow discovered by the recovery-path scan. */
export interface OutflowMatch {
  /** The base58 signature of the CONFIRMED, matching on-chain transfer. */
  signature: string;
}

/** Inputs for the pre-re-sign outflow scan (see `findConfirmedOutflow`). */
export interface OutflowScanParams {
  /**
   * Addresses whose recent on-chain history to scan. Every dispatch tx references
   * both the hot dispenser (fee payer) and the claimant (ATA owner / new NFT
   * owner), so either surfaces the tx via `getSignaturesForAddress`.
   */
  addresses: Address[];
  /**
   * This claim's OWN recorded signatures (dispatch_signature + tx_signatures).
   * The match is AUTHORITATIVE by signature: an attacker cannot forge a tx under
   * our signature, so a decoy tx that merely references our address or carries our
   * memo can NEVER be mistaken for a real dispense (no false `confirmed`).
   */
  knownSignatures: string[];
  /** `ar.io-claim:<id>` — the on-chain marker our dispatch carries (audit only). */
  memo?: string;
  /** How far back to scan per address (default 1000). */
  limit?: number;
}

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
  /**
   * DEFENSE-IN-DEPTH against a lagging/pooled confirm-RPC (adversarial-pass item
   * A): before the recovery path re-signs a claim whose prior tx was classified
   * `expired`, scan the dispenser/claimant on-chain history for a CONFIRMED tx
   * that is one of THIS claim's own recorded signatures. If found, the transfer
   * already landed (the `getSignatureStatuses` read simply lagged) and the worker
   * marks the claim confirmed instead of emitting a second on-chain send. Matching
   * is by our own signature (decoy-proof); `null` = no landed outflow found, so a
   * single bounded re-sign is safe.
   */
  findConfirmedOutflow(params: OutflowScanParams): Promise<OutflowMatch | null>;
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

  /** One raw status lookup (no polling) — used to classify a signature's fate.
   *
   * TOCTOU-safe expiry (order matters): sample block HEIGHT *before* the status
   * read. If we read statuses first and height second, a tx landing in its final
   * valid slot BETWEEN the two reads would be seen not-found (early) then
   * height>lastValid (late) -> misclassified `expired` -> re-sign -> DOUBLE SEND.
   * Reading height first makes not-found definitive: if height was already
   * strictly past `lastValidBlockHeight` at sample time, then by the time we do
   * the LATER status read every slot the tx could have landed in has been
   * produced — a still-not-found is provably dead. */
  async #statusOnce(signature: string, lastValidBlockHeight: bigint): Promise<ConfirmState> {
    const heightAtSample = await this.getBlockHeight(); // FIRST — see doc above
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
    // Not found AND, at the moment sampled BEFORE this read, height was already
    // strictly past the last valid slot -> the exact tx can never land. Dead.
    if (heightAtSample > lastValidBlockHeight) return "expired";
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

  async findConfirmedOutflow(params: OutflowScanParams): Promise<OutflowMatch | null> {
    const known = new Set(params.knownSignatures.filter(Boolean));
    if (known.size === 0) return null; // nothing of ours to match against
    const limit = params.limit ?? 1000;
    for (const addr of params.addresses) {
      let page: Awaited<ReturnType<ReturnType<KitRpc["getSignaturesForAddress"]>["send"]>>;
      try {
        page = await this.#rpc.getSignaturesForAddress(addr, { limit }).send();
      } catch {
        continue; // a single address failing must not block the scan
      }
      for (const e of page) {
        // Only a CONFIRMED (or finalized), non-erroring tx counts as a landed
        // transfer. `err != null` means it reverted; ignore it.
        if (e.err != null) continue;
        const cs = e.confirmationStatus;
        if (cs !== "confirmed" && cs !== "finalized") continue;
        // AUTHORITATIVE match: the tx is one WE signed for this claim. A decoy
        // that merely references our address or replays our memo cannot appear
        // here under our signature, so this can never yield a false confirm.
        if (known.has(e.signature)) return { signature: e.signature };
      }
    }
    return null;
  }
}

export type { Address, Blockhash };
