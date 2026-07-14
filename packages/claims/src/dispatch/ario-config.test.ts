//! Item F: decode min/max vault duration from a live ArioConfig account, and the
//! boot reconciliation that FAILS FAST when the configured durations don't match
//! the on-chain truth (a stale `min` could misclassify a still-locked vault as
//! liquid).

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  MIN_VAULT_DURATION_OFFSET,
  MAX_VAULT_DURATION_OFFSET,
  decodeVaultDurations,
  assertVaultDurationsMatchChain,
} from "./ario-config.js";

/** Build a synthetic ArioConfig data buffer with the given durations at the
 *  documented offsets (mirrors ario-core state/mod.rs::ArioConfig layout). */
function fakeArioConfig(min: bigint, max: bigint, len = 261): Uint8Array {
  const data = new Uint8Array(len);
  const view = new DataView(data.buffer);
  view.setBigInt64(MIN_VAULT_DURATION_OFFSET, min, true);
  view.setBigInt64(MAX_VAULT_DURATION_OFFSET, max, true);
  return data;
}

describe("ario-config vault durations (item F)", () => {
  const MIN = BigInt(14 * 86_400); // 14 days
  const MAX = BigInt(365 * 86_400); // 365 days

  it("decodes min/max vault duration (i64 LE) at the documented offsets", () => {
    const d = decodeVaultDurations(fakeArioConfig(MIN, MAX));
    assert.equal(d.minVaultDuration, MIN);
    assert.equal(d.maxVaultDuration, MAX);
    // Offsets are the layout-derived constants, not magic numbers.
    assert.equal(MIN_VAULT_DURATION_OFFSET, 168);
    assert.equal(MAX_VAULT_DURATION_OFFSET, 176);
  });

  it("rejects an account too short to hold the durations", () => {
    assert.throws(() => decodeVaultDurations(new Uint8Array(100)), /too short/);
  });

  it("reconciliation PASSES when configured == on-chain", () => {
    assert.doesNotThrow(() =>
      assertVaultDurationsMatchChain(
        { minVaultDuration: MIN, maxVaultDuration: MAX },
        decodeVaultDurations(fakeArioConfig(MIN, MAX)),
      ),
    );
  });

  it("reconciliation FAILS FAST on a min mismatch (stale env -> locked-as-liquid risk)", () => {
    assert.throws(
      () =>
        assertVaultDurationsMatchChain(
          { minVaultDuration: BigInt(7 * 86_400), maxVaultDuration: MAX }, // wrong 7-day min
          decodeVaultDurations(fakeArioConfig(MIN, MAX)),
        ),
      /vault-duration mismatch/,
    );
  });

  it("reconciliation FAILS FAST on a max mismatch", () => {
    assert.throws(
      () =>
        assertVaultDurationsMatchChain(
          { minVaultDuration: MIN, maxVaultDuration: BigInt(200 * 86_400) },
          decodeVaultDurations(fakeArioConfig(MIN, MAX)),
        ),
      /vault-duration mismatch/,
    );
  });
});
