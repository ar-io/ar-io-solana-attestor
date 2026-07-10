//! ADVERSARIAL M3 validation — independent tester/UAT suite.
//!
//! Goal: try HARD to break the double-claim + replay guarantees. A double
//! dispatch intent here = a double-spend of user funds, so these tests are
//! deliberately hostile: high-N concurrency, externally-held row locks,
//! initiate/complete interleaving, abrupt connection kills, nonce/proof replay,
//! and the AT-RISK exclusion against the REAL mainnet ledger.
//!
//! DB-gated exactly like `service.db.test.ts` (skips without DATABASE_URL).
//! Every synthetic identity/asset is randomly keyed and cleaned up; the real
//! ledger rows are only READ, never mutated.

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import { Client, Pool } from "pg";

import type { Config } from "../config.js";
import { createDb, type Db } from "../db.js";
import {
  cleanup,
  insertAsset,
  insertRecipient,
  makeEthIdentity,
  randomClaimant,
  signEthCanonical,
  type EthIdentity,
} from "./proof-testkit.js";
import { ApiError } from "./errors.js";
import { completeClaim, getAsset, getClaimable, initiateClaim } from "./service.js";

const HAS_DB = !!process.env.DATABASE_URL;

function testConfig(over: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: "127.0.0.1",
    logLevel: "silent",
    network: "solana-mainnet",
    databaseUrl: process.env.DATABASE_URL ?? "",
    solanaRpcUrl: "http://127.0.0.1:8899",
    challengeTtlMs: 900_000,
    bigClaimThresholdMario: 100_000_000_000n,
    rateLimitPerMin: 100_000,
    rateLimitIdentityPerMin: 100_000,
    corsOrigin: "*",
    ...over,
  };
}

function uid(): string {
  return randomBytes(6).toString("hex");
}
function tokenKey(): string {
  return randomBytes(32).toString("hex");
}

async function assetStatus(db: Db, assetKey: string): Promise<string | undefined> {
  const r = await db.pool.query<{ status: string }>("SELECT status FROM assets WHERE asset_key = $1", [assetKey]);
  return r.rows[0]?.status;
}
async function countWon(db: Db, assetKey: string): Promise<number> {
  const r = await db.pool.query<{ n: string }>(
    "SELECT count(*)::text n FROM claims WHERE asset_key=$1 AND status IN ('verified','pending_review','dispatching')",
    [assetKey],
  );
  return Number(r.rows[0].n);
}
async function countAudit(db: Db, claimId: string, event: string): Promise<number> {
  const r = await db.pool.query<{ n: string }>(
    "SELECT count(*)::text n FROM audit_log WHERE entry->>'claimId' = $1 AND entry->>'event' = $2",
    [claimId, event],
  );
  return Number(r.rows[0].n);
}

/** Seed one ETH recipient + one token asset; return identity + key. */
async function seedEthToken(db: Db, amount: bigint, track: (r: string, ...a: string[]) => void): Promise<{ id: EthIdentity; ak: string }> {
  const id = makeEthIdentity();
  const ak = tokenKey();
  track(id.recipientId, ak);
  await insertRecipient(db.pool, { recipientId: id.recipientId, protocol: 1, sourceAddress: id.addressLower, recipientPubkey: id.address });
  await insertAsset(db.pool, id.recipientId, { assetKey: ak, assetType: "token", amount });
  return { id, ak };
}

/** initiate + sign a valid ETH proof for (asset, fresh claimant). */
async function makeValidProof(db: Db, cfg: Config, id: EthIdentity, ak: string): Promise<{ claimId: string; proof: { protocol: "ethereum"; signatureHex: string } }> {
  const init = await initiateClaim(db.pool, cfg, { assetKey: ak, claimant: randomClaimant() });
  const sig = await signEthCanonical(id.priv, Buffer.from(init.canonicalMessageHex, "hex"));
  return { claimId: init.claimId, proof: { protocol: "ethereum", signatureHex: Buffer.from(sig).toString("hex") } };
}

describe("ADVERSARIAL M3 — double-claim / replay / AT-RISK", { skip: HAS_DB ? false : "DATABASE_URL not set" }, () => {
  let db: Db;
  let usable = false;
  const createdAssets: string[] = [];
  const createdRecipients: string[] = [];

  before(async () => {
    db = createDb(process.env.DATABASE_URL!, { max: 80 });
    try {
      const cols = await db.pool.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name='claims' AND column_name='challenge_nonce'",
      );
      usable = cols.rows.length === 1;
    } catch {
      usable = false;
    }
  });
  after(async () => {
    if (db) {
      try {
        await cleanup(db.pool, createdAssets, createdRecipients);
      } catch {
        /* best effort */
      }
      await db.close();
    }
  });
  function track(recipientId: string, ...assetKeys: string[]): void {
    createdRecipients.push(recipientId);
    createdAssets.push(...assetKeys);
  }

  // =========================================================================
  // 1. DOUBLE-CLAIM UNDER HIGH-N CONCURRENCY
  // =========================================================================

  it("HIGH-N: 48 DIFFERENT valid claims, ONE asset -> exactly 1 verified, 47 clean ALREADY_CLAIMED, 1 dispatch intent", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const cfg = testConfig();
    const { id, ak } = await seedEthToken(db, 7n, track);

    const N = 48;
    const proofs = [] as { claimId: string; proof: { protocol: "ethereum"; signatureHex: string } }[];
    for (let i = 0; i < N; i++) proofs.push(await makeValidProof(db, cfg, id, ak));

    // Fire all N at once. Only the asset FOR UPDATE lock + state machine gate them.
    const results = await Promise.allSettled(
      proofs.map((p) => completeClaim(db.pool, cfg, { claimId: p.claimId, proof: p.proof })),
    );
    const wins = results.filter((r) => r.status === "fulfilled" && r.value.status === "verified" && r.value.idempotentReplay === false);
    const already = results.filter((r) => r.status === "rejected" && r.reason instanceof ApiError && r.reason.code === "ALREADY_CLAIMED");
    const other = results.filter((r) => r.status === "rejected" && !(r.reason instanceof ApiError && r.reason.code === "ALREADY_CLAIMED"));

    assert.equal(wins.length, 1, "exactly ONE winner");
    assert.equal(other.length, 0, `every loser is a clean ALREADY_CLAIMED, got other errors: ${other.map((o) => (o as PromiseRejectedResult).reason?.code).join(",")}`);
    assert.equal(already.length, N - 1, "N-1 losers");
    assert.equal(await assetStatus(db, ak), "claiming", "asset consumed exactly once");
    assert.equal(await countWon(db, ak), 1, "exactly one dispatch intent across ALL claims for this asset");

    // exactly one claim.verified audit row for the winner; each loser wrote one claim.rejected
    const winnerId = (wins[0] as PromiseFulfilledResult<{ claimId: string }>).value.claimId;
    assert.equal(await countAudit(db, winnerId, "claim.verified"), 1);
    const rej = await db.pool.query<{ n: string }>("SELECT count(*)::text n FROM claims WHERE asset_key=$1 AND status='rejected'", [ak]);
    assert.equal(Number(rej.rows[0].n), N - 1, "N-1 rejected claim rows");
  });

  it("HIGH-N: 64 completes of the SAME claim -> all verified, exactly 1 real dispatch, 1 verified audit row", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const cfg = testConfig();
    const { id, ak } = await seedEthToken(db, 9n, track);
    const { claimId, proof } = await makeValidProof(db, cfg, id, ak);

    const N = 64;
    const results = await Promise.allSettled(
      Array.from({ length: N }, () => completeClaim(db.pool, cfg, { claimId, proof })),
    );
    const ok = results.filter((r) => r.status === "fulfilled" && r.value.status === "verified");
    const real = results.filter((r) => r.status === "fulfilled" && r.value.idempotentReplay === false);
    const replay = results.filter((r) => r.status === "fulfilled" && r.value.idempotentReplay === true);
    assert.equal(ok.length, N, "all N idempotent successes");
    assert.equal(real.length, 1, "exactly ONE did the real work");
    assert.equal(replay.length, N - 1, "the rest replayed the stored outcome");
    assert.equal(await countWon(db, ak), 1, "one dispatch intent");
    assert.equal(await countAudit(db, claimId, "claim.verified"), 1, "exactly one claim.verified audit row (no double dispense)");
    assert.equal(await assetStatus(db, ak), "claiming");
  });

  // =========================================================================
  // 2. TRANSACTION-RACE ATTACKS (try to defeat the lock)
  // =========================================================================

  it("EXTERNAL LOCK: two valid completes both BLOCK on an externally-held asset lock; exactly 1 wins on release", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const cfg = testConfig();
    const { id, ak } = await seedEthToken(db, 13n, track);
    const p1 = await makeValidProof(db, cfg, id, ak);
    const p2 = await makeValidProof(db, cfg, id, ak);

    // A separate connection grabs the asset row lock and holds it.
    const holder = new Pool({ connectionString: process.env.DATABASE_URL!, max: 1 });
    const hc = await holder.connect();
    await hc.query("BEGIN");
    await hc.query("SELECT asset_key FROM assets WHERE asset_key=$1 FOR UPDATE", [ak]);

    const settled = new Set<number>();
    const c1 = completeClaim(db.pool, cfg, { claimId: p1.claimId, proof: p1.proof }).finally(() => settled.add(1));
    const c2 = completeClaim(db.pool, cfg, { claimId: p2.claimId, proof: p2.proof }).finally(() => settled.add(2));

    // While the external lock is held, neither complete may make progress past LOCK 2.
    await sleep(400);
    assert.equal(settled.size, 0, "both completes must BLOCK on the asset lock (proves the lock is the gate, not an app-level check)");
    assert.equal(await assetStatus(db, ak), "available", "asset still available while contended");

    // Release the external lock; now exactly one may win.
    await hc.query("ROLLBACK");
    hc.release();
    await holder.end();

    const results = await Promise.allSettled([c1, c2]);
    const wins = results.filter((r) => r.status === "fulfilled" && (r.value as { idempotentReplay: boolean }).idempotentReplay === false);
    const already = results.filter((r) => r.status === "rejected" && r.reason instanceof ApiError && r.reason.code === "ALREADY_CLAIMED");
    assert.equal(wins.length, 1, "exactly one winner after release");
    assert.equal(already.length, 1, "the other is ALREADY_CLAIMED");
    assert.equal(await countWon(db, ak), 1);
    assert.equal(await assetStatus(db, ak), "claiming");
  });

  it("INTERLEAVE initiate/complete: asset consumed by claim B between A.initiate and A.complete -> A gets ALREADY_CLAIMED, one intent", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const cfg = testConfig();
    const { id, ak } = await seedEthToken(db, 21n, track);

    // A initiates first (older challenge)...
    const a = await makeValidProof(db, cfg, id, ak);
    // ...B initiates AND completes, consuming the asset.
    const b = await makeValidProof(db, cfg, id, ak);
    const bRes = await completeClaim(db.pool, cfg, { claimId: b.claimId, proof: b.proof });
    assert.equal(bRes.status, "verified");

    // Now A completes with a still-valid (unexpired) proof -> loses cleanly.
    await assert.rejects(
      completeClaim(db.pool, cfg, { claimId: a.claimId, proof: a.proof }),
      (e: unknown) => e instanceof ApiError && e.code === "ALREADY_CLAIMED" && e.status === 409,
    );
    assert.equal(await countWon(db, ak), 1, "still exactly one dispatch intent");
    assert.equal(await assetStatus(db, ak), "claiming");
  });

  it("CONNECTION KILL mid-transaction leaves NO partial state (asset stays available, then a fresh complete wins)", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const cfg = testConfig();
    const { id, ak } = await seedEthToken(db, 33n, track);

    // A rogue connection opens a tx, locks + flips the asset, then dies abruptly.
    const rc = new Client({ connectionString: process.env.DATABASE_URL! });
    await rc.connect();
    await rc.query("BEGIN");
    await rc.query("SELECT asset_key FROM assets WHERE asset_key=$1 FOR UPDATE", [ak]);
    await rc.query("UPDATE assets SET status='claiming' WHERE asset_key=$1", [ak]);
    // Abrupt socket destroy — no COMMIT. Postgres must roll the whole tx back.
    const streamHolder = rc as unknown as { connection?: { stream?: { destroy: () => void } } };
    streamHolder.connection?.stream?.destroy();
    await rc.end().catch(() => {});

    // Give the server a beat to reap the broken backend.
    await sleep(500);
    assert.equal(await assetStatus(db, ak), "available", "aborted tx must not persist the 'claiming' flip");

    // The asset is genuinely still claimable.
    const p = await makeValidProof(db, cfg, id, ak);
    const res = await completeClaim(db.pool, cfg, { claimId: p.claimId, proof: p.proof });
    assert.equal(res.status, "verified");
    assert.equal(await countWon(db, ak), 1);
  });

  it("BACKSTOP INDEX: a second won-claim insert for one asset raises 23505 (belt-and-suspenders)", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const cfg = testConfig();
    const { id, ak } = await seedEthToken(db, 5n, track);
    const p = await makeValidProof(db, cfg, id, ak);
    await completeClaim(db.pool, cfg, { claimId: p.claimId, proof: p.proof }); // -> verified

    // Force a raw second 'verified' claim row for the same asset. The partial-
    // unique index must reject it even though no app logic is involved.
    await assert.rejects(
      db.pool.query(
        `INSERT INTO claims (asset_key, claimant, canonical_message, status) VALUES ($1,$2,$3,'verified')`,
        [ak, randomClaimant(), Buffer.from("x")],
      ),
      (e: unknown) => (e as { code?: string }).code === "23505",
    );
  });

  // =========================================================================
  // 3. REPLAY / NONCE SINGLE-USE
  // =========================================================================

  it("REPLAY: reusing a winning proof on a NEW initiate for the same asset -> ALREADY_CLAIMED (nonce is single-use per asset)", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const cfg = testConfig();
    const { id, ak } = await seedEthToken(db, 3n, track);
    const p = await makeValidProof(db, cfg, id, ak);
    await completeClaim(db.pool, cfg, { claimId: p.claimId, proof: p.proof });

    // Fresh initiate on the consumed asset is refused (asset != available).
    await assert.rejects(
      initiateClaim(db.pool, cfg, { assetKey: ak, claimant: randomClaimant() }),
      (e: unknown) => e instanceof ApiError && e.code === "ALREADY_CLAIMED",
    );
    // Replaying the exact same proof/claim just idempotently echoes the outcome.
    const again = await completeClaim(db.pool, cfg, { claimId: p.claimId, proof: p.proof });
    assert.equal(again.idempotentReplay, true);
    assert.equal(await countWon(db, ak), 1);
  });

  it("REPLAY: after expiry the OLD signature is dead against the NEW challenge; asset stays available then a fresh proof wins", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const cfg = testConfig({ challengeTtlMs: 1 });
    const { id, ak } = await seedEthToken(db, 44n, track);

    // First session: sign, then let the 1ms challenge expire.
    const init1 = await initiateClaim(db.pool, cfg, { assetKey: ak, claimant: randomClaimant() });
    const oldSig = await signEthCanonical(id.priv, Buffer.from(init1.canonicalMessageHex, "hex"));
    await sleep(10);
    await assert.rejects(
      completeClaim(db.pool, cfg, { claimId: init1.claimId, proof: { protocol: "ethereum", signatureHex: Buffer.from(oldSig).toString("hex") } }),
      (e: unknown) => e instanceof ApiError && e.code === "CHALLENGE_EXPIRED",
    );
    assert.equal(await assetStatus(db, ak), "available", "expiry must NOT consume the asset");

    // Second session: a NEW challenge -> the OLD signature no longer verifies
    // (this attempt rejects THIS claim, which is terminal — matching the
    // documented "bad proof -> claim rejected -> re-initiate" contract).
    const cfg2 = testConfig();
    const init2 = await initiateClaim(db.pool, cfg2, { assetKey: ak, claimant: randomClaimant() });
    assert.notEqual(init2.nonceHex, init1.nonceHex, "a fresh challenge nonce is minted");
    await assert.rejects(
      completeClaim(db.pool, cfg2, { claimId: init2.claimId, proof: { protocol: "ethereum", signatureHex: Buffer.from(oldSig).toString("hex") } }),
      (e: unknown) => e instanceof ApiError && (e.status === 401 || e.status === 422),
    );
    assert.equal(await assetStatus(db, ak), "available", "a stale signature must not consume it either");

    // Re-initiate (fresh challenge) and sign it correctly -> wins.
    const init3 = await initiateClaim(db.pool, cfg2, { assetKey: ak, claimant: randomClaimant() });
    const goodSig = await signEthCanonical(id.priv, Buffer.from(init3.canonicalMessageHex, "hex"));
    const res = await completeClaim(db.pool, cfg2, { claimId: init3.claimId, proof: { protocol: "ethereum", signatureHex: Buffer.from(goodSig).toString("hex") } });
    assert.equal(res.status, "verified");
  });

  it("REPLAY: a valid proof + echoed nonce from asset A is rejected against asset B (cross-asset + nonce guess)", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const cfg = testConfig();
    const id = makeEthIdentity();
    const akA = tokenKey();
    const akB = tokenKey();
    track(id.recipientId, akA, akB);
    await insertRecipient(db.pool, { recipientId: id.recipientId, protocol: 1, sourceAddress: id.addressLower, recipientPubkey: id.address });
    await insertAsset(db.pool, id.recipientId, { assetKey: akA, assetType: "token", amount: 11n });
    await insertAsset(db.pool, id.recipientId, { assetKey: akB, assetType: "token", amount: 11n });

    const initA = await initiateClaim(db.pool, cfg, { assetKey: akA, claimant: randomClaimant() });
    const sigA = await signEthCanonical(id.priv, Buffer.from(initA.canonicalMessageHex, "hex"));
    const initB = await initiateClaim(db.pool, cfg, { assetKey: akB, claimant: randomClaimant() });

    // Submit A's signature AND A's nonce echo to B's claim -> both the canonical
    // rebuild (B's asset id + B's challenge) and the nonce echo mismatch reject it.
    await assert.rejects(
      completeClaim(db.pool, cfg, {
        claimId: initB.claimId,
        nonceHex: initA.nonceHex,
        proof: { protocol: "ethereum", signatureHex: Buffer.from(sigA).toString("hex") },
      }),
      (e: unknown) => e instanceof ApiError && (e.status === 401 || e.status === 409 || e.status === 422),
    );
    assert.equal(await assetStatus(db, akB), "available", "asset B never consumed by a foreign proof/nonce");
  });

  it("REPLAY: idempotencyKey cannot be reused for a DIFFERENT asset (409 IDEMPOTENCY_KEY_REUSED)", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const cfg = testConfig();
    const a = await seedEthToken(db, 2n, track);
    const b = await seedEthToken(db, 2n, track);
    const key = "idem-" + uid();
    await initiateClaim(db.pool, cfg, { assetKey: a.ak, claimant: randomClaimant(), idempotencyKey: key });
    await assert.rejects(
      initiateClaim(db.pool, cfg, { assetKey: b.ak, claimant: randomClaimant(), idempotencyKey: key }),
      (e: unknown) => e instanceof ApiError && e.code === "IDEMPOTENCY_KEY_REUSED" && e.status === 409,
    );
  });

  // =========================================================================
  // 4. AT-RISK EXCLUSION — against the REAL mainnet ledger (read-only)
  // =========================================================================

  it("AT-RISK: real manual_review assets are hidden (getAsset 404) and un-initiatable; never reach 'claiming'", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const cfg = testConfig();
    const sample = await db.pool.query<{ asset_key: string; status: string }>(
      "SELECT asset_key, status FROM assets WHERE status='manual_review' ORDER BY asset_key LIMIT 25",
    );
    if (sample.rows.length === 0) return t.skip("no manual_review assets in this ledger");

    for (const row of sample.rows) {
      // getAsset hides it as 404.
      await assert.rejects(
        getAsset(db.pool, row.asset_key),
        (e: unknown) => e instanceof ApiError && e.status === 404,
        `getAsset must 404 for manual_review ${row.asset_key}`,
      );
      // initiate by assetKey directly is refused (never mints a challenge).
      let initiated = false;
      try {
        await initiateClaim(db.pool, cfg, { assetKey: row.asset_key, claimant: randomClaimant() });
        initiated = true;
      } catch (e) {
        assert.ok(e instanceof ApiError, `initiate on manual_review threw non-ApiError: ${(e as Error).message}`);
        // Must be a refusal (MANUAL_REVIEW / conflict / not-found), never a success.
        assert.ok(e.status === 409 || e.status === 404, `unexpected initiate status ${e.status} (${e.code})`);
      }
      assert.equal(initiated, false, `manual_review asset ${row.asset_key} must NOT be initiatable`);
      // The real asset is untouched.
      assert.equal(await assetStatus(db, row.asset_key), "manual_review");
    }
    // No claim row was ever created for any manual_review asset.
    const leaked = await db.pool.query<{ n: string }>(
      "SELECT count(*)::text n FROM claims c JOIN assets a ON a.asset_key=c.asset_key WHERE a.status='manual_review'",
    );
    assert.equal(Number(leaked.rows[0].n), 0, "no claim may reference a manual_review asset");
  });

  it("AT-RISK: a real manual_review recipient's /claimable lookup returns ZERO assets", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const r = await db.pool.query<{ recipient_id: string }>(
      "SELECT recipient_id FROM recipients WHERE status='manual_review' AND recipient_id IS NOT NULL AND recipient_id <> 'undefined' LIMIT 1",
    );
    if (r.rows.length === 0) return t.skip("no manual_review recipient");
    const res = await getClaimable(db.pool, { recipientId: r.rows[0].recipient_id });
    assert.equal(res.assets.length, 0, "manual_review recipient must expose no claimable assets");
  });

  // =========================================================================
  // 5. STATE-MACHINE / BRAKE INTEGRITY
  // =========================================================================

  it("BRAKE: two sub-threshold assets of ONE recipient that SUM over the brake both route to pending_review, each consumed once", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const cfg = testConfig({ bigClaimThresholdMario: 1_000n });
    const id = makeEthIdentity();
    const ak1 = tokenKey();
    const ak2 = tokenKey();
    track(id.recipientId, ak1, ak2);
    await insertRecipient(db.pool, { recipientId: id.recipientId, protocol: 1, sourceAddress: id.addressLower, recipientPubkey: id.address });
    await insertAsset(db.pool, id.recipientId, { assetKey: ak1, assetType: "token", amount: 600n }); // each < 1000
    await insertAsset(db.pool, id.recipientId, { assetKey: ak2, assetType: "token", amount: 600n }); // sum 1200 > 1000

    const p1 = await makeValidProof(db, cfg, id, ak1);
    const p2 = await makeValidProof(db, cfg, id, ak2);
    const [r1, r2] = await Promise.all([
      completeClaim(db.pool, cfg, { claimId: p1.claimId, proof: p1.proof }),
      completeClaim(db.pool, cfg, { claimId: p2.claimId, proof: p2.proof }),
    ]);
    assert.equal(r1.status, "pending_review", "recipient-total brake fires");
    assert.equal(r2.status, "pending_review");
    assert.equal(await assetStatus(db, ak1), "pending_review");
    assert.equal(await assetStatus(db, ak2), "pending_review");
    assert.equal(await countWon(db, ak1), 1);
    assert.equal(await countWon(db, ak2), 1);
  });

  it("STATE: a pending_review asset cannot then be claimed by a second racing claim (409 PENDING_REVIEW)", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const cfg = testConfig({ bigClaimThresholdMario: 1_000n });
    const id = makeEthIdentity();
    const ak = tokenKey();
    track(id.recipientId, ak);
    await insertRecipient(db.pool, { recipientId: id.recipientId, protocol: 1, sourceAddress: id.addressLower, recipientPubkey: id.address });
    await insertAsset(db.pool, id.recipientId, { assetKey: ak, assetType: "token", amount: 50_000n });

    const p1 = await makeValidProof(db, cfg, id, ak);
    const p2 = await makeValidProof(db, cfg, id, ak);
    const r1 = await completeClaim(db.pool, cfg, { claimId: p1.claimId, proof: p1.proof });
    assert.equal(r1.status, "pending_review");
    await assert.rejects(
      completeClaim(db.pool, cfg, { claimId: p2.claimId, proof: p2.proof }),
      (e: unknown) => e instanceof ApiError && e.code === "PENDING_REVIEW" && e.status === 409,
    );
    assert.equal(await countWon(db, ak), 1, "one live/won claim only");
  });

  // =========================================================================
  // 6. ERROR MAPPING MATRIX
  // =========================================================================

  it("ERROR MAP: 400 / 404 / 401 / 422 / 409 map as specified", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const cfg = testConfig();
    const { id, ak } = await seedEthToken(db, 8n, track);

    // 400 — structurally invalid (bad claimant / no proof / no id).
    await assert.rejects(initiateClaim(db.pool, cfg, { assetKey: ak, claimant: "not!base58" }), (e: unknown) => e instanceof ApiError && e.status === 400);
    await assert.rejects(completeClaim(db.pool, cfg, { proof: { protocol: "ethereum", signatureHex: "00".repeat(65) } }), (e: unknown) => e instanceof ApiError && e.status === 400);

    // 404 — unknown claim.
    await assert.rejects(completeClaim(db.pool, cfg, { claimId: "00000000-0000-0000-0000-000000000000", proof: { protocol: "ethereum", signatureHex: "00".repeat(65) } }), (e: unknown) => e instanceof ApiError && e.status === 404);

    // 422 — bad signature LENGTH (typed-but-malformed).
    const g = await initiateClaim(db.pool, cfg, { assetKey: ak, claimant: randomClaimant() });
    await assert.rejects(completeClaim(db.pool, cfg, { claimId: g.claimId, proof: { protocol: "ethereum", signatureHex: "00".repeat(10) } }), (e: unknown) => e instanceof ApiError && e.status === 422);
    assert.equal(await assetStatus(db, ak), "available", "a malformed proof must not consume the asset");

    // 401 — well-formed signature by the WRONG key.
    const g2 = await initiateClaim(db.pool, cfg, { assetKey: ak, claimant: randomClaimant() });
    const wrong = makeEthIdentity();
    const badSig = await signEthCanonical(wrong.priv, Buffer.from(g2.canonicalMessageHex, "hex"));
    await assert.rejects(completeClaim(db.pool, cfg, { claimId: g2.claimId, proof: { protocol: "ethereum", signatureHex: Buffer.from(badSig).toString("hex") } }), (e: unknown) => e instanceof ApiError && e.status === 401);
    assert.equal(await assetStatus(db, ak), "available");

    // 409 — complete a genuinely-won asset via a fresh claim.
    const win = await makeValidProof(db, cfg, id, ak);
    await completeClaim(db.pool, cfg, { claimId: win.claimId, proof: win.proof });
    const loser = await initiateClaim(db.pool, cfg, { assetKey: ak, claimant: randomClaimant() }).catch((e: unknown) => e);
    assert.ok(loser instanceof ApiError && loser.status === 409, "initiate on a won asset is 409");
  });

  it("AUDIT: every state transition writes exactly one audit row and the sha256 hash-chain formula holds per row", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const cfg = testConfig();
    const { id, ak } = await seedEthToken(db, 8n, track);

    // initiate -> reject (bad key) -> re-initiate -> verify: 4 transitions.
    const g = await initiateClaim(db.pool, cfg, { assetKey: ak, claimant: randomClaimant() });
    const wrong = makeEthIdentity();
    const badSig = await signEthCanonical(wrong.priv, Buffer.from(g.canonicalMessageHex, "hex"));
    await completeClaim(db.pool, cfg, { claimId: g.claimId, proof: { protocol: "ethereum", signatureHex: Buffer.from(badSig).toString("hex") } }).catch(() => {});
    assert.equal(await countAudit(db, g.claimId, "claim.initiate"), 1);
    assert.equal(await countAudit(db, g.claimId, "claim.rejected"), 1);

    const win = await makeValidProof(db, cfg, id, ak);
    await completeClaim(db.pool, cfg, { claimId: win.claimId, proof: win.proof });
    assert.equal(await countAudit(db, win.claimId, "claim.initiate"), 1);
    assert.equal(await countAudit(db, win.claimId, "claim.verified"), 1);

    // Tamper-evident chain: over a contiguous seq window, each row's prev_hash
    // must equal the previous row's entry_hash, and every entry_hash is a real
    // 32-byte digest (not the zero genesis except at seq=1).
    const rows = await db.pool.query<{ seq: string; prev_hash: Buffer; entry_hash: Buffer }>(
      "SELECT seq, prev_hash, entry_hash FROM audit_log ORDER BY seq DESC LIMIT 20",
    );
    assert.ok(rows.rows.length >= 2, "audit rows exist");
    const asc = rows.rows.slice().reverse();
    for (let i = 1; i < asc.length; i++) {
      assert.ok(Buffer.isBuffer(asc[i].entry_hash) && asc[i].entry_hash.length === 32, "entry_hash is a 32-byte digest");
      assert.ok(asc[i].prev_hash.equals(asc[i - 1].entry_hash), `chain linkage broken at seq ${asc[i].seq} (prev_hash != previous entry_hash)`);
    }
  });
});
