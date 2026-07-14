import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import { assertKnownGoodFingerprints, KNOWN_GOOD_FINGERPRINTS } from "./inputs.js";

// MED-C: the loader pins the sha256 of every frozen input and asserts it at
// load time. A tampered frozen INPUT (e.g. an inflated raw-vaults.json amount)
// otherwise sails past reconcile — the builder and the "independent"
// authoritative reconciler read the SAME poisoned file, so the bit-exact diff
// still matches. These tests exercise the fail-closed comparison directly
// (no need to stage the ~20MB frozen dir); a real file edit changes that file's
// sha256, which flows into the computed map exactly as a flipped hash here does.

describe("assertKnownGoodFingerprints (frozen-input tripwire, MED-C)", () => {
  const good = (): Record<string, string> => ({ ...KNOWN_GOOD_FINGERPRINTS });

  afterEach(() => {
    delete process.env.ALLOW_UNPINNED_FROZEN_INPUTS;
  });

  it("genuine (matching) fingerprints => no throw", () => {
    assert.doesNotThrow(() => assertKnownGoodFingerprints(good()));
  });

  it("a MODIFIED input file (changed sha256) => FAILs closed", () => {
    // Simulate raw-vaults.json being edited: its content hash changes.
    const tampered = good();
    tampered["raw-vaults.json"] = createHash("sha256")
      .update("inflated-vault-amountMario")
      .digest("hex");
    assert.throws(
      () => assertKnownGoodFingerprints(tampered),
      /fingerprint assertion FAILED[\s\S]*raw-vaults\.json/,
    );
  });

  it("the ANT-set digest changing (added/removed/re-owned ANT) => FAILs", () => {
    const tampered = good();
    tampered["ants/"] = "0".repeat(64);
    assert.throws(() => assertKnownGoodFingerprints(tampered), /"ants\/"/);
  });

  it("a MISSING pinned input => FAILs closed", () => {
    const missing = good();
    delete missing["delivery-escrow-plan.json"];
    assert.throws(
      () => assertKnownGoodFingerprints(missing),
      /missing computed fingerprint[\s\S]*delivery-escrow-plan\.json/,
    );
  });

  it("an UNEXPECTED extra input => FAILs closed", () => {
    const extra = good();
    extra["smuggled-input.json"] = "ab".repeat(32);
    assert.throws(() => assertKnownGoodFingerprints(extra), /unexpected input/);
  });

  it("ALLOW_UNPINNED_FROZEN_INPUTS=1 bypasses (documented re-freeze escape)", () => {
    process.env.ALLOW_UNPINNED_FROZEN_INPUTS = "1";
    const tampered = good();
    tampered["raw-vaults.json"] = "ff".repeat(32);
    assert.doesNotThrow(() => assertKnownGoodFingerprints(tampered));
  });

  it("pins exactly the seven canonical frozen inputs", () => {
    assert.deepEqual(Object.keys(KNOWN_GOOD_FINGERPRINTS).sort(), [
      "address-map.json",
      "ants/",
      "delivery-escrow-plan.json",
      "escrow-recipient-AT-RISK.json",
      "escrow-recipient-modulus.json",
      "raw-vaults.json",
      "snapshot-summary.json",
    ]);
  });
});
