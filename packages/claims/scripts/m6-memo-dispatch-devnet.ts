//! HIGH-fix proof: a DEFAULT-CONFIG (memo ON) token dispatch through the REAL
//! DispatchWorker references the LIVE memo program and the memo LANDS on devnet.
//!
//! Before the fix, MEMO_PROGRAM was the dead "v2" id (getAccountInfo -> null) and
//! includeMemo defaults ON, so a default production dispatch would reference a
//! nonexistent program and FAIL. This drives a real token dispense with the memo
//! ENABLED (worker default) and asserts the dispensing tx confirmed AND its logs
//! show the live Memo1Uhk program + the `ar.io-claim:<id>` memo.
//!
//! Run: DATABASE_URL=... NETWORK=solana-devnet SOLANA_RPC_URL=https://api.devnet.solana.com \
//!      FUNDER_KEYPAIR=/home/vilenarios/source/solana-ar-io/keys/staging/authority-keypair.json \
//!      tsx scripts/m6-memo-dispatch-devnet.ts

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import bs58 from "bs58";
import {
  AccountRole,
  appendTransactionMessageInstructions,
  addSignersToTransactionMessage,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type IInstruction,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
  type TransactionSigner,
} from "@solana/kit";

import { loadConfig } from "../src/config.js";
import { createDb, type Db } from "../src/db.js";
import { SolanaChainGateway } from "../src/dispatch/chain.js";
import { FloatManager, type FloatPolicy } from "../src/dispatch/float.js";
import { DispatchWorker } from "../src/dispatch/worker.js";
import { InMemoryKeypairSigner, type SignerRegistry } from "../src/dispatch/signer.js";
import {
  MEMO_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  createAtaIdempotentIx,
  getAssociatedTokenAddress,
} from "../src/dispatch/instructions.js";

const ONE_TOKEN = 1_000_000n;
const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const WS_URL = process.env.SOLANA_WS_URL ?? RPC_URL.replace("https", "wss").replace("http", "ws");
const rpc = createSolanaRpc(RPC_URL) as Rpc<SolanaRpcApi>;
const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
const ADDR = getAddressEncoder();
const enc = (a: Address): Uint8Array => new Uint8Array(ADDR.encode(a));
const u64 = (n: bigint): Uint8Array => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
const log = (m: string, e?: unknown): void => console.log(`  ${m}${e !== undefined ? " " + JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) : ""}`);

async function sendTx(ixs: IInstruction[], feePayer: TransactionSigner, extra: TransactionSigner[] = []): Promise<void> {
  const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
    (m) => (extra.length ? addSignersToTransactionMessage(extra, m) : m),
  );
  await sendAndConfirm(await signTransactionMessageWithSigners(msg), { commitment: "confirmed" });
}
async function fundFromFunder(target: Address, sol: number): Promise<void> {
  const fp = process.env.FUNDER_KEYPAIR ?? "/home/vilenarios/source/solana-ar-io/keys/staging/authority-keypair.json";
  const funder = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array((JSON.parse(readFileSync(fp, "utf8")) as number[]).slice(0, 32)));
  await sendTx([{ programAddress: SYSTEM_PROGRAM, accounts: [{ address: funder.address, role: AccountRole.WRITABLE_SIGNER }, { address: target, role: AccountRole.WRITABLE }], data: new Uint8Array([2, 0, 0, 0, ...u64(BigInt(Math.floor(sol * 1e9)))]) }], funder);
}
async function createMint(payer: KeyPairSigner, auth: Address): Promise<Address> {
  const mint = await generateKeyPairSigner();
  const rent = await rpc.getMinimumBalanceForRentExemption(82n).send();
  await sendTx([
    { programAddress: SYSTEM_PROGRAM, accounts: [{ address: payer.address, role: AccountRole.WRITABLE_SIGNER }, { address: mint.address, role: AccountRole.WRITABLE_SIGNER }], data: new Uint8Array([0, 0, 0, 0, ...u64(BigInt(rent)), ...u64(82n), ...enc(TOKEN_PROGRAM)]) },
    { programAddress: TOKEN_PROGRAM, accounts: [{ address: mint.address, role: AccountRole.WRITABLE }], data: new Uint8Array([20, 6, ...enc(auth), 0]) },
  ], payer, [mint]);
  return mint.address;
}
async function mintTo(payer: KeyPairSigner, mint: Address, dest: Address, amount: bigint): Promise<void> {
  await sendTx([{ programAddress: TOKEN_PROGRAM, accounts: [{ address: mint, role: AccountRole.WRITABLE }, { address: dest, role: AccountRole.WRITABLE }, { address: payer.address, role: AccountRole.READONLY_SIGNER }], data: new Uint8Array([7, ...u64(amount)]) }], payer, [payer]);
}
async function tokenBalance(ata: Address): Promise<bigint> {
  try { return BigInt((await rpc.getTokenAccountBalance(ata).send()).value.amount); } catch { return 0n; }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
  const config = loadConfig();
  const db: Db = createDb(config.databaseUrl);
  const gateway = new SolanaChainGateway(rpc);
  const cleanupAssets: string[] = [];
  const cleanupRecipients: string[] = [];
  let ok = false;
  let detail = "";

  try {
    const payer = await generateKeyPairSigner();
    const hotSeed = new Uint8Array(randomBytes(32));
    const hotSigner = await InMemoryKeypairSigner.fromSeed("token", hotSeed);
    const hotKp = await createKeyPairSignerFromPrivateKeyBytes(hotSeed);
    log("funding payer + hot signer from FUNDER");
    await fundFromFunder(payer.address, 0.05);
    await fundFromFunder(hotKp.address, 0.05);

    const mint = await createMint(payer, payer.address); // payer is the mint authority
    const hotAta = await getAssociatedTokenAddress(hotKp.address, mint);
    await sendTx([createAtaIdempotentIx({ payer: hotKp.address, ata: hotAta, owner: hotKp.address, mint })], hotKp);
    // Fund above the shared DB's global in-flight `reserved` (FloatManager sums
    // ALL verified+dispatching token/vault claims) so this claim isn't deferred.
    await mintTo(payer, mint, hotAta, 400_000n * ONE_TOKEN);
    log("hot float", { hotAta, bal: (await tokenBalance(hotAta)).toString() });

    // Seed a verified token claim.
    const recipientId = `memo_${randomBytes(6).toString("hex")}`;
    await db.pool.query("INSERT INTO recipients (recipient_id, protocol, source_address, recipient_pubkey, status) VALUES ($1,1,$1,$2,'open')", [recipientId, Buffer.from(randomBytes(20))]);
    const assetKey = randomBytes(32).toString("hex");
    await db.pool.query("INSERT INTO assets (asset_key, asset_type, recipient_id, amount, nonce, status, source) VALUES ($1,'token',$2,$3,$4,'claiming',$5::jsonb)", [assetKey, recipientId, (1234n * ONE_TOKEN).toString(), randomBytes(32), JSON.stringify({ phase: "token", onchainSeed: "escrow_token", proof: true })]);
    const claimant = await generateKeyPairSigner();
    const cr = await db.pool.query<{ claim_id: string }>("INSERT INTO claims (asset_key, claimant, canonical_message, recipient_id, protocol, status, verified_at) VALUES ($1,$2,$3,$4,1,'verified',now()) RETURNING claim_id", [assetKey, claimant.address, Buffer.from("proof"), recipientId]);
    cleanupAssets.push(assetKey); cleanupRecipients.push(recipientId);
    const claimId = cr.rows[0].claim_id;

    // DEFAULT config: includeMemo NOT set => memo ON (the production default).
    const policy: FloatPolicy = { capMario: 500_000n * ONE_TOKEN, bigClaimThresholdMario: 100_000n * ONE_TOKEN, refillThresholdMario: 100_000n * ONE_TOKEN };
    const signers: SignerRegistry = { token: hotSigner };
    const worker = new DispatchWorker({
      pool: db.pool, gateway, signers, float: new FloatManager(policy), config, mint,
      vaultDurations: { minVaultDuration: BigInt(14 * 86_400), maxVaultDuration: BigInt(365 * 86_400) },
      antRequiresApproval: true, // includeMemo omitted -> defaults ON
      log: (m, e) => log(`worker: ${m}`, e),
    });

    const res = await worker.processClaim(claimId);
    log("processClaim result", res);
    const claimantAta = await getAssociatedTokenAddress(claimant.address, mint);
    const bal = await tokenBalance(claimantAta);
    if (!res.signature) { detail = `no signature — outcome=${res.outcome} ${res.detail ?? ""}`; throw new Error(detail); }

    // Inspect the dispensing tx: it MUST reference the live memo program AND carry
    // the `ar.io-claim:<id>` memo. The v1 memo program does not LOG the text, so
    // decode the memo instruction data (base58) directly from the tx message.
    const sig = res.signature as string;
    const tx = (await (rpc as unknown as { getTransaction: (s: string, c: unknown) => { send: () => Promise<{
      meta: { err: unknown; logMessages?: string[] } | null;
      transaction: { message: { accountKeys: string[]; instructions: { programIdIndex: number; data: string }[] } };
    } | null> } })
      .getTransaction(sig, { maxSupportedTransactionVersion: 0, encoding: "json", commitment: "confirmed" }).send());
    const logs = tx?.meta?.logMessages ?? [];
    const memoInvoked = logs.some((l) => l.includes(`Program ${MEMO_PROGRAM} invoke`) && !l.includes("failed"));
    let memoText = false;
    for (const ix of tx?.transaction.message.instructions ?? []) {
      if (tx!.transaction.message.accountKeys[ix.programIdIndex] === (MEMO_PROGRAM as string)) {
        memoText = new TextDecoder().decode(bs58.decode(ix.data)) === `ar.io-claim:${claimId}`;
      }
    }

    ok = res.outcome === "confirmed" && bal === 1234n * ONE_TOKEN && memoInvoked && memoText && tx?.meta?.err === null;
    detail = `outcome=${res.outcome} bal=${bal} memoProgram=${MEMO_PROGRAM} memoInvoked=${memoInvoked} memoText=${memoText} sig=${sig}`;
    log(memoInvoked ? "memo program invoked in dispensing tx" : "MEMO NOT INVOKED", { program: MEMO_PROGRAM });
  } finally {
    if (cleanupAssets.length) {
      await db.pool.query("DELETE FROM audit_log WHERE entry->>'assetKey' = ANY($1)", [cleanupAssets]).catch(() => {});
      await db.pool.query("DELETE FROM claims WHERE asset_key = ANY($1)", [cleanupAssets]).catch(() => {});
      await db.pool.query("DELETE FROM assets WHERE asset_key = ANY($1)", [cleanupAssets]).catch(() => {});
      await db.pool.query("DELETE FROM recipients WHERE recipient_id = ANY($1)", [cleanupRecipients]).catch(() => {});
    }
    await db.close();
  }

  console.log(`\n[${ok ? "PASS" : "FAIL"}] default-config (memo ON) dispatch uses the LIVE memo program — ${detail}`);
  if (!ok) process.exit(1);
  console.log("\nHIGH memo-fix proof PASSED");
}

main().catch((e) => { console.error("memo dispatch proof failed:", e); process.exit(1); });
