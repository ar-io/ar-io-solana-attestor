//! Shared on-chain helpers for the DEVNET STAGING stack (NOT product code).
//! Copied/adapted from scripts/staging-rehearsal.ts so the persistent staging
//! tooling reuses the exact same primitives (mint / ATA / mintTo / MPL Core ANT).
//! DEVNET ONLY.

import { Buffer } from "node:buffer";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  addSignersToTransactionMessage,
  type Address,
  type IInstruction,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
  type TransactionSigner,
} from "@solana/kit";
import {
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  MPL_CORE_PROGRAM,
  createAtaIdempotentIx,
  getAssociatedTokenAddress,
} from "../../src/dispatch/instructions.js";

export const ONE_TOKEN = 1_000_000n; // 6 decimals

export function makeRpc(rpcUrl: string, wsUrl: string): {
  rpc: Rpc<SolanaRpcApi>;
  sendAndConfirm: ReturnType<typeof sendAndConfirmTransactionFactory>;
} {
  const rpc = createSolanaRpc(rpcUrl) as Rpc<SolanaRpcApi>;
  const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  return { rpc, sendAndConfirm };
}

const ADDR_ENCODER = getAddressEncoder();
const ADDR_DECODER = getAddressDecoder();
function u64le(n: bigint): Uint8Array { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; }
function u32le(n: number): Uint8Array { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; }
function encodeAddr(a: Address): Uint8Array { return new Uint8Array(ADDR_ENCODER.encode(a)); }

export { getAssociatedTokenAddress };

export async function sendTx(
  rpc: Rpc<SolanaRpcApi>,
  sendAndConfirm: ReturnType<typeof sendAndConfirmTransactionFactory>,
  ixs: IInstruction[],
  feePayer: TransactionSigner,
  extra: TransactionSigner[] = [],
): Promise<string> {
  const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
    (m) => (extra.length ? addSignersToTransactionMessage(extra, m) : m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  await sendAndConfirm(signed, { commitment: "confirmed" });
  return getSignatureFromTransaction(signed);
}

export async function fundLamports(
  rpc: Rpc<SolanaRpcApi>,
  sendAndConfirm: ReturnType<typeof sendAndConfirmTransactionFactory>,
  funder: KeyPairSigner,
  target: Address,
  lamps: bigint,
): Promise<string> {
  const ix: IInstruction = {
    programAddress: SYSTEM_PROGRAM,
    accounts: [
      { address: funder.address, role: AccountRole.WRITABLE_SIGNER },
      { address: target, role: AccountRole.WRITABLE },
    ],
    data: new Uint8Array([2, 0, 0, 0, ...u64le(lamps)]),
  };
  return sendTx(rpc, sendAndConfirm, [ix], funder);
}

export async function createMint(
  rpc: Rpc<SolanaRpcApi>,
  sendAndConfirm: ReturnType<typeof sendAndConfirmTransactionFactory>,
  payer: KeyPairSigner,
  mintAuthority: Address,
  decimals: number,
): Promise<Address> {
  const mint = await generateKeyPairSigner();
  const rent = await rpc.getMinimumBalanceForRentExemption(82n).send();
  const createAccount: IInstruction = {
    programAddress: SYSTEM_PROGRAM,
    accounts: [
      { address: payer.address, role: AccountRole.WRITABLE_SIGNER },
      { address: mint.address, role: AccountRole.WRITABLE_SIGNER },
    ],
    data: new Uint8Array([0, 0, 0, 0, ...u64le(BigInt(rent)), ...u64le(82n), ...encodeAddr(TOKEN_PROGRAM)]),
  };
  const initMint2: IInstruction = {
    programAddress: TOKEN_PROGRAM,
    accounts: [{ address: mint.address, role: AccountRole.WRITABLE }],
    data: new Uint8Array([20, decimals, ...encodeAddr(mintAuthority), 0]),
  };
  await sendTx(rpc, sendAndConfirm, [createAccount, initMint2], payer, [mint]);
  return mint.address;
}

export async function mintTo(
  rpc: Rpc<SolanaRpcApi>,
  sendAndConfirm: ReturnType<typeof sendAndConfirmTransactionFactory>,
  payer: KeyPairSigner,
  mint: Address,
  dest: Address,
  mintAuthority: KeyPairSigner,
  amount: bigint,
): Promise<void> {
  const ix: IInstruction = {
    programAddress: TOKEN_PROGRAM,
    accounts: [
      { address: mint, role: AccountRole.WRITABLE },
      { address: dest, role: AccountRole.WRITABLE },
      { address: mintAuthority.address, role: AccountRole.READONLY_SIGNER },
    ],
    data: new Uint8Array([7, ...u64le(amount)]),
  };
  await sendTx(rpc, sendAndConfirm, [ix], payer, [mintAuthority]);
}

export async function createAta(
  rpc: Rpc<SolanaRpcApi>,
  sendAndConfirm: ReturnType<typeof sendAndConfirmTransactionFactory>,
  payer: KeyPairSigner,
  owner: Address,
  mint: Address,
): Promise<Address> {
  const ata = await getAssociatedTokenAddress(owner, mint);
  await sendTx(rpc, sendAndConfirm, [createAtaIdempotentIx({ payer: payer.address, ata, owner, mint })], payer);
  return ata;
}

export async function tokenBalance(rpc: Rpc<SolanaRpcApi>, ata: Address): Promise<bigint> {
  try { const r = await rpc.getTokenAccountBalance(ata).send(); return BigInt(r.value.amount); } catch { return 0n; }
}

export async function balanceAtLeast(rpc: Rpc<SolanaRpcApi>, ata: Address, want: bigint, tries = 20): Promise<bigint> {
  let bal = 0n;
  for (let i = 0; i < tries; i++) {
    bal = await tokenBalance(rpc, ata);
    if (bal >= want) return bal;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return bal;
}

export async function createCoreAsset(
  rpc: Rpc<SolanaRpcApi>,
  sendAndConfirm: ReturnType<typeof sendAndConfirmTransactionFactory>,
  payer: KeyPairSigner,
  owner: KeyPairSigner,
  name: string,
): Promise<Address> {
  const asset = await generateKeyPairSigner();
  const uri = "https://ar.io/ant.json";
  const data = new Uint8Array([0, 0, ...u32le(name.length), ...new TextEncoder().encode(name), ...u32le(uri.length), ...new TextEncoder().encode(uri), 0]);
  const ix: IInstruction = {
    programAddress: MPL_CORE_PROGRAM,
    accounts: [
      { address: asset.address, role: AccountRole.WRITABLE_SIGNER },
      { address: MPL_CORE_PROGRAM, role: AccountRole.READONLY },
      { address: owner.address, role: AccountRole.READONLY_SIGNER },
      { address: payer.address, role: AccountRole.WRITABLE_SIGNER },
      { address: owner.address, role: AccountRole.READONLY },
      { address: owner.address, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: MPL_CORE_PROGRAM, role: AccountRole.READONLY },
    ],
    data,
  };
  await sendTx(rpc, sendAndConfirm, [ix], payer, [asset, owner]);
  return asset.address;
}

export async function readCoreOwnerUA(rpc: Rpc<SolanaRpcApi>, asset: Address): Promise<{ owner: string; ua: string }> {
  const r = await rpc.getAccountInfo(asset, { encoding: "base64" }).send();
  if (!r.value) throw new Error("asset not found");
  const raw = Buffer.from(r.value.data[0], "base64");
  const uaTag = raw[33];
  return {
    owner: ADDR_DECODER.decode(raw.subarray(1, 33)) as string,
    ua: uaTag === 1 ? (ADDR_DECODER.decode(raw.subarray(34, 66)) as string) : `tag:${uaTag}`,
  };
}

export { address };
