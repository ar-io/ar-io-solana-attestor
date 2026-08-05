//! ANT ACL heal — EXECUTOR (async reads + build/sign/simulate/apply/verify).
//!
//! Reads live on-chain state for one ANT, hands it to the pure `planAclHeal`,
//! then either SIMULATES (dry, commits nothing) or APPLIES (treasury-signs,
//! broadcasts, confirms) the resulting tx, and re-reads to VERIFY. Reuses the
//! worker's `SolanaChainGateway` for build/sign/broadcast/confirm so the
//! single-CONFIRM_RPC discipline and blockhash handling are identical.

import {
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  getBase64EncodedWireTransaction,
  type Address,
  type TransactionSigner,
} from "@solana/kit";
import type { SolanaRpc } from "../solana.js";
import type { SolanaChainGateway } from "./chain.js";
import {
  deriveAntConfigPda,
  deriveAntControllersPda,
  deriveAclConfigPda,
  deriveAclPagePda,
  decodeMplCoreOwner,
  decodeAntConfigLastKnownOwner,
  decodeAntControllers,
  decodeAclConfig,
  decodeAclPageEntries,
  MAX_ACL_PAGE_ENTRIES,
  ACL_ROLE_OWNER,
} from "./ant-acl-instructions.js";
import { planAclHeal, type AclHealSnapshot, type AclHealPlan, type PageRef } from "./ant-acl-reconcile.js";

async function getAcct(rpc: SolanaRpc, addr: Address): Promise<Uint8Array | null> {
  const res = await rpc.getAccountInfo(addr, { encoding: "base64" }).send();
  if (!res.value) return null;
  return new Uint8Array(Buffer.from(res.value.data[0], "base64"));
}

/** Batch-read accounts via getMultipleAccounts (chunked at 100) — gentle on the RPC. */
async function getMany(rpc: SolanaRpc, addrs: Address[]): Promise<Array<Uint8Array | null>> {
  const out: Array<Uint8Array | null> = [];
  for (let i = 0; i < addrs.length; i += 100) {
    const chunk = addrs.slice(i, i + 100);
    const res = await rpc.getMultipleAccounts(chunk, { encoding: "base64" }).send();
    for (const v of res.value) out.push(v ? new Uint8Array(Buffer.from(v.data[0], "base64")) : null);
  }
  return out;
}

interface OwnerAclRead {
  exists: boolean;
  aclConfigPda: Address;
  pageCount: bigint;
  ownerEntryPage: PageRef | null;
  firstNonFullPage: PageRef | null;
}

/** Read a user's ACL: does it exist, which page holds (mint, Owner), first page with room. */
async function readOwnerAcl(rpc: SolanaRpc, antProgram: Address, user: Address, mint: Address): Promise<OwnerAclRead> {
  const aclConfigPda = await deriveAclConfigPda(antProgram, user);
  const cfgData = await getAcct(rpc, aclConfigPda);
  if (!cfgData) return { exists: false, aclConfigPda, pageCount: 0n, ownerEntryPage: null, firstNonFullPage: null };
  const { pageCount } = decodeAclConfig(cfgData);
  // Derive every page PDA (CPU-only) then batch-read them in one RPC round-trip.
  const refs: PageRef[] = [];
  for (let i = 0n; i < pageCount; i++) refs.push({ pageIdx: i, pagePda: await deriveAclPagePda(antProgram, user, i) });
  const pages = await getMany(rpc, refs.map((r) => r.pagePda));
  let ownerEntryPage: PageRef | null = null;
  let firstNonFullPage: PageRef | null = null;
  for (let k = 0; k < refs.length; k++) {
    const pData = pages[k];
    if (!pData) continue;
    const entries = decodeAclPageEntries(pData);
    if (!firstNonFullPage && entries.length < MAX_ACL_PAGE_ENTRIES) firstNonFullPage = refs[k];
    if (entries.some((e) => e.asset === mint && e.role === ACL_ROLE_OWNER)) ownerEntryPage = refs[k];
  }
  return { exists: true, aclConfigPda, pageCount, ownerEntryPage, firstNonFullPage };
}

export interface HealParams {
  antProgram: Address;
  mint: Address;
  oldOwner: Address;
  claimant: Address;
  treasury: Address;
}

/** Read all live state for one ANT into the pure planner's input snapshot. */
export async function readAclHealSnapshot(rpc: SolanaRpc, p: HealParams): Promise<AclHealSnapshot> {
  const antConfigPda = await deriveAntConfigPda(p.antProgram, p.mint);
  const antControllersPda = await deriveAntControllersPda(p.antProgram, p.mint);

  const mintData = await getAcct(rpc, p.mint);
  const mplOwner = mintData ? decodeMplCoreOwner(mintData) : null;

  const antCfgData = await getAcct(rpc, antConfigPda);
  if (!antCfgData) throw new Error(`no AntConfig for ${p.mint} (program ${p.antProgram}) — not an ario-ant ANT`);
  const lastKnownOwner = decodeAntConfigLastKnownOwner(antCfgData);

  const ctrlData = await getAcct(rpc, antControllersPda);
  const controllers = ctrlData ? decodeAntControllers(ctrlData) : [];

  const old = await readOwnerAcl(rpc, p.antProgram, p.oldOwner, p.mint);
  const neu = await readOwnerAcl(rpc, p.antProgram, p.claimant, p.mint);

  const targetPage: PageRef & { needsCreate: boolean } = neu.firstNonFullPage
    ? { ...neu.firstNonFullPage, needsCreate: false }
    : { pageIdx: neu.pageCount, pagePda: await deriveAclPagePda(p.antProgram, p.claimant, neu.pageCount), needsCreate: true };

  return {
    antProgram: p.antProgram,
    mint: p.mint,
    oldOwner: p.oldOwner,
    claimant: p.claimant,
    treasury: p.treasury,
    antConfigPda,
    antControllersPda,
    mplOwner,
    controllers,
    lastKnownOwner,
    oldOwnerAcl: { aclConfigPda: old.aclConfigPda, entryPage: old.ownerEntryPage },
    newOwnerAcl: {
      exists: neu.exists,
      aclConfigPda: neu.aclConfigPda,
      hasOwnerEntry: neu.ownerEntryPage !== null,
      targetPage,
    },
  };
}

export interface SimResult {
  err: unknown;
  logs: string[] | null;
  unitsConsumed: bigint | null;
}

/**
 * SIMULATE the heal tx (commits nothing, needs NO private key). Builds the tx
 * with a NOOP signer for the treasury fee-payer and simulates with
 * `sigVerify:false` + `replaceRecentBlockhash:true` — the deployed program runs
 * against live state and returns logs + the would-be result, exactly as a real
 * send would, but no signature or SOL is required.
 */
export async function simulateHeal(rpc: SolanaRpc, treasury: Address, plan: AclHealPlan): Promise<SimResult> {
  const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(treasury, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(plan.ixs, m),
  );
  // Compile, then fill every required signature slot with 64 zero bytes so the
  // wire encodes. `sigVerify:false` below means the (invalid) signatures are
  // never checked — the program logic still runs against live state.
  const compiled = compileTransaction(message);
  const zero = new Uint8Array(64) as unknown as (typeof compiled.signatures)[Address];
  const signatures = Object.fromEntries(Object.keys(compiled.signatures).map((a) => [a, compiled.signatures[a as Address] ?? zero])) as typeof compiled.signatures;
  const wire = getBase64EncodedWireTransaction({ ...compiled, signatures });
  const res = await rpc
    .simulateTransaction(wire as Parameters<SolanaRpc["simulateTransaction"]>[0], {
      encoding: "base64",
      commitment: "confirmed",
      sigVerify: false,
      replaceRecentBlockhash: true,
    })
    .send();
  return {
    err: res.value.err,
    logs: res.value.logs ?? null,
    unitsConsumed: res.value.unitsConsumed ?? null,
  };
}

/** APPLY the heal tx: broadcast + confirm. Returns the signature. */
export async function applyHeal(gateway: SolanaChainGateway, treasury: TransactionSigner, plan: AclHealPlan): Promise<{ signature: string; state: string }> {
  const signed = await gateway.signTransaction(plan.ixs, treasury);
  await gateway.broadcast(signed.wireBase64);
  const state = await gateway.confirmSignature(signed.signature, signed.lastValidBlockHeight);
  return { signature: signed.signature, state };
}

export interface HealVerification {
  ownedByClaimant: boolean;
  oldEntryGone: boolean;
  newEntryPresent: boolean;
  /** The OLD owner is not a lingering controller. A controller that IS the
   *  claimant (their own name) is healthy and expected — `reconcile` only strips
   *  the previous owner's delegated controllers, not the new owner's own. */
  noStaleController: boolean;
  lastKnownOwnerOk: boolean;
  fullyHealed: boolean;
}

/** Re-read state and assert the heal landed as intended. */
export async function verifyHealed(rpc: SolanaRpc, p: HealParams): Promise<HealVerification> {
  const s = await readAclHealSnapshot(rpc, p);
  const v: HealVerification = {
    ownedByClaimant: s.mplOwner === p.claimant,
    oldEntryGone: s.oldOwnerAcl.entryPage === null,
    newEntryPresent: s.newOwnerAcl.hasOwnerEntry,
    noStaleController: !s.controllers.includes(p.oldOwner),
    lastKnownOwnerOk: s.lastKnownOwner === p.claimant,
    fullyHealed: false,
  };
  v.fullyHealed = v.ownedByClaimant && v.oldEntryGone && v.newEntryPresent && v.noStaleController && v.lastKnownOwnerOk;
  return v;
}

/** Convenience: read → plan (for dry-run / callers that want the plan first). */
export async function planHeal(rpc: SolanaRpc, p: HealParams): Promise<{ snapshot: AclHealSnapshot; plan: AclHealPlan }> {
  const snapshot = await readAclHealSnapshot(rpc, p);
  return { snapshot, plan: planAclHeal(snapshot) };
}
