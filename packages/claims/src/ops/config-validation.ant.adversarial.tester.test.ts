//! INDEPENDENT boot-config adversarial suite for ANT_DISPATCH_MODE (§7.5), by the
//! TESTER agent. operator-wallet mode MUST refuse any persistent server-held ANT
//! key and MUST require ANT_COLD_ADDRESS; cli-cold (the default) MUST leave existing
//! behavior unchanged (no new refusals).

import { strict as assert } from "node:assert";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";
import bs58 from "bs58";

import { validateBootConfig } from "./config-validation.js";

const ADDR = (n: number): string => bs58.encode(Buffer.alloc(32, n));
const HEX = (n: number): string => Buffer.alloc(32, n).toString("hex");

/** A minimal worker env that passes validation (mirrors the dev's test helper). */
function goodWorkerEnv(): NodeJS.ProcessEnv {
  return {
    NETWORK: "solana-mainnet",
    DATABASE_URL: "postgres://u:p@db:5432/claims",
    SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
    CONFIRM_RPC_URL: "https://my-single-rpc.example.com",
    CORS_ORIGIN: "https://claim.ar.io",
    ARIO_MINT: ADDR(1),
    TREASURY_KEY_SEALED_PATH: "/run/secrets/treasury.json",
    TREASURY_KEY_PASSPHRASE: "kek",
    TREASURY_ADDRESS: ADDR(2),
    ATTESTOR_PUBKEY_HEX: HEX(3),
    AUDIT_PUBKEY_HEX: HEX(4),
    LEDGER_PUBLISHER_PUBKEY_HEX: HEX(5),
    ANT_COLD_ADDRESS: ADDR(6),
  };
}
const codes = (env: NodeJS.ProcessEnv): string[] =>
  validateBootConfig(env, { role: "worker" }).errors.map((e) => e.code);

describe("boot config — ANT_DISPATCH_MODE ADVERSARIAL (tester)", () => {
  it("S7-default: no ANT_DISPATCH_MODE => cli-cold; a server-held ANT key is ALLOWED (existing behavior unchanged)", async () => {
    const env = goodWorkerEnv();
    delete env.ANT_DISPATCH_MODE;
    env.ANT_COLD_KEYPAIR_PATH = "/run/secrets/ant-cold.json"; // legacy cold key on the box
    const r = validateBootConfig(env, { role: "worker" });
    assert.ok(!r.errors.some((e) => e.code === "ANT_OPERATOR_MODE_SERVER_KEY"), "cli-cold must NOT refuse a server ANT key");
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  });

  it("S7-explicit-cli-cold: same — server ANT key allowed", () => {
    const env = goodWorkerEnv();
    env.ANT_DISPATCH_MODE = "cli-cold";
    env.ANT_COLD_KEY_SEALED_PATH = "/run/secrets/ant-cold.sealed";
    assert.ok(!codes(env).includes("ANT_OPERATOR_MODE_SERVER_KEY"));
  });

  for (const key of ["ANT_SIGNER_KEY_SEALED_PATH", "ANT_SIGNER_SEED_BASE64", "ANT_COLD_KEY_SEALED_PATH", "ANT_COLD_KEYPAIR_PATH"]) {
    it(`S7: operator-wallet + ${key} set => boot FAILS (ANT_OPERATOR_MODE_SERVER_KEY)`, () => {
      const env = goodWorkerEnv();
      env.ANT_DISPATCH_MODE = "operator-wallet";
      env[key] = key.includes("SEED") ? Buffer.alloc(32, 7).toString("base64") : "/run/secrets/ant.key";
      const r = validateBootConfig(env, { role: "worker" });
      assert.equal(r.ok, false, "must not boot");
      assert.ok(r.errors.some((e) => e.code === "ANT_OPERATOR_MODE_SERVER_KEY"), `expected refusal for ${key}, got ${codes(env)}`);
    });
  }

  it("S7: operator-wallet with MULTIPLE server ANT keys => one refusal per key", () => {
    const env = goodWorkerEnv();
    env.ANT_DISPATCH_MODE = "operator-wallet";
    env.ANT_COLD_KEYPAIR_PATH = "/a";
    env.ANT_SIGNER_SEED_BASE64 = Buffer.alloc(32, 7).toString("base64");
    const refusals = codes(env).filter((c) => c === "ANT_OPERATOR_MODE_SERVER_KEY");
    assert.equal(refusals.length, 2);
  });

  it("S7: operator-wallet WITHOUT ANT_COLD_ADDRESS => boot FAILS (ANT_COLD_ADDRESS_MISSING)", () => {
    const env = goodWorkerEnv();
    env.ANT_DISPATCH_MODE = "operator-wallet";
    delete env.ANT_COLD_ADDRESS;
    const r = validateBootConfig(env, { role: "worker" });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.code === "ANT_COLD_ADDRESS_MISSING"), codes(env).join(","));
  });

  it("S7: operator-wallet, NO server key, ANT_COLD_ADDRESS present => boots clean", () => {
    const env = goodWorkerEnv();
    env.ANT_DISPATCH_MODE = "operator-wallet";
    const r = validateBootConfig(env, { role: "worker" });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  });

  it("S7: an INVALID ANT_DISPATCH_MODE => boot FAILS (ANT_DISPATCH_MODE_INVALID)", () => {
    const env = goodWorkerEnv();
    env.ANT_DISPATCH_MODE = "yolo-mode";
    const r = validateBootConfig(env, { role: "worker" });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.code === "ANT_DISPATCH_MODE_INVALID"));
  });
});
