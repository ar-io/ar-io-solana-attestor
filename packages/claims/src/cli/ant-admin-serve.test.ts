//! Boot-validation tests for the dedicated ANT admin server (B3). Pure over env —
//! no port, no DB. Proves: cli-cold (default) => disabled/inert; operator-wallet +
//! a POOLED confirm-RPC => boot REFUSES (worker-grade single-endpoint requirement);
//! operator-wallet + a single endpoint + separable keys => enabled.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import bs58 from "bs58";
import { Buffer } from "node:buffer";

import { assertAntAdminBoot } from "./ant-admin-serve.js";
import { BootConfigError } from "../ops/config-validation.js";

/** A worker-valid env with five distinct keys (mirrors config-validation.test). */
function goodOperatorEnv(): NodeJS.ProcessEnv {
  return {
    NETWORK: "solana-mainnet",
    DATABASE_URL: "postgres://u:p@db:5432/claims",
    SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
    CONFIRM_RPC_URL: "https://my-single-rpc.example.com",
    CORS_ORIGIN: "https://claim.ar.io",
    ARIO_MINT: bs58.encode(Buffer.alloc(32, 1)),
    TREASURY_KEY_SEALED_PATH: "/run/secrets/treasury.json",
    TREASURY_KEY_PASSPHRASE: "kek",
    TREASURY_ADDRESS: bs58.encode(Buffer.alloc(32, 2)),
    ATTESTOR_PUBKEY_HEX: Buffer.alloc(32, 3).toString("hex"),
    AUDIT_PUBKEY_HEX: Buffer.alloc(32, 4).toString("hex"),
    LEDGER_PUBLISHER_PUBKEY_HEX: Buffer.alloc(32, 5).toString("hex"),
    ANT_COLD_ADDRESS: bs58.encode(Buffer.alloc(32, 6)),
    ANT_DISPATCH_MODE: "operator-wallet",
    ADMIN_CORS_ORIGIN: "https://admin.internal",
  };
}

describe("ant-admin-serve — boot validation (B3)", () => {
  it("cli-cold (default) => disabled/inert, no validation", () => {
    const r = assertAntAdminBoot({ ...goodOperatorEnv(), ANT_DISPATCH_MODE: "cli-cold" });
    assert.equal(r.enabled, false);
    // Even a totally empty env stays disabled (default cli-cold) rather than throwing.
    assert.equal(assertAntAdminBoot({}).enabled, false);
  });

  it("operator-wallet + a POOLED confirm-RPC => boot REFUSES (single-endpoint required)", () => {
    const env = { ...goodOperatorEnv(), CONFIRM_RPC_URL: "https://rpc-lb.example.com,https://b.example.com" };
    try {
      assertAntAdminBoot(env);
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(e instanceof BootConfigError, `expected BootConfigError, got ${(e as Error).name}`);
      assert.ok((e as BootConfigError).problems.some((p) => p.code === "CONFIRM_RPC_POOLED"));
    }
  });

  it("operator-wallet + a persistent server ANT key => boot REFUSES", () => {
    const env = { ...goodOperatorEnv(), ANT_COLD_KEYPAIR_PATH: "/run/cold.json" };
    assert.throws(() => assertAntAdminBoot(env), (e: unknown) =>
      e instanceof BootConfigError && e.problems.some((p) => p.code === "ANT_OPERATOR_MODE_SERVER_KEY"));
  });

  it("operator-wallet + single endpoint + separable keys => enabled", () => {
    const r = assertAntAdminBoot(goodOperatorEnv());
    assert.equal(r.enabled, true);
  });

  it("L2: operator-wallet on a REAL network REFUSES an unset or wildcard ADMIN_CORS_ORIGIN", () => {
    const unset = { ...goodOperatorEnv() };
    delete unset.ADMIN_CORS_ORIGIN;
    assert.throws(() => assertAntAdminBoot(unset), (e: unknown) =>
      e instanceof BootConfigError && e.problems.some((p) => p.code === "ADMIN_CORS_WILDCARD"));
    assert.throws(() => assertAntAdminBoot({ ...goodOperatorEnv(), ADMIN_CORS_ORIGIN: "*" }), (e: unknown) =>
      e instanceof BootConfigError && e.problems.some((p) => p.code === "ADMIN_CORS_WILDCARD"));
  });

  it("L2: localnet allows an unset/wildcard admin CORS origin (dev convenience)", () => {
    const local: NodeJS.ProcessEnv = {
      NETWORK: "localnet", DATABASE_URL: "postgres://u:p@localhost:5432/claims",
      SOLANA_RPC_URL: "http://127.0.0.1:8899", CONFIRM_RPC_URL: "http://127.0.0.1:8899",
      ARIO_MINT: bs58.encode(Buffer.alloc(32, 1)), TREASURY_SEED_BASE64: Buffer.alloc(32, 9).toString("base64"),
      ANT_COLD_ADDRESS: bs58.encode(Buffer.alloc(32, 6)), ANT_DISPATCH_MODE: "operator-wallet",
    };
    assert.equal(assertAntAdminBoot(local).enabled, true);
  });
});
