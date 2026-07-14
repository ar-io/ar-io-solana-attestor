//! ADR-027 vault settlement decision tests.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { computeVaultSettlement } from "./vault-settlement.js";
import { VerificationError } from "./errors.js";
import {
  MIN_VAULT_SIZE_MARIO,
  MIN_VAULT_LOCK_SECONDS,
} from "../ledger/vault-rules.js";

const MIN = BigInt(MIN_VAULT_LOCK_SECONDS); // 14 days
const MAX = BigInt(200 * 365 * 86_400); // DEFAULT_MAX_VAULT_DURATION
const NOW = 1_783_641_600n; // 2026-07-10T00:00:00Z (the M1 pin)
const AMOUNT = 1_000_000_000n; // 1000 ARIO, above MIN_VAULT_SIZE

function settle(overrides: Partial<Parameters<typeof computeVaultSettlement>[0]> = {}) {
  return computeVaultSettlement({
    vaultEndTs: NOW + MIN + 100n,
    amount: AMOUNT,
    minVaultDuration: MIN,
    maxVaultDuration: MAX,
    now: NOW,
    ...overrides,
  });
}

describe("computeVaultSettlement — ADR-027 three branches", () => {
  it("expired (remaining == 0) -> liquid", () => {
    const s = settle({ vaultEndTs: NOW });
    assert.equal(s.kind, "liquid");
    assert.equal(s.kind === "liquid" && s.reason, "expired");
    assert.equal(s.remainingSeconds, 0n);
  });

  it("expired (remaining < 0) -> liquid", () => {
    const s = settle({ vaultEndTs: NOW - 5n });
    assert.equal(s.kind, "liquid");
    assert.equal(s.kind === "liquid" && s.reason, "expired");
    assert.equal(s.remainingSeconds, -5n);
  });

  it("below MIN_VAULT_SIZE amount -> liquid (re-lock would revert VaultBelowMinimum)", () => {
    const s = settle({ amount: MIN_VAULT_SIZE_MARIO - 1n, vaultEndTs: NOW + MAX / 2n });
    assert.equal(s.kind, "liquid");
    assert.equal(s.kind === "liquid" && s.reason, "below_min_amount");
  });

  it("remaining just under min_vault_duration -> liquid (BD-113 early-liquidity window)", () => {
    const s = settle({ vaultEndTs: NOW + MIN - 1n });
    assert.equal(s.kind, "liquid");
    assert.equal(s.kind === "liquid" && s.reason, "below_min_duration");
    assert.equal(s.remainingSeconds, MIN - 1n);
  });

  it("remaining == min_vault_duration -> RE-LOCK (boundary is re-lock)", () => {
    const s = settle({ vaultEndTs: NOW + MIN });
    assert.equal(s.kind, "relock");
    if (s.kind !== "relock") return;
    assert.equal(s.lockDurationSeconds, MIN);
    assert.equal(s.unlockTimestamp, NOW + MIN);
    assert.equal(s.revocable, false);
  });

  it("re-lock: unlock lands at EXACTLY the original vault_end_timestamp", () => {
    const end = NOW + MIN + 987_654n;
    const s = settle({ vaultEndTs: end });
    assert.equal(s.kind, "relock");
    if (s.kind !== "relock") return;
    assert.equal(s.unlockTimestamp, end);
    assert.equal(s.lockDurationSeconds, end - NOW);
    assert.equal(NOW + s.lockDurationSeconds, end);
  });

  it("remaining > max_vault_duration -> LOCK_DURATION_TOO_LONG (no silent cap)", () => {
    assert.throws(
      () => settle({ vaultEndTs: NOW + MAX + 1n }),
      (e: unknown) =>
        e instanceof VerificationError && e.code === "LOCK_DURATION_TOO_LONG",
    );
  });

  it("remaining == max_vault_duration -> RE-LOCK (upper boundary ok)", () => {
    const s = settle({ vaultEndTs: NOW + MAX });
    assert.equal(s.kind, "relock");
    if (s.kind !== "relock") return;
    assert.equal(s.lockDurationSeconds, MAX);
  });

  it("accepts number inputs (not just bigint) and normalizes", () => {
    const s = computeVaultSettlement({
      vaultEndTs: Number(NOW) + Number(MIN) + 10,
      amount: 1_000_000_000,
      minVaultDuration: Number(MIN),
      maxVaultDuration: Number(MAX),
      now: Number(NOW),
    });
    assert.equal(s.kind, "relock");
  });

  it("rejects non-integer number input", () => {
    assert.throws(
      () => settle({ now: 1.5 as unknown as bigint }),
      (e: unknown) => e instanceof VerificationError && e.code === "INVALID_INPUT",
    );
  });

  it("rejects negative amount", () => {
    assert.throws(
      () => settle({ amount: -1n }),
      (e: unknown) => e instanceof VerificationError && e.code === "INVALID_INPUT",
    );
  });

  it("amount check precedes duration: sub-min amount but healthy duration -> below_min_amount", () => {
    const s = settle({ amount: 1n, vaultEndTs: NOW + MIN * 10n });
    assert.equal(s.kind === "liquid" && s.reason, "below_min_amount");
  });

  it("expired check precedes amount: sub-min amount AND expired -> expired", () => {
    const s = settle({ amount: 1n, vaultEndTs: NOW - 1n });
    assert.equal(s.kind === "liquid" && s.reason, "expired");
  });
});
