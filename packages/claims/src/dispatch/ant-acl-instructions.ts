//! `ario-ant` ACL / ownership-reconcile instruction builders — **`@solana/kit`
//! native, no `@solana/web3.js`** (BUILD.md non-negotiable), byte-pinned to the
//! deployed `ario-ant` program (`ar-io/ar-io-solana-contracts`).
//!
//! WHY THIS EXISTS: our ANT dispatch hands the claimant the Metaplex Core asset
//! via a RAW `TransferV1 + UpdateV1` (see `instructions.ts`). That moves the
//! *asset* but bypasses the `ario-ant` program's on-chain ACL, leaving two
//! stale states that make arns.app still show the OLD owner:
//!   1. `AntConfig.last_known_owner` + `AntControllers`  → healed by `reconcile`.
//!   2. per-user ACL reverse index (`AclConfig`/`AclPage`) → healed by
//!      `remove_acl_owner(old)` + `record_acl_owner(new)`.
//! Every instruction here is PERMISSIONLESS — the only signer is the fee-paying
//! `payer`/`caller` (our treasury); the on-chain handler verifies the ANT's live
//! MPL Core owner as ground truth (`acl.rs`, `lib.rs::reconcile`). So the
//! operator can heal any ANT without the claimant's signature.
//!
//! Sources (all `programs/ario-ant/src`): `acl.rs` (RecordAclOwner /
//! RegisterAclConfig / AddAclPage account structs + handlers), `lib.rs`
//! (`reconcile` @1110, `Reconcile` struct @2524, `read_mpl_core_owner` @1888),
//! `state.rs` (seed consts + AclConfig/AclPage/AntControllers layouts).

import {
  AccountRole,
  getAddressEncoder,
  getAddressDecoder,
  getProgramDerivedAddress,
  getU64Encoder,
  getU32Decoder,
  getU64Decoder,
  type Address,
  type IInstruction,
} from "@solana/kit";
import { anchorDiscriminator } from "./instructions.js";

// --- ario-ant program IDs (from ar-io-sdk src/solana/clusters.ts) -----------
export const ARIO_ANT_PROGRAM_MAINNET = "2MWexMHfMhGJwMHv9Qm9YAVCqjUFUJwDJAysW4oCUGk5" as Address;
export const ARIO_ANT_PROGRAM_DEVNET = "DbHbRwUD1oAn1mrDSqtWtvwGcNrmhWdD2g8L4xmeQ7NX" as Address;

// --- PDA seeds (state.rs) ----------------------------------------------------
const ANT_CONFIG_SEED = new TextEncoder().encode("ant_config");
const ANT_CONTROLLERS_SEED = new TextEncoder().encode("ant_controllers");
const ACL_CONFIG_SEED = new TextEncoder().encode("acl_config");
const ACL_PAGE_SEED = new TextEncoder().encode("acl_page");

export const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;
/** Per-page entry cap (state.rs `MAX_ACL_PAGE_ENTRIES`). */
export const MAX_ACL_PAGE_ENTRIES = 256;

const addressEncoder = getAddressEncoder();
const addressDecoder = getAddressDecoder();
const u32 = getU32Decoder();
const u64e = getU64Encoder();
const u64d = getU64Decoder();

function encAddr(a: Address): Uint8Array {
  return new Uint8Array(addressEncoder.encode(a));
}
function u64le(n: bigint): Uint8Array {
  return new Uint8Array(u64e.encode(n));
}

// ---------------------------------------------------------------------------
// PDA derivations (all under the ario-ant program)
// ---------------------------------------------------------------------------
export async function deriveAntConfigPda(antProgram: Address, mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: antProgram, seeds: [ANT_CONFIG_SEED, encAddr(mint)] });
  return pda;
}
export async function deriveAntControllersPda(antProgram: Address, mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: antProgram, seeds: [ANT_CONTROLLERS_SEED, encAddr(mint)] });
  return pda;
}
export async function deriveAclConfigPda(antProgram: Address, user: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: antProgram, seeds: [ACL_CONFIG_SEED, encAddr(user)] });
  return pda;
}
export async function deriveAclPagePda(antProgram: Address, user: Address, pageIdx: bigint): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: antProgram,
    seeds: [ACL_PAGE_SEED, encAddr(user), u64le(pageIdx)],
  });
  return pda;
}

// ---------------------------------------------------------------------------
// Instruction builders
// ---------------------------------------------------------------------------

/**
 * `reconcile` — clears `AntControllers` and sets `AntConfig.last_known_owner`
 * to the asset's live MPL Core owner (idempotent no-op if already current).
 * This is what makes arns.app show the correct Owner/Controllers. Permissionless
 * (`Reconcile` struct: caller is a non-mut Signer). Data = 8-byte disc only.
 */
export function arioAntReconcileIx(args: { antProgram: Address; asset: Address; antConfig: Address; antControllers: Address; caller: Address }): IInstruction {
  return {
    programAddress: args.antProgram,
    accounts: [
      { address: args.asset, role: AccountRole.READONLY },
      { address: args.antConfig, role: AccountRole.WRITABLE },
      { address: args.antControllers, role: AccountRole.WRITABLE },
      { address: args.caller, role: AccountRole.READONLY_SIGNER },
    ],
    data: anchorDiscriminator("reconcile"),
  };
}

/**
 * `record_acl_owner` — appends `(asset, Owner)` to the NEW owner's ACL page.
 * On-chain requires `asset.owner == acl_config.user` (so `user` MUST be the
 * live MPL owner / claimant). `aclConfig` + a non-full `aclPage` for `user`
 * must already exist (bootstrap via register/add below). Data = disc only.
 */
export function recordAclOwnerIx(args: {
  antProgram: Address; asset: Address; antConfig: Address; aclConfig: Address; aclPage: Address; payer: Address;
}): IInstruction {
  return {
    programAddress: args.antProgram,
    accounts: [
      { address: args.asset, role: AccountRole.READONLY },
      { address: args.antConfig, role: AccountRole.READONLY },
      { address: args.aclConfig, role: AccountRole.WRITABLE },
      { address: args.aclPage, role: AccountRole.WRITABLE },
      { address: args.payer, role: AccountRole.WRITABLE_SIGNER },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ],
    data: anchorDiscriminator("record_acl_owner"),
  };
}

/**
 * `remove_acl_owner` — swap-removes the OLD owner's `(asset, Owner)` entry.
 * On-chain requires `asset.owner != acl_config.user` (valid precisely because
 * the old owner no longer holds the asset). Same account shape as record
 * (both use the Rust `RecordAclOwner` context). `aclPage` must be the page
 * that CONTAINS the stale entry. Data = disc only.
 */
export function removeAclOwnerIx(args: {
  antProgram: Address; asset: Address; antConfig: Address; aclConfig: Address; aclPage: Address; payer: Address;
}): IInstruction {
  return {
    programAddress: args.antProgram,
    accounts: [
      { address: args.asset, role: AccountRole.READONLY },
      { address: args.antConfig, role: AccountRole.READONLY },
      { address: args.aclConfig, role: AccountRole.WRITABLE },
      { address: args.aclPage, role: AccountRole.WRITABLE },
      { address: args.payer, role: AccountRole.WRITABLE_SIGNER },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ],
    data: anchorDiscriminator("remove_acl_owner"),
  };
}

/**
 * `register_acl_config` — create the `AclConfig` head for `user` (permissionless;
 * anyone pays rent). Data = disc || user(32). Needed once per user before their
 * first `add_acl_page` / `record_acl_owner`.
 */
export function registerAclConfigIx(args: { antProgram: Address; user: Address; aclConfig: Address; payer: Address }): IInstruction {
  const disc = anchorDiscriminator("register_acl_config");
  const data = new Uint8Array(disc.length + 32);
  data.set(disc, 0);
  data.set(encAddr(args.user), disc.length);
  return {
    programAddress: args.antProgram,
    accounts: [
      { address: args.aclConfig, role: AccountRole.WRITABLE },
      { address: args.payer, role: AccountRole.WRITABLE_SIGNER },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ],
    data,
  };
}

/**
 * `add_acl_page` — allocate the next page (`page_idx == page_count`) for `user`.
 * The page PDA is seeded by the CURRENT `page_count`, so callers must pass the
 * page derived from `aclConfig.page_count` and send these serially per user.
 * Data = disc only.
 */
export function addAclPageIx(args: { antProgram: Address; aclConfig: Address; aclPage: Address; payer: Address }): IInstruction {
  return {
    programAddress: args.antProgram,
    accounts: [
      { address: args.aclConfig, role: AccountRole.WRITABLE },
      { address: args.aclPage, role: AccountRole.WRITABLE },
      { address: args.payer, role: AccountRole.WRITABLE_SIGNER },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ],
    data: anchorDiscriminator("add_acl_page"),
  };
}

// ---------------------------------------------------------------------------
// Account decoders (Anchor: 8-byte disc prefix + borsh). Only the fields we
// need for planning + before/after verification.
// ---------------------------------------------------------------------------

/** MPL Core AssetV1 owner (key byte == 1, owner = bytes[1..33]). Matches `read_mpl_core_owner`. */
export function decodeMplCoreOwner(data: Uint8Array): Address | null {
  if (data.length < 33 || data[0] !== 1) return null;
  return addressDecoder.decode(data.subarray(1, 33));
}

/** `AclConfig` head: disc(8) user(32) page_count(u64@40) total_entries(u64@48). */
export function decodeAclConfig(data: Uint8Array): { user: Address; pageCount: bigint; totalEntries: bigint } {
  return {
    user: addressDecoder.decode(data.subarray(8, 40)),
    pageCount: u64d.decode(data.subarray(40, 48)),
    totalEntries: u64d.decode(data.subarray(48, 56)),
  };
}

/** `AclPage` entries: disc(8) user(32) page_idx(u64@40) entries: Vec<AclEntry{asset(32),role(1)}> @48. */
export function decodeAclPageEntries(data: Uint8Array): Array<{ asset: Address; role: number }> {
  const len = u32.decode(data.subarray(48, 52));
  const out: Array<{ asset: Address; role: number }> = [];
  let off = 52;
  for (let i = 0; i < len; i++) {
    out.push({ asset: addressDecoder.decode(data.subarray(off, off + 32)), role: data[off + 32] });
    off += 33;
  }
  return out;
}

/** `AntControllers.controllers`: disc(8) mint(32) controllers: Vec<Pubkey> @40. */
export function decodeAntControllers(data: Uint8Array): Address[] {
  const len = u32.decode(data.subarray(40, 44));
  const out: Address[] = [];
  let off = 44;
  for (let i = 0; i < len; i++) {
    out.push(addressDecoder.decode(data.subarray(off, off + 32)));
    off += 32;
  }
  return out;
}

/**
 * `AntConfig.last_known_owner` — set by `reconcile`. It sits behind four borsh
 * `String`s (name/ticker/logo/description) + a `Vec<String>` (keywords), so we
 * must walk them (state.rs `AntConfig`). Used only to decide whether `reconcile`
 * still has work to do (idempotency), never the money path.
 */
export function decodeAntConfigLastKnownOwner(data: Uint8Array): Address {
  let off = 8 + 32; // disc(8) + mint(32)
  const skipStr = () => {
    const len = u32.decode(data.subarray(off, off + 4));
    off += 4 + len;
  };
  skipStr(); // name
  skipStr(); // ticker
  skipStr(); // logo
  skipStr(); // description
  const kw = u32.decode(data.subarray(off, off + 4));
  off += 4;
  for (let i = 0; i < kw; i++) skipStr(); // keywords
  return addressDecoder.decode(data.subarray(off, off + 32));
}

export const ACL_ROLE_OWNER = 0;
export const ACL_ROLE_CONTROLLER = 1;
