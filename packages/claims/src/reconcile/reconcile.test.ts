import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { AuthoritativeResult } from "./authoritative.js";
import {
  type BuiltAsset,
  checkVaultStakeMarioGate,
  EXPECTED_GATE,
  gateAppliesAt,
  reconcile,
} from "./reconcile.js";

function auth(
  deposits: Array<[string, { assetType: "ant" | "token" | "vault"; amount: bigint | null; recipientHex: string }]>,
): AuthoritativeResult {
  const map = new Map(
    deposits.map(([k, v]) => [k, { assetType: v.assetType, assetKey: k, amount: v.amount, recipientHex: v.recipientHex }]),
  );
  const seed = { ant: 0, token: 0, vault: 0 };
  for (const d of map.values()) seed[d.assetType]++;
  return {
    deposits: map,
    counters: { ant: 0, tokenEscrowed: 0, vaultEscrowed: 0, stakeEscrowed: 0 },
    phase2TokenOutflowMario: 0n,
    phase3VaultMario: 0n,
    phase4StakeMario: 0n,
    onchainSeedCounts: seed,
    importSrc: "(test)",
  };
}

function built(entries: Array<[string, BuiltAsset]>): Map<string, BuiltAsset> {
  return new Map(entries);
}

const RH = "aa".repeat(20); // recipient hex (20-byte ETH-shaped)

describe("reconcile() diff engine", () => {
  it("identical sets => PASS, zero diffs", () => {
    const a = auth([
      ["k1", { assetType: "token", amount: 100n, recipientHex: RH }],
      ["k2", { assetType: "ant", amount: null, recipientHex: RH }],
    ]);
    const b = built([
      ["k1", { assetType: "token", assetKey: "k1", amount: 100n, recipientHex: RH }],
      ["k2", { assetType: "ant", assetKey: "k2", amount: null, recipientHex: RH }],
    ]);
    const r = reconcile(b, a);
    assert.equal(r.pass, true);
    assert.equal(r.diffs.length, 0);
    assert.equal(r.matched, 2);
  });

  it("catches amount_mismatch (off-by-one mARIO)", () => {
    const a = auth([["k1", { assetType: "token", amount: 100n, recipientHex: RH }]]);
    const b = built([["k1", { assetType: "token", assetKey: "k1", amount: 101n, recipientHex: RH }]]);
    const r = reconcile(b, a);
    assert.equal(r.pass, false);
    assert.equal(r.diffs[0].reason, "amount_mismatch");
  });

  it("catches missing_in_built and extra_in_built", () => {
    const a = auth([["k1", { assetType: "token", amount: 1n, recipientHex: RH }]]);
    const b = built([["k2", { assetType: "token", assetKey: "k2", amount: 1n, recipientHex: RH }]]);
    const r = reconcile(b, a);
    assert.equal(r.pass, false);
    const reasons = r.diffs.map((d) => d.reason).sort();
    assert.deepEqual(reasons, ["extra_in_built", "missing_in_built"]);
  });

  it("catches type_mismatch (token vs vault)", () => {
    const a = auth([["k1", { assetType: "vault", amount: 1n, recipientHex: RH }]]);
    const b = built([["k1", { assetType: "token", assetKey: "k1", amount: 1n, recipientHex: RH }]]);
    const r = reconcile(b, a);
    assert.equal(r.diffs[0].reason, "type_mismatch");
  });

  it("catches recipient_mismatch (wrong bytes)", () => {
    const a = auth([["k1", { assetType: "token", amount: 1n, recipientHex: RH }]]);
    const b = built([["k1", { assetType: "token", assetKey: "k1", amount: 1n, recipientHex: "bb".repeat(20) }]]);
    const r = reconcile(b, a);
    assert.equal(r.diffs[0].reason, "recipient_mismatch");
  });

  it("EXPECTED_GATE pins the published frozen dry-run numbers", () => {
    assert.equal(EXPECTED_GATE.ant, 2269);
    assert.equal(EXPECTED_GATE.tokenEscrowed, 5374);
    assert.equal(EXPECTED_GATE.vaultEscrowed, 111);
    assert.equal(EXPECTED_GATE.stakeEscrowed, 2957);
    assert.equal(EXPECTED_GATE.total, 10711);
    assert.equal(EXPECTED_GATE.atRisk, 136);
    assert.equal(EXPECTED_GATE.phase2TokenOutflowMario, 48264957232031n);
    assert.equal(EXPECTED_GATE.nowMs, 1783641600000);
  });

  it("EXPECTED_GATE pins absolute vault + stake mARIO (MED-C)", () => {
    // Captured from the canonical frozen dir; nowMs-independent absolutes.
    assert.equal(EXPECTED_GATE.expectedVaultMario, 20629353000000n);
    assert.equal(EXPECTED_GATE.expectedStakeMario, 4382868348396n);
    assert.equal(typeof EXPECTED_GATE.expectedVaultMario, "bigint");
    // Σ available = phase2 + vault + stake = 73,277,178.580427 ARIO.
    assert.equal(
      EXPECTED_GATE.phase2TokenOutflowMario +
        EXPECTED_GATE.expectedVaultMario +
        EXPECTED_GATE.expectedStakeMario,
      73277178580427n,
    );
  });

  it("gateAppliesAt: the published oracle is coupled to its reference instant", () => {
    assert.equal(gateAppliesAt(EXPECTED_GATE.nowMs), true);
    assert.equal(gateAppliesAt(EXPECTED_GATE.nowMs + 1), false); // a re-pin -> oracle skipped
  });
});

describe("checkVaultStakeMarioGate — catches a tampered vault/stake amount (MED-C)", () => {
  const V = EXPECTED_GATE.expectedVaultMario;
  const S = EXPECTED_GATE.expectedStakeMario;

  it("genuine per-phase totals => no failures", () => {
    assert.deepEqual(checkVaultStakeMarioGate("built", V, S), []);
  });

  it("an inflated vault amountMario (+1) FAILs the gate", () => {
    // Pre-fix there was NO absolute vault pin, so inflating a raw-vaults.json
    // balance passed: the count is unchanged and both builder + authoritative
    // read the same tampered file, so the bit-exact diff matched too.
    const fails = checkVaultStakeMarioGate("built", V + 1n, S);
    assert.equal(fails.length, 1);
    assert.match(fails[0], /vaultMario/);
  });

  it("an inflated stake amountMario FAILs the gate", () => {
    const fails = checkVaultStakeMarioGate("authoritative", V, S + 1_000_000n);
    assert.equal(fails.length, 1);
    assert.match(fails[0], /stakeMario/);
  });

  it("both inflated => two failures", () => {
    assert.equal(checkVaultStakeMarioGate("built", V + 5n, S + 5n).length, 2);
  });
});
