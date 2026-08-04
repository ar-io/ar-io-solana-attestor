//! DEVNET STAGING gentle concurrency/load probe (scratch, not wired to CI).
//! 1) burst of concurrent /v1/claimable lookups  2) same-asset claim RACE (expect
//! exactly one winner; the rest rejected -> one_live_claim_per_asset)  3) a couple
//! of distinct-asset concurrent claims. Reports HTTP status distribution + any 5xx.
//! Reuses the controlled seed identities. DEVNET ONLY.

import { Buffer } from "node:buffer";
import { generateKeyPairSigner } from "@solana/kit";
import { loadSeed, signProof, type SeedManifest } from "./drive-claim.js";

const API = process.env.API_URL ?? "http://127.0.0.1:3041";
const SECURE_DIR = process.env.SECURE_DIR ?? "/opt/claims-secure/staging";

interface FlowResult {
  ok: boolean;
  initiateStatus: number;
  completeStatus?: number;
  claimId?: string;
  finalStatus?: string;
  error?: string;
}

async function claimFlow(seed: SeedManifest, assetKey: string): Promise<FlowResult> {
  const asset = seed.assets.find((a) => a.assetKey === assetKey)!;
  const id = seed.identities[asset.recipientId];
  const claimant = (await generateKeyPairSigner()).address;
  try {
    const init = await fetch(`${API}/v1/claims/initiate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ assetKey, claimant }),
    });
    if (init.status !== 201) return { ok: false, initiateStatus: init.status, error: (await init.text()).slice(0, 120) };
    const { claimId, canonicalMessageHex, nonceHex } = await init.json();
    const canonical = new Uint8Array(Buffer.from(canonicalMessageHex, "hex"));
    const proof = await signProof(id, canonical);
    const done = await fetch(`${API}/v1/claims/complete`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ claimId, nonceHex, proof }),
    });
    const body = done.status === 202 ? await done.json() : { status: undefined };
    return { ok: done.status === 202, initiateStatus: 201, completeStatus: done.status, claimId, finalStatus: body.status };
  } catch (e) {
    return { ok: false, initiateStatus: 0, error: (e as Error).message };
  }
}

async function main(): Promise<void> {
  const seed = loadSeed(SECURE_DIR);
  const recips = [...new Set(seed.assets.map((a) => a.recipientId))];

  // ---- 1. lookup burst (read-only) ----
  const N = Number(process.env.LOOKUPS ?? 40);
  const lookups = await Promise.all(
    Array.from({ length: N }, (_, i) => {
      const r = recips[i % recips.length];
      return fetch(`${API}/v1/claimable?recipientId=${r}`).then((x) => x.status).catch(() => -1);
    }),
  );
  const lookupDist: Record<string, number> = {};
  for (const s of lookups) lookupDist[s] = (lookupDist[s] ?? 0) + 1;

  // ---- 2. same-asset RACE ----
  const raceAsset = process.env.RACE_ASSET!;
  const R = Number(process.env.RACERS ?? 6);
  const race = await Promise.all(Array.from({ length: R }, () => claimFlow(seed, raceAsset)));
  const winners = race.filter((r) => r.ok);
  const raceDist: Record<string, number> = {};
  for (const r of race) {
    const k = r.ok ? `WIN(${r.finalStatus})` : `reject(init=${r.initiateStatus},complete=${r.completeStatus ?? "-"})`;
    raceDist[k] = (raceDist[k] ?? 0) + 1;
  }

  // ---- 3. distinct-asset concurrent claims ----
  const distinctKeys = (process.env.DISTINCT_ASSETS ?? "").split(",").filter(Boolean);
  const distinct = await Promise.all(distinctKeys.map((k) => claimFlow(seed, k)));

  const any5xx = [...lookups].some((s) => s >= 500) ||
    race.some((r) => (r.completeStatus ?? 0) >= 500 || r.initiateStatus >= 500) ||
    distinct.some((r) => (r.completeStatus ?? 0) >= 500 || r.initiateStatus >= 500);

  console.log(JSON.stringify({
    lookups: { total: N, dist: lookupDist },
    race: { asset: raceAsset.slice(0, 12), racers: R, winners: winners.length, winnerClaimIds: winners.map((w) => w.claimId), dist: raceDist },
    distinct: distinct.map((d, i) => ({ asset: distinctKeys[i].slice(0, 12), ok: d.ok, completeStatus: d.completeStatus, finalStatus: d.finalStatus, claimId: d.claimId, error: d.error })),
    any5xx: any5xx,
  }, null, 2));
}

main().catch((e) => { console.error("concurrency-probe failed:", e); process.exit(1); });
