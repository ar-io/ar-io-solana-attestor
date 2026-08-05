//! Vault RE-LOCK delivery — build the treasury-signed `ario-core::vaulted_transfer`
//! that hands a claimant a LOCKED Solana vault preserving their original unlock
//! date (ADR-027). Verified against the deployed `ario-core` program: the vault's
//! token account is NOT `init` in `VaultedTransfer`, so we must PRE-CREATE it
//! (owner = the vault PDA) in the same tx → a two-instruction delivery. The vault
//! PDA is seeded by the recipient's live `VaultCounter.next_id`, so we read it
//! first (0 if the counter doesn't exist yet).
//!
//! Faithful to how the on-chain escrow delivered locked vaults
//! (`ario-ant-escrow::claim_vault_common` → CPI `vaulted_transfer(amount,
//! remaining, revocable=false)`). The only difference is unavoidable: we compute
//! `remaining` off-chain at build time, so the new vault unlocks a few seconds
//! LATER than the original end (safe over-lock direction), never earlier.

import { getAddressDecoder, getU64Decoder, type Address, type IInstruction } from "@solana/kit";
import {
  deriveArioConfig,
  deriveVaultCounter,
  deriveVault,
  vaultedTransferIx,
  createAtaIdempotentIx,
  getAssociatedTokenAddress,
} from "./instructions.js";

const u64 = getU64Decoder();
const addrDec = getAddressDecoder();

/** `VaultCounter.next_id` — u64 LE @ offset 40 (disc(8)+owner(32)). Absent counter ⇒ 0. */
export function decodeVaultCounterNextId(data: Uint8Array | null): bigint {
  if (!data || data.length < 48) return 0n;
  return u64.decode(data.subarray(40, 48));
}

/** `Vault` (verify): disc(8) owner(32)@8 vault_id(u64)@40 amount(u64)@48 start(i64)@56 end(i64)@64. */
export function decodeVault(data: Uint8Array): { owner: Address; vaultId: bigint; amount: bigint; endTimestamp: bigint } {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    owner: addrDec.decode(data.subarray(8, 40)),
    vaultId: u64.decode(data.subarray(40, 48)),
    amount: u64.decode(data.subarray(48, 56)),
    endTimestamp: dv.getBigInt64(64, true),
  };
}

export interface VaultRelockArgs {
  /** Reads raw account data (base64-decoded) or null — e.g. gateway.getAccountData. */
  readAccount: (a: Address) => Promise<Uint8Array | null>;
  arioCoreProgram: Address;
  mint: Address;
  /** Hot dispenser — SPL transfer authority + rent payer + tx signer. */
  sender: Address;
  /** Vault recipient / owner. Must differ from `sender` (program rejects SelfTransfer). */
  claimant: Address;
  amount: bigint;
  lockDurationSeconds: bigint;
  memoIxs?: IInstruction[];
}

export interface VaultRelockBuild {
  ixs: IInstruction[];
  /** The derived vault PDA (for post-delivery verification). */
  vault: Address;
  vaultAta: Address;
  nextId: bigint;
}

/**
 * Build the two-ix (+memo) re-lock delivery for one claim:
 *   1. createIdempotent ATA owned by the vault PDA (the program requires it to exist),
 *   2. vaulted_transfer(amount, lockDurationSeconds, revocable=false) → locks it.
 * Reads the recipient's live `VaultCounter.next_id` to derive the vault PDA.
 */
export async function buildVaultRelockIxs(args: VaultRelockArgs): Promise<VaultRelockBuild> {
  const config = await deriveArioConfig(args.arioCoreProgram);
  const vaultCounter = await deriveVaultCounter(args.arioCoreProgram, args.claimant);
  const nextId = decodeVaultCounterNextId(await args.readAccount(vaultCounter));
  const vault = await deriveVault(args.arioCoreProgram, args.claimant, nextId);
  const vaultAta = await getAssociatedTokenAddress(vault, args.mint);
  const hotAta = await getAssociatedTokenAddress(args.sender, args.mint);
  const ixs: IInstruction[] = [
    createAtaIdempotentIx({ payer: args.sender, ata: vaultAta, owner: vault, mint: args.mint }),
    vaultedTransferIx({
      arioCoreProgram: args.arioCoreProgram,
      config,
      recipientVaultCounter: vaultCounter,
      vault,
      senderTokenAccount: hotAta,
      vaultTokenAccount: vaultAta,
      recipient: args.claimant,
      sender: args.sender,
      amount: args.amount,
      lockDurationSeconds: args.lockDurationSeconds,
    }),
    ...(args.memoIxs ?? []),
  ];
  return { ixs, vault, vaultAta, nextId };
}
