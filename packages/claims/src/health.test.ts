//! Placeholder test for the claims skeleton (M0).
//!
//! Proves the Fastify app builds and answers `GET /health` with 200
//! without binding a port or touching Postgres. Real claim-flow tests
//! (lookup, proof verification, dispatch, replay defense) arrive in
//! M1-M5 alongside the endpoints they cover.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";

describe("claims /health", () => {
  const config = loadConfig({ NETWORK: "localnet", LOG_LEVEL: "silent" });
  const app = buildApp({ config });

  after(async () => {
    await app.close();
  });

  it("GET /health returns 200 with the service identity", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { ok: boolean; service: string; network: string };
    assert.equal(body.ok, true);
    assert.equal(body.service, "ar-io-claims");
    assert.equal(body.network, "localnet");
  });

  it("GET /health/ready reports ready when no DB is wired", async () => {
    const res = await app.inject({ method: "GET", url: "/health/ready" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { ready: boolean };
    assert.equal(body.ready, true);
  });
});

describe("claims config", () => {
  it("defaults PORT to 3040 and rejects an invalid NETWORK", () => {
    const cfg = loadConfig({});
    assert.equal(cfg.port, 3040);
    assert.equal(cfg.network, "localnet");
    assert.throws(() => loadConfig({ NETWORK: "ethereum" }));
  });
});
