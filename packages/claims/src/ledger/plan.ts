//! The ledger planner — reproduces batch-escrow's recipient->asset derivation
//! EXACTLY (bit-for-bit) as a pure function of the frozen inputs.
//!
//! This mirrors `solana-ar-io/migration/import/src/batch-escrow.ts` in FROZEN
//! mode (`escrow-recipient-modulus.json` present): the four deposit phases,
//! the unmapped filter, the AO self-balance exclusion, the frozen-recipient
//! resolvability skip, the vault expired->token and sub-min/short->liquid
//! fallbacks, and the stake/withdrawal routing. Output is the set of would-be
//! on-chain deposits (the "available" claimable set) PLUS the AT-RISK owners'
//! assets flagged `manual_review` (never deposited on-chain; operator-queue
//! only). The independent reconciler re-derives the same set from the
//! authoritative solana-ar-io code and diffs — see src/reconcile/.
//!
//! Time dependence: the vault/stake liquid-vs-vault split depends on "now"
//! (lock_duration = unlock - now). The build PINS `nowMs` so the ledger is
//! deterministic and the reconciler uses the same pin. Default 2026-07-10
//! 00:00:00Z reproduces the frozen dry-run gate (2269/5374/111/2957).

import { deriveRecipientIdB64Url } from "@ar.io/attestor-canonical";
import { deriveAntMintBase58 } from "./ant-mint.js";
import {
  deriveStakeAssetId,
  deriveTokenAssetId,
  deriveVaultAssetId,
  toHex,
} from "./asset-id.js";
import type { FrozenInputs } from "./inputs.js";
import { isEthereumAddress, normalizeSourceAddress } from "./normalize.js";
import {
  collectStakeWithdrawalEscrow,
  assertUniqueAssetSeeds,
} from "./stake-extract.js";
import type {
  LedgerPlan,
  PlannedAsset,
  PlannedRecipient,
  Protocol,
} from "./types.js";
import { MIN_VAULT_LOCK_SECONDS, MIN_VAULT_SIZE_MARIO, vaultEscrowFallsBackToLiquid } from "./vault-rules.js";

/** 2026-07-10T00:00:00.000Z — pinned reference reproducing the frozen gate. */
export const DEFAULT_NOW_MS = 1783641600000;

/** base64url -> raw bytes. */
function base64urlToBytes(b64url: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64url, "base64url"));
}

/** ETH 20-byte address from a normalized `0x…` string. */
function ethAddressBytes(normalized: string): Uint8Array {
  return new Uint8Array(Buffer.from(normalized.slice(2), "hex"));
}

interface PlanOptions {
  antMintSecret: Uint8Array;
  nowMs?: number;
}

/**
 * Resolve an owner to its recipient pubkey bytes in FROZEN mode:
 *   - ETH owner  -> 20-byte address (deterministic, no modulus needed)
 *   - AR in the frozen modulus set -> 512-byte RSA modulus
 *   - otherwise (AT-RISK / no recoverable key) -> null (batch-escrow skips it)
 */
function resolveRecipientPubkey(
  owner: string,
  inputs: FrozenInputs,
): Uint8Array | null {
  if (isEthereumAddress(owner)) {
    return ethAddressBytes(normalizeSourceAddress(owner));
  }
  const modB64 = inputs.modulus[owner];
  if (modB64) {
    const bytes = base64urlToBytes(modB64);
    if (bytes.length !== 512) {
      throw new Error(
        `frozen modulus for ${owner} is ${bytes.length} bytes, expected 512`,
      );
    }
    return bytes;
  }
  return null;
}

export function buildLedgerPlan(inputs: FrozenInputs, opts: PlanOptions): LedgerPlan {
  const nowMs = opts.nowMs ?? DEFAULT_NOW_MS;
  const nowS = Math.floor(nowMs / 1000);
  const { addressMap } = inputs;

  // ---- Recipients ----------------------------------------------------------
  const recipients = new Map<string, PlannedRecipient>();

  const upsertRecipient = (
    owner: string,
    pubkey: Uint8Array | null,
  ): void => {
    const src = normalizeSourceAddress(owner);
    if (recipients.has(src)) return;
    const eth = isEthereumAddress(owner);
    const protocol: Protocol = eth ? 1 : 0;
    if (pubkey) {
      const recipientId = deriveRecipientIdB64Url(pubkey);
      // Invariant: for Arweave, recipient_id (= b64url(sha256(modulus))) IS the
      // Arweave address. A mismatch means a corrupt / substituted modulus.
      if (!eth && recipientId !== owner) {
        throw new Error(
          `modulus->address mismatch for ${owner}: derived recipient_id ${recipientId}`,
        );
      }
      recipients.set(src, {
        sourceAddress: src,
        protocol,
        recipientPubkey: pubkey,
        recipientId,
        status: "open",
      });
    } else {
      // AT-RISK / manual_review: no published key. recipient_id = source addr.
      recipients.set(src, {
        sourceAddress: src,
        protocol,
        recipientPubkey: null,
        recipientId: src,
        status: "manual_review",
      });
    }
  };

  // Load ALL frozen moduli as recipients (open), per plan section 3.2 step 1.
  for (const [addr, modB64] of Object.entries(inputs.modulus)) {
    upsertRecipient(addr, base64urlToBytes(modB64));
  }
  // Load ALL AT-RISK owners as manual_review recipients (no key).
  for (const addr of inputs.atRisk) {
    upsertRecipient(addr, null);
  }

  // ---- Assets --------------------------------------------------------------
  const assets: PlannedAsset[] = [];
  const seenKeys = new Set<string>();
  const counters = { ant: 0, tokenEscrowed: 0, vaultEscrowed: 0, stakeEscrowed: 0 };
  let phase2TokenOutflowMario = 0n;

  const pushAsset = (a: PlannedAsset): void => {
    if (seenKeys.has(a.assetKey)) {
      throw new Error(
        `duplicate asset_key ${a.assetKey} (${a.assetType}) — on-chain PDA would alias`,
      );
    }
    seenKeys.add(a.assetKey);
    assets.push(a);
  };

  // Route an owner's would-be deposit: resolvable -> available (ETH recipient
  // is materialized here), unresolvable unmapped owner -> manual_review. Any
  // unresolvable owner MUST be in the AT-RISK file (else it's an unexpected
  // gap and we fail loudly).
  const classifyOwner = (
    owner: string,
  ): { status: "available" | "manual_review"; pubkey: Uint8Array | null } => {
    const pubkey = resolveRecipientPubkey(owner, inputs);
    if (pubkey) {
      // Ensure the recipient exists (ETH owners aren't in the modulus file).
      upsertRecipient(owner, pubkey);
      return { status: "available", pubkey };
    }
    if (!inputs.atRisk.has(owner)) {
      throw new Error(
        `unmapped owner ${JSON.stringify(owner)} is unresolvable but NOT in the ` +
          `AT-RISK file — unexpected gap; refusing to build an inconsistent ledger.`,
      );
    }
    upsertRecipient(owner, null);
    return { status: "manual_review", pubkey: null };
  };

  // Phase 1: ANTs (unmapped only).
  for (const ant of inputs.ants) {
    if (addressMap[ant.Owner]) continue; // mapped -> minted directly, not escrowed
    const antMint = deriveAntMintBase58(ant.processId, opts.antMintSecret);
    const { status } = classifyOwner(ant.Owner);
    pushAsset({
      assetKey: antMint,
      assetType: "ant",
      recipientSource: normalizeSourceAddress(ant.Owner),
      antMint,
      amount: null,
      vaultEndTs: null,
      status,
      source: { phase: "ant", aoProcessId: ant.processId, onchainSeed: "escrow_ant" },
    });
    if (status === "available") counters.ant++;
  }

  // Phase 2: token balances (unmapped, positive; AO self-balance already removed).
  for (const [addr, amount] of Object.entries(inputs.balances)) {
    if (addressMap[addr] || amount <= 0) continue;
    const { status } = classifyOwner(addr);
    const amt = BigInt(amount);
    pushAsset({
      assetKey: toHex(deriveTokenAssetId(addr)),
      assetType: "token",
      recipientSource: normalizeSourceAddress(addr),
      antMint: null,
      amount: amt,
      vaultEndTs: null,
      status,
      source: { phase: "token", arweaveAddress: addr, onchainSeed: "escrow_token" },
    });
    if (status === "available") {
      counters.tokenEscrowed++;
      phase2TokenOutflowMario += amt;
    }
  }

  // Phase 3: personal vaults (unmapped owners).
  for (const [owner, ownerVaults] of Object.entries(inputs.vaults)) {
    if (addressMap[owner]) continue;
    for (const [vaultId, v] of Object.entries(ownerVaults)) {
      const amount = BigInt(v.balance);
      if (amount <= 0n) continue;
      const { status } = classifyOwner(owner);
      const assetKey = toHex(deriveVaultAssetId(owner, vaultId));
      const src = normalizeSourceAddress(owner);
      const isExpired = v.endTimestamp <= nowMs;
      if (isExpired) {
        // Expired -> liquid token escrow (escrow_token seed). Counts as token.
        pushAsset({
          assetKey,
          assetType: "token",
          recipientSource: src,
          antMint: null,
          amount,
          vaultEndTs: null,
          status,
          source: {
            phase: "vault",
            arweaveAddress: owner,
            vaultId,
            planKind: "expired->token",
            onchainSeed: "escrow_token",
          },
        });
        if (status === "available") counters.tokenEscrowed++;
        continue;
      }
      const lockDurationSeconds = BigInt(Math.ceil((v.endTimestamp - nowMs) / 1000));
      const fallbackLiquid = vaultEscrowFallsBackToLiquid(amount, lockDurationSeconds);
      if (fallbackLiquid) {
        pushAsset({
          assetKey,
          assetType: "token",
          recipientSource: src,
          antMint: null,
          amount,
          vaultEndTs: null,
          status,
          source: {
            phase: "vault",
            arweaveAddress: owner,
            vaultId,
            planKind: "active-fallback-liquid",
            onchainSeed: "escrow_token",
          },
        });
      } else {
        pushAsset({
          assetKey,
          assetType: "vault",
          recipientSource: src,
          antMint: null,
          amount,
          vaultEndTs: nowS + Number(lockDurationSeconds),
          status,
          source: {
            phase: "vault",
            arweaveAddress: owner,
            vaultId,
            planKind: "vault",
            onchainSeed: "escrow_vault",
          },
        });
      }
      // Manifest "vaultEscrowed" counts every active unmapped vault regardless
      // of whether it routed to vault or liquid-fallback.
      if (status === "available") counters.vaultEscrowed++;
    }
  }

  // Phase 4: stake + withdrawal escrow (plan-driven).
  const stakeSet = collectStakeWithdrawalEscrow(inputs.plan);
  assertUniqueAssetSeeds(stakeSet);

  for (const v of stakeSet.vaults) {
    const { status } = classifyOwner(v.arweaveAddr);
    const assetKey = toHex(deriveStakeAssetId(v.assetIdSeed));
    const src = normalizeSourceAddress(v.arweaveAddr);
    let lockDuration = BigInt(v.unlockTs - nowS);
    const isLockedOperatorExit =
      v.kind.startsWith("withdrawal:operator-exit:") &&
      v.amountMario >= MIN_VAULT_SIZE_MARIO &&
      lockDuration > 0n;
    if (isLockedOperatorExit && lockDuration < BigInt(MIN_VAULT_LOCK_SECONDS)) {
      lockDuration = BigInt(MIN_VAULT_LOCK_SECONDS);
    }
    const fallbackLiquid = vaultEscrowFallsBackToLiquid(v.amountMario, lockDuration);
    if (fallbackLiquid) {
      pushAsset({
        assetKey,
        assetType: "token",
        recipientSource: src,
        antMint: null,
        amount: v.amountMario,
        vaultEndTs: null,
        status,
        source: {
          phase: "stake",
          arweaveAddress: v.arweaveAddr,
          planKind: `${v.kind}-fallback-liquid`,
          onchainSeed: "escrow_token",
        },
      });
    } else {
      pushAsset({
        assetKey,
        assetType: "vault",
        recipientSource: src,
        antMint: null,
        amount: v.amountMario,
        vaultEndTs: nowS + Number(lockDuration),
        status,
        source: {
          phase: "stake",
          arweaveAddress: v.arweaveAddr,
          planKind: v.kind,
          onchainSeed: "escrow_vault",
        },
      });
    }
    if (status === "available") counters.stakeEscrowed++;
  }

  for (const l of stakeSet.liquid) {
    const { status } = classifyOwner(l.arweaveAddr);
    pushAsset({
      assetKey: toHex(deriveStakeAssetId(l.assetIdSeed)),
      assetType: "token",
      recipientSource: normalizeSourceAddress(l.arweaveAddr),
      antMint: null,
      amount: l.amountMario,
      vaultEndTs: null,
      status,
      source: {
        phase: "stake",
        arweaveAddress: l.arweaveAddr,
        planKind: `${l.kind}-liquid`,
        onchainSeed: "escrow_token",
      },
    });
    if (status === "available") counters.stakeEscrowed++;
  }

  const atRiskRecipientCount = [...recipients.values()].filter(
    (r) => r.status === "manual_review",
  ).length;

  return {
    recipients: [...recipients.values()],
    assets,
    counters,
    phase2TokenOutflowMario,
    atRiskRecipientCount,
    inputFingerprints: inputs.fingerprints,
    nowMs,
  };
}
