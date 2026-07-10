//! Claims service — the state machine + concurrency defense (M3).
//!
//! Three operations back the pivot-plan §4.1 endpoints:
//!   getClaimable  — read-only lookup by identity (excludes manual_review).
//!   initiateClaim — mint a single-use challenge, persist a `claiming` claim,
//!                   return the exact canonical bytes to sign (server-built).
//!   completeClaim — verify the signed proof (M2 `verifyClaim`) and atomically
//!                   consume the asset, or reject without consuming it.
//!
//! ---------------------------------------------------------------------------
//! DOUBLE-CLAIM IMPOSSIBILITY (the milestone's core guarantee)
//! ---------------------------------------------------------------------------
//! `completeClaim` runs one DB transaction with TWO row locks, ALWAYS acquired
//! in the same order so no deadlock cycle can form:
//!   1. `SELECT ... FROM claims WHERE claim_id = $1 FOR UPDATE`  (claim row)
//!   2. `SELECT ... FROM assets WHERE asset_key = $1 FOR UPDATE` (asset row)
//!
//! * Two parallel completes of DIFFERENT claims for the SAME asset lock
//!   different claim rows, then serialize on the asset row (step 2). The first
//!   sees the asset `available`, verifies, flips it to `claiming`; the second
//!   then sees `claiming` and returns a clean ALREADY_CLAIMED. Exactly one wins
//!   — enforced by Postgres row locking + the asset state machine, NOT by an
//!   app-level read-then-write.
//! * N parallel completes of the SAME claim serialize on the claim row
//!   (step 1). The first transitions it to `verified`; the rest observe the
//!   terminal state and return the SAME result (idempotent — no second dispatch
//!   intent).
//!
//! The partial-unique index `one_live_claim_per_asset` is the last-resort
//! backstop: even a logic bug cannot leave two `verified` claims on one asset
//! (the second write raises 23505 -> mapped to ALREADY_CLAIMED).

import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import type { Pool, PoolClient } from "pg";

import type { Config } from "../config.js";
import type { AssetType } from "../ledger/types.js";
import { normalizeSourceAddress } from "../ledger/normalize.js";
import { vaultEscrowFallsBackToLiquid } from "../ledger/vault-rules.js";
import {
  buildCanonicalFromLedger,
  verifyClaim,
  VerificationError,
  type AssetView,
  type ClaimProof,
  type RecipientView,
} from "../verify/index.js";
import { ApiError, fromVerificationError, isApiError } from "./errors.js";
import { appendAudit } from "./audit.js";

const ARWEAVE = 0;
const ETHEREUM = 1;
const RSA_SIG_LEN = 512;
const ETH_SIG_LEN = 65;

type ProtocolName = "arweave" | "ethereum";

function protocolName(n: number): ProtocolName {
  if (n === ARWEAVE) return "arweave";
  if (n === ETHEREUM) return "ethereum";
  throw new ApiError(422, "PROTOCOL_MISMATCH", `unknown protocol ${n}`);
}
function protocolNum(name: string): number {
  if (name === "arweave") return ARWEAVE;
  if (name === "ethereum") return ETHEREUM;
  throw new ApiError(400, "INVALID_REQUEST", `unknown protocol "${name}"`);
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------
interface AssetRow {
  asset_key: string;
  asset_type: AssetType;
  ant_mint: string | null;
  amount: string | null;
  vault_end_ts: string | null;
  nonce: Buffer;
  status: string;
  recipient_id: string;
}
interface RecipientRow {
  recipient_id: string;
  protocol: number;
  source_address: string;
  recipient_pubkey: Buffer | null;
  status: string;
}
interface ClaimRow {
  claim_id: string;
  asset_key: string;
  claimant: string;
  canonical_message: Buffer;
  challenge_nonce: Buffer | null;
  challenge_expires_at: Date | null;
  recipient_id: string | null;
  protocol: number | null;
  salt_length: number | null;
  settlement: string | null;
  status: string;
  tx_signatures: string[] | null;
  idempotency_key: string | null;
  error: string | null;
  created_at: Date;
  verified_at: Date | null;
  confirmed_at: Date | null;
}

// ---------------------------------------------------------------------------
// Public result shapes (pivot plan §4.1)
// ---------------------------------------------------------------------------
export interface ClaimableAssetView {
  assetKey: string;
  assetType: AssetType;
  antMint: string | null;
  amount: string | null; // mARIO decimal string; null for ANTs
  vaultEndTimestamp: number | null;
  nonceHex: string; // asset's stored nonce (informational; the binding nonce is issued by initiate)
  status: string;
}
export interface ClaimableResult {
  recipientId: string;
  protocol: ProtocolName;
  sourceAddress: string;
  assets: ClaimableAssetView[];
}
export interface InitiateResult {
  claimId: string;
  status: "claiming";
  assetKey: string;
  claimant: string;
  protocol: ProtocolName;
  recipientId: string;
  network: string;
  /** The single-use CHALLENGE nonce to bind into the signature (64-hex). */
  nonceHex: string;
  /** The exact canonical bytes the client must sign (server-built from ledger). */
  canonicalMessageHex: string;
  canonicalMessageBase64: string;
  expiresAt: string;
}
export interface CompleteResult {
  claimId: string;
  status: "verified" | "pending_review";
  assetKey: string;
  claimant: string;
  settlement: string | null;
  /** True when this response replays an already-completed claim (idempotent). */
  idempotentReplay: boolean;
}
export interface ClaimStatusView {
  claimId: string;
  assetKey: string;
  claimant: string;
  protocol: ProtocolName | null;
  status: string;
  settlement: string | null;
  txSignatures: string[];
  error: string | null;
  createdAt: string;
  verifiedAt: string | null;
  confirmedAt: string | null;
}

export type ProofInput =
  | {
      protocol: "arweave";
      rsaSignatureBase64Url: string;
      rsaModulusBase64Url?: string;
      saltLength?: number;
    }
  | { protocol: "ethereum"; signatureHex: string };

export interface InitiateInput {
  assetKey: string;
  claimant: string;
  idempotencyKey?: string;
}
export interface CompleteInput {
  claimId?: string;
  idempotencyKey?: string;
  nonceHex?: string;
  claimant?: string;
  proof: ProofInput;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Cheap structural check that `s` looks like a base58 Solana pubkey. */
function assertClaimant(s: string): void {
  if (typeof s !== "string" || !BASE58_RE.test(s)) {
    throw new ApiError(400, "INVALID_REQUEST", "claimant must be a base58 Solana address");
  }
}

function toAssetView(row: AssetRow, nonce: Buffer): AssetView {
  return {
    assetType: row.asset_type,
    assetKey: row.asset_key,
    antMint: row.ant_mint,
    amount: row.amount === null ? null : BigInt(row.amount),
    nonce: new Uint8Array(nonce),
    vaultEndTs: row.vault_end_ts === null ? null : Number(row.vault_end_ts),
  };
}
function toRecipientView(row: RecipientRow): RecipientView {
  if (!row.recipient_pubkey) {
    throw new ApiError(409, "MANUAL_REVIEW", "recipient has no published key (AT-RISK / manual_review)");
  }
  return {
    protocol: row.protocol as 0 | 1,
    recipientPubkey: new Uint8Array(row.recipient_pubkey),
    recipientId: row.recipient_id,
    sourceAddress: row.source_address,
  };
}

/** Map a non-available asset status to the right client-facing conflict. */
function unavailableError(status: string): ApiError {
  switch (status) {
    case "claiming":
    case "claimed":
      return new ApiError(409, "ALREADY_CLAIMED", "asset has already been claimed");
    case "pending_review":
      return new ApiError(409, "PENDING_REVIEW", "asset is awaiting operator review");
    case "manual_review":
      return new ApiError(409, "MANUAL_REVIEW", "asset is operator-queue only (AT-RISK)");
    case "frozen":
      return new ApiError(409, "ASSET_FROZEN", "asset is frozen");
    case "cancelled":
      return new ApiError(409, "ASSET_CANCELLED", "asset was cancelled");
    default:
      return new ApiError(409, "ASSET_UNAVAILABLE", `asset status ${status}`);
  }
}

/** Recover the HTTP status a stored rejection code should replay with. */
function statusForStoredCode(code: string): number {
  if (code === "ALREADY_CLAIMED" || code === "NONCE_MISMATCH" || code === "CHALLENGE_EXPIRED") return 409;
  if (code === "MANUAL_REVIEW" || code === "PENDING_REVIEW" || code.startsWith("ASSET_")) return 409;
  if (code === "RSA_SIGNATURE_INVALID" || code === "SIGNATURE_VERIFICATION_FAILED" || code === "ETHEREUM_ADDRESS_MISMATCH") return 401;
  return 422;
}

// ---------------------------------------------------------------------------
// getClaimable — read-only lookup by identity (excludes manual_review)
// ---------------------------------------------------------------------------
export async function getClaimable(
  pool: Pool,
  q: { protocol?: string; address?: string; recipientId?: string },
): Promise<ClaimableResult> {
  let recip: RecipientRow | undefined;
  if (q.recipientId) {
    const r = await pool.query<RecipientRow>(
      "SELECT recipient_id, protocol, source_address, recipient_pubkey, status FROM recipients WHERE recipient_id = $1",
      [q.recipientId],
    );
    recip = r.rows[0];
  } else if (q.address) {
    const norm = normalizeSourceAddress(q.address);
    const r = await pool.query<RecipientRow>(
      "SELECT recipient_id, protocol, source_address, recipient_pubkey, status FROM recipients WHERE source_address = $1",
      [norm],
    );
    recip = r.rows[0];
  } else {
    throw new ApiError(400, "INVALID_REQUEST", "provide `address` (+`protocol`) or `recipientId`");
  }
  if (!recip) {
    throw new ApiError(404, "RECIPIENT_NOT_FOUND", "no recipient matches that identity");
  }
  if (q.protocol && protocolNum(q.protocol) !== recip.protocol) {
    throw new ApiError(422, "PROTOCOL_MISMATCH", "protocol does not match the stored recipient");
  }

  // available ONLY — manual_review / AT-RISK assets are excluded entirely.
  const a = await pool.query<AssetRow>(
    `SELECT asset_key, asset_type, ant_mint, amount, vault_end_ts, nonce, status, recipient_id
       FROM assets WHERE recipient_id = $1 AND status = 'available'
       ORDER BY asset_key`,
    [recip.recipient_id],
  );
  return {
    recipientId: recip.recipient_id,
    protocol: protocolName(recip.protocol),
    sourceAddress: recip.source_address,
    assets: a.rows.map((row) => ({
      assetKey: row.asset_key,
      assetType: row.asset_type,
      antMint: row.ant_mint,
      amount: row.amount,
      vaultEndTimestamp: row.vault_end_ts === null ? null : Number(row.vault_end_ts),
      nonceHex: row.nonce.toString("hex"),
      status: row.status,
    })),
  };
}

/** GET /v1/assets/{assetKey} — single asset (manual_review hidden as 404). */
export async function getAsset(pool: Pool, assetKey: string): Promise<ClaimableAssetView> {
  const a = await pool.query<AssetRow>(
    `SELECT asset_key, asset_type, ant_mint, amount, vault_end_ts, nonce, status, recipient_id
       FROM assets WHERE asset_key = $1`,
    [assetKey],
  );
  const row = a.rows[0];
  if (!row || row.status === "manual_review") {
    throw new ApiError(404, "ASSET_NOT_FOUND", "no self-serve asset with that key");
  }
  return {
    assetKey: row.asset_key,
    assetType: row.asset_type,
    antMint: row.ant_mint,
    amount: row.amount,
    vaultEndTimestamp: row.vault_end_ts === null ? null : Number(row.vault_end_ts),
    nonceHex: row.nonce.toString("hex"),
    status: row.status,
  };
}

// ---------------------------------------------------------------------------
// initiateClaim — mint a challenge, persist a `claiming` claim, return canonical
// ---------------------------------------------------------------------------
export async function initiateClaim(
  pool: Pool,
  config: Config,
  input: InitiateInput,
): Promise<InitiateResult> {
  assertClaimant(input.claimant);
  if (typeof input.assetKey !== "string" || input.assetKey.length === 0) {
    throw new ApiError(400, "INVALID_REQUEST", "assetKey required");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Idempotent initiate: same idempotency key -> return the existing claim.
    if (input.idempotencyKey) {
      const ex = await client.query<ClaimRow>(
        "SELECT * FROM claims WHERE idempotency_key = $1 FOR UPDATE",
        [input.idempotencyKey],
      );
      if (ex.rows[0]) {
        const c = ex.rows[0];
        if (c.asset_key !== input.assetKey) {
          throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "idempotency key already used for a different asset");
        }
        await client.query("COMMIT");
        return initiateResultFromRow(c, config);
      }
    }

    const asset = await loadAsset(client, input.assetKey);
    if (!asset) throw new ApiError(404, "ASSET_NOT_FOUND", "no asset with that key");
    if (asset.status !== "available") throw unavailableError(asset.status);

    const recipRow = await loadRecipient(client, asset.recipient_id);
    if (!recipRow) throw new ApiError(404, "RECIPIENT_NOT_FOUND", "asset references an unknown recipient");
    const recipient = toRecipientView(recipRow); // throws MANUAL_REVIEW if no key

    const challengeNonce = randomBytes(32);
    const expiresAt = new Date(Date.now() + config.challengeTtlMs);

    const canonical = buildCanonicalFromLedger({
      recipient,
      asset: toAssetView(asset, challengeNonce),
      claimant: input.claimant,
      nonce: new Uint8Array(challengeNonce),
      network: config.network,
    });

    const ins = await client.query<{ claim_id: string }>(
      `INSERT INTO claims
         (asset_key, claimant, canonical_message, challenge_nonce, challenge_expires_at,
          recipient_id, protocol, status, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'claiming', $8)
       RETURNING claim_id`,
      [
        asset.asset_key,
        input.claimant,
        Buffer.from(canonical),
        challengeNonce,
        expiresAt,
        recipRow.recipient_id,
        recipRow.protocol,
        input.idempotencyKey ?? null,
      ],
    );
    const claimId = ins.rows[0].claim_id;

    await appendAudit(client, {
      event: "claim.initiate",
      claimId,
      assetKey: asset.asset_key,
      claimant: input.claimant,
      recipientId: recipRow.recipient_id,
      protocol: recipRow.protocol,
      status: "claiming",
      detail: { expiresAt: expiresAt.toISOString() },
    });

    await client.query("COMMIT");

    return {
      claimId,
      status: "claiming",
      assetKey: asset.asset_key,
      claimant: input.claimant,
      protocol: protocolName(recipRow.protocol),
      recipientId: recipRow.recipient_id,
      network: config.network,
      nonceHex: challengeNonce.toString("hex"),
      canonicalMessageHex: Buffer.from(canonical).toString("hex"),
      canonicalMessageBase64: Buffer.from(canonical).toString("base64"),
      expiresAt: expiresAt.toISOString(),
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

function initiateResultFromRow(c: ClaimRow, config: Config): InitiateResult {
  if (!c.challenge_nonce || !c.challenge_expires_at) {
    throw new ApiError(409, "CLAIM_NOT_INITIATABLE", "existing claim has no challenge");
  }
  return {
    claimId: c.claim_id,
    status: "claiming",
    assetKey: c.asset_key,
    claimant: c.claimant,
    protocol: protocolName(c.protocol ?? ARWEAVE),
    recipientId: c.recipient_id ?? "",
    network: config.network,
    nonceHex: c.challenge_nonce.toString("hex"),
    canonicalMessageHex: c.canonical_message.toString("hex"),
    canonicalMessageBase64: c.canonical_message.toString("base64"),
    expiresAt: c.challenge_expires_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// completeClaim — verify + atomically consume, or reject without consuming
// ---------------------------------------------------------------------------
export async function completeClaim(
  pool: Pool,
  config: Config,
  input: CompleteInput,
): Promise<CompleteResult> {
  if (!input.claimId && !input.idempotencyKey) {
    throw new ApiError(400, "INVALID_REQUEST", "provide claimId or idempotencyKey");
  }
  if (!input.proof || typeof input.proof !== "object") {
    throw new ApiError(400, "INVALID_REQUEST", "proof required");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ---- LOCK 1: the claim row (serializes same-claim retries) -------------
    const claimRes = input.claimId
      ? await client.query<ClaimRow>("SELECT * FROM claims WHERE claim_id = $1 FOR UPDATE", [input.claimId])
      : await client.query<ClaimRow>("SELECT * FROM claims WHERE idempotency_key = $1 FOR UPDATE", [
          input.idempotencyKey,
        ]);
    const claim = claimRes.rows[0];
    if (!claim) throw new ApiError(404, "CLAIM_NOT_FOUND", "no such claim");

    // Idempotency: a terminal claim replays its stored outcome, no new work.
    if (claim.status === "verified" || claim.status === "dispatching" || claim.status === "confirmed") {
      await client.query("COMMIT");
      return { claimId: claim.claim_id, status: "verified", assetKey: claim.asset_key, claimant: claim.claimant, settlement: claim.settlement, idempotentReplay: true };
    }
    if (claim.status === "pending_review") {
      await client.query("COMMIT");
      return { claimId: claim.claim_id, status: "pending_review", assetKey: claim.asset_key, claimant: claim.claimant, settlement: claim.settlement, idempotentReplay: true };
    }
    if (claim.status === "rejected") {
      await client.query("COMMIT");
      const code = claim.error ?? "REJECTED";
      throw new ApiError(statusForStoredCode(code), code, "claim was previously rejected");
    }
    if (claim.status === "expired") {
      await client.query("COMMIT");
      throw new ApiError(409, "CHALLENGE_EXPIRED", "claim challenge expired");
    }
    if (claim.status !== "claiming") {
      await client.query("COMMIT");
      throw new ApiError(409, "CLAIM_STATE", `claim not completable from ${claim.status}`);
    }

    // Optional claimant echo — the bound wallet is authoritative.
    if (input.claimant && input.claimant !== claim.claimant) {
      await rejectClaim(client, claim, "INVALID_FIELD_VALUE", "claimant echo != bound claimant");
      await client.query("COMMIT");
      throw new ApiError(422, "INVALID_FIELD_VALUE", "claimant does not match the initiated claim");
    }

    // Challenge expiry -> single-use nonce is dead; do NOT consume the asset.
    if (!claim.challenge_expires_at || claim.challenge_expires_at.getTime() <= Date.now()) {
      await client.query("UPDATE claims SET status = 'expired', updated_at = now() WHERE claim_id = $1", [claim.claim_id]);
      await appendAudit(client, {
        event: "claim.expired", claimId: claim.claim_id, assetKey: claim.asset_key,
        claimant: claim.claimant, recipientId: claim.recipient_id ?? undefined,
        protocol: claim.protocol ?? undefined, status: "expired",
      });
      await client.query("COMMIT");
      throw new ApiError(409, "CHALLENGE_EXPIRED", "claim challenge expired");
    }

    // ---- LOCK 2: the asset row (serializes competing claims per asset) -----
    const asset = await loadAsset(client, claim.asset_key, /* forUpdate */ true);
    if (!asset) {
      await rejectClaim(client, claim, "ASSET_NOT_FOUND", "asset vanished");
      await client.query("COMMIT");
      throw new ApiError(404, "ASSET_NOT_FOUND", "asset no longer exists");
    }
    if (asset.status !== "available") {
      // Someone else already won it (or it's operator-held). Clean conflict.
      const err = unavailableError(asset.status);
      await rejectClaim(client, claim, err.code, err.message);
      await client.query("COMMIT");
      throw err;
    }

    // ---- Verify the proof against the STORED identity + rebuilt canonical --
    const recipRow = await loadRecipient(client, asset.recipient_id);
    if (!recipRow) {
      await rejectClaim(client, claim, "RECIPIENT_NOT_FOUND", "asset references unknown recipient");
      await client.query("COMMIT");
      throw new ApiError(404, "RECIPIENT_NOT_FOUND", "recipient missing");
    }
    const recipient = toRecipientView(recipRow);
    const challengeNonce = claim.challenge_nonce as Buffer;

    let proof: ClaimProof;
    try {
      proof = buildProof(input.proof, claim.claimant, recipient.protocol, input.nonceHex);
    } catch (e) {
      const code = isApiError(e) ? e.code : "INVALID_INPUT";
      await rejectClaim(client, claim, code, (e as Error).message);
      await client.query("COMMIT");
      throw e;
    }

    let saltLength: number | null = null;
    try {
      verifyClaim({
        recipient,
        // Bind the CHALLENGE nonce (not the ledger nonce) into the canonical.
        asset: toAssetView(asset, challengeNonce),
        proof,
        network: config.network,
      });
      saltLength = recipient.protocol === ARWEAVE ? proof.saltLength ?? 32 : null;
    } catch (e) {
      if (e instanceof VerificationError) {
        await rejectClaim(client, claim, e.code, e.message);
        await client.query("COMMIT");
        throw fromVerificationError(e);
      }
      throw e; // infra fault — let it roll back
    }

    // ---- Success: settle route + atomic consume ---------------------------
    const settlement = computeSettlement(asset);
    const amount = asset.amount === null ? 0n : BigInt(asset.amount);
    const recipientTotal = await sumRecipientAvailable(client, asset.recipient_id);
    const bigClaim =
      config.bigClaimThresholdMario > 0n &&
      (amount > config.bigClaimThresholdMario || recipientTotal > config.bigClaimThresholdMario);

    const sig = Buffer.from(proof.signature);

    if (bigClaim) {
      await client.query("UPDATE assets SET status = 'pending_review', updated_at = now() WHERE asset_key = $1", [asset.asset_key]);
      await client.query(
        `UPDATE claims SET status='pending_review', user_signature=$2, salt_length=$3, settlement=$4,
           verified_at=now(), error=NULL, updated_at=now() WHERE claim_id=$1`,
        [claim.claim_id, sig, saltLength, settlement],
      );
      await appendAudit(client, {
        event: "claim.pending_review", claimId: claim.claim_id, assetKey: asset.asset_key,
        claimant: claim.claimant, recipientId: asset.recipient_id, protocol: recipient.protocol,
        status: "pending_review",
        detail: { amount: amount.toString(), recipientTotal: recipientTotal.toString(), reason: "big-claim brake" },
      });
      await client.query("COMMIT");
      return { claimId: claim.claim_id, status: "pending_review", assetKey: asset.asset_key, claimant: claim.claimant, settlement, idempotentReplay: false };
    }

    // Won: asset available -> claiming (dispatch intent recorded; M4 dispenses).
    await client.query("UPDATE assets SET status = 'claiming', updated_at = now() WHERE asset_key = $1", [asset.asset_key]);
    await client.query(
      `UPDATE claims SET status='verified', user_signature=$2, salt_length=$3, settlement=$4,
         verified_at=now(), error=NULL, updated_at=now() WHERE claim_id=$1`,
      [claim.claim_id, sig, saltLength, settlement],
    );
    await appendAudit(client, {
      event: "claim.verified", claimId: claim.claim_id, assetKey: asset.asset_key,
      claimant: claim.claimant, recipientId: asset.recipient_id, protocol: recipient.protocol,
      status: "verified",
      detail: { assetType: asset.asset_type, amount: amount.toString(), settlement },
    });
    await client.query("COMMIT");
    return { claimId: claim.claim_id, status: "verified", assetKey: asset.asset_key, claimant: claim.claimant, settlement, idempotentReplay: false };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    // Backstop: a concurrent winner tripped the one-live-claim unique index.
    if ((e as { code?: string }).code === "23505") {
      throw new ApiError(409, "ALREADY_CLAIMED", "asset has already been claimed");
    }
    throw e;
  } finally {
    client.release();
  }
}

/** GET /v1/claims/{claimId}. */
export async function getClaim(pool: Pool, claimId: string): Promise<ClaimStatusView> {
  const r = await pool.query<ClaimRow>("SELECT * FROM claims WHERE claim_id = $1", [claimId]);
  const c = r.rows[0];
  if (!c) throw new ApiError(404, "CLAIM_NOT_FOUND", "no such claim");
  return {
    claimId: c.claim_id,
    assetKey: c.asset_key,
    claimant: c.claimant,
    protocol: c.protocol === null ? null : protocolName(c.protocol),
    status: c.status,
    settlement: c.settlement,
    txSignatures: c.tx_signatures ?? [],
    error: c.error,
    createdAt: c.created_at.toISOString(),
    verifiedAt: c.verified_at ? c.verified_at.toISOString() : null,
    confirmedAt: c.confirmed_at ? c.confirmed_at.toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------
async function loadAsset(client: PoolClient, assetKey: string, forUpdate = false): Promise<AssetRow | undefined> {
  const r = await client.query<AssetRow>(
    `SELECT asset_key, asset_type, ant_mint, amount, vault_end_ts, nonce, status, recipient_id
       FROM assets WHERE asset_key = $1${forUpdate ? " FOR UPDATE" : ""}`,
    [assetKey],
  );
  return r.rows[0];
}
async function loadRecipient(client: PoolClient, recipientId: string): Promise<RecipientRow | undefined> {
  const r = await client.query<RecipientRow>(
    "SELECT recipient_id, protocol, source_address, recipient_pubkey, status FROM recipients WHERE recipient_id = $1",
    [recipientId],
  );
  return r.rows[0];
}
async function sumRecipientAvailable(client: PoolClient, recipientId: string): Promise<bigint> {
  const r = await client.query<{ total: string | null }>(
    "SELECT COALESCE(SUM(amount), 0)::text AS total FROM assets WHERE recipient_id = $1 AND amount IS NOT NULL AND status IN ('available','claiming','claimed','pending_review')",
    [recipientId],
  );
  return BigInt(r.rows[0].total ?? "0");
}

async function rejectClaim(client: PoolClient, claim: ClaimRow, code: string, reason: string): Promise<void> {
  await client.query("UPDATE claims SET status='rejected', error=$2, updated_at=now() WHERE claim_id=$1", [claim.claim_id, code]);
  await appendAudit(client, {
    event: "claim.rejected", claimId: claim.claim_id, assetKey: claim.asset_key,
    claimant: claim.claimant, recipientId: claim.recipient_id ?? undefined,
    protocol: claim.protocol ?? undefined, status: "rejected", reason: `${code}: ${reason}`,
  });
}

/**
 * Provisional vault settlement (M4 recomputes live from ArioConfig at dispatch,
 * incl. the max-duration bound). M3 only needs the coarse liquid-vs-relock hint
 * for the audit trail / operator view, so it reuses the deposit-time
 * `vaultEscrowFallsBackToLiquid` predicate plus an expiry check — no live
 * min/max read required. Returns null for non-vault assets.
 */
function computeSettlement(asset: AssetRow): string | null {
  if (asset.asset_type !== "vault" || asset.vault_end_ts === null || asset.amount === null) return null;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const remaining = BigInt(asset.vault_end_ts) - nowSec;
  if (remaining <= 0n || vaultEscrowFallsBackToLiquid(BigInt(asset.amount), remaining)) return "liquid";
  return "relock";
}

/**
 * Translate an API proof body into the M2 `ClaimProof`.
 *
 * `echoedNonceHex` is the client's OPTIONAL nonce echo. When present it is
 * threaded into `proof.nonce` so the M2 verifier compares it against the
 * asset's (challenge) nonce — a mismatch is `NONCE_MISMATCH`. The canonical
 * binding is enforced regardless (the message is rebuilt from the challenge
 * nonce), so omitting the echo does not weaken replay defense.
 */
function buildProof(
  p: ProofInput,
  boundClaimant: string,
  recipientProtocol: number,
  echoedNonceHex?: string,
): ClaimProof {
  const proofProto = protocolNum(p.protocol);
  if (proofProto !== recipientProtocol) {
    throw new ApiError(422, "PROTOCOL_MISMATCH", `proof protocol ${p.protocol} != recipient protocol`);
  }
  let echoedNonce: Uint8Array | undefined;
  if (echoedNonceHex !== undefined) {
    const clean = echoedNonceHex.replace(/^0x/, "");
    if (clean.length !== 64 || !/^[0-9a-fA-F]+$/.test(clean)) {
      throw new ApiError(422, "INVALID_FIELD_VALUE", "nonceHex must be 32 bytes hex");
    }
    echoedNonce = new Uint8Array(Buffer.from(clean, "hex"));
  }
  const base = { claimant: boundClaimant, nonce: echoedNonce };

  if (p.protocol === "arweave") {
    if (typeof p.rsaSignatureBase64Url !== "string") {
      throw new ApiError(400, "INVALID_REQUEST", "rsaSignatureBase64Url required");
    }
    const signature = Buffer.from(p.rsaSignatureBase64Url, "base64url");
    if (signature.length !== RSA_SIG_LEN) {
      throw new ApiError(422, "INVALID_FIELD_VALUE", `rsa signature must be ${RSA_SIG_LEN} bytes`);
    }
    const saltLength = p.saltLength ?? 32;
    const providedModulus = p.rsaModulusBase64Url
      ? new Uint8Array(Buffer.from(p.rsaModulusBase64Url, "base64url"))
      : undefined;
    return { ...base, signature: new Uint8Array(signature), saltLength, providedModulus };
  }

  // ethereum
  if (typeof p.signatureHex !== "string") {
    throw new ApiError(400, "INVALID_REQUEST", "signatureHex required");
  }
  const hex = p.signatureHex.replace(/^0x/, "");
  if (hex.length !== ETH_SIG_LEN * 2 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new ApiError(422, "INVALID_FIELD_VALUE", `eth signature must be ${ETH_SIG_LEN} bytes hex`);
  }
  return { ...base, signature: new Uint8Array(Buffer.from(hex, "hex")) };
}
