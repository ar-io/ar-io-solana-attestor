//! HTTP wiring for the M6 transparency endpoints (app.inject, no port bind).
//! Gated on DATABASE_URL + migrated transparency schema.

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import { buildApp } from "../app.js";
import type { Config } from "../config.js";
import { createDb, type Db } from "../db.js";
import { createRateLimiters } from "./rate-limit.js";
import { keypairFromSeed } from "../transparency/keys.js";
import { buildLedgerArtifact, verifyMembership, type LedgerLeaf } from "../transparency/ledger-artifact.js";
import { persistPublishedLedger } from "../transparency/store.js";

const HAS_DB = !!process.env.DATABASE_URL;
const PUB = keypairFromSeed("publisher", new Uint8Array(32).fill(11));

function cfg(over: Partial<Config> = {}): Config {
  return {
    port: 0, host: "127.0.0.1", logLevel: "silent", network: "solana-mainnet",
    databaseUrl: process.env.DATABASE_URL ?? "", solanaRpcUrl: "http://127.0.0.1:8899",
    challengeTtlMs: 900_000, bigClaimThresholdMario: 100_000_000_000n,
    rateLimitPerMin: 100_000, rateLimitIdentityPerMin: 100_000, corsOrigin: "*", ...over,
  };
}

const LEAVES: LedgerLeaf[] = [
  { recipientId: "httpRecA", protocol: 0, assetKey: "http-token-1", assetType: "token", amount: "42", antMint: null, vaultEndTs: null, status: "available" },
  { recipientId: "httpRecA", protocol: 0, assetKey: "http-ant-1", assetType: "ant", amount: null, antMint: "http-ant-1", vaultEndTs: null, status: "available" },
  { recipientId: "httpRecB", protocol: 1, assetKey: "http-vault-1", assetType: "vault", amount: "1000", antMint: null, vaultEndTs: 1795000000, status: "manual_review" },
];

describe("transparency HTTP routes", { skip: HAS_DB ? false : "DATABASE_URL not set" }, () => {
  let db: Db;
  let usable = false;
  const publishedIds: string[] = [];

  before(async () => {
    db = createDb(process.env.DATABASE_URL!, { max: 6 });
    try {
      const t = await db.pool.query("SELECT to_regclass('public.published_ledger') AS r");
      usable = t.rows[0].r !== null;
    } catch {
      usable = false;
    }
  });
  after(async () => {
    if (db) {
      if (publishedIds.length) {
        try { await db.pool.query("DELETE FROM published_ledger WHERE id = ANY($1::bigint[])", [publishedIds]); } catch { /* best effort */ }
      }
      await db.close();
    }
  });

  it("serves the signed ledger, a membership proof, log + anchors; reserves route is wired", async (t) => {
    if (!usable) return t.skip("transparency schema not migrated");
    const artifact = buildLedgerArtifact({ leaves: LEAVES, network: "solana-mainnet", ledgerVersion: `http-${Date.now()}`, publisher: PUB });
    const myId = await persistPublishedLedger(db.pool, artifact);
    publishedIds.push(myId);

    const app = buildApp({ config: cfg(), db, limiters: createRateLimiters({ windowMs: 60_000, ipLimit: 100_000, identityLimit: 100_000 }) });
    await app.ready();

    // ledger manifest for OUR id (deterministic under concurrent publishers).
    const led = await app.inject({ method: "GET", url: `/v1/transparency/ledger?id=${myId}` });
    assert.equal(led.statusCode, 200);
    assert.equal(led.json().manifest.rootHex, artifact.manifest.rootHex);
    assert.equal(led.json().leaves, undefined);
    // The latest-ledger endpoint (no id) is reachable and returns a valid manifest.
    const latest = await app.inject({ method: "GET", url: "/v1/transparency/ledger" });
    assert.equal(latest.statusCode, 200);
    assert.ok(typeof latest.json().manifest.rootHex === "string");
    const full = await app.inject({ method: "GET", url: `/v1/transparency/ledger?id=${myId}&full=1` });
    assert.equal(full.json().leaves.length, 3);

    // membership proof for a real asset — independently verifiable against the root
    const pr = await app.inject({ method: "GET", url: `/v1/transparency/ledger/proof?id=${myId}&assetKey=http-vault-1` });
    assert.equal(pr.statusCode, 200);
    const body = pr.json();
    assert.equal(body.verifiesAgainstRoot, true);
    assert.ok(verifyMembership({ assetKey: body.assetKey, leaf: body.leaf, leafHashHex: body.leafHashHex, proof: body.proof, rootHex: body.rootHex }, artifact.manifest.rootHex));

    // unknown asset -> 404
    const miss = await app.inject({ method: "GET", url: `/v1/transparency/ledger/proof?id=${myId}&assetKey=nope` });
    assert.equal(miss.statusCode, 404);

    // audit log page + head shape
    const log = await app.inject({ method: "GET", url: "/v1/transparency/log?limit=5" });
    assert.equal(log.statusCode, 200);
    assert.ok(Array.isArray(log.json().entries));

    // anchors list
    const anch = await app.inject({ method: "GET", url: "/v1/transparency/anchors" });
    assert.equal(anch.statusCode, 200);
    assert.ok(Array.isArray(anch.json().anchors));

    // A non-numeric ?limit must NOT reach SQL as `LIMIT NaN` (would 500). It is
    // clamped to the default instead — 200, not 500 (low/info hardening).
    const badLog = await app.inject({ method: "GET", url: "/v1/transparency/log?limit=abc" });
    assert.equal(badLog.statusCode, 200, "bad ?limit must clamp, not 500");
    assert.ok(Array.isArray(badLog.json().entries));
    const badAnch = await app.inject({ method: "GET", url: "/v1/transparency/anchors?limit=NaN" });
    assert.equal(badAnch.statusCode, 200, "bad ?limit must clamp, not 500");
    assert.ok(Array.isArray(badAnch.json().anchors));

    // reserves route is registered (503 when mint/treasury not configured in env)
    const res = await app.inject({ method: "GET", url: "/v1/transparency/reserves" });
    assert.notEqual(res.statusCode, 404);

    await app.close();
  });
});
