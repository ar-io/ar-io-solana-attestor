//! FULL end-to-end STAGING REHEARSAL (M7 headline deliverable).
//!
//! One scripted run that proves the WHOLE ar-io-claims system works together on a
//! real SVM: it stands up a CLEAN dedicated Postgres (so the audit_log is
//! append-only for the transparency proofs), seeds a REPRESENTATIVE ledger with
//! identities we control the keys for, drives the FULL claim matrix through the
//! REAL HTTP API + the REAL DispatchWorker on-chain, then runs reconcile +
//! publish-ledger + audit-anchor + reserves and verifies each as a third party.
//!
//! MATRIX (each: lookup -> initiate -> sign -> complete -> dispatch -> on-chain):
//!   1  AR-token         -> confirmed, claimant ATA balance == amount
//!   2  AR-ANT           -> gated -> approve -> cold-batch -> Owner+UA == claimant
//!   3  ETH-token        -> confirmed, balance == amount
//!   4  ETH-ANT          -> gated -> approve -> cold-batch -> Owner+UA == claimant
//!   5  vault-active     -> re-lock ROUTED to operator (never silently liquid)
//!   6  vault-expired    -> confirmed liquid, balance == amount
//!   7  >100k claim      -> complete=pending_review -> operator approve -> confirmed
//!   8  ANT cold-batch   -> a SINGLE runAntBatch(cold) dispenses BOTH ANTs at once
//!   9  AR-ANT OPERATOR-WALLET -> buildAntBatch (treasury fee-payer, txid known) ->
//!         operator wallet signs (sign-only) -> submitAntBatch -> on-chain Owner+UA
//!         == claimant, DB confirmed/claimed, memo ar.io-claim:<id> on the landed tx.
//!         The ANT authority key never lives on the server; the treasury pays the fee.
//! Then: reconcile-dispatch PASS; publish signed ledger + third-party verify +
//! membership; anchor audit head on-chain + read-back + extension check + signer
//! pin; reserves endpoint (holdings >= liabilities).
//!
//! Run (devnet, funded by the staging authority):
//!   NETWORK=solana-devnet SOLANA_RPC_URL=https://api.devnet.solana.com \
//!   SOLANA_WS_URL=wss://api.devnet.solana.com \
//!   FUNDER_KEYPAIR=/home/vilenarios/source/solana-ar-io/keys/staging/authority-keypair.json \
//!   DATABASE_URL=postgres://claims:claims@localhost:5432/claims \
//!     tsx scripts/staging-rehearsal.ts
//! (or against a surfpool mainnet-fork localnet: SOLANA_RPC_URL=http://127.0.0.1:8899,
//!  no FUNDER_KEYPAIR — SOL comes from airdrops.)
//!
//! Row 9 (operator-wallet ANT) needs NO extra manual keys: the leg GENERATES the
//! devnet ANT-authority keypair internally (it stands in for the operator's Phantom
//! — it both owns the minted asset and signs the batch, and holds ZERO SOL because
//! the treasury is the fee payer). `ANT_DISPATCH_MODE=operator-wallet` is implied by
//! running this leg (it drives buildAntBatch/submitAntBatch directly, not the worker).
//! The FUNDER (or airdrop) funds the treasury for the trivial ANT base fee.

import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { Client } from "pg";
import {
  AccountRole,
  address,
  airdropFactory,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionDecoder,
  lamports,
  partiallySignTransaction,
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

import type { Config, Network } from "../src/config.js";
import { createDb, type Db } from "../src/db.js";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import { SolanaChainGateway } from "../src/dispatch/chain.js";
import { FloatManager, type FloatPolicy } from "../src/dispatch/float.js";
import { DispatchWorker } from "../src/dispatch/worker.js";
import { InMemoryKeypairSigner, type SignerRegistry } from "../src/dispatch/signer.js";
import {
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  MPL_CORE_PROGRAM,
  MEMO_PROGRAM,
  createAtaIdempotentIx,
  getAssociatedTokenAddress,
} from "../src/dispatch/instructions.js";
import { buildAntBatch, submitAntBatch } from "../src/dispatch/ant-operator.js";
import {
  makeArIdentity,
  makeEthIdentity,
  signArCanonical,
  signEthCanonical,
  type ArIdentity,
  type EthIdentity,
} from "../src/api/proof-testkit.js";
import { reconcileDispatch } from "../src/dispatch/reconcile-dispatch.js";
import { buildLeavesFromDb, persistPublishedLedger, recordAnchor } from "../src/transparency/store.js";
import { buildLedgerArtifact, proveMembership, verifyLedgerArtifact, verifyMembership } from "../src/transparency/ledger-artifact.js";
import { toHex } from "../src/transparency/merkle.js";
import { keypairFromSeed, assertTransparencyKeysSeparable, transparencyAddress } from "../src/transparency/keys.js";
import {
  signUnsignedAuditRows,
  verifyAuditChain,
  loadAuditRows,
  getAuditHead,
  checkExtendsAnchor,
} from "../src/transparency/audit-chain.js";
import { auditHeadMemo, anchorMemoWithRpc, fetchAnchorMemo, anchorSignedBy, addressFromPublicKey } from "../src/transparency/anchor.js";
import { computeReserves } from "../src/transparency/reserves.js";

const ONE_TOKEN = 1_000_000n;
const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const WS_URL = process.env.SOLANA_WS_URL ?? RPC_URL.replace("https", "wss").replace("http", "ws");
const NETWORK = (process.env.NETWORK ?? "solana-devnet") as Network;
const FUNDER_KEYPAIR = process.env.FUNDER_KEYPAIR;
const OUT_DIR = process.env.REHEARSAL_OUT ?? new URL("./rehearsal-out/", import.meta.url).pathname;

const rpc = createSolanaRpc(RPC_URL) as Rpc<SolanaRpcApi>;
const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
const airdrop = airdropFactory({ rpc, rpcSubscriptions });
const ADDR_ENCODER = getAddressEncoder();
const ADDR_DECODER = getAddressDecoder();

const results: Record<string, string> = {};
const artifacts: Record<string, unknown> = {};
const failures: string[] = [];
function expect(name: string, cond: boolean, detail?: string): void {
  results[name] = cond ? "PASS" : `FAIL${detail ? ": " + detail : ""}`;
  if (!cond) failures.push(name);
  // eslint-disable-next-line no-console
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}
function log(msg: string, extra?: unknown): void {
  // eslint-disable-next-line no-console
  console.log(`\n== ${msg} ==${extra !== undefined ? " " + JSON.stringify(extra, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) : ""}`);
}

// --------------------------------------------------------------------------
// On-chain helpers (setup only; not product code — same shape as the M4 proof).
// --------------------------------------------------------------------------
function u32le(n: number): Uint8Array { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; }
function u64le(n: bigint): Uint8Array { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; }
function encodeAddr(a: Address): Uint8Array { return new Uint8Array(ADDR_ENCODER.encode(a)); }

async function sendTx(ixs: IInstruction[], feePayer: TransactionSigner, extra: TransactionSigner[] = []): Promise<string> {
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

async function fundLamports(target: Address, lamps: bigint, funder?: KeyPairSigner): Promise<void> {
  if (funder) {
    const ix: IInstruction = {
      programAddress: SYSTEM_PROGRAM,
      accounts: [
        { address: funder.address, role: AccountRole.WRITABLE_SIGNER },
        { address: target, role: AccountRole.WRITABLE },
      ],
      data: new Uint8Array([2, 0, 0, 0, ...u64le(lamps)]),
    };
    await sendTx([ix], funder);
  } else {
    await airdrop({ recipientAddress: target, lamports: lamports(lamps), commitment: "confirmed" });
  }
}

async function createMint(payer: KeyPairSigner, mintAuthority: Address, decimals: number): Promise<Address> {
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
  await sendTx([createAccount, initMint2], payer, [mint]);
  return mint.address;
}
async function mintTo(payer: KeyPairSigner, mint: Address, dest: Address, mintAuthority: KeyPairSigner, amount: bigint): Promise<void> {
  const ix: IInstruction = {
    programAddress: TOKEN_PROGRAM,
    accounts: [
      { address: mint, role: AccountRole.WRITABLE },
      { address: dest, role: AccountRole.WRITABLE },
      { address: mintAuthority.address, role: AccountRole.READONLY_SIGNER },
    ],
    data: new Uint8Array([7, ...u64le(amount)]),
  };
  await sendTx([ix], payer, [mintAuthority]);
}
async function createAta(payer: KeyPairSigner, owner: Address, mint: Address): Promise<Address> {
  const ata = await getAssociatedTokenAddress(owner, mint);
  await sendTx([createAtaIdempotentIx({ payer: payer.address, ata, owner, mint })], payer);
  return ata;
}
async function tokenBalance(ata: Address): Promise<bigint> {
  try { const r = await rpc.getTokenAccountBalance(ata).send(); return BigInt(r.value.amount); } catch { return 0n; }
}
/** Poll the balance until it reaches `want` (or tries run out) — absorbs the
 *  read-after-"confirmed" propagation lag on a public/pooled devnet RPC where a
 *  just-created ATA can briefly read 0 from a lagging replica. */
async function balanceAtLeast(ata: Address, want: bigint, tries = 15): Promise<bigint> {
  let bal = 0n;
  for (let i = 0; i < tries; i++) {
    bal = await tokenBalance(ata);
    if (bal >= want) return bal;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return bal;
}
async function createCoreAsset(payer: KeyPairSigner, owner: KeyPairSigner, name: string): Promise<Address> {
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
  await sendTx([ix], payer, [asset, owner]);
  return asset.address;
}
async function readCoreOwnerUA(asset: Address): Promise<{ owner: string; ua: string }> {
  const r = await rpc.getAccountInfo(asset, { encoding: "base64" }).send();
  if (!r.value) throw new Error("asset not found");
  const raw = Buffer.from(r.value.data[0], "base64");
  const uaTag = raw[33];
  return {
    owner: ADDR_DECODER.decode(raw.subarray(1, 33)) as string,
    ua: uaTag === 1 ? (ADDR_DECODER.decode(raw.subarray(34, 66)) as string) : `tag:${uaTag}`,
  };
}

// --------------------------------------------------------------------------
// Clean dedicated rehearsal DB (append-only audit_log for the transparency proofs).
// --------------------------------------------------------------------------
function rehearsalDbUrl(base: string): { rehearsal: string; maintenance: string; dbName: string } {
  const dbName = "claims_rehearsal";
  const rehearsal = new URL(base); rehearsal.pathname = `/${dbName}`;
  const maintenance = new URL(base); // connect to the base DB to DROP/CREATE the rehearsal one
  return { rehearsal: rehearsal.toString(), maintenance: maintenance.toString(), dbName };
}
async function recreateDb(maintenance: string, dbName: string): Promise<void> {
  const c = new Client({ connectionString: maintenance });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await c.query(`CREATE DATABASE ${dbName}`);
  await c.end();
}
async function migrate(rehearsalUrl: string): Promise<void> {
  const dir = new URL("../migrations/", import.meta.url).pathname;
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const c = new Client({ connectionString: rehearsalUrl });
  await c.connect();
  for (const f of files) {
    const sql = readFileSync(dir + f, "utf8").split("-- Down Migration")[0];
    await c.query(sql);
  }
  await c.end();
}

// --------------------------------------------------------------------------
// DB seeding (into the clean rehearsal DB).
// --------------------------------------------------------------------------
let db: Db;
async function seedRecipientAr(id: ArIdentity): Promise<void> {
  await db.pool.query(
    `INSERT INTO recipients (recipient_id, protocol, source_address, recipient_pubkey, status)
     VALUES ($1, 0, $1, $2, 'open') ON CONFLICT (recipient_id) DO NOTHING`,
    [id.recipientId, Buffer.from(id.modulus)],
  );
}
async function seedRecipientEth(id: EthIdentity): Promise<void> {
  await db.pool.query(
    `INSERT INTO recipients (recipient_id, protocol, source_address, recipient_pubkey, status)
     VALUES ($1, 1, $2, $3, 'open') ON CONFLICT (recipient_id) DO NOTHING`,
    [id.recipientId, id.addressLower, Buffer.from(id.address)],
  );
}
async function seedAsset(recipientId: string, a: { assetKey: string; assetType: "token" | "vault" | "ant"; amount?: bigint; vaultEndTs?: number; antMint?: string }): Promise<void> {
  await db.pool.query(
    `INSERT INTO assets (asset_key, asset_type, recipient_id, ant_mint, amount, vault_end_ts, nonce, status, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'available',$8::jsonb)`,
    [a.assetKey, a.assetType, recipientId, a.antMint ?? null,
      a.amount === undefined ? null : a.amount.toString(), a.vaultEndTs ?? null,
      randomBytes(32), JSON.stringify({ rehearsal: true, phase: a.assetType })],
  );
}

// --------------------------------------------------------------------------
// The full API claim drive: lookup -> initiate -> sign -> complete.
// --------------------------------------------------------------------------
type Proof =
  | { protocol: "arweave"; rsaSignatureBase64Url: string; rsaModulusBase64Url: string; saltLength: number }
  | { protocol: "ethereum"; signatureHex: string };

async function driveComplete(
  app: FastifyInstance,
  opts: { recipientId: string; assetKey: string; claimant: string; sign: (canonical: Uint8Array) => Proof },
): Promise<{ claimId: string; status: string }> {
  // lookup
  const look = await app.inject({ method: "GET", url: `/v1/claimable?recipientId=${opts.recipientId}` });
  if (look.statusCode !== 200) throw new Error(`lookup ${look.statusCode}: ${look.body}`);
  const found = look.json().assets.some((x: { assetKey: string }) => x.assetKey === opts.assetKey);
  if (!found) throw new Error(`asset ${opts.assetKey} not in lookup`);
  // initiate
  const init = await app.inject({ method: "POST", url: "/v1/claims/initiate", payload: { assetKey: opts.assetKey, claimant: opts.claimant } });
  if (init.statusCode !== 201) throw new Error(`initiate ${init.statusCode}: ${init.body}`);
  const { claimId, canonicalMessageHex, nonceHex } = init.json();
  // sign the SERVER canonical
  const proof = opts.sign(Buffer.from(canonicalMessageHex, "hex"));
  // complete
  const done = await app.inject({ method: "POST", url: "/v1/claims/complete", payload: { claimId, nonceHex, proof } });
  if (done.statusCode !== 202) throw new Error(`complete ${done.statusCode}: ${done.body}`);
  return { claimId, status: done.json().status };
}

function arProof(id: ArIdentity): (c: Uint8Array) => Proof {
  return (canonical) => ({
    protocol: "arweave",
    rsaSignatureBase64Url: Buffer.from(signArCanonical(id.privateKey, canonical, 32)).toString("base64url"),
    rsaModulusBase64Url: Buffer.from(id.modulus).toString("base64url"),
    saltLength: 32,
  });
}
// ETH uses `driveEth` (async signer); AR uses the sync `sign` thunk of driveComplete.

// --------------------------------------------------------------------------
async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required (base DB; the rehearsal DB is derived from it)");
  mkdirSync(OUT_DIR, { recursive: true });
  log("Rehearsal config", { network: NETWORK, rpc: RPC_URL, funded: FUNDER_KEYPAIR ? "funder-transfer" : "airdrop" });

  // ---- clean dedicated DB ----
  const { rehearsal, maintenance, dbName } = rehearsalDbUrl(process.env.DATABASE_URL);
  await recreateDb(maintenance, dbName);
  await migrate(rehearsal);
  db = createDb(rehearsal);
  log("Clean rehearsal DB ready (append-only audit_log)", { dbName });

  const config: Config = {
    port: 0, host: "127.0.0.1", logLevel: "silent", network: NETWORK, databaseUrl: rehearsal,
    solanaRpcUrl: RPC_URL, challengeTtlMs: 900_000, bigClaimThresholdMario: 100_000n * ONE_TOKEN,
    rateLimitPerMin: 1e9, rateLimitIdentityPerMin: 1e9, corsOrigin: "*",
  };
  const app = buildApp({ config, db });
  await app.ready();

  // ---- keys: five distinct roles ----
  const funder = FUNDER_KEYPAIR ? await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(FUNDER_KEYPAIR, "utf8")))) : undefined;
  const payer = await generateKeyPairSigner();
  const hotSeed = new Uint8Array(randomBytes(32));
  const antSeed = new Uint8Array(randomBytes(32));
  const hotSigner = await InMemoryKeypairSigner.fromSeed("token", hotSeed);
  const antSigner = await InMemoryKeypairSigner.fromSeed("ant", antSeed);
  const hotKp = await createKeyPairSignerFromPrivateKeyBytes(hotSeed);
  const antKp = await createKeyPairSignerFromPrivateKeyBytes(antSeed);
  const coldReserveKp = await generateKeyPairSigner();
  const auditKey = keypairFromSeed("audit", new Uint8Array(randomBytes(32)));
  const publisherKey = keypairFromSeed("publisher", new Uint8Array(randomBytes(32)));
  assertTransparencyKeysSeparable(auditKey, publisherKey);
  // token-only production posture: the cold ANT authority is operator-supplied per batch.
  const signers: SignerRegistry = { token: hotSigner };

  // The publisher/anchor key fee-pays the on-chain audit anchor memo tx.
  const publisherAnchorAddr = address(addressFromPublicKey(publisherKey.publicKey));
  log("Funding SOL (payer, hot, ant, cold, publisher/anchor — rent + fees)…");
  for (const a of [payer.address, hotKp.address, antKp.address, coldReserveKp.address, publisherAnchorAddr]) {
    await fundLamports(a, 300_000_000n, funder); // 0.3 SOL each — plenty for rent+fees, re-runnable
  }

  // ---- on-chain: ARIO mint + hot float + cold reserve ----
  log("Create ARIO mint + fund the hot float (300k) + cold reserve (1M)");
  const mint = await createMint(payer, payer.address, 6);
  const hotAta = await createAta(hotKp, hotKp.address, mint);
  await mintTo(payer, mint, hotAta, payer, 300_000n * ONE_TOKEN);
  const coldAta = await createAta(coldReserveKp, coldReserveKp.address, mint);
  await mintTo(payer, mint, coldAta, payer, 1_000_000n * ONE_TOKEN);
  expect("setup_float_funded", (await tokenBalance(hotAta)) === 300_000n * ONE_TOKEN, `hot=${await tokenBalance(hotAta)}`);

  const policy: FloatPolicy = { capMario: 500_000n * ONE_TOKEN, bigClaimThresholdMario: 100_000n * ONE_TOKEN, refillThresholdMario: 60_000n * ONE_TOKEN };
  const gateway = new SolanaChainGateway(rpc);
  const worker = new DispatchWorker({
    pool: db.pool, gateway, signers, float: new FloatManager(policy), config, mint,
    vaultDurations: { minVaultDuration: BigInt(14 * 86_400), maxVaultDuration: BigInt(365 * 86_400) },
    antRequiresApproval: true,
    log: () => {},
  });

  // ---- identities (we control the keys, so we can sign the server canonical) ----
  const arTokenId = makeArIdentity();
  const arAntId = makeArIdentity();
  const ethTokenId = makeEthIdentity();
  const ethAntId = makeEthIdentity();
  const arVaultId = makeArIdentity();
  const ethBigId = makeEthIdentity();
  await Promise.all([
    seedRecipientAr(arTokenId), seedRecipientAr(arAntId), seedRecipientAr(arVaultId),
    seedRecipientEth(ethTokenId), seedRecipientEth(ethAntId), seedRecipientEth(ethBigId),
  ]);

  const claimant = async (): Promise<string> => (await generateKeyPairSigner()).address;
  const now = Math.floor(Date.now() / 1000);

  // ---- Row 1: AR-token ----
  log("Row 1: AR-token");
  const c1 = await claimant();
  const ak1 = randomBytes(32).toString("hex");
  await seedAsset(arTokenId.recipientId, { assetKey: ak1, assetType: "token", amount: 1234n * ONE_TOKEN });
  const d1 = await driveComplete(app, { recipientId: arTokenId.recipientId, assetKey: ak1, claimant: c1, sign: arProof(arTokenId) });
  const r1 = await worker.processClaim(d1.claimId);
  const bal1 = await balanceAtLeast(await getAssociatedTokenAddress(address(c1), mint), 1234n * ONE_TOKEN);
  expect("row1_ar_token", d1.status === "verified" && r1.outcome === "confirmed" && bal1 === 1234n * ONE_TOKEN, `complete=${d1.status} dispatch=${r1.outcome} bal=${bal1} sig=${r1.signature}`);
  if (r1.signature) artifacts.row1_tx = r1.signature;

  // ---- Row 3: ETH-token ----
  log("Row 3: ETH-token");
  const c3 = await claimant();
  const ak3 = randomBytes(32).toString("hex");
  await seedAsset(ethTokenId.recipientId, { assetKey: ak3, assetType: "token", amount: 2000n * ONE_TOKEN });
  const d3 = await driveEth(app, ethTokenId, ak3, c3);
  const r3 = await worker.processClaim(d3.claimId);
  const bal3 = await balanceAtLeast(await getAssociatedTokenAddress(address(c3), mint), 2000n * ONE_TOKEN);
  expect("row3_eth_token", d3.status === "verified" && r3.outcome === "confirmed" && bal3 === 2000n * ONE_TOKEN, `complete=${d3.status} dispatch=${r3.outcome} bal=${bal3}`);
  if (r3.signature) artifacts.row3_tx = r3.signature;

  // ---- Row 6: vault-expired -> liquid ----
  log("Row 6: vault-expired (liquid)");
  const c6 = await claimant();
  const ak6 = randomBytes(32).toString("hex");
  await seedAsset(arVaultId.recipientId, { assetKey: ak6, assetType: "vault", amount: 5000n * ONE_TOKEN, vaultEndTs: now - 86_400 });
  const d6 = await driveComplete(app, { recipientId: arVaultId.recipientId, assetKey: ak6, claimant: c6, sign: arProof(arVaultId) });
  const r6 = await worker.processClaim(d6.claimId);
  const bal6 = await balanceAtLeast(await getAssociatedTokenAddress(address(c6), mint), 5000n * ONE_TOKEN);
  expect("row6_vault_expired_liquid", r6.outcome === "confirmed" && bal6 === 5000n * ONE_TOKEN, `dispatch=${r6.outcome} bal=${bal6}`);
  if (r6.signature) artifacts.row6_tx = r6.signature;

  // ---- Row 5: vault-active -> relock ROUTED to operator ----
  log("Row 5: vault-active (relock routed to operator)");
  const c5 = await claimant();
  const ak5 = randomBytes(32).toString("hex");
  await seedAsset(arVaultId.recipientId, { assetKey: ak5, assetType: "vault", amount: 3000n * ONE_TOKEN, vaultEndTs: now + 200 * 86_400 });
  const d5 = await driveComplete(app, { recipientId: arVaultId.recipientId, assetKey: ak5, claimant: c5, sign: arProof(arVaultId) });
  const r5 = await worker.processClaim(d5.claimId);
  const st5 = (await db.pool.query<{ status: string }>("SELECT status FROM assets WHERE asset_key=$1", [ak5])).rows[0].status;
  // An ACTIVE (still-locked) vault relock routes to the MANUAL operator delivery
  // queue (worker.ts `settlement.kind === "relock"`), NOT the big-claim brake:
  // outcome `awaiting_manual_vault_delivery`, asset held `pending_review`.
  expect("row5_vault_active_relock_routed", r5.outcome === "awaiting_manual_vault_delivery" && st5 === "pending_review", `dispatch=${r5.outcome} assetStatus=${st5}`);

  // ---- Row 7: >100k -> pending_review -> approve -> confirmed ----
  log("Row 7: >100k big-claim (review -> approve -> dispatch)");
  const c7 = await claimant();
  const ak7 = randomBytes(32).toString("hex");
  await seedAsset(ethBigId.recipientId, { assetKey: ak7, assetType: "token", amount: 150_000n * ONE_TOKEN });
  const d7 = await driveEth(app, ethBigId, ak7, c7);
  const r7a = await worker.processClaim(d7.claimId); // over-brake defensive route (already pending_review from complete)
  await DispatchWorker.approveClaim(db.pool, d7.claimId, "rehearsal-operator");
  const r7b = await worker.processClaim(d7.claimId);
  const bal7 = await balanceAtLeast(await getAssociatedTokenAddress(address(c7), mint), 150_000n * ONE_TOKEN);
  expect("row7_big_claim_review_approve_dispatch", d7.status === "pending_review" && r7b.outcome === "confirmed" && bal7 === 150_000n * ONE_TOKEN, `complete=${d7.status} preApprove=${r7a.outcome} postApprove=${r7b.outcome} bal=${bal7}`);
  if (r7b.signature) artifacts.row7_tx = r7b.signature;

  // ---- Rows 2 + 4 + 8: AR-ANT and ETH-ANT via a SINGLE cold-batch ----
  log("Rows 2/4/8: AR-ANT + ETH-ANT via cold-batch dispatch");
  const cAr = await claimant();
  const cEth = await claimant();
  const antMintAr = await createCoreAsset(antKp, antKp, "ar-ant");
  const antMintEth = await createCoreAsset(antKp, antKp, "eth-ant");
  await seedAsset(arAntId.recipientId, { assetKey: antMintAr as string, assetType: "ant", antMint: antMintAr as string });
  await seedAsset(ethAntId.recipientId, { assetKey: antMintEth as string, assetType: "ant", antMint: antMintEth as string });
  const dAr = await driveComplete(app, { recipientId: arAntId.recipientId, assetKey: antMintAr as string, claimant: cAr, sign: arProof(arAntId) });
  const dEth = await driveEth(app, ethAntId, antMintEth as string, cEth);
  // token-only worker -> both gate to awaiting_approval
  const gateAr = await worker.processClaim(dAr.claimId);
  const gateEth = await worker.processClaim(dEth.claimId);
  await DispatchWorker.approveClaim(db.pool, dAr.claimId, "rehearsal-operator");
  await DispatchWorker.approveClaim(db.pool, dEth.claimId, "rehearsal-operator");
  // ONE cold-batch dispenses BOTH approved ANTs with the operator-supplied cold key.
  const batch = await worker.runAntBatch(antSigner);
  const okAr = batch.find((x) => x.claimId === dAr.claimId)?.outcome === "confirmed";
  const okEth = batch.find((x) => x.claimId === dEth.claimId)?.outcome === "confirmed";
  const ownAr = await readCoreOwnerUA(antMintAr);
  const ownEth = await readCoreOwnerUA(antMintEth);
  expect("row2_ar_ant_cold_batch", okAr && gateAr.outcome === "awaiting_approval" && ownAr.owner === cAr && ownAr.ua === cAr, `owner=${ownAr.owner} ua=${ownAr.ua} claimant=${cAr}`);
  expect("row4_eth_ant_cold_batch", okEth && gateEth.outcome === "awaiting_approval" && ownEth.owner === cEth && ownEth.ua === cEth, `owner=${ownEth.owner} ua=${ownEth.ua} claimant=${cEth}`);
  expect("row8_cold_batch_dispenses_both", batch.filter((x) => x.outcome === "confirmed").length >= 2, `batch confirmed=${batch.filter((x) => x.outcome === "confirmed").length}`);

  // ---- Row 9: AR-ANT via OPERATOR-WALLET signing (buildAntBatch -> operator signs -> submitAntBatch) ----
  // The ANT authority key NEVER lives on the server. The operator's wallet (here a
  // locally-generated devnet keypair standing in for Phantom) both OWNS the asset and
  // signs the batch; the TREASURY (hot dispenser) is the fee payer, so the authority
  // wallet needs ZERO SOL. Exercises the real chain end-to-end: buildAntBatch (treasury
  // co-signs the fee-payer slot -> txid known + persisted) -> operator sign-only ->
  // submitAntBatch (server reconstructs from its stored message + broadcasts + confirms).
  log("Row 9: AR-ANT via operator-wallet signing (treasury fee-payer; authority in-wallet)");
  const antAuthorityKp = await generateKeyPairSigner(); // == the operator's Phantom (zero SOL)
  const arOpAntId = makeArIdentity();
  await seedRecipientAr(arOpAntId);
  const cOp = await claimant();
  // Mint a real MPL Core asset OWNED (owner + update-authority) by the operator authority.
  const opAntMint = await createCoreAsset(payer, antAuthorityKp, "op-ant");
  await seedAsset(arOpAntId.recipientId, { assetKey: opAntMint as string, assetType: "ant", antMint: opAntMint as string });
  // Drive the API to a genuine `verified` claim (asset -> claiming), same shape as the
  // other ANT legs, so buildAntBatch (ANT_REQUIRES_APPROVAL=false) picks it up.
  const dOp = await driveComplete(app, { recipientId: arOpAntId.recipientId, assetKey: opAntMint as string, claimant: cOp, sign: arProof(arOpAntId) });

  // BUILD: the TREASURY (hot dispenser) co-signs the fee-payer slot; the server learns
  // + persists the final txid BEFORE the operator ever co-signs. Scope to THIS asset.
  const opBatch = await buildAntBatch(db.pool, hotKp, gateway, {
    antColdAddress: antAuthorityKp.address, max: 50, requireApproval: false, assetKeyScope: [opAntMint as string],
  });
  const opItem = opBatch.items.find((i) => i.claimId === dOp.claimId);

  // OPERATOR SIGNS (sign-only; == Phantom `signAllTransactions`): add the AUTHORITY
  // signature to the SERVER-built partial tx with a real @solana/kit signer. The txid
  // (the treasury fee-payer signature) is invariant to this co-signature.
  const opSignedTxs: string[] = [];
  if (opItem) {
    const decoded = getTransactionDecoder().decode(new Uint8Array(getBase64Encoder().encode(opItem.txBase64)));
    const opSigned = await partiallySignTransaction([antAuthorityKp.keyPair], decoded);
    opSignedTxs.push(getBase64EncodedWireTransaction(opSigned));
  }

  // SUBMIT: server verifies the authority sig over ITS OWN stored message, reconstructs
  // the wire, then broadcasts + confirms on the REAL devnet gateway.
  const opResults = await submitAntBatch(db.pool, gateway, {
    batchId: opBatch.batchId, signedTxs: opSignedTxs,
    antColdAddress: antAuthorityKp.address, treasuryAddress: hotKp.address,
  });
  const opRes = opResults[0];

  // ASSERT ON-CHAIN (the point): the asset's Owner AND UpdateAuthority both moved to
  // the claimant; DB claim -> confirmed, asset -> claimed; the ar.io-claim memo landed.
  const opOwn = await readCoreOwnerUA(opAntMint);
  const opClaimStatus = (await db.pool.query<{ status: string }>("SELECT status FROM claims WHERE claim_id=$1", [dOp.claimId])).rows[0]?.status;
  const opAssetStatus = (await db.pool.query<{ status: string }>("SELECT status FROM assets WHERE asset_key=$1", [opAntMint as string])).rows[0]?.status;
  const opMemo = opRes?.txid ? await fetchAnchorMemo(rpc, opRes.txid, MEMO_PROGRAM as string) : null;
  const opMemoOk = opMemo?.memo === `ar.io-claim:${dOp.claimId}`;
  expect(
    "row9_ar_ant_operator_wallet",
    dOp.status === "verified"
      && opBatch.items.length === 1 && !!opItem
      && opRes?.outcome === "confirmed"
      && opOwn.owner === cOp && opOwn.ua === cOp
      && opClaimStatus === "confirmed" && opAssetStatus === "claimed"
      && opMemoOk,
    `complete=${dOp.status} items=${opBatch.items.length} submit=${opRes?.outcome} owner=${opOwn.owner} ua=${opOwn.ua} claimant=${cOp} claim=${opClaimStatus} asset=${opAssetStatus} memo=${opMemo?.memo ?? "none"} txid=${opRes?.txid}`,
  );
  if (opRes?.txid) artifacts.row9_tx = opRes.txid;

  // ---- reconcile-dispatch ----
  log("reconcile-dispatch (Σ dispatched == Σ claimed; no double-dispense)");
  const rep = await reconcileDispatch(db.pool);
  expect("reconcile_dispatch_ok", rep.ok && rep.dispatchedTotalMario === rep.claimedTotalMario, `ok=${rep.ok} dispatched=${rep.dispatchedTotalMario} claimed=${rep.claimedTotalMario} issues=${rep.issues.join("|")}`);
  artifacts.reconcile = { confirmedClaims: rep.confirmedClaims, dispatchedTotalMario: rep.dispatchedTotalMario.toString(), antConfirmed: rep.antConfirmed };

  // ---- publish signed ledger + third-party verify + membership ----
  log("publish signed ledger + third-party verify + membership proof");
  const leaves = await buildLeavesFromDb(db.pool);
  const artifact = buildLedgerArtifact({ leaves, network: NETWORK, ledgerVersion: `rehearsal-${new Date().toISOString()}`, inputFingerprints: { rehearsal: "representative-subset" }, publisher: publisherKey });
  await persistPublishedLedger(db.pool, artifact);
  const pinnedVerify = verifyLedgerArtifact(artifact, toHex(publisherKey.publicKey));
  const unpinnedVerify = verifyLedgerArtifact(artifact); // must NOT pass unpinned
  const mem = proveMembership(artifact, ak1);
  const memOk = verifyMembership(mem, artifact.manifest.rootHex);
  expect("publish_ledger_verified_pinned", pinnedVerify.ok && !unpinnedVerify.ok && memOk, `pinned=${pinnedVerify.ok} unpinned=${unpinnedVerify.ok} membership=${memOk} issues=${pinnedVerify.issues.join("|")}`);
  writeFileSync(OUT_DIR + "ledger-artifact.json", JSON.stringify(artifact, null, 2));
  artifacts.ledger = { rootHex: artifact.manifest.rootHex, entryCount: artifact.manifest.entryCount, totalClaimableMario: artifact.manifest.totalClaimableMario };

  // ---- anchor audit head on-chain + read-back + extension + signer pin ----
  log("anchor audit-log head on-chain + verify extension + signer pin");
  await signUnsignedAuditRows(db.pool, auditKey);
  const rows = await loadAuditRows(db.pool, {});
  const chain = verifyAuditChain(rows, auditKey.publicKey);
  const head = await getAuditHead(db.pool);
  if (!head) throw new Error("no audit head");
  const memo = auditHeadMemo(head.seq, head.entryHashHex, NETWORK);
  const anchor = await anchorMemoWithRpc({ rpc, seed: publisherKey.secretKey, memoText: memo });
  await recordAnchor(db.pool, { kind: "audit-head", anchoredRef: head.seq, headHashHex: head.entryHashHex, target: "solana-memo", network: NETWORK, txid: anchor.signature, slot: null, memo, confirmed: anchor.confirmed });
  // Read the memo BACK FROM CHAIN (do not trust the DB), confirm extension + signer.
  const fetched = await fetchAnchorMemo(rpc, anchor.signature);
  const rowsAfter = await loadAuditRows(db.pool, {});
  const extends_ = checkExtendsAnchor(rowsAfter, head.seq, head.entryHashHex, auditKey.publicKey);
  const signerOk = fetched !== null && anchorSignedBy(fetched, addressFromPublicKey(publisherKey.publicKey));
  expect("anchor_onchain_verified", chain.ok && anchor.confirmed && fetched?.memo === memo && extends_.ok && signerOk, `chain=${chain.ok} confirmed=${anchor.confirmed} memoMatch=${fetched?.memo === memo} extends=${extends_.ok} signer=${signerOk}`);
  artifacts.anchor = { signature: anchor.signature, seq: head.seq, entryHashHex: head.entryHashHex, publisherAddress: transparencyAddress(publisherKey) };

  // ---- reserves: holdings >= liabilities ----
  log("reserves endpoint (holdings >= liabilities)");
  const reserves = await computeReserves({
    pool: db.pool, gateway, rpc, network: NETWORK, mint,
    hotDispenser: hotSigner.address, coldReserve: coldReserveKp.address, antCheck: { mode: "off" },
  });
  expect("reserves_covered", reserves.coverage.tokenVaultCovered && BigInt(reserves.coverage.surplusMario) >= 0n, `covered=${reserves.coverage.tokenVaultCovered} surplus=${reserves.coverage.surplusMario} outstanding=${reserves.liabilities.outstandingMario} reserve=${reserves.reserves.totalReserveMario}`);
  artifacts.reserves = reserves.coverage;

  // ---- write artifacts + summary ----
  writeFileSync(OUT_DIR + "rehearsal-results.json", JSON.stringify({ network: NETWORK, rpc: RPC_URL, results, artifacts, generatedAt: new Date().toISOString() }, null, 2));
  await app.close();
  await db.close();

  // eslint-disable-next-line no-console
  console.log("\n==== STAGING REHEARSAL RESULTS ====");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(results, null, 2));
  // eslint-disable-next-line no-console
  console.log(`\nartifacts -> ${OUT_DIR}rehearsal-results.json`);
  if (failures.length) {
    // eslint-disable-next-line no-console
    console.error(`\nFAILURES: ${failures.join(", ")}`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log("\nALL REHEARSAL PHASES PASSED (full matrix, on-chain, transparency verified).");
}

/** ETH drive (async signer can't fit the sync `sign` thunk of driveComplete). */
async function driveEth(app: FastifyInstance, id: EthIdentity, assetKey: string, claimant: string): Promise<{ claimId: string; status: string }> {
  const look = await app.inject({ method: "GET", url: `/v1/claimable?recipientId=${id.recipientId}` });
  if (look.statusCode !== 200) throw new Error(`lookup ${look.statusCode}: ${look.body}`);
  const init = await app.inject({ method: "POST", url: "/v1/claims/initiate", payload: { assetKey, claimant } });
  if (init.statusCode !== 201) throw new Error(`initiate ${init.statusCode}: ${init.body}`);
  const { claimId, canonicalMessageHex, nonceHex } = init.json();
  const sig = await signEthCanonical(id.priv, Buffer.from(canonicalMessageHex, "hex"));
  const proof: Proof = { protocol: "ethereum", signatureHex: Buffer.from(sig).toString("hex") };
  const done = await app.inject({ method: "POST", url: "/v1/claims/complete", payload: { claimId, nonceHex, proof } });
  if (done.statusCode !== 202) throw new Error(`complete ${done.statusCode}: ${done.body}`);
  return { claimId, status: done.json().status };
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("staging rehearsal failed:", err);
  process.exit(1);
});
