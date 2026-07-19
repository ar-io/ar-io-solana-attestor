//! One-time DEVNET STAGING setup: mint the staging keys (treasury + ANT authority),
//! fund them from the FUNDER, create the staging ARIO test mint, and mint the hot
//! float to the treasury ATA. Idempotent: re-running reuses existing keys/mint.
//!
//! DEVNET ONLY. Never airdrops — funds from FUNDER_KEYPAIR.
//!
//!   RPC_URL=... WS_URL=... FUNDER_KEYPAIR=/opt/claims-secure/staging/funder-keypair.json \
//!   SECURE_DIR=/opt/claims-secure/staging \
//!     node --import tsx scripts/staging/setup.ts

import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import {
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  getAddressEncoder,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import {
  ONE_TOKEN, makeRpc, fundLamports, createMint, mintTo, createAta, tokenBalance, balanceAtLeast,
  getAssociatedTokenAddress,
} from "./onchain.js";

const RPC_URL = process.env.RPC_URL!;
const WS_URL = process.env.WS_URL!;
const FUNDER_KEYPAIR = process.env.FUNDER_KEYPAIR!;
const SECURE_DIR = process.env.SECURE_DIR ?? "/opt/claims-secure/staging";
const NETWORK = "solana-devnet";
const FLOAT_ARIO = BigInt(process.env.FLOAT_ARIO ?? "500000"); // 500k test ARIO

const TREASURY_SOL = BigInt(process.env.TREASURY_SOL_LAMPORTS ?? "400000000"); // 0.4 SOL
const ANT_SOL = BigInt(process.env.ANT_SOL_LAMPORTS ?? "60000000"); // 0.06 SOL

const ADDR_ENCODER = getAddressEncoder();

const MANIFEST = `${SECURE_DIR}/manifest.json`;

interface KeyRec { address: string; seedBase64: string }
interface Manifest {
  network: string; rpcUrl: string; wsUrl: string;
  funder: string;
  treasury: KeyRec; antAuthority: KeyRec;
  arioMint?: string; treasuryAta?: string;
  createdAt: string;
}

function pubkeyBytes(a: Address): Uint8Array { return new Uint8Array(ADDR_ENCODER.encode(a)); }

/** Persist a keypair both as a 64-byte Solana CLI JSON (seed||pubkey) and return the record. */
async function loadOrCreateKey(name: string): Promise<{ rec: KeyRec; signer: KeyPairSigner }> {
  const path = `${SECURE_DIR}/${name}-keypair.json`;
  if (existsSync(path)) {
    const arr = new Uint8Array(JSON.parse(readFileSync(path, "utf8")));
    const signer = await createKeyPairSignerFromBytes(arr);
    return { rec: { address: signer.address, seedBase64: Buffer.from(arr.slice(0, 32)).toString("base64") }, signer };
  }
  const seed = new Uint8Array(randomBytes(32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const full = new Uint8Array(64);
  full.set(seed, 0);
  full.set(pubkeyBytes(signer.address), 32);
  writeFileSync(path, JSON.stringify(Array.from(full)));
  chmodSync(path, 0o600);
  return { rec: { address: signer.address, seedBase64: Buffer.from(seed).toString("base64") }, signer };
}

async function main(): Promise<void> {
  if (!RPC_URL || !WS_URL || !FUNDER_KEYPAIR) throw new Error("RPC_URL, WS_URL, FUNDER_KEYPAIR required");
  const { rpc, sendAndConfirm } = makeRpc(RPC_URL, WS_URL);
  const funder = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(FUNDER_KEYPAIR, "utf8"))));
  console.log("funder", funder.address, Number((await rpc.getBalance(funder.address).send()).value) / 1e9, "SOL");

  const prev: Manifest | undefined = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : undefined;

  const treasury = await loadOrCreateKey("treasury");
  const antAuthority = await loadOrCreateKey("ant-authority");
  console.log("treasury", treasury.rec.address);
  console.log("ant-authority", antAuthority.rec.address);

  // Fund SOL (top up to target if low).
  for (const [label, sig, want] of [
    ["treasury", treasury.signer, TREASURY_SOL] as const,
    ["ant-authority", antAuthority.signer, ANT_SOL] as const,
  ]) {
    const bal = (await rpc.getBalance(sig.address).send()).value;
    if (bal < want) {
      const top = want - bal;
      const s = await fundLamports(rpc, sendAndConfirm, funder, sig.address, top);
      console.log(`funded ${label} +${Number(top) / 1e9} SOL`, s);
    } else {
      console.log(`${label} already has ${Number(bal) / 1e9} SOL (skip)`);
    }
  }

  // ARIO mint (mint authority = FUNDER so re-seeds can mint more float if needed).
  let arioMint: Address;
  let treasuryAta: Address;
  if (prev?.arioMint) {
    arioMint = prev.arioMint as Address;
    console.log("reuse ARIO mint", arioMint);
  } else {
    arioMint = await createMint(rpc, sendAndConfirm, funder, funder.address, 6);
    console.log("created ARIO test mint", arioMint);
  }
  treasuryAta = await getAssociatedTokenAddress(treasury.signer.address, arioMint);
  await createAta(rpc, sendAndConfirm, funder, treasury.signer.address, arioMint);
  const floatMario = FLOAT_ARIO * ONE_TOKEN;
  const cur = await tokenBalance(rpc, treasuryAta);
  if (cur < floatMario) {
    await mintTo(rpc, sendAndConfirm, funder, arioMint, treasuryAta, funder, floatMario - cur);
    const bal = await balanceAtLeast(rpc, treasuryAta, floatMario);
    console.log("treasury float", Number(bal) / 1e6, "ARIO");
  } else {
    console.log("treasury float already", Number(cur) / 1e6, "ARIO (skip)");
  }

  const manifest: Manifest = {
    network: NETWORK, rpcUrl: RPC_URL, wsUrl: WS_URL,
    funder: funder.address,
    treasury: treasury.rec, antAuthority: antAuthority.rec,
    arioMint, treasuryAta,
    createdAt: prev?.createdAt ?? new Date().toISOString(),
  };
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  chmodSync(MANIFEST, 0o600);
  console.log("\nmanifest ->", MANIFEST);
  console.log(JSON.stringify({ treasury: treasury.rec.address, antAuthority: antAuthority.rec.address, arioMint, treasuryAta }, null, 2));
}

main().catch((e) => { console.error("setup failed:", e); process.exit(1); });
