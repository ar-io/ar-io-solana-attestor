//! M4 LIVE localnet proof — dispenses each asset type on a real SVM (surfpool)
//! through the ACTUAL DispatchWorker, and proves idempotency + the brake.
//!
//! Run:
//!   surfpool start --no-tui --port 8899 --network mainnet   # forks SPL Token + MPL Core
//!   DATABASE_URL=postgres://claims:claims@localhost:5544/claims \
//!     SOLANA_RPC_URL=http://127.0.0.1:8899 \
//!     tsx scripts/m4-localnet-proof.ts
//!
//! Phases (each dispenses via worker.processClaim against the live chain):
//!   1  ARIO SPL mint + fund the hot dispenser float.
//!   2  TOKEN dispense -> claimant ATA; verify on-chain balance == amount.
//!   3  IDEMPOTENCY: re-run -> already_confirmed, on-chain balance unchanged.
//!   4  VAULT-liquid (expired) dispense -> SPL transfer; verify balance.
//!   5  ANT: mint an MPL Core asset to the ant signer, dispatch (approve) ->
//!      TransferV1+UpdateV1; verify Owner + UpdateAuthority == claimant on-chain.
//!   6  >100k BRAKE: an over-threshold claim routes to review, NOT dispensed.

import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  addSignersToTransactionMessage,
  address,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  generateKeyPairSigner,
  getSignatureFromTransaction,
  getAddressDecoder,
  getAddressEncoder,
  lamports,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  AccountRole,
  airdropFactory,
  type Address,
  type IInstruction,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
  type TransactionSigner,
} from "@solana/kit";

import { createDb, type Db } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { SolanaChainGateway } from "../src/dispatch/chain.js";
import { FloatManager, type FloatPolicy } from "../src/dispatch/float.js";
import { DispatchWorker } from "../src/dispatch/worker.js";
import { InMemoryKeypairSigner, type SignerRegistry } from "../src/dispatch/signer.js";
import {
  ASSOCIATED_TOKEN_PROGRAM,
  MPL_CORE_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  createAtaIdempotentIx,
  getAssociatedTokenAddress,
} from "../src/dispatch/instructions.js";

const ONE_TOKEN = 1_000_000n;
const RPC_URL = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
const WS_URL = process.env.SOLANA_WS_URL ?? RPC_URL.replace("http", "ws").replace(":8899", ":8900");

const rpc = createSolanaRpc(RPC_URL) as Rpc<SolanaRpcApi>;
const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
const airdrop = airdropFactory({ rpc, rpcSubscriptions });

function log(msg: string, extra?: unknown): void {
  // eslint-disable-next-line no-console
  console.log(`  ${msg}${extra !== undefined ? " " + JSON.stringify(extra, bigintReplacer) : ""}`);
}
function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
}

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

// --- setup instruction builders (hand-rolled; not product code) -------------
function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}
function u64le(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
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
    data: new Uint8Array([20, decimals, ...encodeAddr(mintAuthority), 0]), // InitializeMint2, freeze=None
  };
  await sendTx([createAccount, initMint2], payer, [mint]);
  return mint.address;
}

const ADDR_ENCODER = getAddressEncoder();
const ADDR_DECODER = getAddressDecoder();
function encodeAddr(a: Address): Uint8Array {
  return new Uint8Array(ADDR_ENCODER.encode(a));
}

async function mintTo(payer: KeyPairSigner, mint: Address, dest: Address, mintAuthority: KeyPairSigner, amount: bigint): Promise<void> {
  const ix: IInstruction = {
    programAddress: TOKEN_PROGRAM,
    accounts: [
      { address: mint, role: AccountRole.WRITABLE },
      { address: dest, role: AccountRole.WRITABLE },
      { address: mintAuthority.address, role: AccountRole.READONLY_SIGNER },
    ],
    data: new Uint8Array([7, ...u64le(amount)]), // MintTo
  };
  await sendTx([ix], payer, [mintAuthority]);
}

async function createAta(payer: KeyPairSigner, owner: Address, mint: Address): Promise<Address> {
  const ata = await getAssociatedTokenAddress(owner, mint);
  await sendTx([createAtaIdempotentIx({ payer: payer.address, ata, owner, mint })], payer);
  return ata;
}

async function tokenBalance(ata: Address): Promise<bigint> {
  try {
    const r = await rpc.getTokenAccountBalance(ata).send();
    return BigInt(r.value.amount);
  } catch {
    return 0n;
  }
}

/** Mint a minimal MPL Core asset (CreateV1, no plugins) owned by `owner`. */
async function createCoreAsset(payer: KeyPairSigner, owner: KeyPairSigner, name: string): Promise<Address> {
  const asset = await generateKeyPairSigner();
  const uri = "https://ar.io/ant.json";
  const data = new Uint8Array([
    0, // CreateV1 discriminator
    0, // dataState = AccountState
    ...u32le(name.length), ...new TextEncoder().encode(name),
    ...u32le(uri.length), ...new TextEncoder().encode(uri),
    0, // plugins = None
  ]);
  const ix: IInstruction = {
    programAddress: MPL_CORE_PROGRAM,
    accounts: [
      { address: asset.address, role: AccountRole.WRITABLE_SIGNER }, // asset (new)
      { address: MPL_CORE_PROGRAM, role: AccountRole.READONLY }, // collection (none)
      { address: owner.address, role: AccountRole.READONLY_SIGNER }, // authority
      { address: payer.address, role: AccountRole.WRITABLE_SIGNER }, // payer
      { address: owner.address, role: AccountRole.READONLY }, // owner
      { address: owner.address, role: AccountRole.READONLY }, // update authority = owner
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: MPL_CORE_PROGRAM, role: AccountRole.READONLY }, // log wrapper (none)
    ],
    data,
  };
  await sendTx([ix], payer, [asset, owner]);
  return asset.address;
}

/** Decode an MPL Core AssetV1: [key(1)][owner(32)][updateAuthority tag(1)+pubkey(32)]... */
async function readCoreOwnerAndUA(asset: Address): Promise<{ owner: string; updateAuthority: string }> {
  const r = await rpc.getAccountInfo(asset, { encoding: "base64" }).send();
  if (!r.value) throw new Error("asset not found");
  const raw = Buffer.from(r.value.data[0], "base64");
  // AssetV1: key: u8 (1 byte), owner: Pubkey (32), update_authority: UpdateAuthority
  //   UpdateAuthority enum: 0=None, 1=Address(Pubkey), 2=Collection(Pubkey)
  const owner = raw.subarray(1, 33);
  const uaTag = raw[33];
  const uaPubkey = raw.subarray(34, 66);
  return {
    owner: ADDR_DECODER.decode(owner) as string,
    updateAuthority: uaTag === 1 ? (ADDR_DECODER.decode(uaPubkey) as string) : `tag:${uaTag}`,
  };
}

// --- DB seeding -------------------------------------------------------------
let db: Db;
const cleanupAssets: string[] = [];
const cleanupRecipients: string[] = [];

async function seedVerifiedClaim(opts: {
  assetType: "token" | "vault" | "ant";
  amount?: bigint;
  vaultEndTs?: number;
  antMint?: string;
  claimant: string;
}): Promise<{ claimId: string; assetKey: string }> {
  const recipientId = `proof_${randomBytes(6).toString("hex")}`;
  await db.pool.query(
    `INSERT INTO recipients (recipient_id, protocol, source_address, recipient_pubkey, status)
     VALUES ($1,1,$1,$2,'open')`,
    [recipientId, Buffer.from(randomBytes(20))],
  );
  const assetKey = opts.assetType === "ant" ? (opts.antMint as string) : randomBytes(32).toString("hex");
  await db.pool.query(
    `INSERT INTO assets (asset_key, asset_type, recipient_id, ant_mint, amount, vault_end_ts, nonce, status, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'claiming', $8::jsonb)`,
    [assetKey, opts.assetType, recipientId, opts.assetType === "ant" ? opts.antMint : null,
      opts.assetType === "ant" ? null : (opts.amount ?? 0n).toString(), opts.vaultEndTs ?? null,
      randomBytes(32), JSON.stringify({ phase: opts.assetType, onchainSeed: "escrow_token", proof: true })],
  );
  const r = await db.pool.query<{ claim_id: string }>(
    `INSERT INTO claims (asset_key, claimant, canonical_message, recipient_id, protocol, status, verified_at)
     VALUES ($1,$2,$3,$4,1,'verified', now()) RETURNING claim_id`,
    [assetKey, opts.claimant, Buffer.from("proof"), recipientId],
  );
  cleanupAssets.push(assetKey);
  cleanupRecipients.push(recipientId);
  return { claimId: r.rows[0].claim_id, assetKey };
}

// --- main -------------------------------------------------------------------
async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
  const config = loadConfig();
  db = createDb(config.databaseUrl);

  const results: Record<string, string> = {};
  const fail: string[] = [];
  const expect = (name: string, cond: boolean, detail?: string): void => {
    results[name] = cond ? "PASS" : `FAIL${detail ? ": " + detail : ""}`;
    if (!cond) fail.push(name);
    log(`[${cond ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  };

  // Keys: payer/mint-authority, hot dispenser, ant signer, claimants.
  const payer = await generateKeyPairSigner();
  const hotSeed = new Uint8Array(randomBytes(32));
  const antSeed = new Uint8Array(randomBytes(32));
  const hotSigner = await InMemoryKeypairSigner.fromSeed("token", hotSeed);
  const antSignerObj = await InMemoryKeypairSigner.fromSeed("ant", antSeed);
  const hotKp = await (await import("@solana/kit")).createKeyPairSignerFromPrivateKeyBytes(hotSeed);
  const antKp = await (await import("@solana/kit")).createKeyPairSignerFromPrivateKeyBytes(antSeed);
  const signers: SignerRegistry = { token: hotSigner, ant: antSignerObj };

  log("funding SOL to payer + signers via airdrop…");
  for (const a of [payer.address, hotKp.address, antKp.address]) {
    await airdrop({ recipientAddress: a, lamports: lamports(2_000_000_000n), commitment: "confirmed" });
  }

  // ---- Phase 1: mint + fund float ----
  log("Phase 1: create ARIO mint + fund hot float");
  const mint = await createMint(payer, hotKp.address, 6);
  const hotAta = await createAta(hotKp, hotKp.address, mint);
  await mintTo(payer, mint, hotAta, hotKp, 300_000n * ONE_TOKEN); // 300k float
  const floatBal = await tokenBalance(hotAta);
  expect("phase1_float_funded", floatBal === 300_000n * ONE_TOKEN, `hot float = ${floatBal}`);

  const policy: FloatPolicy = { capMario: 500_000n * ONE_TOKEN, bigClaimThresholdMario: 100_000n * ONE_TOKEN, refillThresholdMario: 100_000n * ONE_TOKEN };
  const gateway = new SolanaChainGateway(rpc);
  const worker = new DispatchWorker({
    pool: db.pool, gateway, signers, float: new FloatManager(policy), config,
    mint, vaultDurations: { minVaultDuration: BigInt(14 * 86_400), maxVaultDuration: BigInt(365 * 86_400) },
    antRequiresApproval: true,
    includeMemo: false, // surfpool datasource does not clone the SPL Memo program
    log: (m, e) => log(`  worker: ${m}`, e),
  });

  // ---- Phase 2: TOKEN dispense ----
  log("Phase 2: TOKEN dispense via worker");
  const claimant1 = await generateKeyPairSigner();
  const t = await seedVerifiedClaim({ assetType: "token", amount: 1234n * ONE_TOKEN, claimant: claimant1.address });
  const r2 = await worker.processClaim(t.claimId);
  const claimant1Ata = await getAssociatedTokenAddress(claimant1.address, mint);
  const bal2 = await tokenBalance(claimant1Ata);
  expect("phase2_token_dispensed", r2.outcome === "confirmed" && bal2 === 1234n * ONE_TOKEN, `outcome=${r2.outcome} bal=${bal2} sig=${r2.signature}`);

  // ---- Phase 3: IDEMPOTENCY ----
  log("Phase 3: idempotency — re-run must NOT double-send");
  const r3 = await worker.processClaim(t.claimId);
  const bal3 = await tokenBalance(claimant1Ata);
  expect("phase3_idempotent", r3.outcome === "already_confirmed" && bal3 === 1234n * ONE_TOKEN, `outcome=${r3.outcome} bal=${bal3}`);

  // ---- Phase 4: VAULT-liquid (expired) ----
  log("Phase 4: VAULT-liquid dispense via worker");
  const claimant2 = await generateKeyPairSigner();
  const past = Math.floor(Date.now() / 1000) - 86_400;
  const v = await seedVerifiedClaim({ assetType: "vault", amount: 5000n * ONE_TOKEN, vaultEndTs: past, claimant: claimant2.address });
  const r4 = await worker.processClaim(v.claimId);
  const bal4 = await tokenBalance(await getAssociatedTokenAddress(claimant2.address, mint));
  expect("phase4_vault_liquid", r4.outcome === "confirmed" && bal4 === 5000n * ONE_TOKEN, `outcome=${r4.outcome} bal=${bal4}`);

  // ---- Phase 5: ANT (Owner + UA) ----
  log("Phase 5: ANT dispense (Owner + UpdateAuthority) via worker");
  try {
    const antMint = await createCoreAsset(antKp, antKp, "proof-ant");
    const beforeOwn = await readCoreOwnerAndUA(antMint);
    log("minted core asset", { antMint, owner: beforeOwn.owner });
    const claimant3 = await generateKeyPairSigner();
    const a = await seedVerifiedClaim({ assetType: "ant", antMint, claimant: claimant3.address });
    const rGate = await worker.processClaim(a.claimId); // operator-gated -> awaiting_approval
    await DispatchWorker.approveClaim(db.pool, a.claimId, "proof-operator");
    const rAnt = await worker.processClaim(a.claimId);
    const afterOwn = await readCoreOwnerAndUA(antMint);
    const ok = rGate.outcome === "awaiting_approval" && rAnt.outcome === "confirmed" &&
      afterOwn.owner === claimant3.address && afterOwn.updateAuthority === claimant3.address;
    expect("phase5_ant_owner_ua", ok, `gate=${rGate.outcome} dispatch=${rAnt.outcome} owner=${afterOwn.owner} ua=${afterOwn.updateAuthority} claimant=${claimant3.address}`);
  } catch (e) {
    expect("phase5_ant_owner_ua", false, `ANT live path error: ${(e as Error).message}`);
  }

  // ---- Phase 6: >100k brake ----
  log("Phase 6: >100k big-claim brake");
  const claimant4 = await generateKeyPairSigner();
  const big = await seedVerifiedClaim({ assetType: "token", amount: 150_000n * ONE_TOKEN, claimant: claimant4.address });
  const r6 = await worker.processClaim(big.claimId);
  const bal6 = await tokenBalance(await getAssociatedTokenAddress(claimant4.address, mint));
  const st6 = (await db.pool.query<{ status: string }>("SELECT status FROM assets WHERE asset_key=$1", [big.assetKey])).rows[0].status;
  expect("phase6_brake", r6.outcome === "routed_to_review" && bal6 === 0n && st6 === "pending_review", `outcome=${r6.outcome} bal=${bal6} assetStatus=${st6}`);

  // Cleanup.
  await db.pool.query("DELETE FROM audit_log WHERE entry->>'assetKey' = ANY($1)", [cleanupAssets]);
  await db.pool.query("DELETE FROM claims WHERE asset_key = ANY($1)", [cleanupAssets]);
  await db.pool.query("DELETE FROM assets WHERE asset_key = ANY($1)", [cleanupAssets]);
  await db.pool.query("DELETE FROM recipients WHERE recipient_id = ANY($1)", [cleanupRecipients]);
  await db.close();

  // eslint-disable-next-line no-console
  console.log("\n==== M4 LIVE PROOF RESULTS ====");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(results, null, 2));
  if (fail.length) {
    // eslint-disable-next-line no-console
    console.error(`\nFAILURES: ${fail.join(", ")}`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log("\nALL LIVE PHASES PASSED");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("proof failed:", err);
  process.exit(1);
});
