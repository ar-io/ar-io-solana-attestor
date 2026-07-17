//! Test-only helpers for the operator wallet-signed ANT flow (excluded from the
//! build — `*.testkit.ts`). Stands in a LOCAL keypair for the ANT_COLD_ADDRESS
//! wallet: given a partially-signed (treasury-cosigned) tx, it adds the authority
//! signature exactly as `wallet.signAllTransactions` would — signing the message
//! bytes and filling the authority slot, never re-signing the fee payer.

import { Buffer } from "node:buffer";
import * as ed from "@noble/ed25519";
import {
  createKeyPairSignerFromPrivateKeyBytes,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  type Address,
  type TransactionSigner,
} from "@solana/kit";

export interface LocalAuthority {
  seed: Uint8Array;
  address: Address;
  signer: TransactionSigner;
}

export async function makeLocalAuthority(seed: Uint8Array): Promise<LocalAuthority> {
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  return { seed, address: signer.address, signer };
}

/**
 * Simulate the operator's wallet signing a partially-signed tx: decode, produce the
 * ed25519 signature over the message bytes with `authoritySeed`, insert it into the
 * authority slot, and re-encode. The fee-payer (treasury) signature — and thus the
 * txid — is untouched. `signAllTransactions` is just this over an array.
 */
export async function operatorSignTx(txBase64: string, authority: LocalAuthority): Promise<string> {
  return signTxAtSlot(txBase64, authority.address, authority.seed);
}

/**
 * Low-level: place an ed25519 signature (made with `signingSeed`) into the
 * `slotAddress` signature slot of a tx. Used to forge a WRONG-authority signature
 * (sign with an attacker seed but insert at the real ANT_COLD_ADDRESS slot) — the
 * backend must reject it because it does not verify for that address.
 */
export async function signTxAtSlot(txBase64: string, slotAddress: Address, signingSeed: Uint8Array): Promise<string> {
  const decoded = getTransactionDecoder().decode(new Uint8Array(getBase64Encoder().encode(txBase64)));
  const sig = await ed.signAsync(decoded.messageBytes as unknown as Uint8Array, signingSeed);
  const signed = {
    ...decoded,
    signatures: { ...decoded.signatures, [slotAddress]: sig },
  } as typeof decoded;
  return getBase64EncodedWireTransaction(signed);
}

export async function operatorSignAll(txsBase64: string[], authority: LocalAuthority): Promise<string[]> {
  return Promise.all(txsBase64.map((t) => operatorSignTx(t, authority)));
}

/** Sign a raw message with a local key (for the admin challenge), base64 signature. */
export async function signMessageBase64(message: Uint8Array, seed: Uint8Array): Promise<string> {
  const sig = await ed.signAsync(message, seed);
  return Buffer.from(sig).toString("base64");
}
