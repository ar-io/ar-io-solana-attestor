//! HTTP route wiring + rate limiting via app.inject (no port bind).
//! Gated on DATABASE_URL + migrated M3 schema.

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { randomBytes } from "node:crypto";

import { buildApp } from "../app.js";
import type { Config } from "../config.js";
import { createDb, type Db } from "../db.js";
import { createRateLimiters } from "./rate-limit.js";
import {
  cleanup,
  insertAsset,
  insertRecipient,
  makeEthIdentity,
  randomClaimant,
  signEthCanonical,
} from "./proof-testkit.js";

const HAS_DB = !!process.env.DATABASE_URL;

function cfg(over: Partial<Config> = {}): Config {
  return {
    port: 0, host: "127.0.0.1", logLevel: "silent", network: "solana-mainnet",
    databaseUrl: process.env.DATABASE_URL ?? "", solanaRpcUrl: "http://127.0.0.1:8899",
    challengeTtlMs: 900_000, bigClaimThresholdMario: 100_000_000_000n,
    rateLimitPerMin: 100_000, rateLimitIdentityPerMin: 100_000, corsOrigin: "*", ...over,
  };
}

describe("claims HTTP routes", { skip: HAS_DB ? false : "DATABASE_URL not set" }, () => {
  let db: Db;
  let usable = false;
  const assets: string[] = [];
  const recips: string[] = [];

  before(async () => {
    db = createDb(process.env.DATABASE_URL!, { max: 12 });
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
      try { await cleanup(db.pool, assets, recips); } catch { /* best effort */ }
      await db.close();
    }
  });

  it("drives claimable -> initiate -> complete -> status over HTTP", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const app = buildApp({ config: cfg(), db, limiters: createRateLimiters({ windowMs: 60_000, ipLimit: 100_000, identityLimit: 100_000 }) });
    await app.ready();

    const id = makeEthIdentity();
    const ak = randomBytes(32).toString("hex"); // 64-hex token asset id
    recips.push(id.recipientId); assets.push(ak);
    await insertRecipient(db.pool, { recipientId: id.recipientId, protocol: 1, sourceAddress: id.addressLower, recipientPubkey: id.address });
    await insertAsset(db.pool, id.recipientId, { assetKey: ak, assetType: "token", amount: 1234n });

    // claimable (ETH casing normalized — mixed-case hex body, lowercase 0x prefix as clients send)
    const mixedCase = "0x" + id.addressLower.slice(2).toUpperCase();
    const look = await app.inject({ method: "GET", url: `/v1/claimable?protocol=ethereum&address=${mixedCase}` });
    assert.equal(look.statusCode, 200);
    assert.ok(look.json().assets.some((a: { assetKey: string }) => a.assetKey === ak));

    // initiate
    const init = await app.inject({ method: "POST", url: "/v1/claims/initiate", payload: { assetKey: ak, claimant: randomClaimant() } });
    assert.equal(init.statusCode, 201);
    const { claimId, canonicalMessageHex } = init.json();

    // complete
    const sig = await signEthCanonical(id.priv, Buffer.from(canonicalMessageHex, "hex"));
    const done = await app.inject({ method: "POST", url: "/v1/claims/complete", payload: { claimId, proof: { protocol: "ethereum", signatureHex: Buffer.from(sig).toString("hex") } } });
    assert.equal(done.statusCode, 202);
    assert.equal(done.json().status, "verified");

    // status
    const st = await app.inject({ method: "GET", url: `/v1/claims/${claimId}` });
    assert.equal(st.statusCode, 200);
    assert.equal(st.json().status, "verified");

    await app.close();
  });

  it("returns 404 for an unknown identity and 400 for a malformed initiate", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const app = buildApp({ config: cfg(), db, limiters: createRateLimiters({ windowMs: 60_000, ipLimit: 100_000, identityLimit: 100_000 }) });
    await app.ready();
    const r404 = await app.inject({ method: "GET", url: "/v1/claimable?recipientId=nope" });
    assert.equal(r404.statusCode, 404);
    const r400 = await app.inject({ method: "POST", url: "/v1/claims/initiate", payload: { assetKey: "x", claimant: "not-base58!!" } });
    assert.equal(r400.statusCode, 400);
    await app.close();
  });

  it("enforces the per-IP rate limit (429)", async (t) => {
    if (!usable) return t.skip("M3 schema not migrated");
    const app = buildApp({ config: cfg(), db, limiters: createRateLimiters({ windowMs: 60_000, ipLimit: 3, identityLimit: 100_000 }) });
    await app.ready();
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({ method: "GET", url: "/v1/claimable?recipientId=whatever" });
      codes.push(r.statusCode);
    }
    assert.ok(codes.includes(429), `expected a 429 within the burst, got ${codes.join(",")}`);
    await app.close();
  });
});
