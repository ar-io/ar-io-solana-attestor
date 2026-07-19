//! STAGING SMOKE SUITE — reusable end-to-end verification of a RUNNING claims
//! deployment. Reuses scripts/staging helpers (seed / drive-claim / ant-operator-sign
//! / onchain). Prints a per-case PASS/FAIL table and exits non-zero on any failure.
//!
//! POSITIVE cases DISPENSE assets (devnet money-path). NEGATIVE cases assert the
//! money-protecting defenses hold and never dispense. A header banner prints the
//! target + network; dispensing cases REFUSE to run against a non-devnet network
//! unless --allow-nondevnet is passed. --negative-only runs only the safe subset.
//!
//! Config (env, all optional — sensible staging defaults, seed.env used as fallback):
//!   API_URL       (default https://claims.services.ar.io)
//!   ADMIN_URL     (default http://127.0.0.1:3051)   — needed for the ANT case
//!   SECURE_DIR    (default /opt/claims-secure/staging)
//!   RPC_URL       (default from SECURE_DIR/seed.env) — on-chain assertions
//!   WS_URL, DATABASE_URL (from SECURE_DIR/seed.env)  — reseed + DB guardrail
//!
//!   node --import tsx scripts/staging/smoke-suite.ts [--negative-only] [--no-reseed] [--allow-nondevnet]

import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import pg from "pg";
import { createSolanaRpc, generateKeyPairSigner, type Address } from "@solana/kit";
import { loadSeed, driveClaim, signProof, type SeedManifest } from "./drive-claim.js";
import { operatorSign } from "./ant-operator-sign.js";
import { readCoreOwnerUA, getAssociatedTokenAddress, tokenBalance } from "./onchain.js";
import { MEMO_PROGRAM } from "../../src/dispatch/instructions.js";
import { fetchAnchorMemo } from "../../src/transparency/anchor.js";
import { DispatchWorker } from "../../src/dispatch/worker.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLAIMS_PKG = resolve(HERE, "../..");

// --------------------------------------------------------------------------
const NEGATIVE_ONLY = process.argv.includes("--negative-only");
const NO_RESEED = process.argv.includes("--no-reseed");
const ALLOW_NONDEVNET = process.argv.includes("--allow-nondevnet");

const SECURE_DIR = process.env.SECURE_DIR ?? "/opt/claims-secure/staging";
// seed.env fallback (persistent RPC/WS/DB for this deployment).
const seedEnv: Record<string, string> = {};
if (existsSync(`${SECURE_DIR}/seed.env`)) {
  for (const line of readFileSync(`${SECURE_DIR}/seed.env`, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) seedEnv[m[1]] = m[2];
  }
}
const API_URL = process.env.API_URL ?? "https://claims.services.ar.io";
const ADMIN_URL = process.env.ADMIN_URL ?? seedEnv.ADMIN_URL ?? "http://127.0.0.1:3051";
const RPC_URL = process.env.RPC_URL ?? seedEnv.RPC_URL ?? "";
const WS_URL = process.env.WS_URL ?? seedEnv.WS_URL ?? "";
const DATABASE_URL = process.env.DATABASE_URL ?? seedEnv.DATABASE_URL ?? "";

// --------------------------------------------------------------------------
interface CaseResult { id: string; name: string; status: "PASS" | "FAIL" | "SKIP"; detail: string }
const results: CaseResult[] = [];
function record(id: string, name: string, ok: boolean | "skip", detail = ""): void {
  const status = ok === "skip" ? "SKIP" : ok ? "PASS" : "FAIL";
  results.push({ id, name, status, detail });
  console.log(`  [${status}] ${id} ${name}${detail ? " — " + detail : ""}`);
}
async function step<T>(id: string, name: string, fn: () => Promise<{ ok: boolean; detail: string; value?: T }>): Promise<T | undefined> {
  try {
    const r = await fn();
    record(id, name, r.ok, r.detail);
    return r.value;
  } catch (e) {
    record(id, name, false, `threw: ${(e as Error).message}`);
    return undefined;
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string): Promise<{ status: number; json: any; ok: boolean }> {
  const r = await fetch(url);
  let json: any = null;
  try { json = await r.json(); } catch { /* non-json */ }
  return { status: r.status, json, ok: r.ok };
}

// --------------------------------------------------------------------------
async function main(): Promise<void> {
  const rpc = RPC_URL ? createSolanaRpc(RPC_URL) : undefined;

  // -- probe network for the banner + guard --
  const health = await getJson(`${API_URL}/health`);
  const network = health.json?.network ?? "unknown";
  const dispensing = !NEGATIVE_ONLY;

  console.log("=".repeat(78));
  console.log("  ar-io-claims STAGING SMOKE SUITE");
  console.log(`  target API   : ${API_URL}   network=${network}`);
  console.log(`  admin (ANT)  : ${ADMIN_URL}`);
  console.log(`  secure dir   : ${SECURE_DIR}`);
  console.log(`  RPC          : ${RPC_URL ? RPC_URL.replace(/\/[^/]+\/?$/, "/…") : "(none)"}`);
  console.log(`  mode         : ${NEGATIVE_ONLY ? "NEGATIVE-ONLY (no dispense)" : "FULL (positive cases DISPENSE on-chain)"}`);
  console.log("=".repeat(78));

  if (dispensing && network !== "solana-devnet" && !ALLOW_NONDEVNET) {
    console.error(`\nREFUSING: FULL mode DISPENSES assets but target network is "${network}" (not solana-devnet).`);
    console.error("Re-run with --negative-only (safe) or --allow-nondevnet if you REALLY mean to dispense here.\n");
    process.exit(3);
  }

  // -- DB guardrail: claims_staging only --
  let pool: pg.Pool | undefined;
  if (DATABASE_URL) {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const who = (await pool.query("SELECT current_database() db")).rows[0].db;
    console.log(`  DB current_database() = ${who}`);
    if (who !== "claims_staging") {
      console.error(`REFUSING: DATABASE_URL points at "${who}", not claims_staging. Aborting.`);
      process.exit(3);
    }
  } else {
    console.log("  DB: no DATABASE_URL — DB-backed reseed/approve steps unavailable");
  }
  console.log("");

  // ================= read-only checks (both modes) =================
  await step("R1", "GET /health (liveness)", async () => {
    return { ok: health.ok && health.json?.ok === true, detail: `status=${health.status} network=${network}` };
  });
  await step("R2", "GET /health/ready (readiness)", async () => {
    const r = await getJson(`${API_URL}/health/ready`);
    return { ok: r.status === 200 && r.json?.ready === true, detail: `status=${r.status} db=${r.json?.db}` };
  });
  await step("R3", "GET /v1/transparency/reserves (read-only)", async () => {
    const r = await getJson(`${API_URL}/v1/transparency/reserves`);
    const hasShape = r.json && (r.json.coverage || r.json.reserves || r.json.liabilities);
    return { ok: r.status === 200 && !!hasShape, detail: `status=${r.status}` };
  });

  // ================= (re)seed a fresh claimable set =================
  if (!NO_RESEED) {
    if (!DATABASE_URL || !RPC_URL || !WS_URL) throw new Error("reseed needs DATABASE_URL + RPC_URL + WS_URL (set them or use --no-reseed)");
    console.log("\n-- reseeding fresh claimable set (+smoke extras) --");
    execFileSync(process.execPath, ["--import", "tsx", "scripts/staging/seed.ts"], {
      cwd: CLAIMS_PKG,
      env: { ...process.env, RPC_URL, WS_URL, DATABASE_URL, SECURE_DIR, SEED_SMOKE_EXTRAS: "1" },
      stdio: "inherit",
    });
  }
  const seed: SeedManifest = loadSeed(SECURE_DIR);
  const byKind = (k: string) => seed.assets.find((a) => a.kind === k);
  const firstToken = seed.assets.find((a) => a.type === "token" && !a.kind && a.protocol === "arweave");
  const ethToken = seed.assets.find((a) => a.type === "token" && !a.kind && a.protocol === "ethereum");
  const vaultLiquid = seed.assets.find((a) => a.type === "vault" && a.label.includes("EXPIRED"));
  const vaultActive = seed.assets.find((a) => a.type === "vault" && a.label.includes("ACTIVE"));
  const antAsset = seed.assets.find((a) => a.type === "ant" && a.protocol === "arweave");
  const bigClaim = byKind("bigclaim");
  const atRisk = byKind("atrisk");
  console.log("");

  // ================= NEGATIVE / safe cases (both modes) =================

  // Case 9 — AT-RISK asset hidden as 404 (never self-serve).
  await step("N9", "AT-RISK asset hidden (404 ASSET_NOT_FOUND)", async () => {
    if (!atRisk) return { ok: false, detail: "no atrisk asset seeded (need SEED_SMOKE_EXTRAS)" };
    const byAsset = await getJson(`${API_URL}/v1/assets/${atRisk.assetKey}`);
    const byLookup = await getJson(`${API_URL}/v1/claimable?recipientId=${atRisk.recipientId}`);
    const hiddenInLookup = Array.isArray(byLookup.json?.assets) && !byLookup.json.assets.some((x: any) => x.assetKey === atRisk.assetKey);
    return {
      ok: byAsset.status === 404 && byAsset.json?.error === "ASSET_NOT_FOUND" && hiddenInLookup,
      detail: `GET asset=${byAsset.status}/${byAsset.json?.error} hiddenInLookup=${hiddenInLookup}`,
    };
  });

  // Case 5 — forged/wrong proof rejected; asset stays available.
  await step("N5", "Forged proof rejected (401/422), asset stays available", async () => {
    if (!firstToken) return { ok: false, detail: "no token asset seeded" };
    const id = seed.identities[firstToken.recipientId];
    const claimant = (await generateKeyPairSigner()).address;
    const init = await fetch(`${API_URL}/v1/claims/initiate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ assetKey: firstToken.assetKey, claimant }),
    });
    if (init.status !== 201) return { ok: false, detail: `initiate ${init.status}` };
    const { claimId, canonicalMessageHex, nonceHex } = await init.json();
    const badProof = await signProof(id, new Uint8Array(Buffer.from(canonicalMessageHex, "hex")), true);
    const done = await fetch(`${API_URL}/v1/claims/complete`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ claimId, nonceHex, proof: badProof }),
    });
    const rejected = done.status === 401 || done.status === 422;
    // asset must remain claimable (available)
    const look = await getJson(`${API_URL}/v1/claimable?recipientId=${firstToken.recipientId}`);
    const stillAvail = Array.isArray(look.json?.assets) && look.json.assets.some((x: any) => x.assetKey === firstToken.assetKey);
    return { ok: rejected && stillAvail, detail: `complete=${done.status} stillAvailable=${stillAvail}` };
  });

  if (NEGATIVE_ONLY) {
    for (const [id, name] of [["P1", "ANT operator-wallet dispatch"], ["P2", "ETH token dispense"], ["P3", "Vault expired->liquid dispense"], ["P4", "Vault active->manual-queue"], ["N6", "Double-claim rejected"], ["N7", "Replay idempotent (no double dispense)"], ["P8", "Big-claim brake + approve"]] as const) {
      record(id, name, "skip", "negative-only mode (depends on a real dispensing claim)");
    }
    await finish(pool);
    return;
  }

  // ================= FULL mode: positive + dependent negatives =================

  // Case 2 — ETH token claim -> confirmed, balance == amount. (Reused by N6/N7.)
  let ethClaim: Awaited<ReturnType<typeof driveClaim>> | undefined;
  await step("P2", "ETH token claim dispenses (balance == amount)", async () => {
    if (!ethToken) return { ok: false, detail: "no eth token seeded" };
    ethClaim = await driveClaim({ apiUrl: API_URL, seed, assetKey: ethToken.assetKey, wait: true, rpcUrl: RPC_URL });
    const want = BigInt(ethToken.amountMario!);
    const ok = ethClaim.finalStatus === "confirmed" && ethClaim.balanceMario === want;
    return { ok, detail: `status=${ethClaim.finalStatus} bal=${ethClaim.balanceMario} want=${want} sig=${ethClaim.txSignatures?.[0] ?? "-"}` };
  });

  // Case 6 — a SECOND claimant on the now-claimed asset is rejected.
  await step("N6", "Double-claim on won asset rejected (ALREADY_CLAIMED)", async () => {
    if (!ethToken) return { ok: false, detail: "no eth token" };
    const claimant2 = (await generateKeyPairSigner()).address;
    const init = await fetch(`${API_URL}/v1/claims/initiate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ assetKey: ethToken.assetKey, claimant: claimant2 }),
    });
    let body: any = null; try { body = await init.json(); } catch { /* */ }
    return { ok: init.status === 409 || init.status === 404, detail: `initiate=${init.status}/${body?.error ?? ""}` };
  });

  // Case 7 — replay the completed claim: idempotent, NO second on-chain dispense.
  await step("N7", "Replay complete is idempotent (no double dispense)", async () => {
    if (!ethClaim || ethClaim.finalStatus !== "confirmed") return { ok: false, detail: "case P2 did not confirm" };
    const before = ethClaim.balanceMario!;
    const replay = await fetch(`${API_URL}/v1/claims/complete`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(ethClaim.completePayload),
    });
    let rj: any = null; try { rj = await replay.json(); } catch { /* */ }
    // idempotent: 202 replay (idempotentReplay) OR a clean 409; NEVER a fresh dispatch.
    const idempotent = (replay.status === 202 && rj?.idempotentReplay === true) || replay.status === 409;
    // give any (erroneous) second tx time to land, then assert balance unchanged.
    await sleep(8000);
    let after = before;
    if (rpc && ethToken) {
      const ata = await getAssociatedTokenAddress(ethClaim.claimant as Address, seed.arioMint as Address);
      after = await tokenBalance(rpc, ata);
    }
    const noDouble = after === before;
    return { ok: idempotent && noDouble, detail: `replay=${replay.status} idempotentReplay=${rj?.idempotentReplay} balBefore=${before} balAfter=${after}` };
  });

  // Case 3 — vault expired -> liquid, dispensed.
  await step("P3", "Vault expired->liquid dispenses (balance == amount)", async () => {
    if (!vaultLiquid) return { ok: false, detail: "no expired vault seeded" };
    const r = await driveClaim({ apiUrl: API_URL, seed, assetKey: vaultLiquid.assetKey, wait: true, rpcUrl: RPC_URL });
    const want = BigInt(vaultLiquid.amountMario!);
    return { ok: r.finalStatus === "confirmed" && r.balanceMario === want, detail: `status=${r.finalStatus} bal=${r.balanceMario} want=${want} sig=${r.txSignatures?.[0] ?? "-"}` };
  });

  // Case 4 — vault active -> routed to manual queue, NOT dispensed.
  await step("P4", "Vault active routes to manual-queue (not dispensed)", async () => {
    if (!vaultActive) return { ok: false, detail: "no active vault seeded" };
    const r = await driveClaim({ apiUrl: API_URL, seed, assetKey: vaultActive.assetKey, wait: true, rpcUrl: RPC_URL });
    const held = r.finalStatus === "awaiting_manual_vault_delivery";
    const notDispensed = !r.balanceMario || r.balanceMario === 0n;
    return { ok: held && notDispensed, detail: `status=${r.finalStatus} bal=${r.balanceMario ?? 0}` };
  });

  // Case 8 — big-claim brake: pending_review, no dispense; then approve -> confirmed.
  await step("P8", "Big-claim brake -> pending_review, then approve -> dispense", async () => {
    if (!bigClaim) return { ok: false, detail: "no bigclaim asset (need SEED_SMOKE_EXTRAS)" };
    if (!pool) return { ok: false, detail: "no DB to approve" };
    const r = await driveClaim({ apiUrl: API_URL, seed, assetKey: bigClaim.assetKey, wait: true, rpcUrl: RPC_URL });
    const brakeHeld = r.completeStatus === "pending_review" && r.finalStatus === "pending_review" && (!r.balanceMario || r.balanceMario === 0n);
    if (!brakeHeld) return { ok: false, detail: `brake NOT held: complete=${r.completeStatus} final=${r.finalStatus} bal=${r.balanceMario ?? 0}` };
    // approve, then wait for the worker to dispense.
    await DispatchWorker.approveClaim(pool, r.claimId, "smoke-suite");
    let final = "pending_review"; let bal = 0n;
    const want = BigInt(bigClaim.amountMario!);
    for (let i = 0; i < 24; i++) {
      await sleep(5000);
      const s = await getJson(`${API_URL}/v1/claims/${r.claimId}`);
      final = s.json?.status ?? final;
      if (["confirmed", "failed", "needs_operator"].includes(final)) break;
    }
    if (rpc) {
      const ata = await getAssociatedTokenAddress(r.claimant as Address, seed.arioMint as Address);
      bal = await tokenBalance(rpc, ata);
    }
    return { ok: final === "confirmed" && bal === want, detail: `afterApprove=${final} bal=${bal} want=${want}` };
  });

  // Case 1 — ANT operator-wallet 2-step: verified -> operator-sign -> on-chain owner+UA.
  await step("P1", "ANT operator-wallet dispatch (owner+UA==claimant, memo)", async () => {
    if (!antAsset) return { ok: false, detail: "no ANT asset seeded" };
    if (!rpc) return { ok: false, detail: "no RPC for on-chain assert" };
    // admin reachable?
    try { const h = await getJson(`${ADMIN_URL}/health`); if (!h.ok) return { ok: false, detail: `ant-admin ${ADMIN_URL} unreachable (${h.status})` }; }
    catch (e) { return { ok: false, detail: `ant-admin ${ADMIN_URL} unreachable: ${(e as Error).message}` }; }

    const drive = await driveClaim({ apiUrl: API_URL, seed, assetKey: antAsset.assetKey });
    if (drive.completeStatus !== "verified") return { ok: false, detail: `complete=${drive.completeStatus} (expected verified)` };
    const signed = await operatorSign({ adminUrl: ADMIN_URL, secureDir: SECURE_DIR, log: () => {} });
    const res = signed.results.find((x) => x.claimId === drive.claimId);
    if (!res || res.outcome !== "confirmed" || !res.txid) return { ok: false, detail: `submit outcome=${res?.outcome} txid=${res?.txid}` };
    const ua = await readCoreOwnerUA(rpc, antAsset.assetKey as Address);
    const ownerOk = ua.owner === drive.claimant && ua.ua === drive.claimant;
    const claimStatus = (await getJson(`${API_URL}/v1/claims/${drive.claimId}`)).json?.status;
    let memoOk = false;
    try { const memo = await fetchAnchorMemo(rpc, res.txid, MEMO_PROGRAM as string); memoOk = memo?.memo === `ar.io-claim:${drive.claimId}`; } catch { /* */ }
    return {
      ok: ownerOk && claimStatus === "confirmed" && memoOk,
      detail: `owner==ua==claimant=${ownerOk} claim=${claimStatus} memo=${memoOk} txid=${res.txid}`,
    };
  });

  await finish(pool);
}

async function finish(pool?: pg.Pool): Promise<void> {
  if (pool) await pool.end();
  // prod-untouched evidence: prod API still up + mainnet (read-only, never its DB).
  try {
    const prod = await getJson("http://127.0.0.1:3040/health");
    console.log(`\nprod (3040) still up: network=${prod.json?.network} (never written to; smoke suite only touched claims_staging + devnet)`);
  } catch { /* prod may not be locally reachable from every host */ }

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const skip = results.filter((r) => r.status === "SKIP").length;
  console.log("\n" + "=".repeat(78));
  console.log("  SMOKE SUITE RESULTS");
  console.log("=".repeat(78));
  for (const r of results) console.log(`  ${r.status.padEnd(4)} ${r.id.padEnd(4)} ${r.name}${r.detail ? "  (" + r.detail + ")" : ""}`);
  console.log("-".repeat(78));
  console.log(`  ${pass} PASS  /  ${fail} FAIL  /  ${skip} SKIP`);
  console.log("=".repeat(78));
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error("smoke-suite failed:", e); process.exit(1); });
