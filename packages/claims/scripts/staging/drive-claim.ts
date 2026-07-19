//! Drive ONE claim end-to-end through a RUNNING claims API (lookup -> initiate ->
//! sign the server canonical with the identity we control -> complete). For token /
//! vault the persistent worker then auto-dispenses; for ant the claim reaches
//! `verified` and the ant-admin operator flow dispenses it (see ant-operator-sign.ts).
//!
//! DEVNET ONLY. Uses the identity key material saved by seed.ts (seed-manifest.json).
//! Exposes reusable helpers (loadSeed / signProof / driveClaim) consumed by
//! smoke-suite.ts, plus a thin CLI.
//!
//!   API_URL=http://127.0.0.1:3041 SECURE_DIR=/opt/claims-secure/staging \
//!   RPC_URL=... node --import tsx scripts/staging/drive-claim.ts --assetKey <KEY> [--claimant <ADDR>] [--wait]

import { Buffer } from "node:buffer";
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { generateKeyPairSigner, createSolanaRpc, type Address } from "@solana/kit";
import { signArCanonical, signEthCanonical } from "../../src/api/proof-testkit.js";
import { getAssociatedTokenAddress, tokenBalance } from "./onchain.js";

export interface SeedIdentity {
  recipientId: string;
  protocol: "arweave" | "ethereum";
  arPrivPkcs8Pem?: string;
  modulusBase64?: string;
  ethPrivHex?: string;
  addressLower?: string;
}
export interface SeedAsset {
  assetKey: string; type: "token" | "vault" | "ant"; amountArio: string | null; amountMario: string | null;
  vaultEndTs: number | null; antMint: string | null; recipientId: string; protocol: "arweave" | "ethereum";
  expected: string; label: string; status?: string; kind?: string;
}
export interface SeedManifest {
  seededAt: string; arioMint: string; antAuthority: string;
  assets: SeedAsset[]; identities: Record<string, SeedIdentity>;
}

export type Proof =
  | { protocol: "arweave"; rsaSignatureBase64Url: string; rsaModulusBase64Url: string; saltLength: number }
  | { protocol: "ethereum"; signatureHex: string };

export function loadSeed(secureDir: string): SeedManifest {
  return JSON.parse(readFileSync(`${secureDir}/seed-manifest.json`, "utf8"));
}

/** Sign the server canonical with a seeded identity (valid proof). `corrupt` flips a
 *  byte to forge an INVALID proof (negative tests). */
export async function signProof(id: SeedIdentity, canonical: Uint8Array, corrupt = false): Promise<Proof> {
  if (id.protocol === "arweave") {
    const priv = createPrivateKey(id.arPrivPkcs8Pem!);
    const sig = signArCanonical(priv, canonical, 32);
    if (corrupt) sig[0] ^= 0xff;
    return {
      protocol: "arweave",
      rsaSignatureBase64Url: Buffer.from(sig).toString("base64url"),
      rsaModulusBase64Url: Buffer.from(id.modulusBase64!, "base64").toString("base64url"),
      saltLength: 32,
    };
  }
  const priv = new Uint8Array(Buffer.from(id.ethPrivHex!, "hex"));
  const sig = await signEthCanonical(priv, canonical);
  if (corrupt) sig[0] ^= 0xff;
  return { protocol: "ethereum", signatureHex: Buffer.from(sig).toString("hex") };
}

export interface DriveResult {
  claimId: string; claimant: string; assetType: string;
  completeStatus: string; idempotentReplay?: boolean;
  finalStatus?: string; txSignatures?: string[]; balanceMario?: bigint;
  completePayload: { claimId: string; nonceHex: string; proof: Proof };
}

/** Full lookup -> initiate -> sign -> complete against a live API. `wait` polls the
 *  claim to a terminal state (worker auto-dispenses token/vault). */
export async function driveClaim(opts: {
  apiUrl: string; seed: SeedManifest; assetKey: string; claimant?: string;
  wait?: boolean; rpcUrl?: string;
}): Promise<DriveResult> {
  const asset = opts.seed.assets.find((a) => a.assetKey === opts.assetKey);
  if (!asset) throw new Error(`assetKey ${opts.assetKey} not in seed-manifest.json`);
  const id = opts.seed.identities[asset.recipientId];
  if (!id) throw new Error(`no identity for recipient ${asset.recipientId}`);
  const claimant = opts.claimant ?? (await generateKeyPairSigner()).address;

  const look = await fetch(`${opts.apiUrl}/v1/claimable?recipientId=${asset.recipientId}`);
  if (!look.ok) throw new Error(`lookup ${look.status}: ${await look.text()}`);
  if (!(await look.json()).assets.some((x: { assetKey: string }) => x.assetKey === opts.assetKey)) {
    throw new Error(`asset not visible in lookup (already claimed?)`);
  }

  const init = await fetch(`${opts.apiUrl}/v1/claims/initiate`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ assetKey: opts.assetKey, claimant }),
  });
  if (init.status !== 201) throw new Error(`initiate ${init.status}: ${await init.text()}`);
  const { claimId, canonicalMessageHex, nonceHex } = await init.json();
  const canonical = new Uint8Array(Buffer.from(canonicalMessageHex, "hex"));
  const proof = await signProof(id, canonical);

  const done = await fetch(`${opts.apiUrl}/v1/claims/complete`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ claimId, nonceHex, proof }),
  });
  if (done.status !== 202) throw new Error(`complete ${done.status}: ${await done.text()}`);
  const doneJson = await done.json();

  const res: DriveResult = {
    claimId, claimant, assetType: asset.type,
    completeStatus: doneJson.status, idempotentReplay: doneJson.idempotentReplay,
    completePayload: { claimId, nonceHex, proof },
  };

  if (opts.wait) {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const s = await fetch(`${opts.apiUrl}/v1/claims/${claimId}`);
      if (!s.ok) continue;
      const j = await s.json();
      res.finalStatus = j.status;
      res.txSignatures = j.txSignatures ?? [];
      if (["confirmed", "failed", "needs_operator", "awaiting_manual_vault_delivery", "pending_review"].includes(j.status)) {
        if (opts.rpcUrl && asset.amountMario && res.claimant) {
          const rpc = createSolanaRpc(opts.rpcUrl);
          const ata = await getAssociatedTokenAddress(res.claimant as Address, opts.seed.arioMint as Address);
          res.balanceMario = await tokenBalance(rpc, ata);
        }
        break;
      }
    }
  }
  return res;
}

// ------------------------------- CLI -------------------------------
async function main(): Promise<void> {
  const arg = (n: string): string | undefined => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const assetKey = arg("assetKey");
  if (!assetKey) throw new Error("--assetKey required");
  const apiUrl = process.env.API_URL ?? "http://127.0.0.1:3041";
  const secureDir = process.env.SECURE_DIR ?? "/opt/claims-secure/staging";
  const seed = loadSeed(secureDir);
  const res = await driveClaim({
    apiUrl, seed, assetKey, claimant: arg("claimant"),
    wait: process.argv.includes("--wait"), rpcUrl: process.env.RPC_URL,
  });
  if (!process.argv.includes("--claimant")) console.log("generated claimant:", res.claimant);
  console.log(JSON.stringify({
    claimId: res.claimId, claimant: res.claimant, assetType: res.assetType,
    completeStatus: res.completeStatus, finalStatus: res.finalStatus,
    balanceArio: res.balanceMario !== undefined ? Number(res.balanceMario) / 1e6 : undefined,
    txSignatures: res.txSignatures,
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("drive-claim failed:", e); process.exit(1); });
}
