//! Dispatch worker (M4) — consumes verified dispatch-intents and dispenses the
//! asset on-chain **idempotently and exactly-once** (pivot plan §4.3).
//!
//! ---------------------------------------------------------------------------
//! EXACTLY-ONCE — how a crash/retry can NEVER double-send
//! ---------------------------------------------------------------------------
//! The guarantee is NOT "recompute the same signature". A retry re-signs against
//! a FRESH blockhash, so it produces a DIFFERENT signature. The guarantee is:
//! PERSIST-the-signature-BEFORE-broadcast, and RE-SIGN ONLY AFTER the previous
//! signature is PROVABLY dead (its blockhash can no longer land). A message is
//! only landable while its blockhash is valid, so at most ONE of the signatures
//! ever written for a claim can land.
//!
//!   1. FRESH dispatch (claim `verified` / approved `pending_review`):
//!      - single-flight: `SELECT ... FOR UPDATE` on the claim row.
//!      - build + SIGN the dispense tx -> get its signature.
//!      - PERSIST the signature + its blockhash/lastValidBlockHeight, flip the
//!        claim to `dispatching`, AND re-check the ASSET `FOR UPDATE` (must still
//!        be `claiming`/`pending_review`, never `claimed`) — all in ONE committed
//!        txn, BEFORE broadcasting. If the asset already moved to `claimed`, the
//!        txn ABORTS: the signed tx is discarded and NEVER broadcast (the worker
//!        is double-send-safe in isolation, not merely because M3 locked first).
//!      - only AFTER that commit: broadcast the wire bytes, then confirm.
//!      A crash anywhere here leaves a `dispatching` row with a recorded sig.
//!
//!   2. RECOVERY (claim `dispatching` with a recorded sig, seen on restart):
//!      - confirmSignature(sig) (height sampled BEFORE the status read; see chain.ts):
//!          confirmed -> finalize (claim `confirmed`, asset `claimed`). No resend.
//!          failed    -> claim `failed`; asset stays `claiming` for an operator
//!                       (never auto-retried — the failure may be deterministic).
//!          pending + blockhash still valid -> wait (a prior broadcast may land).
//!          pending + lastValidBlockHeight passed -> the tx is PROVABLY dead, so
//!                       it is safe to re-sign a fresh tx and try again.
//!      At most ONE signature per claim can ever land, because a replacement is
//!      only ever signed once the previous one is provably dead.
//!
//! The asset state machine (`available -> claiming -> claimed`) + the
//! `one_live_claim_per_asset` unique index are the belt-and-suspenders backstop:
//! a confirmed dispense marks the asset `claimed` (terminal), so no second claim
//! can ever win it, and no second dispatch row can exist for it.
//!
//! Custody / brakes:
//!   * token + vault settlements are signed by the HOT dispenser (float ≤ cap);
//!     a claim over the float, or over the >100k brake without operator approval,
//!     is NOT dispensed (queued for refill / routed to review).
//!   * ANT dispatches use a SEPARATE cold `ant` signer, OPERATOR-SUPPLIED at
//!     approval time for just that batch (NOT a persistent server key; NO bulk
//!     move of the 2,269 ANTs). Operator-approval gated — an NFT is NEVER
//!     auto-dispensed from a hot key. See `runAntBatch`.

import { Buffer } from "node:buffer";
import type { Pool, PoolClient } from "pg";
import { address, type Address, type IInstruction, type TransactionSigner } from "@solana/kit";

import type { AntDispatchMode, Config } from "../config.js";
import { appendAudit } from "../api/audit.js";
import { computeVaultSettlement, type VaultSettlement } from "../verify/vault-settlement.js";
import type { ChainGateway } from "./chain.js";
import { FloatManager } from "./float.js";
import { assertSeparableRoles, type DispenserSigner, type SignerRegistry } from "./signer.js";
import {
  type AssetRow,
  type ClaimRow,
  clearDeadSignature as coreClearDeadSignature,
  dispatchSignedTx as coreDispatchSignedTx,
  finalizeConfirmed as coreFinalizeConfirmed,
  loadAsset as coreLoadAsset,
  loadClaim as coreLoadClaim,
  markFailed as coreMarkFailed,
  markNeedsOperator as coreMarkNeedsOperator,
  routeToManualVaultDelivery as coreRouteToManualVaultDelivery,
  routeToReview as coreRouteToReview,
} from "./dispatch-core.js";
import {
  claimMemoIx,
  createAtaIdempotentIx,
  getAssociatedTokenAddress,
  mplCoreTransferV1Ix,
  mplCoreUpdateAuthorityIx,
  transferTokensIx,
} from "./instructions.js";

export interface VaultDurations {
  minVaultDuration: bigint;
  maxVaultDuration: bigint;
}

export interface DispatchWorkerDeps {
  pool: Pool;
  gateway: ChainGateway;
  signers: SignerRegistry;
  float: FloatManager;
  config: Config;
  /** ARIO SPL mint. */
  mint: Address;
  /** ario-core ArioConfig.min/max_vault_duration — configured via env and
   *  boot-reconciled against the live on-chain ArioConfig (mismatch aborts the
   *  worker; see dispatch/ario-config.ts). */
  vaultDurations: VaultDurations;
  /** ario-core program id — required to build a vault RE-LOCK; absent => relock routes to review. */
  arioCoreProgram?: Address;
  /** Gate ANT dispatch on operator approval (default true — NFT never auto-dispensed hot). */
  antRequiresApproval?: boolean;
  /**
   * ANT custody mode (B1). In `operator-wallet` the ANT authority lives in the
   * operator's wallet and ANT claims are dispatched EXCLUSIVELY by ant-operator.ts;
   * the automated worker must NOT process ANT claims (it would run its own #recover
   * against them — clearing signatures, consuming the rebuild budget, scanning the
   * wrong fee payer). When `operator-wallet`, ANT claims are excluded from the
   * pickup queue and any claim reserved into an ANT batch is refused defensively.
   * Default `cli-cold` (unchanged behavior — the break-glass runAntBatch path).
   */
  antDispatchMode?: AntDispatchMode;
  /** Include the `ar.io-claim:<id>` memo ix for traceability (default true). Set
   *  false on a cluster whose SPL Memo program isn't loaded — the memo is
   *  cosmetic and must never block a dispense. */
  includeMemo?: boolean;
  /** Injectable clock (unix seconds) for deterministic tests. */
  now?: () => bigint;
  /** Structured log sink. */
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** Optional critical-alert sink. Fired when a claim is frozen `needs_operator`
   *  after exceeding the re-sign cap (a possible RPC anomaly). Best-effort — the
   *  durable operator-facing alert is the metrics `dispatch-needs-operator`. */
  alert?: (a: { name: string; severity: "critical" | "warning"; message: string; claimId: string }) => void;
}

/** HARD CAP on dispatch re-signs per claim (adversarial item A). After the first
 *  provably-dead re-sign, a further expiry freezes the claim `needs_operator`
 *  rather than emitting another on-chain send — bounds the blast radius under a
 *  persistently lagging/pooled confirm-RPC to at most one extra transfer. */
const MAX_RESIGN_ATTEMPTS = 1;

export type DispatchOutcome =
  | "confirmed"
  | "already_confirmed"
  | "recovered_confirmed"
  | "failed"
  | "awaiting_confirmation"
  | "deferred_refill"
  | "routed_to_review"
  | "awaiting_approval"
  | "awaiting_ant_signer"
  // Terminal-until-operator: the re-sign cap was hit (possible RPC anomaly); the
  // claim is frozen for an operator instead of emitting another on-chain send (A).
  | "needs_operator"
  // A still-locked vault claim: routed to the manual-delivery operator queue with
  // the correct absolute unlock timestamp instead of an auto CPI / a review loop (V).
  | "awaiting_manual_vault_delivery"
  | "skipped";

export interface DispatchResult {
  claimId: string;
  assetKey: string;
  outcome: DispatchOutcome;
  signature?: string;
  detail?: string;
}

export class DispatchWorker {
  #d: DispatchWorkerDeps;
  constructor(deps: DispatchWorkerDeps) {
    this.#d = deps;
    assertSeparableRoles(deps.signers);
  }

  #now(): bigint {
    return this.#d.now ? this.#d.now() : BigInt(Math.floor(Date.now() / 1000));
  }
  #log(msg: string, extra?: Record<string, unknown>): void {
    this.#d.log?.(msg, extra);
  }

  /** Hot dispenser ATA (float lives here). */
  async hotAta(): Promise<Address> {
    return getAssociatedTokenAddress(this.#d.signers.token.address, this.#d.mint);
  }

  /**
   * Process every eligible claim once: recover in-flight `dispatching` rows, then
   * dispense `verified` + approved `pending_review` intents. Returns per-claim
   * results. Sequential by design (single-flight; horizontal scaling would add a
   * distributed float lock — see SPEC.md).
   */
  async runOnce(): Promise<DispatchResult[]> {
    const ids = await this.#eligibleClaimIds();
    const out: DispatchResult[] = [];
    for (const id of ids) {
      out.push(await this.processClaim(id));
    }
    return out;
  }

  async #eligibleClaimIds(): Promise<string[]> {
    // B1: in operator-wallet mode, EXCLUDE ANT assets from the automated pickup
    // queue — they are dispatched exclusively by the operator-wallet flow. Join
    // assets and filter `asset_type <> 'ant'`. In cli-cold (default) the queue is
    // unchanged (ANT claims still flow through the break-glass runAntBatch path).
    if ((this.#d.antDispatchMode ?? "cli-cold") === "operator-wallet") {
      const r = await this.#d.pool.query<{ claim_id: string }>(
        `SELECT c.claim_id FROM claims c JOIN assets a ON a.asset_key = c.asset_key
          WHERE a.asset_type <> 'ant'
            AND (c.status IN ('verified', 'dispatching')
                 OR (c.status = 'pending_review' AND c.approved_at IS NOT NULL))
          ORDER BY c.verified_at NULLS FIRST, c.created_at`,
      );
      return r.rows.map((x) => x.claim_id);
    }
    const r = await this.#d.pool.query<{ claim_id: string }>(
      `SELECT claim_id FROM claims
        WHERE status IN ('verified', 'dispatching')
           OR (status = 'pending_review' AND approved_at IS NOT NULL)
        ORDER BY verified_at NULLS FIRST, created_at`,
    );
    return r.rows.map((x) => x.claim_id);
  }

  /**
   * Process a single claim through the exactly-once state machine.
   *
   * `antSignerOverride` is the OPERATOR-SUPPLIED cold ANT signer loaded for the
   * current approval batch (see `runAntBatch`). It is used ONLY for ANT assets;
   * token/vault always use the hot dispenser. When absent, an ANT dispatch waits
   * (there is intentionally no persistent server-side ANT key).
   */
  async processClaim(claimId: string, antSignerOverride?: DispenserSigner): Promise<DispatchResult> {
    // Snapshot (no lock) to decide the path; all mutations re-check under lock.
    const snap = await this.#loadClaim(this.#d.pool, claimId);
    if (!snap) return { claimId, assetKey: "", outcome: "skipped", detail: "no such claim" };

    if (snap.status === "confirmed") {
      return { claimId, assetKey: snap.asset_key, outcome: "already_confirmed", signature: snap.dispatch_signature ?? undefined };
    }
    // L1 + B1 (guard symmetry): a claim RESERVED into an operator-wallet ANT batch
    // (`ant_batch_id` set) is owned by ant-operator.ts. The automated/cli-cold worker
    // must NEVER dispatch it FRESH (with a server ANT key) NOR recover it — either
    // would strand the operator's reservation. Refuse it here so BOTH the fresh
    // (#dispatchFresh) and recovery (#recover) paths are covered, in ANY mode. (The
    // in-tx FOR UPDATE re-check + one_live_claim_per_asset still make a double-send
    // impossible even without this; this closes the reservation-stranding gap.)
    if (snap.ant_batch_id) {
      this.#log("processClaim: skipping operator-owned ANT claim (ant_batch_id set)", { claimId, antBatchId: snap.ant_batch_id });
      return { claimId, assetKey: snap.asset_key, outcome: "skipped", detail: "operator-wallet ANT claim (owned by ant-operator)" };
    }
    // A recorded signature means a dispatch is (or was) in flight — recover it
    // before ever signing anything new. This is the "check for an existing
    // successful tx before sending" guard.
    if (snap.dispatch_signature && (snap.status === "dispatching" || snap.status === "verified")) {
      return this.#recover(snap, antSignerOverride);
    }
    if (snap.status === "verified") return this.#dispatchFresh(claimId, antSignerOverride);
    if (snap.status === "pending_review" && snap.approved_at) return this.#dispatchFresh(claimId, antSignerOverride);
    if (snap.status === "pending_review") return { claimId, assetKey: snap.asset_key, outcome: "awaiting_approval" };
    return { claimId, assetKey: snap.asset_key, outcome: "skipped", detail: `status ${snap.status}` };
  }

  /**
   * Operator ANT-dispatch batch (custody decision: cold authority, signed per
   * approval batch). The operator loads the COLD ANT authority signer at
   * approval time and passes it here; the worker dispatches every APPROVED ANT
   * claim with it, then the caller discards the signer. No persistent
   * server-side ANT key; no bulk-move of the 2,269 ANTs. `assertSeparableRoles`
   * still guarantees this cold signer isn't the hot token dispenser.
   */
  async runAntBatch(coldAntSigner: DispenserSigner): Promise<DispatchResult[]> {
    if (coldAntSigner.role !== "ant") {
      throw new Error(`runAntBatch requires an 'ant'-role signer, got '${coldAntSigner.role}'`);
    }
    if (coldAntSigner.address === this.#d.signers.token.address) {
      throw new Error("cold ANT signer must NOT be the hot token dispenser (separate blast radii)");
    }
    const r = await this.#d.pool.query<{ claim_id: string }>(
      `SELECT c.claim_id FROM claims c JOIN assets a ON a.asset_key = c.asset_key
        WHERE a.asset_type = 'ant'
          -- B1: a claim reserved into an operator-wallet ANT batch is owned by the
          -- operator flow; the cli-cold break-glass path must NOT grab it (the two
          -- paths must never fight over a claim).
          AND c.ant_batch_id IS NULL
          AND (c.status = 'dispatching'
               OR (c.status = 'pending_review' AND c.approved_at IS NOT NULL))
        ORDER BY c.approved_at NULLS FIRST, c.created_at`,
    );
    const out: DispatchResult[] = [];
    for (const { claim_id } of r.rows) {
      out.push(await this.processClaim(claim_id, coldAntSigner));
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // RECOVERY — a `dispatching` claim with a persisted signature.
  // -------------------------------------------------------------------------
  async #recover(snap: ClaimRow, antSignerOverride?: DispenserSigner): Promise<DispatchResult> {
    // DEFENSE (B1): a claim reserved into an operator-wallet ANT batch is owned by
    // ant-operator.ts (its own recover uses the TREASURY fee-payer for the outflow
    // scan and its own rebuild budget). The automated worker must NEVER recover it —
    // doing so would clear its signature, consume the rebuild budget, strand the
    // batch, and scan the WRONG fee payer. Leave it untouched.
    if (snap.ant_batch_id) {
      this.#log("recover: skipping operator-owned ANT claim (ant_batch_id set)", { claimId: snap.claim_id, antBatchId: snap.ant_batch_id });
      return { claimId: snap.claim_id, assetKey: snap.asset_key, outcome: "skipped", detail: "operator-wallet ANT claim (owned by ant-operator)" };
    }
    const sig = snap.dispatch_signature as string;
    const lastValid = BigInt(snap.dispatch_last_valid_bh ?? "0");
    const state = await this.#d.gateway.confirmSignature(sig, lastValid);
    this.#log("recover: signature status", { claimId: snap.claim_id, sig, state });

    if (state === "confirmed") {
      await this.#finalizeConfirmed(snap.claim_id, sig);
      return { claimId: snap.claim_id, assetKey: snap.asset_key, outcome: "recovered_confirmed", signature: sig };
    }
    if (state === "failed") {
      await this.#markFailed(snap.claim_id, `on-chain tx ${sig} failed`);
      return { claimId: snap.claim_id, assetKey: snap.asset_key, outcome: "failed", signature: sig, detail: "tx failed" };
    }
    if (state === "expired") {
      // ADVERSARIAL ITEM A — a lagging/pooled confirm-RPC can misreport a LANDED
      // tx as not-found -> `expired`. Re-signing on that false premise DOUBLE-
      // SENDS. Before re-signing, independently scan the dispenser + claimant
      // on-chain history for a CONFIRMED tx that is one of THIS claim's own
      // recorded signatures. If found, the transfer already landed and we finalize
      // (never re-sign). Matching by our own signature is decoy-proof.
      const known = [sig, ...(snap.tx_signatures ?? [])].filter(Boolean) as string[];
      const outflow = await this.#d.gateway.findConfirmedOutflow({
        addresses: [this.#d.signers.token.address, address(snap.claimant)],
        knownSignatures: known,
        memo: `ar.io-claim:${snap.claim_id}`,
      });
      if (outflow) {
        this.#log("recover: outflow scan found a landed tx despite an `expired` status — confirming, NOT re-sending", {
          claimId: snap.claim_id, deadSig: sig, landedSig: outflow.signature,
        });
        await this.#finalizeConfirmed(snap.claim_id, outflow.signature);
        return { claimId: snap.claim_id, assetKey: snap.asset_key, outcome: "recovered_confirmed", signature: outflow.signature };
      }

      // No landed outflow: the prior tx is provably dead AND never landed. Re-sign
      // ONCE. Beyond the cap, freeze the claim `needs_operator` (never loop) so a
      // persistently misbehaving RPC can't drive N sends. + a critical alert.
      if ((snap.dispatch_resign_count ?? 0) >= MAX_RESIGN_ATTEMPTS) {
        await this.#markNeedsOperator(
          snap.claim_id,
          `dispatch re-sign cap (${MAX_RESIGN_ATTEMPTS}) exceeded after repeated \`expired\` classifications with no landed outflow — possible lagging/pooled confirm-RPC. Frozen for an operator; do NOT auto-retry. Verify on-chain before any manual re-drive.`,
        );
        return { claimId: snap.claim_id, assetKey: snap.asset_key, outcome: "needs_operator", signature: sig, detail: "resign cap exceeded" };
      }
      // The persisted tx is permanently dead. Clear the dead sig (bumps the
      // resign counter) and re-dispatch a single fresh tx.
      await this.#clearDeadSignature(snap.claim_id);
      this.#log("recover: prior tx expired (no landed outflow), re-dispatching once", { claimId: snap.claim_id, deadSig: sig });
      return this.#dispatchFresh(snap.claim_id, antSignerOverride);
    }
    // pending + still valid: a prior broadcast may yet land; do not touch it.
    return { claimId: snap.claim_id, assetKey: snap.asset_key, outcome: "awaiting_confirmation", signature: sig };
  }

  // -------------------------------------------------------------------------
  // FRESH dispatch — verified / approved-pending_review.
  // -------------------------------------------------------------------------
  async #dispatchFresh(claimId: string, antSignerOverride?: DispenserSigner): Promise<DispatchResult> {
    const snap = await this.#loadClaim(this.#d.pool, claimId);
    if (!snap) return { claimId, assetKey: "", outcome: "skipped", detail: "vanished" };
    const asset = await this.#loadAsset(this.#d.pool, snap.asset_key);
    if (!asset) return { claimId, assetKey: snap.asset_key, outcome: "skipped", detail: "asset missing" };

    // Cheap pre-sign guard (racy read; the authoritative one is the FOR UPDATE
    // re-check in #persistDispatching): skip an already-terminal asset entirely.
    if (asset.status === "claimed" || asset.status === "cancelled") {
      return { claimId, assetKey: asset.asset_key, outcome: "skipped", detail: `asset ${asset.status}` };
    }

    const approved = !!snap.approved_at;
    const claimant = address(snap.claimant);

    // ---- ANT: SEPARATE cold signer, OPERATOR-SUPPLIED per approval batch ----
    if (asset.asset_type === "ant") {
      const antRequiresApproval = this.#d.antRequiresApproval ?? true;
      if (antRequiresApproval && !approved) {
        await this.#routeToReview(claimId, asset.asset_key, "ant dispatch requires operator approval");
        return { claimId, assetKey: asset.asset_key, outcome: "awaiting_approval", detail: "ant needs approval" };
      }
      // The cold ANT authority is loaded by the operator for this batch
      // (runAntBatch) and passed in; `signers.ant` is a fallback only if a
      // deployment explicitly configures one (production does NOT).
      const antCustody = antSignerOverride ?? this.#d.signers.ant;
      if (!antCustody) {
        // Approved but no cold signer loaded in this invocation: it waits for the
        // operator ANT batch. NOT routed to review (already approved) — just held.
        return { claimId, assetKey: asset.asset_key, outcome: "awaiting_ant_signer", detail: "cold ant signer not loaded" };
      }
      if (antCustody.address === this.#d.signers.token.address) {
        await this.#markFailed(claimId, "ANT signer must not be the hot dispenser");
        return { claimId, assetKey: asset.asset_key, outcome: "failed", detail: "ant signer == hot key" };
      }
      if (!asset.ant_mint) {
        await this.#markFailed(claimId, "ant asset has no mint");
        return { claimId, assetKey: asset.asset_key, outcome: "failed", detail: "no ant mint" };
      }
      const antSigner = await antCustody.getSigner();
      const ixs = this.#buildAntIxs(claimId, antSigner, address(asset.ant_mint), claimant);
      return this.#signPersistBroadcastConfirm(claimId, asset, antSigner, ixs, null);
    }

    // ---- token / vault: hot dispenser, float + brake enforced --------------
    const amount = BigInt(asset.amount ?? "0");
    // Available float = live hot balance MINUS what OTHER in-flight dispatches
    // have already committed (exclude THIS claim so it isn't double-counted).
    const [balance, reserved] = await Promise.all([
      this.#d.gateway.getTokenBalance(await this.hotAta()),
      this.#d.float.reserved(this.#d.pool, claimId),
    ]);
    const available = balance > reserved ? balance - reserved : 0n;
    const denial = this.#d.float.check({ amountMario: amount, availableMario: available, approved });
    if (denial) {
      if (denial.reason === "exceeds_brake") {
        await this.#routeToReview(claimId, asset.asset_key, `amount ${amount} over brake ${denial.thresholdMario}`);
        return { claimId, assetKey: asset.asset_key, outcome: "routed_to_review", detail: "big-claim brake" };
      }
      // insufficient float -> leave queued, raise refill-needed. NOT a failure.
      this.#log("deferred: insufficient float", {
        claimId, need: amount.toString(), available: available.toString(),
      });
      return { claimId, assetKey: asset.asset_key, outcome: "deferred_refill", detail: "refill needed" };
    }

    const hotSigner = await this.#d.signers.token.getSigner();
    let ixs: IInstruction[];
    let settlementLabel: string;

    if (asset.asset_type === "vault") {
      const vaultEndTs = BigInt(asset.vault_end_ts ?? "0");
      let settlement: VaultSettlement;
      try {
        settlement = computeVaultSettlement({
          vaultEndTs,
          amount,
          minVaultDuration: this.#d.vaultDurations.minVaultDuration,
          maxVaultDuration: this.#d.vaultDurations.maxVaultDuration,
          now: this.#now(),
        });
      } catch (e) {
        // Only LOCK_DURATION_TOO_LONG is a settlement anomaly (remaining >
        // max_vault_duration); route it to the operator with the absolute unlock
        // rather than silently capping or crashing the tick.
        const remaining = vaultEndTs - this.#now();
        await this.#routeToManualVaultDelivery(claimId, asset.asset_key, vaultEndTs, remaining > 0n ? remaining : 0n);
        return { claimId, assetKey: asset.asset_key, outcome: "awaiting_manual_vault_delivery", detail: `vault settlement anomaly: ${(e as Error).message}` };
      }
      if (settlement.kind === "relock") {
        // ADVERSARIAL ITEM V — a still-locked vault claim is NOT auto-relocked via
        // a CPI and must NOT loop in `pending_review`. Route it to the MANUAL
        // operator delivery queue with the CORRECT ABSOLUTE unlock timestamp (==
        // the escrow's original vault_end_timestamp). The operator hand-delivers a
        // "transfer tokens locked" to that end date; if it has since passed by the
        // time the operator acts, the queue report flags deliver-UNLOCKED (liquid).
        await this.#routeToManualVaultDelivery(
          claimId, asset.asset_key, settlement.unlockTimestamp, settlement.lockDurationSeconds,
        );
        return { claimId, assetKey: asset.asset_key, outcome: "awaiting_manual_vault_delivery", detail: "vault relock -> manual delivery" };
      }
      settlementLabel = `liquid:${settlement.reason}`;
      ixs = await this.#buildTokenIxs(claimId, hotSigner, claimant, amount);
    } else {
      settlementLabel = "token";
      ixs = await this.#buildTokenIxs(claimId, hotSigner, claimant, amount);
    }

    return this.#signPersistBroadcastConfirm(claimId, asset, hotSigner, ixs, amount, settlementLabel);
  }

  // -------------------------------------------------------------------------
  // The sign -> PERSIST -> broadcast -> confirm core (exactly-once anchor).
  // -------------------------------------------------------------------------
  async #signPersistBroadcastConfirm(
    claimId: string,
    asset: AssetRow,
    signer: TransactionSigner,
    ixs: IInstruction[],
    settlementAmount: bigint | null,
    settlementLabel?: string,
  ): Promise<DispatchResult> {
    // 1. SIGN (network I/O for the blockhash) — no DB lock held.
    const signed = await this.#d.gateway.signTransaction(ixs, signer);
    // 2-4. PERSIST-before-broadcast -> broadcast -> confirm (shared exactly-once
    //      core; identical to the operator-wallet ANT path). If the state moved
    //      under the FOR UPDATE re-check, the signed tx is discarded, never sent.
    const r = await coreDispatchSignedTx(this.#d.pool, this.#d.gateway, {
      claimId, assetKey: asset.asset_key, signed, settlementAmount, settlementLabel, log: this.#d.log,
    });
    return { claimId, assetKey: asset.asset_key, outcome: r.outcome, signature: r.signature, detail: r.detail };
  }

  // -------------------------------------------------------------------------
  // Instruction builders
  // -------------------------------------------------------------------------
  #memoIxs(claimId: string): IInstruction[] {
    return (this.#d.includeMemo ?? true) ? [claimMemoIx(claimId)] : [];
  }

  async #buildTokenIxs(claimId: string, hotSigner: TransactionSigner, claimant: Address, amount: bigint): Promise<IInstruction[]> {
    const hotAta = await getAssociatedTokenAddress(hotSigner.address, this.#d.mint);
    const recipientAta = await getAssociatedTokenAddress(claimant, this.#d.mint);
    return [
      createAtaIdempotentIx({ payer: hotSigner.address, ata: recipientAta, owner: claimant, mint: this.#d.mint }),
      transferTokensIx({ source: hotAta, destination: recipientAta, authority: hotSigner.address, amount }),
      ...this.#memoIxs(claimId),
    ];
  }

  #buildAntIxs(claimId: string, antSigner: TransactionSigner, antMint: Address, newOwner: Address): IInstruction[] {
    return [
      mplCoreTransferV1Ix({ asset: antMint, payer: antSigner.address, authority: antSigner.address, newOwner }),
      mplCoreUpdateAuthorityIx({ asset: antMint, payer: antSigner.address, authority: antSigner.address, newAuthority: newOwner }),
      ...this.#memoIxs(claimId),
    ];
  }

  // -------------------------------------------------------------------------
  // DB state transitions — delegate to the shared exactly-once core so the
  // operator-wallet ANT path (ant-operator.ts) reuses the SAME guard. Behavior
  // is byte-identical to the pre-refactor private methods.
  // -------------------------------------------------------------------------
  #finalizeConfirmed(claimId: string, signature: string): Promise<void> {
    return coreFinalizeConfirmed(this.#d.pool, claimId, signature);
  }

  #markFailed(claimId: string, reason: string): Promise<void> {
    return coreMarkFailed(this.#d.pool, claimId, reason);
  }

  /**
   * Freeze a claim `needs_operator` (terminal-until-operator) + fire the critical
   * alert. The DB flip is the shared core; the alert stays worker-local.
   */
  async #markNeedsOperator(claimId: string, reason: string): Promise<void> {
    const flipped = await coreMarkNeedsOperator(this.#d.pool, claimId, reason);
    if (!flipped) return;
    this.#log("CRITICAL: claim frozen needs_operator", { claimId, reason });
    this.#d.alert?.({ name: "dispatch-needs-operator", severity: "critical", message: reason, claimId });
  }

  #routeToManualVaultDelivery(claimId: string, assetKey: string, unlockTs: bigint, lockDurationSeconds: bigint): Promise<void> {
    return coreRouteToManualVaultDelivery(this.#d.pool, claimId, assetKey, unlockTs, lockDurationSeconds);
  }

  #clearDeadSignature(claimId: string): Promise<void> {
    return coreClearDeadSignature(this.#d.pool, claimId);
  }

  #routeToReview(claimId: string, assetKey: string, reason: string): Promise<void> {
    return coreRouteToReview(this.#d.pool, claimId, assetKey, reason);
  }

  // -------------------------------------------------------------------------
  // Loaders (delegate to the shared core loaders)
  // -------------------------------------------------------------------------
  #loadClaim(db: Pool | PoolClient, claimId: string, forUpdate = false): Promise<ClaimRow | null> {
    return coreLoadClaim(db, claimId, forUpdate);
  }
  #loadAsset(db: Pool | PoolClient, assetKey: string, forUpdate = false): Promise<AssetRow | null> {
    return coreLoadAsset(db, assetKey, forUpdate);
  }

  /** Approve a claim (operator): sets approved_at so the worker will dispatch it. */
  static async approveClaim(pool: Pool, claimId: string, approvedBy: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query<{ status: string }>("SELECT status FROM claims WHERE claim_id = $1 FOR UPDATE", [claimId]);
      const row = r.rows[0];
      if (!row) throw new Error(`no such claim ${claimId}`);
      if (row.status !== "pending_review") throw new Error(`claim ${claimId} is ${row.status}, not pending_review`);
      await client.query("UPDATE claims SET approved_at = now(), approved_by = $2, updated_at = now() WHERE claim_id = $1", [claimId, approvedBy]);
      const a = await client.query<{ asset_key: string }>("SELECT asset_key FROM claims WHERE claim_id = $1", [claimId]);
      await appendAudit(client, { event: "claim.approved", claimId, assetKey: a.rows[0]?.asset_key, status: "pending_review", detail: { approvedBy } });
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
}

/** Utility: 32-byte hex helper for callers building fixtures. */
export function bytesToHex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}
