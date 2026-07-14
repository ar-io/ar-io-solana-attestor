//! M6 LIVE proof — lands an audit-log anchor ON-CHAIN (devnet) and reads live
//! reserves, through the REAL transparency modules + the real DB. Single-process
//! (no test-runner concurrency), self-restoring (leaves the shared DB as it found
//! it: no signed rows, no appended audit rows, no published_ledger/anchors).
//!
//! Run:
//!   DATABASE_URL=postgres://claims:claims@localhost:5544/claims \
//!   NETWORK=solana-devnet SOLANA_RPC_URL=https://api.devnet.solana.com \
//!   FUNDER_KEYPAIR=/home/vilenarios/source/solana-ar-io/keys/staging/authority-keypair.json \
//!     tsx scripts/m6-devnet-proof.ts
//!
//! Phases:
//!   1  Fund an ephemeral PUBLISHER/anchor key (airdrop, else FUNDER transfer).
//!   2  LEDGER  — build+sign an artifact, verify it, prove membership, detect tamper.
//!   3  ANCHOR  — append audit rows, sign (audit key), ANCHOR the head on devnet
//!               (memo tx lands), read the memo BACK FROM CHAIN, confirm the log
//!               EXTENDS the anchored head, and show a rewrite is detected.
//!   4  RESERVES — create an ARIO mint, fund a cold reserve to cover the live ledger
//!               liability, read holdings LIVE via kit, assert holdings >= liability;
//!               then an unfunded owner => NOT covered. Plus a live ANT-owner read.

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  AccountRole,
  address,
  airdropFactory,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getSignatureFromTransaction,
  lamports,
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

import { loadConfig } from "../src/config.js";
import { createDb, type Db } from "../src/db.js";
import { setAuditSigner } from "../src/api/audit.js";
import { keypairFromSeed } from "../src/transparency/keys.js";
import { buildLedgerArtifact, proveMembership, verifyLedgerArtifact, verifyMembership, type LedgerLeaf } from "../src/transparency/ledger-artifact.js";
import { getAuditHead, loadAuditRows, verifyAuditChain, checkExtendsAnchor } from "../src/transparency/audit-chain.js";
import { computeEntryHash } from "../src/api/audit.js";
import { submitAnchor, publisherSigner, auditHeadMemo, fetchAnchorMemo, parseAnchorMemo, anchorSignedBy, addressFromPublicKey, LIVE_MEMO_PROGRAM } from "../src/transparency/anchor.js";
import { persistPublishedLedger, recordAnchor } from "../src/transparency/store.js";
import { computeReserves, readLiabilities, readCoreOwner } from "../src/transparency/reserves.js";
import { SolanaChainGateway } from "../src/dispatch/chain.js";
import {
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  MPL_CORE_PROGRAM,
  createAtaIdempotentIx,
  getAssociatedTokenAddress,
} from "../src/dispatch/instructions.js";

const ONE_TOKEN = 1_000_000n;
const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const WS_URL = process.env.SOLANA_WS_URL ?? RPC_URL.replace("https", "wss").replace("http", "ws");

const rpc = createSolanaRpc(RPC_URL) as Rpc<SolanaRpcApi>;
const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
const airdrop = airdropFactory({ rpc, rpcSubscriptions });
const ADDR = getAddressEncoder();

function log(m: string, extra?: unknown): void {
  console.log(`  ${m}${extra !== undefined ? " " + JSON.stringify(extra, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) : ""}`);
}
function u64le(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}
function encAddr(a: Address): Uint8Array {
  return new Uint8Array(ADDR.encode(a));
}

async function sendTx(ixs: IInstruction[], feePayer: TransactionSigner, extra: TransactionSigner[] = []): Promise<string> {
  const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
    (m) => (extra.length ? addSignersToTransactionMessage(extra, m) : m),
  );
  const signed = await signTransactionMessageWithSigners(msg);
  await sendAndConfirm(signed, { commitment: "confirmed" });
  return getSignatureFromTransaction(signed);
}

async function fundKey(target: Address, sol: number): Promise<void> {
  try {
    await airdrop({ recipientAddress: target, lamports: lamports(BigInt(Math.floor(sol * 1e9))), commitment: "confirmed" });
    log("funded via airdrop", { target, sol });
    return;
  } catch {
    log("airdrop rate-limited; funding from FUNDER_KEYPAIR");
  }
  const fp = process.env.FUNDER_KEYPAIR ?? "/home/vilenarios/source/solana-ar-io/keys/staging/authority-keypair.json";
  const arr = JSON.parse(readFileSync(fp, "utf8")) as number[];
  const funder = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(arr.slice(0, 32)));
  const transferIx: IInstruction = {
    programAddress: SYSTEM_PROGRAM,
    accounts: [
      { address: funder.address, role: AccountRole.WRITABLE_SIGNER },
      { address: target, role: AccountRole.WRITABLE },
    ],
    data: new Uint8Array([2, 0, 0, 0, ...u64le(BigInt(Math.floor(sol * 1e9)))]),
  };
  const sig = await sendTx([transferIx], funder);
  log("funded via FUNDER transfer", { funder: funder.address, target, sol, sig });
}

async function createMint(payer: KeyPairSigner, mintAuthority: Address): Promise<Address> {
  const mint = await generateKeyPairSigner();
  const rent = await rpc.getMinimumBalanceForRentExemption(82n).send();
  const createAccount: IInstruction = {
    programAddress: SYSTEM_PROGRAM,
    accounts: [
      { address: payer.address, role: AccountRole.WRITABLE_SIGNER },
      { address: mint.address, role: AccountRole.WRITABLE_SIGNER },
    ],
    data: new Uint8Array([0, 0, 0, 0, ...u64le(BigInt(rent)), ...u64le(82n), ...encAddr(TOKEN_PROGRAM)]),
  };
  const initMint2: IInstruction = {
    programAddress: TOKEN_PROGRAM,
    accounts: [{ address: mint.address, role: AccountRole.WRITABLE }],
    data: new Uint8Array([20, 6, ...encAddr(mintAuthority), 0]),
  };
  await sendTx([createAccount, initMint2], payer, [mint]);
  return mint.address;
}

async function mintTo(payer: KeyPairSigner, mint: Address, dest: Address, amount: bigint): Promise<void> {
  const ix: IInstruction = {
    programAddress: TOKEN_PROGRAM,
    accounts: [
      { address: mint, role: AccountRole.WRITABLE },
      { address: dest, role: AccountRole.WRITABLE },
      { address: payer.address, role: AccountRole.READONLY_SIGNER },
    ],
    data: new Uint8Array([7, ...u64le(amount)]),
  };
  await sendTx([ix], payer, [payer]);
}

async function createCoreAsset(payer: KeyPairSigner, owner: KeyPairSigner): Promise<Address> {
  const asset = await generateKeyPairSigner();
  const name = "m6-ant";
  const uri = "https://ar.io/ant.json";
  const u32 = (n: number): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
  const data = new Uint8Array([0, 0, ...u32(name.length), ...new TextEncoder().encode(name), ...u32(uri.length), ...new TextEncoder().encode(uri), 0]);
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
  await sendTx([ix], payer, [asset, owner]);
  return asset.address;
}

const SAMPLE_LEAVES: LedgerLeaf[] = [
  { recipientId: "9N1zO4VAUkzweAA6kedaproofArweaveAddrExample01", protocol: 0, assetKey: "0000token", assetType: "token", amount: "1234567890", antMint: null, vaultEndTs: null, status: "available" },
  { recipientId: "ethRecipientProofExample", protocol: 1, assetKey: "5555vault", assetType: "vault", amount: "5000000000", antMint: null, vaultEndTs: 1795000000, status: "available" },
  { recipientId: "atRiskRecipientProofExample", protocol: 0, assetKey: "9999atrisk", assetType: "token", amount: "6250000000000", antMint: null, vaultEndTs: null, status: "manual_review" },
];

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
  const config = loadConfig();
  const db: Db = createDb(config.databaseUrl);
  const gateway = new SolanaChainGateway(rpc);

  const audit = keypairFromSeed("audit", new Uint8Array(32).fill(101));
  // RANDOM ephemeral anchor key — a fixed seed can collide with an existing
  // (program-owned) devnet account, which then can't pay fees (InvalidAccountForFee).
  const publisher = keypairFromSeed("publisher", new Uint8Array(randomBytes(32)));
  const publisherKit = await publisherSigner(publisher.secretKey);

  const results: Record<string, string> = {};
  const fail: string[] = [];
  const expect = (n: string, cond: boolean, detail?: string): void => {
    results[n] = cond ? "PASS" : `FAIL${detail ? ": " + detail : ""}`;
    if (!cond) fail.push(n);
    log(`[${cond ? "PASS" : "FAIL"}] ${n}${detail ? " — " + detail : ""}`);
  };

  // Restore state at the end: appended audit rows (tail) + our records.
  const appendedSeqs: string[] = [];
  const publishedIds: string[] = [];
  const anchorIds: string[] = [];

  try {
    // ---- Phase 1: fund the anchor key ----
    log("Phase 1: fund publisher/anchor key", { publisher: publisherKit.address });
    await fundKey(publisherKit.address, 0.05);
    const bal = await rpc.getBalance(publisherKit.address, { commitment: "confirmed" }).send();
    expect("phase1_anchor_key_funded", bal.value > 0n, `lamports=${bal.value}`);

    // ---- Phase 2: published, signed ledger ----
    log("Phase 2: build + verify signed ledger, prove membership, detect tamper");
    const artifact = buildLedgerArtifact({ leaves: SAMPLE_LEAVES, network: config.network, ledgerVersion: `m6-proof-${Date.now()}`, publisher });
    const av = verifyLedgerArtifact(artifact, artifact.publisherPubkeyHex);
    const m = proveMembership(artifact, "5555vault");
    const memberOk = verifyMembership(m, artifact.manifest.rootHex);
    const tamperDetected = verifyMembership({ ...m, leaf: { ...m.leaf, amount: "999999999" } }, artifact.manifest.rootHex) === false;
    const pubId = await persistPublishedLedger(db.pool, artifact);
    publishedIds.push(pubId);
    expect("phase2_ledger_verifies_membership_tamper", av.ok && memberOk && tamperDetected, `verify=${av.ok} member=${memberOk} tamper=${tamperDetected} root=${artifact.manifest.rootHex}`);

    // ---- Phase 3: on-chain audit anchor + extension + rewrite detection ----
    log("Phase 3: anchor the audit-log head ON-CHAIN (devnet)");
    const head0 = await getAuditHead(db.pool);
    const startSeq = head0?.seq ?? "0";
    const startPrev = head0 ? Buffer.from(head0.entryHashHex, "hex") : Buffer.alloc(32);

    // Append a few rows (signed on write with the audit key).
    setAuditSigner({ signEntryHash: (h) => Buffer.from(audit.sign(h)) });
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      const { appendAudit } = await import("../src/api/audit.js");
      await appendAudit(client, { event: "m6.proof", detail: { step: "1" } });
      await appendAudit(client, { event: "m6.proof", detail: { step: "2" } });
      await appendAudit(client, { event: "m6.proof", detail: { step: "3" } });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    setAuditSigner(null);

    const suffix = await loadAuditRows(db.pool, { sinceSeq: startSeq });
    for (const r of suffix) appendedSeqs.push(r.seq);
    const suffixChain = verifyAuditChain(suffix, { auditPubkey: audit.publicKey, initialPrevHash: startPrev });
    const head = await getAuditHead(db.pool);
    if (!head) throw new Error("no audit head");

    const memo = auditHeadMemo(head.seq, head.entryHashHex, config.network);
    const anchor = await submitAnchor({ gateway, signer: publisherKit, memoText: memo });
    log("anchor tx", { signature: anchor.signature, confirmed: anchor.confirmed });
    const anchorId = await recordAnchor(db.pool, {
      kind: "audit-head", anchoredRef: head.seq, headHashHex: head.entryHashHex, target: "solana-memo",
      network: config.network, txid: anchor.signature, slot: null, memo, confirmed: anchor.confirmed,
    });
    anchorIds.push(anchorId);

    // Read the memo BACK FROM CHAIN (do not trust our DB) and confirm extension.
    const fetched = await fetchAnchorMemo(rpc, anchor.signature, LIVE_MEMO_PROGRAM as string);
    const parsed = fetched ? parseAnchorMemo(fetched.memo) : null;
    const onChainMatches = !!parsed && parsed.kind === "audit-head" && parsed.hashHex === head.entryHashHex && parsed.ref === head.seq;
    // MEDIUM #2: the anchor tx must be SIGNED by the KNOWN publisher/anchor key.
    const anchorAddr = addressFromPublicKey(publisher.publicKey);
    const signerOk = !!fetched && anchorSignedBy(fetched, anchorAddr);
    const ext = checkExtendsAnchor(suffix, parsed?.ref ?? "0", parsed?.hashHex ?? "", { auditPubkey: audit.publicKey, initialPrevHash: startPrev });
    expect(
      "phase3_anchor_onchain_extends",
      anchor.confirmed && suffixChain.ok && onChainMatches && signerOk && ext.ok,
      `confirmed=${anchor.confirmed} suffix=${suffixChain.ok} onchain=${onChainMatches} signer=${signerOk}(${fetched?.feePayer}) extends=${ext.ok}`,
    );

    // Rewrite detection: mutate a row's content + re-chain -> no longer extends.
    const rewritten = suffix.map((r) => ({ ...r }));
    let prev: Buffer = startPrev;
    for (let i = 0; i < rewritten.length; i++) {
      if (i === 0) (rewritten[i].entry as { event: string }).event = "m6.REWRITTEN";
      rewritten[i].prevHash = prev;
      rewritten[i].entryHash = computeEntryHash(prev, rewritten[i].entry);
      rewritten[i].signature = Buffer.from(audit.sign(rewritten[i].entryHash));
      prev = rewritten[i].entryHash;
    }
    const extBad = checkExtendsAnchor(rewritten, head.seq, head.entryHashHex, { auditPubkey: audit.publicKey, initialPrevHash: startPrev });
    expect("phase3_rewrite_detected", extBad.ok === false && extBad.hashMatches === false, `extends=${extBad.ok}`);

    // ---- Phase 4: live reserves vs ledger liability ----
    log("Phase 4: reserves — live on-chain holdings vs ledger liability");
    const funderArr = JSON.parse(readFileSync(process.env.FUNDER_KEYPAIR ?? "/home/vilenarios/source/solana-ar-io/keys/staging/authority-keypair.json", "utf8")) as number[];
    const funder = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(funderArr.slice(0, 32)));
    const liab = await readLiabilities(db.pool);
    const mint = await createMint(funder, funder.address);
    const coldOwner = await generateKeyPairSigner();
    const coldAta = await getAssociatedTokenAddress(coldOwner.address, mint);
    await sendTx([createAtaIdempotentIx({ payer: funder.address, ata: coldAta, owner: coldOwner.address, mint })], funder);
    // Fund the cold reserve to cover the live outstanding liability (+1 ARIO buffer).
    await mintTo(funder, mint, coldAta, liab.outstandingMario + ONE_TOKEN);

    const hotOwner = await generateKeyPairSigner(); // unfunded hot float
    const rCovered = await computeReserves({
      pool: db.pool, gateway, rpc, network: config.network, mint,
      hotDispenser: hotOwner.address, coldReserve: coldOwner.address, antCheck: { mode: "off" },
    });
    log("reserves(covered)", { totalReserve: rCovered.reserves.totalReserveMario, outstanding: rCovered.liabilities.outstandingMario, covered: rCovered.coverage.tokenVaultCovered });
    // Balance was read LIVE; compare to what we minted (on-chain truth).
    const liveCold = await gateway.getTokenBalance(coldAta);
    expect(
      "phase4_reserves_live_covers_liability",
      rCovered.coverage.tokenVaultCovered === true &&
        rCovered.reserves.coldReserveMario === liveCold.toString() &&
        liveCold === liab.outstandingMario + ONE_TOKEN,
      `covered=${rCovered.coverage.tokenVaultCovered} cold=${rCovered.reserves.coldReserveMario} live=${liveCold}`,
    );

    // Unfunded owners -> NOT covered (if there is any outstanding liability).
    const rShort = await computeReserves({
      pool: db.pool, gateway, rpc, network: config.network, mint,
      hotDispenser: hotOwner.address, antCheck: { mode: "off" },
    });
    expect("phase4_reserves_shortfall_flagged", liab.outstandingMario === 0n || rShort.coverage.tokenVaultCovered === false, `covered=${rShort.coverage.tokenVaultCovered} outstanding=${liab.outstandingMario}`);

    // Live ANT-ownership read primitive.
    const antAsset = await createCoreAsset(funder, funder);
    const owner = await readCoreOwner(rpc, antAsset);
    expect("phase4_live_ant_owner_read", owner === funder.address, `owner=${owner} authority=${funder.address}`);
  } finally {
    // ALWAYS restore the shared DB (even on a mid-run failure): our appended rows
    // are the tail, so deleting them is safe; drop our published_ledger + anchors.
    setAuditSigner(null);
    log("cleanup: restoring shared DB (delete appended rows + our records)");
    try {
      if (appendedSeqs.length) await db.pool.query("DELETE FROM audit_log WHERE seq = ANY($1::bigint[])", [appendedSeqs]);
      if (publishedIds.length) await db.pool.query("DELETE FROM published_ledger WHERE id = ANY($1::bigint[])", [publishedIds]);
      if (anchorIds.length) await db.pool.query("DELETE FROM audit_anchors WHERE id = ANY($1::bigint[])", [anchorIds]);
    } catch (e) {
      log("cleanup error (non-fatal)", (e as Error).message);
    }
    await db.close();
  }

  console.log("\n==== M6 LIVE PROOF RESULTS ====");
  console.log(JSON.stringify(results, null, 2));
  if (fail.length) {
    console.error(`\nFAILURES: ${fail.join(", ")}`);
    process.exit(1);
  }
  console.log("\nALL LIVE PHASES PASSED");
}

main().catch((err) => {
  console.error("m6 proof failed:", err);
  process.exit(1);
});
