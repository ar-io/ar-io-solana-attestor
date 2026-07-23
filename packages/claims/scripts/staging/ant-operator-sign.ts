//! TEST OPERATOR SIGNER — stands in for the operator's Phantom wallet in the
//! wallet-signed ANT dispatch flow, until the real frontend admin panel exists.
//! It drives the RUNNING ant-admin server (127.0.0.1:3051), build-at-sign-time flow:
//!   1. GET  /v1/admin/ant/challenge, sign `reserve:<nonce>`
//!   2. POST /v1/admin/ant/batch             -> RESERVE eligible claims (review items)
//!   3. GET a fresh challenge, sign `build:<nonce>`
//!   4. POST /v1/admin/ant/batch/:id/build   -> FRESH treasury-cosigned partial txs
//!   5. co-sign each partial tx with the ANT authority (== Phantom signAllTransactions)
//!   6. GET a fresh challenge, sign `submit:<nonce>`
//!   7. POST /v1/admin/ant/batch/:id/submit  -> broadcast + confirm on devnet
//! The ANT authority key signs LOCALLY here; the server never holds it. DEVNET ONLY.
//! Exports `operatorSign()` for smoke-suite.ts; also a thin CLI.
//!
//!   ADMIN_URL=http://127.0.0.1:3051 SECURE_DIR=/opt/claims-secure/staging \
//!     node --import tsx scripts/staging/ant-operator-sign.ts [--max N]

import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import * as ed from "@noble/ed25519";
import {
  createKeyPairSignerFromBytes,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
} from "@solana/kit";

const PREFIX = "ar.io-ant-admin:";
function challengeMsg(nonce: string, action: string): Uint8Array {
  return new TextEncoder().encode(`${PREFIX}${action}:${nonce}`);
}

export interface OperatorSignResult {
  batchId: string;
  items: { claimId: string; antMint: string; claimant: string; txid: string }[];
  results: { claimId: string; outcome: string; txid?: string; detail?: string }[];
}

/** Build + operator-co-sign + submit the pending ANT batch against a running
 *  ant-admin server, signing locally with the ANT authority keypair. */
export async function operatorSign(opts: {
  adminUrl: string; secureDir: string; max?: number;
  log?: (m: string) => void;
}): Promise<OperatorSignResult> {
  const log = opts.log ?? (() => {});
  const arr = new Uint8Array(JSON.parse(readFileSync(`${opts.secureDir}/ant-authority-keypair.json`, "utf8")));
  const seed32 = arr.slice(0, 32); // ed25519 private seed
  const authority = await createKeyPairSignerFromBytes(arr);
  log(`ANT authority (operator wallet stand-in): ${authority.address}`);

  async function signedChallenge(action: string): Promise<{ nonce: string; sig: string }> {
    const r = await fetch(`${opts.adminUrl}/v1/admin/ant/challenge`);
    if (!r.ok) throw new Error(`challenge ${r.status}: ${await r.text()}`);
    const { nonce } = await r.json();
    const sig = await ed.signAsync(challengeMsg(nonce, action), seed32);
    return { nonce, sig: Buffer.from(sig).toString("base64") };
  }

  // 1. RESERVE eligible claims (review step — no txs built yet).
  const reserveCh = await signedChallenge("reserve");
  const reserveRes = await fetch(`${opts.adminUrl}/v1/admin/ant/batch`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...reserveCh, max: opts.max ?? 50 }),
  });
  if (reserveRes.status !== 201) throw new Error(`reserve ${reserveRes.status}: ${await reserveRes.text()}`);
  const reserved = await reserveRes.json();
  log(`reserved batch ${reserved.batchId} with ${reserved.items.length} claim(s) for review`);
  if (reserved.items.length === 0) return { batchId: reserved.batchId, items: [], results: [] };

  // 2. BUILD fresh treasury-cosigned txs for the reserved batch (fresh blockhash NOW).
  const buildCh = await signedChallenge("build");
  const buildRes = await fetch(`${opts.adminUrl}/v1/admin/ant/batch/${reserved.batchId}/build`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(buildCh),
  });
  if (buildRes.status !== 201) throw new Error(`build ${buildRes.status}: ${await buildRes.text()}`);
  const batch = await buildRes.json();
  log(`built batch ${batch.batchId} with ${batch.items.length} tx(s)${batch.skipped?.length ? ` (${batch.skipped.length} skipped)` : ""}`);
  if (batch.items.length === 0) return { batchId: batch.batchId, items: [], results: [] };

  const b64enc = getBase64Encoder();
  const decoder = getTransactionDecoder();
  const signedTxs: string[] = [];
  for (const item of batch.items) {
    const decoded = decoder.decode(new Uint8Array(b64enc.encode(item.txBase64)));
    const signed = await partiallySignTransaction([authority.keyPair], decoded);
    signedTxs.push(getBase64EncodedWireTransaction(signed));
    log(`  co-signed claim ${item.claimId} (antMint ${item.antMint} -> ${item.claimant}) txid ${item.txid}`);
  }

  const submitCh = await signedChallenge("submit");
  const submitRes = await fetch(`${opts.adminUrl}/v1/admin/ant/batch/${batch.batchId}/submit`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...submitCh, signedTxs }),
  });
  if (!submitRes.ok) throw new Error(`submit ${submitRes.status}: ${await submitRes.text()}`);
  const out = await submitRes.json();
  return { batchId: batch.batchId, items: batch.items, results: out.results };
}

// ------------------------------- CLI -------------------------------
async function main(): Promise<void> {
  const adminUrl = process.env.ADMIN_URL ?? "http://127.0.0.1:3051";
  const secureDir = process.env.SECURE_DIR ?? "/opt/claims-secure/staging";
  const maxIdx = process.argv.indexOf("--max");
  const max = maxIdx >= 0 ? parseInt(process.argv[maxIdx + 1], 10) : 50;
  const r = await operatorSign({ adminUrl, secureDir, max, log: (m) => console.log(m) });
  if (r.items.length === 0) { console.log("no verified ANT claims pending — nothing to dispatch"); return; }
  console.log("submit results:");
  for (const x of r.results) console.log(`  claim ${x.claimId}: ${x.outcome} txid=${x.txid ?? "-"} ${x.detail ?? ""}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("ant-operator-sign failed:", e); process.exit(1); });
}
