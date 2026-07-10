//! Boot config validation — fails FAST on each documented misconfig (M7 gate).

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import bs58 from "bs58";
import { Buffer } from "node:buffer";

import { assertBootConfig, BootConfigError, looksPooled, validateBootConfig } from "./config-validation.js";

// A valid 32-byte base58 address + its 64-hex form, for key-distinctness tests.
const ADDR_A = bs58.encode(Buffer.alloc(32, 1));
const ADDR_B = bs58.encode(Buffer.alloc(32, 2));
const HEX_C = Buffer.alloc(32, 3).toString("hex");
const HEX_D = Buffer.alloc(32, 4).toString("hex");

/** A minimal env that PASSES worker validation, so each test mutates one thing. */
function goodWorkerEnv(): NodeJS.ProcessEnv {
  return {
    NETWORK: "solana-mainnet",
    DATABASE_URL: "postgres://u:p@db:5432/claims",
    SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
    CONFIRM_RPC_URL: "https://my-single-rpc.example.com",
    ARIO_MINT: ADDR_A,
    TREASURY_KEY_SEALED_PATH: "/run/secrets/treasury.json",
    TREASURY_KEY_PASSPHRASE: "kek",
    TREASURY_ADDRESS: ADDR_B,
    ATTESTOR_PUBKEY_HEX: HEX_C,
    AUDIT_PUBKEY_HEX: HEX_D,
    LEDGER_PUBLISHER_PUBKEY_HEX: Buffer.alloc(32, 5).toString("hex"),
    ANT_COLD_ADDRESS: bs58.encode(Buffer.alloc(32, 6)),
  };
}

describe("looksPooled heuristic", () => {
  it("flags comma-joined / lb / pool / round-robin URLs", () => {
    assert.equal(looksPooled("https://a.com,https://b.com"), true);
    assert.equal(looksPooled("https://rpc-lb.example.com"), true);
    assert.equal(looksPooled("https://rpc-pool.example.com"), true);
    assert.equal(looksPooled("https://round-robin.example.com"), true);
  });
  it("passes a single consistent endpoint", () => {
    assert.equal(looksPooled("https://api.mainnet-beta.solana.com"), false);
    assert.equal(looksPooled("https://my-dedicated-rpc.example.com"), false);
  });
});

describe("validateBootConfig — happy path", () => {
  it("a well-formed worker env has NO errors", () => {
    const r = validateBootConfig(goodWorkerEnv(), { role: "worker" });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.errors.length, 0);
  });
  it("assertBootConfig returns (does not throw) on a good env", () => {
    assert.doesNotThrow(() => assertBootConfig(goodWorkerEnv(), { role: "worker" }));
  });
});

describe("validateBootConfig — documented misconfigs fail fast", () => {
  it("MISCONFIG 1: a pooled CONFIRM RPC is a WORKER error (exactly-once double-send risk)", () => {
    const env = { ...goodWorkerEnv(), CONFIRM_RPC_URL: "https://rpc-lb.example.com,https://rpc2" };
    const r = validateBootConfig(env, { role: "worker" });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.code === "CONFIRM_RPC_POOLED"));
    // ...but only a WARNING for the read-only API (it doesn't do exactly-once).
    const api = validateBootConfig(env, { role: "api" });
    assert.equal(api.ok, true);
    assert.ok(api.warnings.some((w) => w.code === "CONFIRM_RPC_POOLED"));
  });

  it("MISCONFIG 2: two of the five keys sharing an address is a KEY_REUSE error", () => {
    // Make the audit key (hex) equal the treasury address (base58) → same bytes.
    const shared = Buffer.alloc(32, 9);
    const env = { ...goodWorkerEnv(), TREASURY_ADDRESS: bs58.encode(shared), AUDIT_PUBKEY_HEX: shared.toString("hex") };
    const r = validateBootConfig(env, { role: "worker" });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.code === "KEY_REUSE"), JSON.stringify(r.errors));
  });

  it("MISCONFIG 3: NETWORK=mainnet with a devnet RPC is a NETWORK_RPC_MISMATCH error", () => {
    const env = { ...goodWorkerEnv(), SOLANA_RPC_URL: "https://api.devnet.solana.com", CONFIRM_RPC_URL: "https://api.devnet.solana.com" };
    const r = validateBootConfig(env, { role: "worker" });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.code === "NETWORK_RPC_MISMATCH"));
  });

  it("MISCONFIG 3b: NETWORK=devnet with a mainnet RPC is flagged too", () => {
    const env = {
      ...goodWorkerEnv(), NETWORK: "solana-devnet",
      SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com", CONFIRM_RPC_URL: "https://api.mainnet-beta.solana.com",
    };
    const r = validateBootConfig(env, { role: "worker" });
    assert.ok(r.errors.some((e) => e.code === "NETWORK_RPC_MISMATCH"));
  });

  it("MISCONFIG 4: an unknown NETWORK is rejected", () => {
    const r = validateBootConfig({ ...goodWorkerEnv(), NETWORK: "solana-testnet" }, { role: "worker" });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.code === "NETWORK_INVALID"));
  });

  it("MISCONFIG 5: a bare *_SEED_BASE64 on mainnet is rejected (keys must be sealed)", () => {
    const env: NodeJS.ProcessEnv = { ...goodWorkerEnv(), TREASURY_SEED_BASE64: Buffer.alloc(32, 7).toString("base64") };
    delete env.TREASURY_KEY_SEALED_PATH; delete env.TREASURY_KEY_PASSPHRASE;
    const r = validateBootConfig(env, { role: "worker" });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.code === "MAINNET_BARE_SEED"));
  });

  it("MISCONFIG 6: the worker requires ARIO_MINT + a treasury signer", () => {
    const env = goodWorkerEnv();
    delete env.ARIO_MINT; delete env.TREASURY_KEY_SEALED_PATH; delete env.TREASURY_KEY_PASSPHRASE;
    const r = validateBootConfig(env, { role: "worker" });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.code === "ARIO_MINT_MISSING"));
    assert.ok(r.errors.some((e) => e.code === "TREASURY_SIGNER_MISSING"));
  });

  it("MISCONFIG 7: DATABASE_URL must be explicit on a real network", () => {
    const env = goodWorkerEnv();
    delete env.DATABASE_URL;
    const r = validateBootConfig(env, { role: "api" });
    assert.ok(r.errors.some((e) => e.code === "DATABASE_URL_MISSING"));
    // ...but localnet is allowed to use the dev default.
    const local = validateBootConfig({ ...env, NETWORK: "localnet", SOLANA_RPC_URL: "http://127.0.0.1:8899", CONFIRM_RPC_URL: "http://127.0.0.1:8899" }, { role: "api" });
    assert.equal(local.errors.some((e) => e.code === "DATABASE_URL_MISSING"), false);
  });

  it("assertBootConfig THROWS a BootConfigError listing every problem", () => {
    const env = { ...goodWorkerEnv(), NETWORK: "solana-testnet", CONFIRM_RPC_URL: "https://rpc-pool.x,y" };
    try {
      assertBootConfig(env, { role: "worker" });
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(e instanceof BootConfigError);
      assert.ok((e as BootConfigError).problems.length >= 2);
      assert.match((e as Error).message, /boot config validation failed/);
    }
  });

  it("an invalid key value (not hex/base58) is reported, not swallowed", () => {
    const r = validateBootConfig({ ...goodWorkerEnv(), AUDIT_PUBKEY_HEX: "not-a-key" }, { role: "worker" });
    assert.ok(r.errors.some((e) => e.code === "KEY_ADDRESS_INVALID"));
  });
});
