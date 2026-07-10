//! On-chain instruction builders for the dispatch worker (M4) — **`@solana/kit`
//! native, no `@solana/web3.js`** (BUILD.md non-negotiable).
//!
//! These reproduce the byte-level wire format of the reference transfer logic in
//! `solana-ar-io/migration/import/src/claim-transfers.ts` (which is web3.js) and
//! the on-chain `ario-ant-escrow` `claim_*` semantics, but emit kit `IInstruction`
//! objects instead. Three dispense primitives + a memo:
//!   * SPL token: createIdempotent ATA + plain Transfer (token / vault-liquid).
//!   * MPL Core:  TransferV1 (Owner) + UpdateV1 (UpdateAuthority) — atomic ANT
//!     hand-off (ADR-013), mirroring claim-transfers.ts::transferNft.
//!   * ario-core: vaulted_transfer — treasury-signed vault RE-LOCK for an
//!     active-vault settlement (ADR-027). Builder is byte-correct; see the note.
//!   * Memo:      `ar.io-claim:<claimId>` for on-chain traceability (§4.3).

import { sha256 } from "@noble/hashes/sha2";
import {
  AccountRole,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU64Encoder,
  type Address,
  type IInstruction,
} from "@solana/kit";

// --- Program IDs (mainnet == the addresses the frozen inputs target) --------
export const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address;
export const MPL_CORE_PROGRAM = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d" as Address;
export const MEMO_PROGRAM = "MemoSq4gq4qMz6H4dS7YEG2KDsF7hCkQqRr5dW5CtBc" as Address;

const addressEncoder = getAddressEncoder();
const u64 = getU64Encoder();

function encodeAddress(a: Address): Uint8Array {
  return new Uint8Array(addressEncoder.encode(a));
}

/** Anchor 8-byte instruction discriminator: sha256("global:<name>")[..8]. */
export function anchorDiscriminator(name: string): Uint8Array {
  return sha256(new TextEncoder().encode(`global:${name}`)).subarray(0, 8);
}

// ---------------------------------------------------------------------------
// SPL Token
// ---------------------------------------------------------------------------
/** Derive the associated token account for (owner, mint) under the SPL token program. */
export async function getAssociatedTokenAddress(owner: Address, mint: Address): Promise<Address> {
  const [ata] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    seeds: [encodeAddress(owner), encodeAddress(TOKEN_PROGRAM), encodeAddress(mint)],
  });
  return ata;
}

/**
 * createIdempotent (ATA program ix 1) — creates the recipient ATA, or is a no-op
 * if it already exists. Idempotent by construction, so re-running a dispatch
 * never fails on "account exists" (mirrors claim-transfers.ts's ATA-exists guard,
 * but race-free at the program level).
 */
export function createAtaIdempotentIx(args: {
  payer: Address;
  ata: Address;
  owner: Address;
  mint: Address;
}): IInstruction {
  return {
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    accounts: [
      { address: args.payer, role: AccountRole.WRITABLE_SIGNER },
      { address: args.ata, role: AccountRole.WRITABLE },
      { address: args.owner, role: AccountRole.READONLY },
      { address: args.mint, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
    ],
    data: new Uint8Array([1]), // 1 = CreateIdempotent
  };
}

/**
 * SPL Token Transfer (ix 3): move `amount` mARIO from `source` to `destination`,
 * signed by `authority`. Plain Transfer matches the on-chain `token::transfer`
 * the escrow used. `amount` is u64 mARIO (bigint).
 */
export function transferTokensIx(args: {
  source: Address;
  destination: Address;
  authority: Address;
  amount: bigint;
}): IInstruction {
  if (args.amount < 0n || args.amount > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`transfer amount out of u64 range: ${args.amount}`);
  }
  const data = new Uint8Array(1 + 8);
  data[0] = 3; // Transfer
  data.set(u64.encode(args.amount), 1);
  return {
    programAddress: TOKEN_PROGRAM,
    accounts: [
      { address: args.source, role: AccountRole.WRITABLE },
      { address: args.destination, role: AccountRole.WRITABLE },
      { address: args.authority, role: AccountRole.READONLY_SIGNER },
    ],
    data,
  };
}

// ---------------------------------------------------------------------------
// MPL Core — ANT (Metaplex Core NFT) transfer, Owner + UpdateAuthority.
// ---------------------------------------------------------------------------
/**
 * TransferV1 (disc 14) — change the ANT asset's Owner to `newOwner`. Account
 * layout + data (`[14, 0]` = disc + compressionProof None) mirror
 * claim-transfers.ts::transferNft. `payer` and `authority` (current owner) are
 * the ANT custody signer.
 */
export function mplCoreTransferV1Ix(args: {
  asset: Address;
  payer: Address; // ANT custody signer (also authority)
  authority: Address; // current owner == payer
  newOwner: Address;
}): IInstruction {
  return {
    programAddress: MPL_CORE_PROGRAM,
    accounts: [
      { address: args.asset, role: AccountRole.WRITABLE }, // asset
      { address: MPL_CORE_PROGRAM, role: AccountRole.READONLY }, // collection (none)
      { address: args.payer, role: AccountRole.WRITABLE_SIGNER }, // payer
      { address: args.authority, role: AccountRole.READONLY_SIGNER }, // authority (owner)
      { address: args.newOwner, role: AccountRole.READONLY }, // new owner
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY }, // system program
      { address: MPL_CORE_PROGRAM, role: AccountRole.READONLY }, // log wrapper (none)
    ],
    data: new Uint8Array([14, 0]),
  };
}

/**
 * UpdateV1 (disc 15) — move the ANT's UpdateAuthority to `newAuthority`. Data:
 * `[15, 0(newName None), 0(newUri None), 1(newUA Some), 1(Address variant),
 * <newAuthority 32B>]`. Bundled after TransferV1 so Owner + UA move atomically
 * (ADR-013), mirroring claim-transfers.ts::transferNft.
 */
export function mplCoreUpdateAuthorityIx(args: {
  asset: Address;
  payer: Address;
  authority: Address; // current UA == payer (the custody signer)
  newAuthority: Address;
}): IInstruction {
  const data = new Uint8Array([
    15, // UpdateV1
    0, // newName: Option = None
    0, // newUri: Option = None
    1, // newUpdateAuthority: Option = Some
    1, // BaseUpdateAuthority: Address
    ...encodeAddress(args.newAuthority),
  ]);
  return {
    programAddress: MPL_CORE_PROGRAM,
    accounts: [
      { address: args.asset, role: AccountRole.WRITABLE }, // asset
      { address: MPL_CORE_PROGRAM, role: AccountRole.READONLY }, // collection (none)
      { address: args.payer, role: AccountRole.WRITABLE_SIGNER }, // payer
      { address: args.authority, role: AccountRole.READONLY_SIGNER }, // authority (UA)
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY }, // system program
      { address: MPL_CORE_PROGRAM, role: AccountRole.READONLY }, // log wrapper (none)
    ],
    data,
  };
}

// ---------------------------------------------------------------------------
// ario-core vaulted_transfer — treasury-signed vault RE-LOCK (ADR-027).
// ---------------------------------------------------------------------------
export const CONFIG_SEED = new TextEncoder().encode("config");
export const VAULT_COUNTER_SEED = new TextEncoder().encode("vault_counter");
export const VAULT_SEED = new TextEncoder().encode("vault");

/** Derive ario-core singleton ArioConfig PDA. */
export async function deriveArioConfig(arioCoreProgram: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: arioCoreProgram, seeds: [CONFIG_SEED] });
  return pda;
}
/** Derive a recipient's VaultCounter PDA. */
export async function deriveVaultCounter(arioCoreProgram: Address, recipient: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: arioCoreProgram,
    seeds: [VAULT_COUNTER_SEED, encodeAddress(recipient)],
  });
  return pda;
}
/** Derive the vault PDA for (recipient, nextId). nextId is u64 LE. */
export async function deriveVault(arioCoreProgram: Address, recipient: Address, nextId: bigint): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: arioCoreProgram,
    seeds: [VAULT_SEED, encodeAddress(recipient), u64.encode(nextId)],
  });
  return pda;
}

/** Encode the vaulted_transfer instruction data: disc || amount(u64) || lock(i64) || revocable(bool). */
export function encodeVaultedTransferData(amount: bigint, lockDurationSeconds: bigint, revocable: boolean): Uint8Array {
  if (amount <= 0n || amount > 0xffff_ffff_ffff_ffffn) throw new Error(`vault amount out of range: ${amount}`);
  const disc = anchorDiscriminator("vaulted_transfer");
  const out = new Uint8Array(8 + 8 + 8 + 1);
  out.set(disc, 0);
  out.set(u64.encode(amount), 8);
  // i64 LE — lock duration is always positive here (remaining seconds).
  const view = new DataView(out.buffer);
  view.setBigInt64(16, lockDurationSeconds, true);
  out[24] = revocable ? 1 : 0;
  return out;
}

/**
 * Build the ario-core `vaulted_transfer` instruction (vault RE-LOCK settlement).
 * The sender (hot token dispenser, which also holds the float) funds a fresh
 * non-revocable vault for `recipient` with `lockDurationSeconds` remaining.
 *
 * NOTE (residual — see SPEC.md): the account list is derived from the deployed
 * `VaultedTransfer` struct, and the data encoding is unit-tested, but this path
 * is NOT exercised on localnet in M4 (a live re-lock needs the deployed ario-core
 * program + genesis ArioConfig + a pre-provisioned vault ATA owned by the yet-to-
 * exist vault PDA). The live M4 proof covers the vault-LIQUID settlement (an SPL
 * transfer). Caller must pass a `vaultTokenAccount` created for the derived
 * `vault` PDA before invoking.
 */
export function vaultedTransferIx(args: {
  arioCoreProgram: Address;
  config: Address;
  recipientVaultCounter: Address;
  vault: Address;
  senderTokenAccount: Address;
  vaultTokenAccount: Address;
  recipient: Address;
  sender: Address; // hot dispenser (payer + authority)
  amount: bigint;
  lockDurationSeconds: bigint;
}): IInstruction {
  return {
    programAddress: args.arioCoreProgram,
    accounts: [
      { address: args.config, role: AccountRole.WRITABLE },
      { address: args.recipientVaultCounter, role: AccountRole.WRITABLE },
      { address: args.vault, role: AccountRole.WRITABLE },
      { address: args.senderTokenAccount, role: AccountRole.WRITABLE },
      { address: args.vaultTokenAccount, role: AccountRole.WRITABLE },
      { address: args.recipient, role: AccountRole.READONLY },
      { address: args.sender, role: AccountRole.WRITABLE_SIGNER },
      { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ],
    data: encodeVaultedTransferData(args.amount, args.lockDurationSeconds, false),
  };
}

// ---------------------------------------------------------------------------
// Memo — on-chain claim traceability.
// ---------------------------------------------------------------------------
/** SPL Memo ix carrying `ar.io-claim:<claimId>` (§4.3 dispatch traceability). */
export function claimMemoIx(claimId: string): IInstruction {
  return {
    programAddress: MEMO_PROGRAM,
    accounts: [],
    data: new TextEncoder().encode(`ar.io-claim:${claimId}`),
  };
}
