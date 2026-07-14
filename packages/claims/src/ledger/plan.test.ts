import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { deriveRecipientIdB64Url } from "@ar.io/attestor-canonical";
import { ANT_MINT_TEST_SECRET } from "./ant-mint.js";
import type { FrozenInputs } from "./inputs.js";
import { makeNormalizedAddressMap } from "./normalize.js";
import { buildLedgerPlan } from "./plan.js";

const NOW_MS = 1783641600000;
const NOW_S = NOW_MS / 1000;
const DAY = 86_400;

// Build a self-consistent Arweave owner: address = b64url(sha256(modulus)).
function arOwner(fill: number): { addr: string; b64: string } {
  const mod = new Uint8Array(512).fill(fill);
  return { addr: deriveRecipientIdB64Url(mod), b64: Buffer.from(mod).toString("base64url") };
}

const O1 = arOwner(1); // resolvable, unmapped — the main claimant
const O2 = arOwner(2); // MAPPED — everything skipped
const E1 = "0x6C785A62A9dB4E4E1F1D5EbFbEd5e0aB0B0b0B0b"; // ETH, unmapped
const O3_ATRISK = "atRiskOwnerWithNoRecoverableKeyXXXXXXXXXXXXX"; // in AT-RISK, no modulus

function fixture(): FrozenInputs {
  return {
    dir: "(synthetic)",
    addressMap: makeNormalizedAddressMap<string>({ [O2.addr]: "SolanaDestForO2" }),
    // Mapped owners are never in the captured modulus file — only escrow-bound
    // (unmapped) owners are. O2 is present ONLY in the address-map.
    modulus: { [O1.addr]: O1.b64 },
    atRisk: new Set([O3_ATRISK]),
    // AO self-balance is excluded by the loader (inputs.ts), so it is absent here.
    balances: {
      [O1.addr]: 1_000_000,
      [E1]: 2_000_000,
      [O2.addr]: 500, // mapped -> skipped
      [O3_ATRISK]: 777, // AT-RISK -> manual_review
    },
    vaults: {
      [O1.addr]: {
        "v-active": { balance: 200_000_000, startTimestamp: 0, endTimestamp: NOW_MS + 100 * DAY * 1000 },
        "v-expired": { balance: 50_000_000, startTimestamp: 0, endTimestamp: NOW_MS - DAY * 1000 },
        "v-short": { balance: 300_000_000, startTimestamp: 0, endTimestamp: NOW_MS + 5 * DAY * 1000 },
        "v-submin": { balance: 50_000_000, startTimestamp: 0, endTimestamp: NOW_MS + 100 * DAY * 1000 },
      },
    },
    ants: [
      { processId: "ant-O1", Owner: O1.addr },
      { processId: "ant-O2", Owner: O2.addr }, // mapped -> skipped
      { processId: "ant-O3", Owner: O3_ATRISK }, // AT-RISK -> manual_review
    ],
    plan: {
      plans: {
        stakePlan: {
          operatorEscrowVaults: [
            { arweaveAddr: O1.addr, kind: "operator-min", amountMario: "10001000000", unlockTs: NOW_S + 200 * DAY },
          ],
          operatorLiquidEscrows: [],
          delegatorEscrowVaults: [],
          delegatorLiquidEscrows: [
            { arweaveAddr: E1, kind: "delegator-liquid", amountMario: "3000000" },
          ],
        },
        withdrawalPlan: { escrowVaults: [], liquidEscrows: [] },
      },
    },
    fingerprints: {},
  };
}

describe("buildLedgerPlan (synthetic four-phase fixture)", () => {
  const plan = buildLedgerPlan(fixture(), { antMintSecret: ANT_MINT_TEST_SECRET, nowMs: NOW_MS });
  const avail = plan.assets.filter((a) => a.status === "available");
  const review = plan.assets.filter((a) => a.status === "manual_review");
  const byKind = (t: string) => avail.filter((a) => a.assetType === t);

  it("manifest phase counters match batch-escrow's grouping", () => {
    // ant: O1. token(phase2): O1 balance + E1 balance = 2, + expired vault = 3.
    // vault(active unmapped): v-active + v-short + v-submin = 3.
    // stake: operator vault + delegator liquid = 2.
    assert.deepEqual(plan.counters, {
      ant: 1,
      tokenEscrowed: 3,
      vaultEscrowed: 3,
      stakeEscrowed: 2,
    });
  });

  it("available on-chain seed counts (ant/token/vault)", () => {
    assert.equal(byKind("ant").length, 1); // O1 ant
    // token seed: O1 bal, E1 bal, v-expired, v-short(fallback), v-submin(fallback), stake liquid E1
    assert.equal(byKind("token").length, 6);
    // vault seed: v-active, stake operator vault
    assert.equal(byKind("vault").length, 2);
    assert.equal(avail.length, 9);
  });

  it("excludes MAPPED owners entirely (no asset, no recipient)", () => {
    assert.equal(avail.some((a) => a.recipientSource === O2.addr), false);
    assert.equal(review.some((a) => a.recipientSource === O2.addr), false);
    assert.equal(plan.recipients.some((r) => r.sourceAddress === O2.addr), false);
  });

  it("AT-RISK owner assets are manual_review, flagged not deleted, excluded from available", () => {
    assert.equal(plan.atRiskRecipientCount, 1);
    // O3 has an ANT + a token balance -> 2 manual_review assets.
    assert.equal(review.length, 2);
    for (const a of review) assert.equal(a.recipientSource, O3_ATRISK);
    const rec = plan.recipients.find((r) => r.sourceAddress === O3_ATRISK);
    assert.equal(rec?.status, "manual_review");
    assert.equal(rec?.recipientPubkey, null);
    assert.equal(rec?.recipientId, O3_ATRISK); // no key -> id is the source addr
  });

  it("vault routing: expired->token, active->vault, sub-min/short->token fallback", () => {
    const v = (id: string) => plan.assets.find((a) => a.source.vaultId === id);
    assert.equal(v("v-active")?.assetType, "vault");
    assert.equal(typeof v("v-active")?.vaultEndTs, "number");
    assert.equal(v("v-expired")?.assetType, "token");
    assert.equal(v("v-short")?.assetType, "token"); // <14d remaining
    assert.equal(v("v-submin")?.assetType, "token"); // <100 ARIO
  });

  it("recipients: AR id == address, ETH is 20 bytes / protocol 1", () => {
    const r1 = plan.recipients.find((r) => r.sourceAddress === O1.addr);
    assert.equal(r1?.protocol, 0);
    assert.equal(r1?.recipientId, O1.addr); // b64url(sha256(modulus)) == AR address
    assert.equal(r1?.recipientPubkey?.length, 512);
    const re = plan.recipients.find((r) => r.sourceAddress === E1.toLowerCase());
    assert.equal(re?.protocol, 1);
    assert.equal(re?.recipientPubkey?.length, 20);
    assert.equal(re?.recipientId, deriveRecipientIdB64Url(re!.recipientPubkey!));
  });

  it("phase-2 token outflow = only unmapped balances (bigint)", () => {
    assert.equal(plan.phase2TokenOutflowMario, 3_000_000n);
    assert.equal(typeof plan.phase2TokenOutflowMario, "bigint");
  });

  it("phase-3 vault + phase-4 stake mARIO absolute totals (MED-C)", () => {
    // vault (every deposited vault, regardless of routing):
    //   v-active 200M + v-expired 50M + v-short 300M + v-submin 50M = 600M
    assert.equal(plan.phase3VaultMario, 600_000_000n);
    // stake: operator vault 10.001B + delegator liquid 3M = 10.004B
    assert.equal(plan.phase4StakeMario, 10_004_000_000n);
    assert.equal(typeof plan.phase3VaultMario, "bigint");
    assert.equal(typeof plan.phase4StakeMario, "bigint");
  });

  it("tamper: an inflated VAULT amount shifts phase3VaultMario but NOT the counts (MED-C)", () => {
    // The exact gap MED-C closes: an insider inflates a raw-vaults.json balance.
    // The builder AND the authoritative reconciler read the same poisoned file,
    // so the bit-exact diff still matches; the vault COUNT is unchanged, so the
    // count-only gate passes. Only the absolute mARIO pin moves — and catches it.
    const tampered = fixture();
    tampered.vaults[O1.addr]["v-active"].balance += 1_000_000_000;
    const p = buildLedgerPlan(tampered, { antMintSecret: ANT_MINT_TEST_SECRET, nowMs: NOW_MS });
    assert.deepEqual(p.counters, plan.counters); // count-blind
    assert.equal(p.phase3VaultMario, plan.phase3VaultMario + 1_000_000_000n); // pin catches it
  });

  it("tamper: an inflated STAKE amount shifts phase4StakeMario but NOT the counts (MED-C)", () => {
    const tampered = fixture();
    const ov = tampered.plan.plans.stakePlan.operatorEscrowVaults[0];
    ov.amountMario = (BigInt(ov.amountMario) + 2_000_000_000n).toString();
    const p = buildLedgerPlan(tampered, { antMintSecret: ANT_MINT_TEST_SECRET, nowMs: NOW_MS });
    assert.deepEqual(p.counters, plan.counters); // count-blind
    assert.equal(p.phase4StakeMario, plan.phase4StakeMario + 2_000_000_000n); // pin catches it
  });

  it("money is integer bigint everywhere (never float)", () => {
    for (const a of plan.assets) {
      if (a.assetType === "ant") assert.equal(a.amount, null);
      else assert.equal(typeof a.amount, "bigint");
    }
  });

  it("asset_key is unique across all assets", () => {
    const keys = plan.assets.map((a) => a.assetKey);
    assert.equal(new Set(keys).size, keys.length);
  });

  it("throws if an unmapped owner is unresolvable but NOT in the AT-RISK file", () => {
    const bad = fixture();
    bad.balances["someUnknownUnmappedOwnerNotInAtRiskAAAAAAAAAAA"] = 42;
    assert.throws(
      () => buildLedgerPlan(bad, { antMintSecret: ANT_MINT_TEST_SECRET, nowMs: NOW_MS }),
      /NOT in the AT-RISK/,
    );
  });
});
