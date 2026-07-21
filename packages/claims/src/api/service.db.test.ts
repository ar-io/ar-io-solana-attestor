//! Claims API state-machine + concurrency defense — DB-backed (M3 core gate).
//!
//! Gated on DATABASE_URL + a migrated M3 schema. Every test seeds throwaway
//! synthetic identities (keys we control) and cleans them up, so it is safe to
//! run against a populated ledger. The headline test is CONCURRENCY: N parallel
//! completes -> exactly ONE success, proven against real Postgres row locks.

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { randomBytes } from "node:crypto";

import type { Config } from "../config.js";
import { createDb, type Db } from "../db.js";
import {
  cleanup,
  insertAsset,
  insertRecipient,
  makeArIdentity,
  makeEthIdentity,
  randomClaimant,
  signArCanonical,
  signEthCanonical,
} from "./proof-testkit.js";
import { ApiError } from "./errors.js";
import { completeClaim, getAsset, getClaim, getClaimable, initiateClaim } from "./service.js";

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

/** Unique key prefix per test so parallel/ repeated runs never collide. */
function uid(): string {
  return randomBytes(6).toString("hex");
}
function tokenKey(_tag?: string): string {
  // 64-hex asset id (the token/vault shape the canonical decoder expects).
  // Random => globally unique, so no cross-test collisions.
  return randomBytes(32).toString("hex");
}

async function countAuditEvents(db: Db, claimId: string, event: string): Promise<number> {
  const r = await db.pool.query<{ n: string }>(
    "SELECT count(*)::text n FROM audit_log WHERE entry->>'claimId' = $1 AND entry->>'event' = $2",
    [claimId, event],
  );
  return Number(r.rows[0].n);
}
async function assetStatus(db: Db, assetKey: string): Promise<string | undefined> {
  const r = await db.pool.query<{ status: string }>("SELECT status FROM assets WHERE asset_key = $1", [assetKey]);
  return r.rows[0]?.status;
}

describe("claims API — state machine + concurrency", { skip: HAS_DB ? false : "DATABASE_URL not set" }, () => {
  let db: Db;
  let usable = false;
  const createdAssets: string[] = [];
  const createdRecipients: string[] = [];

  before(async () => {
    db = createDb(process.env.DATABASE_URL!, { max: 24 });
    try {
      const r = await db.pool.query(
        "SELECT to_regclass('public.claims') c, to_regclass('public.audit_log') a",
      );
      // Confirm the M3 columns exist (challenge_nonce added by 1720000002000).
      const cols = await db.pool.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name='claims' AND column_name='challenge_nonce'",
      );
      usable = !!r.rows[0].c && !!r.rows[0].a && cols.rows.length === 1;
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

  // ---- ETH happy path -----------------------------------------------------
  it("ETH: initiate -> sign -> complete verifies and consumes the asset", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const cfg = testConfig();
    const id = makeEthIdentity();
    const ak = tokenKey("e" + uid());
    track(id.recipientId, ak);
    await insertRecipient(db.pool, { recipientId: id.recipientId, protocol: 1, sourceAddress: id.addressLower, recipientPubkey: id.address });
    await insertAsset(db.pool, id.recipientId, { assetKey: ak, assetType: "token", amount: 5_000_000n });

    const claimant = randomClaimant();
    const init = await initiateClaim(db.pool, cfg, { assetKey: ak, claimant });
    assert.equal(init.status, "claiming");
    assert.equal(init.protocol, "ethereum");

    const canonical = Buffer.from(init.canonicalMessageHex, "hex");
    const sig = await signEthCanonical(id.priv, canonical);
    const res = await completeClaim(db.pool, cfg, {
      claimId: init.claimId,
      proof: { protocol: "ethereum", signatureHex: Buffer.from(sig).toString("hex") },
    });
    assert.equal(res.status, "verified");
    assert.equal(res.idempotentReplay, false);
    assert.equal(await assetStatus(db, ak), "claiming");

    const status = await getClaim(db.pool, init.claimId);
    assert.equal(status.status, "verified");
    assert.equal(await countAuditEvents(db, init.claimId, "claim.initiate"), 1);
    assert.equal(await countAuditEvents(db, init.claimId, "claim.verified"), 1);

    // The consumed asset no longer surfaces in the claimable lookup.
    const claimable = await getClaimable(db.pool, { recipientId: id.recipientId });
    assert.equal(claimable.assets.find((a) => a.assetKey === ak), undefined);
  });

  // ---- AR happy path (RSA-PSS salt 0 and 32) ------------------------------
  it("AR: initiate -> RSA-PSS sign (salt 32 and 0) -> complete verifies", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const cfg = testConfig();
    const id = makeArIdentity();
    const ak32 = tokenKey("a" + uid());
    const ak0 = tokenKey("b" + uid());
    track(id.recipientId, ak32, ak0);
    await insertRecipient(db.pool, { recipientId: id.recipientId, protocol: 0, sourceAddress: id.recipientId, recipientPubkey: id.modulus });
    await insertAsset(db.pool, id.recipientId, { assetKey: ak32, assetType: "token", amount: 42n });
    await insertAsset(db.pool, id.recipientId, { assetKey: ak0, assetType: "token", amount: 42n });

    for (const [ak, salt] of [[ak32, 32], [ak0, 0]] as const) {
      const claimant = randomClaimant();
      const init = await initiateClaim(db.pool, cfg, { assetKey: ak, claimant });
      assert.equal(init.protocol, "arweave");
      const canonical = Buffer.from(init.canonicalMessageHex, "hex");
      const sig = signArCanonical(id.privateKey, canonical, salt);
      const res = await completeClaim(db.pool, cfg, {
        claimId: init.claimId,
        proof: {
          protocol: "arweave",
          rsaSignatureBase64Url: Buffer.from(sig).toString("base64url"),
          rsaModulusBase64Url: Buffer.from(id.modulus).toString("base64url"),
          saltLength: salt,
        },
      });
      assert.equal(res.status, "verified", `salt ${salt}`);
      assert.equal(await assetStatus(db, ak), "claiming");
    }
  });

  // ---- DOUBLE-CLAIM CONCURRENCY: different claims, same asset -------------
  it("N parallel completes of DIFFERENT valid claims for ONE asset -> exactly 1 wins", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const cfg = testConfig();
    const id = makeEthIdentity();
    const ak = tokenKey("c" + uid());
    track(id.recipientId, ak);
    await insertRecipient(db.pool, { recipientId: id.recipientId, protocol: 1, sourceAddress: id.addressLower, recipientPubkey: id.address });
    await insertAsset(db.pool, id.recipientId, { assetKey: ak, assetType: "token", amount: 7n });

    const N = 8;
    // N independent initiates -> N distinct challenges -> N independently-VALID proofs.
    const claims: { claimId: string; signatureHex: string }[] = [];
    for (let i = 0; i < N; i++) {
      const init = await initiateClaim(db.pool, cfg, { assetKey: ak, claimant: randomClaimant() });
      const sig = await signEthCanonical(id.priv, Buffer.from(init.canonicalMessageHex, "hex"));
      claims.push({ claimId: init.claimId, signatureHex: Buffer.from(sig).toString("hex") });
    }

    // Fire all N completes at once — the ONLY thing preventing double-claim is
    // the asset FOR UPDATE lock + state machine, not app-level checks.
    const results = await Promise.allSettled(
      claims.map((c) =>
        completeClaim(db.pool, cfg, { claimId: c.claimId, proof: { protocol: "ethereum", signatureHex: c.signatureHex } }),
      ),
    );

    const wins = results.filter((r) => r.status === "fulfilled" && r.value.status === "verified");
    const alreadyClaimed = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof ApiError && r.reason.code === "ALREADY_CLAIMED",
    );
    assert.equal(wins.length, 1, "exactly one complete must succeed");
    assert.equal(alreadyClaimed.length, N - 1, "every loser gets a clean ALREADY_CLAIMED");
    assert.equal(await assetStatus(db, ak), "claiming");

    // Exactly one dispatch intent recorded across ALL claims for this asset.
    const verifiedRows = await db.pool.query<{ n: string }>(
      "SELECT count(*)::text n FROM claims WHERE asset_key=$1 AND status='verified'",
      [ak],
    );
    assert.equal(Number(verifiedRows.rows[0].n), 1);
    const rejectedRows = await db.pool.query<{ n: string }>(
      "SELECT count(*)::text n FROM claims WHERE asset_key=$1 AND status='rejected'",
      [ak],
    );
    assert.equal(Number(rejectedRows.rows[0].n), N - 1);
  });

  // ---- IDEMPOTENCY CONCURRENCY: same claim completed N times -------------
  it("N parallel completes of the SAME claim -> 1 dispatch intent, all idempotent", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const cfg = testConfig();
    const id = makeEthIdentity();
    const ak = tokenKey("d" + uid());
    track(id.recipientId, ak);
    await insertRecipient(db.pool, { recipientId: id.recipientId, protocol: 1, sourceAddress: id.addressLower, recipientPubkey: id.address });
    await insertAsset(db.pool, id.recipientId, { assetKey: ak, assetType: "token", amount: 9n });

    const init = await initiateClaim(db.pool, cfg, { assetKey: ak, claimant: randomClaimant() });
    const sig = await signEthCanonical(id.priv, Buffer.from(init.canonicalMessageHex, "hex"));
    const proof = { protocol: "ethereum" as const, signatureHex: Buffer.from(sig).toString("hex") };

    const N = 8;
    const results = await Promise.allSettled(
      Array.from({ length: N }, () => completeClaim(db.pool, cfg, { claimId: init.claimId, proof })),
    );
    const ok = results.filter((r) => r.status === "fulfilled" && r.value.status === "verified");
    assert.equal(ok.length, N, "all completes of one valid claim succeed (idempotent)");
    const replays = results.filter((r) => r.status === "fulfilled" && r.value.idempotentReplay === true);
    assert.equal(replays.length, N - 1, "exactly one did the real work; the rest replayed");

    // Exactly one dispatch intent + one audit 'verified' — no double dispense.
    assert.equal(await countAuditEvents(db, init.claimId, "claim.verified"), 1);
    assert.equal(await assetStatus(db, ak), "claiming");

    // Sequential retry is also idempotent.
    const again = await completeClaim(db.pool, cfg, { claimId: init.claimId, proof });
    assert.equal(again.status, "verified");
    assert.equal(again.idempotentReplay, true);
  });

  // ---- IDEMPOTENCY via client key ----------------------------------------
  it("idempotencyKey: initiate + complete replay by key returns the same claim", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const cfg = testConfig();
    const id = makeEthIdentity();
    const ak = tokenKey("f" + uid());
    track(id.recipientId, ak);
    await insertRecipient(db.pool, { recipientId: id.recipientId, protocol: 1, sourceAddress: id.addressLower, recipientPubkey: id.address });
    await insertAsset(db.pool, id.recipientId, { assetKey: ak, assetType: "token", amount: 3n });

    const key = "idem-" + uid();
    const i1 = await initiateClaim(db.pool, cfg, { assetKey: ak, claimant: randomClaimant(), idempotencyKey: key });
    const i2 = await initiateClaim(db.pool, cfg, { assetKey: ak, claimant: randomClaimant(), idempotencyKey: key });
    assert.equal(i1.claimId, i2.claimId, "same idempotency key -> same claim");

    const sig = await signEthCanonical(id.priv, Buffer.from(i1.canonicalMessageHex, "hex"));
    const proof = { protocol: "ethereum" as const, signatureHex: Buffer.from(sig).toString("hex") };
    const c1 = await completeClaim(db.pool, cfg, { idempotencyKey: key, proof });
    const c2 = await completeClaim(db.pool, cfg, { idempotencyKey: key, proof });
    assert.equal(c1.status, "verified");
    assert.equal(c2.idempotentReplay, true);
    assert.equal(await countAuditEvents(db, i1.claimId, "claim.verified"), 1);
  });

  // ---- REPLAY: proof for asset A cannot claim asset B --------------------
  it("a signature for asset A is rejected against asset B (canonical binding)", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const cfg = testConfig();
    const id = makeEthIdentity();
    const akA = tokenKey("g" + uid());
    const akB = tokenKey("h" + uid());
    track(id.recipientId, akA, akB);
    await insertRecipient(db.pool, { recipientId: id.recipientId, protocol: 1, sourceAddress: id.addressLower, recipientPubkey: id.address });
    await insertAsset(db.pool, id.recipientId, { assetKey: akA, assetType: "token", amount: 11n });
    await insertAsset(db.pool, id.recipientId, { assetKey: akB, assetType: "token", amount: 11n });

    const initA = await initiateClaim(db.pool, cfg, { assetKey: akA, claimant: randomClaimant() });
    const sigA = await signEthCanonical(id.priv, Buffer.from(initA.canonicalMessageHex, "hex"));
    const initB = await initiateClaim(db.pool, cfg, { assetKey: akB, claimant: randomClaimant() });

    // Submit A's signature to B's claim -> recovered address won't match B's
    // rebuilt canonical (different asset_id + challenge nonce).
    await assert.rejects(
      completeClaim(db.pool, cfg, { claimId: initB.claimId, proof: { protocol: "ethereum", signatureHex: Buffer.from(sigA).toString("hex") } }),
      (e: unknown) => e instanceof ApiError && (e.status === 401 || e.status === 422),
    );
    assert.equal(await assetStatus(db, akB), "available", "asset B must NOT be consumed by a foreign proof");
  });

  // ---- REPLAY: expired challenge -----------------------------------------
  it("an expired challenge is rejected and does NOT consume the asset", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const cfg = testConfig({ challengeTtlMs: 1 }); // 1ms TTL
    const id = makeEthIdentity();
    const ak = tokenKey("i" + uid());
    track(id.recipientId, ak);
    await insertRecipient(db.pool, { recipientId: id.recipientId, protocol: 1, sourceAddress: id.addressLower, recipientPubkey: id.address });
    await insertAsset(db.pool, id.recipientId, { assetKey: ak, assetType: "token", amount: 4n });

    const init = await initiateClaim(db.pool, cfg, { assetKey: ak, claimant: randomClaimant() });
    const sig = await signEthCanonical(id.priv, Buffer.from(init.canonicalMessageHex, "hex"));
    await sleep(10); // let the 1ms challenge expire
    await assert.rejects(
      completeClaim(db.pool, cfg, { claimId: init.claimId, proof: { protocol: "ethereum", signatureHex: Buffer.from(sig).toString("hex") } }),
      (e: unknown) => e instanceof ApiError && e.code === "CHALLENGE_EXPIRED" && e.status === 409,
    );
    assert.equal(await assetStatus(db, ak), "available");
    const status = await getClaim(db.pool, init.claimId);
    assert.equal(status.status, "expired");
  });

  // ---- REPLAY: cannot re-initiate a consumed asset -----------------------
  it("once claimed, a fresh initiate for the same asset is rejected", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const cfg = testConfig();
    const id = makeEthIdentity();
    const ak = tokenKey("j" + uid());
    track(id.recipientId, ak);
    await insertRecipient(db.pool, { recipientId: id.recipientId, protocol: 1, sourceAddress: id.addressLower, recipientPubkey: id.address });
    await insertAsset(db.pool, id.recipientId, { assetKey: ak, assetType: "token", amount: 6n });

    const init = await initiateClaim(db.pool, cfg, { assetKey: ak, claimant: randomClaimant() });
    const sig = await signEthCanonical(id.priv, Buffer.from(init.canonicalMessageHex, "hex"));
    await completeClaim(db.pool, cfg, { claimId: init.claimId, proof: { protocol: "ethereum", signatureHex: Buffer.from(sig).toString("hex") } });

    await assert.rejects(
      initiateClaim(db.pool, cfg, { assetKey: ak, claimant: randomClaimant() }),
      (e: unknown) => e instanceof ApiError && e.code === "ALREADY_CLAIMED",
    );
  });

  // ---- bad signature ------------------------------------------------------
  it("a bad signature is rejected (401) and does NOT consume the asset", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const cfg = testConfig();
    const id = makeEthIdentity();
    const ak = tokenKey("k" + uid());
    track(id.recipientId, ak);
    await insertRecipient(db.pool, { recipientId: id.recipientId, protocol: 1, sourceAddress: id.addressLower, recipientPubkey: id.address });
    await insertAsset(db.pool, id.recipientId, { assetKey: ak, assetType: "token", amount: 8n });

    const init = await initiateClaim(db.pool, cfg, { assetKey: ak, claimant: randomClaimant() });
    // Sign with a DIFFERENT key -> recovered address != stored recipient.
    const wrong = makeEthIdentity();
    const sig = await signEthCanonical(wrong.priv, Buffer.from(init.canonicalMessageHex, "hex"));
    await assert.rejects(
      completeClaim(db.pool, cfg, { claimId: init.claimId, proof: { protocol: "ethereum", signatureHex: Buffer.from(sig).toString("hex") } }),
      (e: unknown) => e instanceof ApiError && e.status === 401,
    );
    assert.equal(await assetStatus(db, ak), "available");
    assert.equal((await getClaim(db.pool, init.claimId)).status, "rejected");
  });

  // ---- nonce echo mismatch -----------------------------------------------
  it("a mismatched echoed nonce is rejected NONCE_MISMATCH", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const cfg = testConfig();
    const id = makeEthIdentity();
    const ak = tokenKey("l" + uid());
    track(id.recipientId, ak);
    await insertRecipient(db.pool, { recipientId: id.recipientId, protocol: 1, sourceAddress: id.addressLower, recipientPubkey: id.address });
    await insertAsset(db.pool, id.recipientId, { assetKey: ak, assetType: "token", amount: 2n });

    const init = await initiateClaim(db.pool, cfg, { assetKey: ak, claimant: randomClaimant() });
    const sig = await signEthCanonical(id.priv, Buffer.from(init.canonicalMessageHex, "hex"));
    await assert.rejects(
      completeClaim(db.pool, cfg, {
        claimId: init.claimId,
        nonceHex: randomBytes(32).toString("hex"), // wrong echo
        proof: { protocol: "ethereum", signatureHex: Buffer.from(sig).toString("hex") },
      }),
      (e: unknown) => e instanceof ApiError && e.code === "NONCE_MISMATCH",
    );
    assert.equal(await assetStatus(db, ak), "available");
  });

  // ---- big-claim brake ----------------------------------------------------
  it("a claim above the threshold routes to pending_review (not dispatched)", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const cfg = testConfig({ bigClaimThresholdMario: 1_000n });
    const id = makeEthIdentity();
    const ak = tokenKey("m" + uid());
    track(id.recipientId, ak);
    await insertRecipient(db.pool, { recipientId: id.recipientId, protocol: 1, sourceAddress: id.addressLower, recipientPubkey: id.address });
    await insertAsset(db.pool, id.recipientId, { assetKey: ak, assetType: "token", amount: 50_000n }); // > 1000

    const init = await initiateClaim(db.pool, cfg, { assetKey: ak, claimant: randomClaimant() });
    const sig = await signEthCanonical(id.priv, Buffer.from(init.canonicalMessageHex, "hex"));
    const res = await completeClaim(db.pool, cfg, { claimId: init.claimId, proof: { protocol: "ethereum", signatureHex: Buffer.from(sig).toString("hex") } });
    assert.equal(res.status, "pending_review");
    assert.equal(await assetStatus(db, ak), "pending_review");
    assert.equal(await countAuditEvents(db, init.claimId, "claim.pending_review"), 1);
  });

  // ---- wrong protocol -----------------------------------------------------
  it("an ethereum proof against an arweave recipient -> PROTOCOL_MISMATCH", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const cfg = testConfig();
    const id = makeArIdentity();
    const ak = tokenKey("n" + uid());
    track(id.recipientId, ak);
    await insertRecipient(db.pool, { recipientId: id.recipientId, protocol: 0, sourceAddress: id.recipientId, recipientPubkey: id.modulus });
    await insertAsset(db.pool, id.recipientId, { assetKey: ak, assetType: "token", amount: 5n });

    const init = await initiateClaim(db.pool, cfg, { assetKey: ak, claimant: randomClaimant() });
    await assert.rejects(
      completeClaim(db.pool, cfg, { claimId: init.claimId, proof: { protocol: "ethereum", signatureHex: "00".repeat(65) } }),
      (e: unknown) => e instanceof ApiError && e.code === "PROTOCOL_MISMATCH" && e.status === 422,
    );
    assert.equal(await assetStatus(db, ak), "available");
  });

  // ---- MEDIUM fix: concurrent idempotency-key initiate is race-safe -------
  it("8 parallel initiates sharing one idempotencyKey -> SAME claim, no 500", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const cfg = testConfig();
    const id = makeEthIdentity();
    const ak = tokenKey();
    track(id.recipientId, ak);
    await insertRecipient(db.pool, { recipientId: id.recipientId, protocol: 1, sourceAddress: id.addressLower, recipientPubkey: id.address });
    await insertAsset(db.pool, id.recipientId, { assetKey: ak, assetType: "token", amount: 10n });

    const key = "race-" + uid();
    const claimant = randomClaimant();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => initiateClaim(db.pool, cfg, { assetKey: ak, claimant, idempotencyKey: key })),
    );
    // NONE may be a 500; ALL must resolve to the SAME claim id.
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(rejected.length, 0, `no initiate may fail: ${rejected.map((r) => (r as PromiseRejectedResult).reason?.message).join("; ")}`);
    const ids = new Set(results.map((r) => (r as PromiseFulfilledResult<{ claimId: string }>).value.claimId));
    assert.equal(ids.size, 1, "all 8 concurrent initiates must return one shared claim");
    // Exactly one claim row exists for the key.
    const rows = await db.pool.query<{ n: string }>("SELECT count(*)::text n FROM claims WHERE idempotency_key=$1", [key]);
    assert.equal(Number(rows.rows[0].n), 1);
  });

  // ---- LOW fix: a garbage-signature replay cannot read back "verified" ----
  it("replaying a completed claim with a garbage signature is REJECTED (not verified)", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const cfg = testConfig();
    const id = makeEthIdentity();
    const ak = tokenKey();
    track(id.recipientId, ak);
    await insertRecipient(db.pool, { recipientId: id.recipientId, protocol: 1, sourceAddress: id.addressLower, recipientPubkey: id.address });
    await insertAsset(db.pool, id.recipientId, { assetKey: ak, assetType: "token", amount: 12n });

    const init = await initiateClaim(db.pool, cfg, { assetKey: ak, claimant: randomClaimant() });
    const goodSig = await signEthCanonical(id.priv, Buffer.from(init.canonicalMessageHex, "hex"));
    const good = { protocol: "ethereum" as const, signatureHex: Buffer.from(goodSig).toString("hex") };

    // First complete succeeds.
    assert.equal((await completeClaim(db.pool, cfg, { claimId: init.claimId, proof: good })).status, "verified");

    // Replay with a FOREIGN (different-key) signature -> must NOT be "verified".
    const foreign = await signEthCanonical(makeEthIdentity().priv, Buffer.from(init.canonicalMessageHex, "hex"));
    await assert.rejects(
      completeClaim(db.pool, cfg, { claimId: init.claimId, proof: { protocol: "ethereum", signatureHex: Buffer.from(foreign).toString("hex") } }),
      (e: unknown) => e instanceof ApiError && e.status === 401,
      "a garbage/foreign replay must be rejected, never return verified",
    );
    // Replay with a structurally-bogus signature -> also rejected, not verified.
    await assert.rejects(
      completeClaim(db.pool, cfg, { claimId: init.claimId, proof: { protocol: "ethereum", signatureHex: "11".repeat(65) } }),
      (e: unknown) => e instanceof ApiError && e.status >= 400 && e.status < 500,
    );
    // The GENUINE proof still replays idempotently (same result, no new work).
    const replay = await completeClaim(db.pool, cfg, { claimId: init.claimId, proof: good });
    assert.equal(replay.status, "verified");
    assert.equal(replay.idempotentReplay, true);
    assert.equal(await countAuditEvents(db, init.claimId, "claim.verified"), 1);
  });

  // ---- INFO fix: AT-RISK asset hides existence (404, not 409 MANUAL_REVIEW) ---
  it("initiate on a manual_review asset returns 404 (no existence confirmation)", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const cfg = testConfig();
    const id = makeEthIdentity();
    const ak = tokenKey();
    track(id.recipientId, ak);
    // AT-RISK-style: recipient has no key; asset flagged manual_review.
    await db.pool.query(
      "INSERT INTO recipients (recipient_id, protocol, source_address, recipient_pubkey, status) VALUES ($1,1,$2,NULL,'manual_review')",
      [id.recipientId, id.addressLower],
    );
    await insertAsset(db.pool, id.recipientId, { assetKey: ak, assetType: "token", amount: 6_250_000n, status: "manual_review" });

    await assert.rejects(
      initiateClaim(db.pool, cfg, { assetKey: ak, claimant: randomClaimant() }),
      (e: unknown) => e instanceof ApiError && e.status === 404 && e.code === "ASSET_NOT_FOUND",
      "manual_review must be indistinguishable from a nonexistent asset",
    );
  });

  it("ANT ArNS name (ant_name) surfaces in getClaimable + getAsset; token has null name", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const id = makeArIdentity();
    const antKey = "AntNameMint" + uid();
    const tokKey = tokenKey("t" + uid());
    track(id.recipientId, antKey, tokKey);
    await insertRecipient(db.pool, { recipientId: id.recipientId, protocol: 0, sourceAddress: id.recipientId, recipientPubkey: id.modulus });
    await insertAsset(db.pool, id.recipientId, { assetKey: antKey, assetType: "ant", antMint: antKey, antName: "wolfethyst" });
    await insertAsset(db.pool, id.recipientId, { assetKey: tokKey, assetType: "token", amount: 5n });

    const claimable = await getClaimable(db.pool, { recipientId: id.recipientId });
    const antView = claimable.assets.find((a) => a.assetKey === antKey);
    const tokView = claimable.assets.find((a) => a.assetKey === tokKey);
    assert.equal(antView?.name, "wolfethyst", "ANT view exposes its on-chain name");
    assert.equal(tokView?.name, null, "token view carries a null name");

    // Single-asset endpoint mirrors the list.
    assert.equal((await getAsset(db.pool, antKey)).name, "wolfethyst");
    assert.equal((await getAsset(db.pool, tokKey)).name, null);
  });

  it("an ANT with no backfilled name returns name: null (not undefined)", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const id = makeArIdentity();
    const antKey = "AntNoName" + uid();
    track(id.recipientId, antKey);
    await insertRecipient(db.pool, { recipientId: id.recipientId, protocol: 0, sourceAddress: id.recipientId, recipientPubkey: id.modulus });
    await insertAsset(db.pool, id.recipientId, { assetKey: antKey, assetType: "ant", antMint: antKey });

    const view = await getAsset(db.pool, antKey);
    assert.equal(view.name, null);
  });

  it("includeClaimed=1 returns claimed assets as history (status+claimTx); default stays available-only", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const id = makeArIdentity();
    const availKey = tokenKey("av" + uid());
    const claimedKey = tokenKey("cl" + uid());
    track(id.recipientId, availKey, claimedKey);
    await insertRecipient(db.pool, { recipientId: id.recipientId, protocol: 0, sourceAddress: id.recipientId, recipientPubkey: id.modulus });
    await insertAsset(db.pool, id.recipientId, { assetKey: availKey, assetType: "token", amount: 100n });
    await insertAsset(db.pool, id.recipientId, { assetKey: claimedKey, assetType: "token", amount: 200n, status: "claimed" });

    // A winning, confirmed claim for the claimed asset carrying an on-chain tx signature.
    const sig = "TxSig" + uid();
    await db.pool.query(
      `INSERT INTO claims (asset_key, claimant, canonical_message, user_signature, status, dispatch_signature, tx_signatures, confirmed_at)
       VALUES ($1, $2, $3, $4, 'confirmed', $5, ARRAY[$5]::text[], now())`,
      [claimedKey, randomClaimant(), Buffer.from("x"), Buffer.from("y"), sig],
    );

    // Default: available-only, backward compatible.
    const def = await getClaimable(db.pool, { recipientId: id.recipientId });
    assert.deepEqual(def.assets.map((a) => a.assetKey).sort(), [availKey].sort());
    assert.equal(def.assets[0].status, "available");
    assert.equal(def.assets[0].claimStatus, null);
    assert.equal(def.assets[0].claimTx, null);

    // includeClaimed=1: both, with the claimed one decorated with its claim status + tx.
    const all = await getClaimable(db.pool, { recipientId: id.recipientId, includeClaimed: "1" });
    const keys = all.assets.map((a) => a.assetKey);
    assert.ok(keys.includes(availKey) && keys.includes(claimedKey), "both assets present");
    const availView = all.assets.find((a) => a.assetKey === availKey)!;
    const claimedView = all.assets.find((a) => a.assetKey === claimedKey)!;
    assert.equal(availView.status, "available");
    assert.equal(availView.claimStatus, null);
    assert.equal(availView.claimTx, null);
    assert.equal(claimedView.status, "claimed");
    assert.equal(claimedView.claimStatus, "confirmed");
    assert.equal(claimedView.claimTx, sig);
    // Available assets sort before claimed history.
    assert.equal(all.assets[0].status, "available");

    // ?all=1 is an accepted alias for includeClaimed.
    const aliased = await getClaimable(db.pool, { recipientId: id.recipientId, all: "1" });
    assert.ok(aliased.assets.some((a) => a.assetKey === claimedKey));
  });
});
