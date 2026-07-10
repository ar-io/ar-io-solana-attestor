//! float: brake + insufficient-float denials, cap/refill status.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { Address } from "@solana/kit";

import { FloatManager, type FloatPolicy } from "./float.js";
import type { ChainGateway } from "./chain.js";

const ONE_TOKEN = 1_000_000n;
const policy: FloatPolicy = {
  capMario: 500_000n * ONE_TOKEN,
  bigClaimThresholdMario: 100_000n * ONE_TOKEN,
  refillThresholdMario: 100_000n * ONE_TOKEN,
};

describe("FloatManager.check", () => {
  const fm = new FloatManager(policy);

  it("permits a normal claim within float + under brake", () => {
    const d = fm.check({ amountMario: 50_000n * ONE_TOKEN, availableMario: 400_000n * ONE_TOKEN, approved: false });
    assert.equal(d, null);
  });

  it("blocks a claim over the >100k brake unless approved", () => {
    const d = fm.check({ amountMario: 150_000n * ONE_TOKEN, availableMario: 400_000n * ONE_TOKEN, approved: false });
    assert.ok(d && d.reason === "exceeds_brake");
  });

  it("an approved over-brake claim is permitted (float allowing)", () => {
    const d = fm.check({ amountMario: 150_000n * ONE_TOKEN, availableMario: 400_000n * ONE_TOKEN, approved: true });
    assert.equal(d, null);
  });

  it("blocks a claim exceeding available float", () => {
    const d = fm.check({ amountMario: 90_000n * ONE_TOKEN, availableMario: 10_000n * ONE_TOKEN, approved: false });
    assert.ok(d && d.reason === "insufficient_float");
  });

  it("brake is checked before float (a big over-float claim reads as brake)", () => {
    const d = fm.check({ amountMario: 900_000n * ONE_TOKEN, availableMario: 10_000n * ONE_TOKEN, approved: false });
    assert.ok(d && d.reason === "exceeds_brake");
  });
});

describe("FloatManager.status", () => {
  function stubGateway(balance: bigint): ChainGateway {
    return {
      getTokenBalance: async () => balance,
      accountExists: async () => true,
      getBlockHeight: async () => 1000n,
      signTransaction: async () => { throw new Error("unused"); },
      broadcast: async () => {},
      confirmSignature: async () => "pending",
    };
  }
  function stubDb(reserved: bigint) {
    return {
      query: async () => ({ rows: [{ total: reserved.toString() }] }),
    } as unknown as Parameters<FloatManager["reserved"]>[0];
  }
  const ata = "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB" as Address;

  it("available = balance - reserved; refill flagged below threshold", async () => {
    const fm = new FloatManager(policy);
    const st = await fm.status(stubDb(450_000n * ONE_TOKEN), stubGateway(500_000n * ONE_TOKEN), ata);
    assert.equal(st.balanceMario, 500_000n * ONE_TOKEN);
    assert.equal(st.reservedMario, 450_000n * ONE_TOKEN);
    assert.equal(st.availableMario, 50_000n * ONE_TOKEN);
    assert.equal(st.refillNeeded, true); // 50k < 100k threshold
    assert.equal(st.overCap, false);
  });

  it("flags overCap when the hot balance exceeds the cap", async () => {
    const fm = new FloatManager(policy);
    const st = await fm.status(stubDb(0n), stubGateway(600_000n * ONE_TOKEN), ata);
    assert.equal(st.overCap, true);
  });

  it("available floors at 0 when reserved exceeds balance", async () => {
    const fm = new FloatManager(policy);
    const st = await fm.status(stubDb(600_000n * ONE_TOKEN), stubGateway(500_000n * ONE_TOKEN), ata);
    assert.equal(st.availableMario, 0n);
  });
});
