//! Dispatch worker (M4) — consumes verified dispatch-intents and dispenses the
//! asset on-chain **idempotently and exactly-once** (pivot plan §4.3).
//!
//! ---------------------------------------------------------------------------
//! EXACTLY-ONCE — how a crash/retry can NEVER double-send
//! ---------------------------------------------------------------------------
//! A Solana tx signature is DETERMINISTIC from (message + signer), and a message
//! is only landable while its blockhash is valid. The worker exploits both:
//!
//!   1. FRESH dispatch (claim `verified` / approved `pending_review`):
//!      - single-flight: `SELECT ... FOR UPDATE` on the claim row.
//!      - build + SIGN the dispense tx -> get the deterministic signature.
//!      - PERSIST the signature + its blockhash/lastValidBlockHeight and flip the
//!        claim to `dispatching`, all in ONE committed txn — BEFORE broadcasting.
//!      - only AFTER that commit: broadcast the wire bytes, then confirm.
//!      A crash anywhere here leaves a `dispatching` row with a recorded sig.
//!
//!   2. RECOVERY (claim `dispatching` with a recorded sig, seen on restart):
//!      - getSignatureStatuses(sig):
//!          confirmed -> finalize (claim `confirmed`, asset `claimed`). No resend.
//!          failed    -> claim `failed`; asset stays `claiming` for an operator
//!                       (never auto-retried — the failure may be deterministic).
//!          pending + blockhash still valid -> wait (a prior broadcast may land).
//!          pending + lastValidBlockHeight passed -> the tx is PERMANENTLY dead
//!                       (that exact signature can never land), so it is safe to
//!                       re-sign a fresh tx and try again.
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
//!   * ANT dispatches use the SEPARATE `ant` signer and are operator-approval
//!     gated by default — an NFT is NEVER auto-dispensed from a hot key.

import { Buffer } from "node:buffer";
import type { Pool, PoolClient } from "pg";
import { address, type Address, type IInstruction, type TransactionSigner } from "@solana/kit";

import type { Config } from "../config.js";
import { appendAudit } from "../api/audit.js";
import { computeVaultSettlement } from "../verify/vault-settlement.js";
import type { ChainGateway, SignedDispatch } from "./chain.js";
import { FloatManager } from "./float.js";
import { assertSeparableRoles, type SignerRegistry } from "./signer.js";
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
  /** Live ario-core ArioConfig.min/max_vault_duration (operator reads them live). */
  vaultDurations: VaultDurations;
  /** ario-core program id — required to build a vault RE-LOCK; absent => relock routes to review. */
  arioCoreProgram?: Address;
  /** Gate ANT dispatch on operator approval (default true — NFT never auto-dispensed hot). */
  antRequiresApproval?: boolean;
  /** Include the `ar.io-claim:<id>` memo ix for traceability (default true). Set
   *  false on a cluster whose SPL Memo program isn't loaded — the memo is
   *  cosmetic and must never block a dispense. */
  includeMemo?: boolean;
  /** Injectable clock (unix seconds) for deterministic tests. */
  now?: () => bigint;
  /** Structured log sink. */
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export type DispatchOutcome =
  | "confirmed"
  | "already_confirmed"
  | "recovered_confirmed"
  | "failed"
  | "awaiting_confirmation"
  | "deferred_refill"
  | "routed_to_review"
  | "awaiting_approval"
  | "skipped";

export interface DispatchResult {
  claimId: string;
  assetKey: string;
  outcome: DispatchOutcome;
  signature?: string;
  detail?: string;
}

interface ClaimRow {
  claim_id: string;
  asset_key: string;
  claimant: string;
  status: string;
  settlement: string | null;
  approved_at: Date | null;
  dispatch_signature: string | null;
  dispatch_blockhash: string | null;
  dispatch_last_valid_bh: string | null;
  settlement_amount: string | null;
  tx_signatures: string[] | null;
}
interface AssetRow {
  asset_key: string;
  asset_type: "ant" | "token" | "vault";
  ant_mint: string | null;
  amount: string | null;
  vault_end_ts: string | null;
  status: string;
  recipient_id: string;
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
    const r = await this.#d.pool.query<{ claim_id: string }>(
      `SELECT claim_id FROM claims
        WHERE status IN ('verified', 'dispatching')
           OR (status = 'pending_review' AND approved_at IS NOT NULL)
        ORDER BY verified_at NULLS FIRST, created_at`,
    );
    return r.rows.map((x) => x.claim_id);
  }

  /** Process a single claim through the exactly-once state machine. */
  async processClaim(claimId: string): Promise<DispatchResult> {
    // Snapshot (no lock) to decide the path; all mutations re-check under lock.
    const snap = await this.#loadClaim(this.#d.pool, claimId);
    if (!snap) return { claimId, assetKey: "", outcome: "skipped", detail: "no such claim" };

    if (snap.status === "confirmed") {
      return { claimId, assetKey: snap.asset_key, outcome: "already_confirmed", signature: snap.dispatch_signature ?? undefined };
    }
    // A recorded signature means a dispatch is (or was) in flight — recover it
    // before ever signing anything new. This is the "check for an existing
    // successful tx before sending" guard.
    if (snap.dispatch_signature && (snap.status === "dispatching" || snap.status === "verified")) {
      return this.#recover(snap);
    }
    if (snap.status === "verified") return this.#dispatchFresh(claimId);
    if (snap.status === "pending_review" && snap.approved_at) return this.#dispatchFresh(claimId);
    if (snap.status === "pending_review") return { claimId, assetKey: snap.asset_key, outcome: "awaiting_approval" };
    return { claimId, assetKey: snap.asset_key, outcome: "skipped", detail: `status ${snap.status}` };
  }

  // -------------------------------------------------------------------------
  // RECOVERY — a `dispatching` claim with a persisted signature.
  // -------------------------------------------------------------------------
  async #recover(snap: ClaimRow): Promise<DispatchResult> {
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
      // The persisted tx is permanently dead. Clear the dead sig and re-dispatch.
      await this.#clearDeadSignature(snap.claim_id);
      this.#log("recover: prior tx expired, re-dispatching", { claimId: snap.claim_id, deadSig: sig });
      return this.#dispatchFresh(snap.claim_id);
    }
    // pending + still valid: a prior broadcast may yet land; do not touch it.
    return { claimId: snap.claim_id, assetKey: snap.asset_key, outcome: "awaiting_confirmation", signature: sig };
  }

  // -------------------------------------------------------------------------
  // FRESH dispatch — verified / approved-pending_review.
  // -------------------------------------------------------------------------
  async #dispatchFresh(claimId: string): Promise<DispatchResult> {
    const snap = await this.#loadClaim(this.#d.pool, claimId);
    if (!snap) return { claimId, assetKey: "", outcome: "skipped", detail: "vanished" };
    const asset = await this.#loadAsset(this.#d.pool, snap.asset_key);
    if (!asset) return { claimId, assetKey: snap.asset_key, outcome: "skipped", detail: "asset missing" };

    const approved = !!snap.approved_at;
    const claimant = address(snap.claimant);

    // ---- ANT: separate signer, operator-approval gated (never auto-hot) ----
    if (asset.asset_type === "ant") {
      const antRequiresApproval = this.#d.antRequiresApproval ?? true;
      if (antRequiresApproval && !approved) {
        await this.#routeToReview(claimId, asset.asset_key, "ant dispatch requires operator approval");
        return { claimId, assetKey: asset.asset_key, outcome: "awaiting_approval", detail: "ant needs approval" };
      }
      if (!this.#d.signers.ant) {
        await this.#routeToReview(claimId, asset.asset_key, "no ANT custody signer configured");
        return { claimId, assetKey: asset.asset_key, outcome: "routed_to_review", detail: "no ant signer" };
      }
      if (!asset.ant_mint) {
        await this.#markFailed(claimId, "ant asset has no mint");
        return { claimId, assetKey: asset.asset_key, outcome: "failed", detail: "no ant mint" };
      }
      const antSigner = await this.#d.signers.ant.getSigner();
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
      const settlement = computeVaultSettlement({
        vaultEndTs: BigInt(asset.vault_end_ts ?? "0"),
        amount,
        minVaultDuration: this.#d.vaultDurations.minVaultDuration,
        maxVaultDuration: this.#d.vaultDurations.maxVaultDuration,
        now: this.#now(),
      });
      if (settlement.kind === "relock") {
        // RE-LOCK needs the deployed ario-core + a provisioned vault ATA (residual;
        // see instructions.ts). Not built inline here — route to the operator so a
        // relock is never silently downgraded to liquid (never "silently cap").
        await this.#routeToReview(
          claimId, asset.asset_key,
          `vault re-lock (${settlement.lockDurationSeconds}s) requires operator/ario-core relock path`,
        );
        return { claimId, assetKey: asset.asset_key, outcome: "routed_to_review", detail: "vault relock" };
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

    // 2. PERSIST the signature + flip verified/approved -> dispatching, in ONE
    //    committed txn, re-checking the state under the claim row lock so a
    //    concurrent completer/worker can't double-dispatch. If the state moved,
    //    we ABORT and never broadcast our signed tx (it simply never lands).
    const persisted = await this.#persistDispatching(claimId, asset.asset_key, signed, settlementAmount, settlementLabel);
    if (!persisted) {
      return { claimId, assetKey: asset.asset_key, outcome: "skipped", detail: "state changed before dispatch" };
    }

    // 3. BROADCAST (after the commit). Idempotent — same signature dedups.
    try {
      await this.#d.gateway.broadcast(signed.wireBase64);
    } catch (e) {
      // A broadcast error is not fatal: the sig is persisted; recovery re-checks
      // it (it may still have landed, or will expire and re-sign).
      this.#log("broadcast error (will recover)", { claimId, sig: signed.signature, err: (e as Error).message });
    }

    // 4. CONFIRM inline. A crash here is fine — recovery finalizes.
    const state = await this.#d.gateway.confirmSignature(signed.signature, signed.lastValidBlockHeight);
    if (state === "confirmed") {
      await this.#finalizeConfirmed(claimId, signed.signature);
      return { claimId, assetKey: asset.asset_key, outcome: "confirmed", signature: signed.signature };
    }
    if (state === "failed") {
      await this.#markFailed(claimId, `on-chain tx ${signed.signature} failed`);
      return { claimId, assetKey: asset.asset_key, outcome: "failed", signature: signed.signature };
    }
    return { claimId, assetKey: asset.asset_key, outcome: "awaiting_confirmation", signature: signed.signature };
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
  // DB state transitions (each its own committed txn; re-check under lock)
  // -------------------------------------------------------------------------
  /** verified/approved-pending_review -> dispatching, persisting the signature. */
  async #persistDispatching(
    claimId: string,
    assetKey: string,
    signed: SignedDispatch,
    settlementAmount: bigint | null,
    settlementLabel?: string,
  ): Promise<boolean> {
    const client = await this.#d.pool.connect();
    try {
      await client.query("BEGIN");
      const c = await this.#loadClaim(client, claimId, true);
      if (!c) {
        await client.query("ROLLBACK");
        return false;
      }
      const canDispatch = c.status === "verified" || (c.status === "pending_review" && c.approved_at);
      if (!canDispatch) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        `UPDATE claims
            SET status = 'dispatching',
                dispatch_signature = $2,
                dispatch_blockhash = $3,
                dispatch_last_valid_bh = $4,
                dispatch_started_at = now(),
                settlement_amount = $5,
                settlement = COALESCE($6, settlement),
                tx_signatures = array_append(COALESCE(tx_signatures, ARRAY[]::text[]), $2),
                error = NULL,
                updated_at = now()
          WHERE claim_id = $1`,
        [claimId, signed.signature, signed.blockhash, signed.lastValidBlockHeight.toString(),
          settlementAmount === null ? null : settlementAmount.toString(), settlementLabel ?? null],
      );
      await client.query(
        "UPDATE assets SET status = 'claiming', updated_at = now() WHERE asset_key = $1 AND status <> 'claimed'",
        [assetKey],
      );
      await appendAudit(client, {
        event: "claim.dispatching", claimId, assetKey, status: "dispatching",
        detail: { signature: signed.signature, blockhash: signed.blockhash, lastValidBlockHeight: signed.lastValidBlockHeight.toString(), settlement: settlementLabel, amount: settlementAmount?.toString() },
      });
      await client.query("COMMIT");
      return true;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /** dispatching -> confirmed; asset -> claimed (terminal). Idempotent. */
  async #finalizeConfirmed(claimId: string, signature: string): Promise<void> {
    const client = await this.#d.pool.connect();
    try {
      await client.query("BEGIN");
      const c = await this.#loadClaim(client, claimId, true);
      if (!c) {
        await client.query("ROLLBACK");
        return;
      }
      if (c.status === "confirmed") {
        await client.query("ROLLBACK");
        return; // already finalized (idempotent)
      }
      await client.query(
        `UPDATE claims
            SET status = 'confirmed', confirmed_at = now(),
                tx_signatures = CASE WHEN $2 = ANY(COALESCE(tx_signatures, ARRAY[]::text[]))
                                     THEN tx_signatures
                                     ELSE array_append(COALESCE(tx_signatures, ARRAY[]::text[]), $2) END,
                error = NULL, updated_at = now()
          WHERE claim_id = $1`,
        [claimId, signature],
      );
      await client.query("UPDATE assets SET status = 'claimed', updated_at = now() WHERE asset_key = $1", [c.asset_key]);
      await appendAudit(client, {
        event: "claim.confirmed", claimId, assetKey: c.asset_key, status: "confirmed",
        detail: { signature, settlementAmount: c.settlement_amount ?? undefined },
      });
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /** dispatching -> failed. Asset stays `claiming` for operator (no auto-retry). */
  async #markFailed(claimId: string, reason: string): Promise<void> {
    const client = await this.#d.pool.connect();
    try {
      await client.query("BEGIN");
      const c = await this.#loadClaim(client, claimId, true);
      if (!c || c.status === "confirmed") {
        await client.query("ROLLBACK");
        return;
      }
      await client.query("UPDATE claims SET status = 'failed', error = $2, updated_at = now() WHERE claim_id = $1", [claimId, reason]);
      await appendAudit(client, { event: "claim.failed", claimId, assetKey: c.asset_key, status: "failed", reason });
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /** Clear a provably-dead (expired) signature so a fresh dispatch can re-sign. */
  async #clearDeadSignature(claimId: string): Promise<void> {
    const client = await this.#d.pool.connect();
    try {
      await client.query("BEGIN");
      const c = await this.#loadClaim(client, claimId, true);
      if (!c || c.status !== "dispatching") {
        await client.query("ROLLBACK");
        return;
      }
      // Revert to `verified` (or pending_review if it was operator-approved) so
      // #dispatchFresh re-signs. The dead sig stays in tx_signatures history.
      const revertTo = c.approved_at ? "pending_review" : "verified";
      await client.query(
        `UPDATE claims SET status = $2, dispatch_signature = NULL, dispatch_blockhash = NULL,
             dispatch_last_valid_bh = NULL, updated_at = now() WHERE claim_id = $1`,
        [claimId, revertTo],
      );
      await appendAudit(client, {
        event: "claim.dispatch_expired", claimId, assetKey: c.asset_key, status: revertTo,
        detail: { deadSignature: c.dispatch_signature ?? undefined },
      });
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /** verified/pending -> pending_review + asset pending_review (brake / ANT gate). */
  async #routeToReview(claimId: string, assetKey: string, reason: string): Promise<void> {
    const client = await this.#d.pool.connect();
    try {
      await client.query("BEGIN");
      const c = await this.#loadClaim(client, claimId, true);
      if (!c || c.status === "confirmed" || c.status === "dispatching") {
        await client.query("ROLLBACK");
        return;
      }
      await client.query("UPDATE claims SET status = 'pending_review', updated_at = now() WHERE claim_id = $1", [claimId]);
      await client.query(
        "UPDATE assets SET status = 'pending_review', updated_at = now() WHERE asset_key = $1 AND status NOT IN ('claimed')",
        [assetKey],
      );
      await appendAudit(client, { event: "claim.pending_review", claimId, assetKey, status: "pending_review", reason });
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Loaders
  // -------------------------------------------------------------------------
  async #loadClaim(db: Pool | PoolClient, claimId: string, forUpdate = false): Promise<ClaimRow | null> {
    const r = await db.query<ClaimRow>(
      `SELECT claim_id, asset_key, claimant, status, settlement, approved_at,
              dispatch_signature, dispatch_blockhash, dispatch_last_valid_bh::text AS dispatch_last_valid_bh,
              settlement_amount::text AS settlement_amount, tx_signatures
         FROM claims WHERE claim_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
      [claimId],
    );
    return r.rows[0] ?? null;
  }
  async #loadAsset(db: Pool | PoolClient, assetKey: string): Promise<AssetRow | null> {
    const r = await db.query<AssetRow>(
      `SELECT asset_key, asset_type, ant_mint, amount::text AS amount, vault_end_ts::text AS vault_end_ts, status, recipient_id
         FROM assets WHERE asset_key = $1`,
      [assetKey],
    );
    return r.rows[0] ?? null;
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
