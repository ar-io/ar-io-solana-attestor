//! HTTP-level tests for the dedicated ANT admin server (B2 CORS, B4 UUID guard,
//! read-token session flow, and the 503-disabled path). Uses `app.inject()` — no
//! port bound. DB-gated (the routes touch Postgres).

import { strict as assert } from "node:assert";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createKeyPairSignerFromPrivateKeyBytes, type Address, type TransactionSigner } from "@solana/kit";

import type { Config } from "../config.js";
import { createDb, type Db } from "../db.js";
import { FakeChainGateway } from "../dispatch/fake-chain.testkit.js";
import { AntChallengeStore, adminChallengeMessage, type AntAdminContext } from "./ant-admin.js";
import { RateLimiter } from "./rate-limit.js";
import { makeLocalAuthority, signMessageBase64, type LocalAuthority } from "../dispatch/ant-operator.testkit.js";
import { buildAntAdminApp } from "../cli/ant-admin-serve.js";

const HAS_DB = !!process.env.DATABASE_URL;

function testConfig(): Config {
  return {
    port: 0, host: "127.0.0.1", logLevel: "silent", network: "solana-mainnet",
    databaseUrl: process.env.DATABASE_URL ?? "", solanaRpcUrl: "http://127.0.0.1:8899",
    challengeTtlMs: 900_000, bigClaimThresholdMario: 100_000n * 1_000_000n,
    rateLimitPerMin: 1e6, rateLimitIdentityPerMin: 1e6, corsOrigin: "https://admin.internal",
  };
}

let db: Db;
let treasury: TransactionSigner;
let antCold: LocalAuthority;
let ctx: AntAdminContext;

async function sessionToken(app: Awaited<ReturnType<typeof buildAntAdminApp>>): Promise<string> {
  const ch = await app.inject({ method: "GET", url: "/v1/admin/ant/challenge" });
  const { nonce } = ch.json() as { nonce: string };
  const sig = await signMessageBase64(adminChallengeMessage(nonce, "session"), antCold.seed);
  const res = await app.inject({ method: "POST", url: "/v1/admin/ant/session", payload: { nonce, sig } });
  return (res.json() as { readToken: string }).readToken;
}

/** A fresh {nonce,sig} authorizing a WRITE action (reserve/build/submit/cancel). */
async function writeChallenge(app: Awaited<ReturnType<typeof buildAntAdminApp>>, action: "reserve" | "build" | "submit" | "cancel"): Promise<{ nonce: string; sig: string }> {
  const ch = await app.inject({ method: "GET", url: "/v1/admin/ant/challenge" });
  const { nonce } = ch.json() as { nonce: string };
  const sig = await signMessageBase64(adminChallengeMessage(nonce, action), antCold.seed);
  return { nonce, sig };
}

describe("ant-admin HTTP routes", { skip: !HAS_DB }, () => {
  before(async () => {
    db = createDb(process.env.DATABASE_URL as string);
    treasury = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(randomBytes(32)));
    antCold = await makeLocalAuthority(new Uint8Array(randomBytes(32)));
    ctx = {
      pool: db.pool, gateway: new FakeChainGateway(),
      treasurySigner: treasury, treasuryAddress: treasury.address, antColdAddress: antCold.address as Address,
      mode: "operator-wallet", batchMax: 50, reservationTtlMs: 600_000, requireApproval: false, includeMemo: true,
      challengeStore: new AntChallengeStore(),
    };
  });
  after(async () => {
    // Housekeeping: drop any batch headers this suite's reserve/build created (their
    // claims are already released by cancel; only the empty/expired headers linger).
    await db.pool.query("DELETE FROM ant_batches WHERE created_by_pubkey = $1", [antCold.address]).catch(() => {});
    await db.close();
  });

  it("B2: CORS advertises x-ant-read-token on the preflight AND normal responses", async () => {
    const app = buildAntAdminApp(testConfig(), ctx);
    const pre = await app.inject({ method: "OPTIONS", url: "/v1/admin/ant/pending" });
    assert.equal(pre.statusCode, 204);
    assert.match(pre.headers["access-control-allow-headers"] as string, /x-ant-read-token/i);
    const ch = await app.inject({ method: "GET", url: "/v1/admin/ant/challenge" });
    assert.match(ch.headers["access-control-allow-headers"] as string, /x-ant-read-token/i);
    await app.close();
  });

  it("read routes: 401 without a token, 200 with a session token", async () => {
    const app = buildAntAdminApp(testConfig(), ctx);
    const noAuth = await app.inject({ method: "GET", url: "/v1/admin/ant/pending" });
    assert.equal(noAuth.statusCode, 401);
    const token = await sessionToken(app);
    const ok = await app.inject({ method: "GET", url: "/v1/admin/ant/pending", headers: { "x-ant-read-token": token } });
    assert.equal(ok.statusCode, 200);
    assert.ok(typeof (ok.json() as { count: number }).count === "number");
    await app.close();
  });

  it("B4: a non-UUID batchId returns 400 (not a 500 uuid-cast error)", async () => {
    const app = buildAntAdminApp(testConfig(), ctx);
    const token = await sessionToken(app);
    const bad = await app.inject({ method: "GET", url: "/v1/admin/ant/batch/not-a-uuid", headers: { "x-ant-read-token": token } });
    assert.equal(bad.statusCode, 400);
    assert.equal((bad.json() as { error: string }).error, "INVALID_REQUEST");
    // A well-formed but unknown UUID is a clean 404.
    const missing = await app.inject({ method: "GET", url: `/v1/admin/ant/batch/${randomUUID()}`, headers: { "x-ant-read-token": token } });
    assert.equal(missing.statusCode, 404);
    await app.close();
  });

  it("submit with a non-UUID batchId returns 400 (after a valid challenge)", async () => {
    const app = buildAntAdminApp(testConfig(), ctx);
    const ch = await app.inject({ method: "GET", url: "/v1/admin/ant/challenge" });
    const { nonce } = ch.json() as { nonce: string };
    const sig = await signMessageBase64(adminChallengeMessage(nonce, "submit"), antCold.seed);
    const res = await app.inject({ method: "POST", url: "/v1/admin/ant/batch/nope/submit", payload: { nonce, sig, signedTxs: [] } });
    assert.equal(res.statusCode, 400);
    await app.close();
  });

  it("build / cancel with a non-UUID batchId return 400 (after a valid action challenge)", async () => {
    const app = buildAntAdminApp(testConfig(), ctx);
    const buildRes = await app.inject({ method: "POST", url: "/v1/admin/ant/batch/nope/build", payload: await writeChallenge(app, "build") });
    assert.equal(buildRes.statusCode, 400);
    const cancelRes = await app.inject({ method: "POST", url: "/v1/admin/ant/batch/nope/cancel", payload: await writeChallenge(app, "cancel") });
    assert.equal(cancelRes.statusCode, 400);
    await app.close();
  });

  it("reserve -> build -> cancel round-trip (build-at-sign-time split)", async () => {
    const app = buildAntAdminApp(testConfig(), ctx);
    // RESERVE: 201 with a batchId + review items (an array; may be empty in the shared
    // test DB). Whatever it grabs is released by the cancel below, so nothing strands.
    const reserveRes = await app.inject({ method: "POST", url: "/v1/admin/ant/batch", payload: await writeChallenge(app, "reserve") });
    assert.equal(reserveRes.statusCode, 201);
    const reserved = reserveRes.json() as { batchId: string; items: unknown[] };
    assert.ok(typeof reserved.batchId === "string" && Array.isArray(reserved.items));
    // Review items carry NO tx bytes yet — the fresh txs are built only at /build.
    for (const it of reserved.items as Record<string, unknown>[]) assert.equal(it.txBase64, undefined);

    // BUILD: 201 with items carrying txBase64 (fresh blockhash). A "build" sig can't be
    // a reserve sig (action-bound) — this proves the new action binding wires through.
    const buildRes = await app.inject({ method: "POST", url: `/v1/admin/ant/batch/${reserved.batchId}/build`, payload: await writeChallenge(app, "build") });
    assert.equal(buildRes.statusCode, 201);
    const built = buildRes.json() as { batchId: string; items: { txBase64: string; txid: string }[] };
    assert.equal(built.batchId, reserved.batchId);
    assert.equal(built.items.length, reserved.items.length, "every reviewed claim builds a tx (none TTL-freed in-window)");
    for (const it of built.items) assert.ok(typeof it.txBase64 === "string" && typeof it.txid === "string");

    // CANCEL: releases every not-yet-submitted reserved claim, returns freed count.
    const cancelRes = await app.inject({ method: "POST", url: `/v1/admin/ant/batch/${reserved.batchId}/cancel`, payload: await writeChallenge(app, "cancel") });
    assert.equal(cancelRes.statusCode, 200);
    const released = cancelRes.json() as { batchId: string; freed: number };
    assert.equal(released.batchId, reserved.batchId);
    assert.equal(released.freed, reserved.items.length, "cancel frees exactly what was reserved");
    // The batch header is now expired; a status read reflects it.
    const token = await sessionToken(app);
    const st = await app.inject({ method: "GET", url: `/v1/admin/ant/batch/${reserved.batchId}`, headers: { "x-ant-read-token": token } });
    assert.equal((st.json() as { status: string }).status, "expired");
    await app.close();
  });

  it("a reserve challenge does NOT authorize submit (action binding for the new verbs)", async () => {
    const app = buildAntAdminApp(testConfig(), ctx);
    const reserveCh = await writeChallenge(app, "reserve");
    // Present the reserve-bound {nonce,sig} to /build -> message mismatch -> 401.
    const res = await app.inject({ method: "POST", url: `/v1/admin/ant/batch/${randomUUID()}/build`, payload: reserveCh });
    assert.equal(res.statusCode, 401);
    await app.close();
  });

  it("L3: GET /challenge is per-IP rate limited (429 past the budget)", async () => {
    const app = buildAntAdminApp(testConfig(), ctx, { limiter: new RateLimiter({ windowMs: 60_000, limit: 2 }) });
    const a = await app.inject({ method: "GET", url: "/v1/admin/ant/challenge" });
    const b = await app.inject({ method: "GET", url: "/v1/admin/ant/challenge" });
    const c = await app.inject({ method: "GET", url: "/v1/admin/ant/challenge" });
    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, 200);
    assert.equal(c.statusCode, 429, "the 3rd request past a budget of 2 is rate limited");
    assert.equal((c.json() as { error: string }).error, "RATE_LIMITED");
    await app.close();
  });

  it("disabled (no antAdmin wired) => every admin route 503s", async () => {
    const app = buildAntAdminApp(testConfig(), undefined);
    const ch = await app.inject({ method: "GET", url: "/v1/admin/ant/challenge" });
    assert.equal(ch.statusCode, 503);
    const pending = await app.inject({ method: "GET", url: "/v1/admin/ant/pending" });
    assert.equal(pending.statusCode, 503);
    await app.close();
  });
});
