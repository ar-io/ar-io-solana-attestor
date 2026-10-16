import { test } from "node:test";
import assert from "node:assert/strict";
import { isRetiredAnt, RETIRED_ANTS } from "./retired-ants.js";
import { MANUALLY_DELIVERED } from "./manually-delivered.js";

test("isRetiredAnt — a retired custody ANT is de-listed", () => {
  // 000001: burned on mainnet 2026-10-16 (tx 5UEsMyCs…).
  assert.equal(isRetiredAnt("8G3GrFxzY9uGfoxLurjkJqoXZ4ENsQ9Vi64waWfXQLq"), true);
});

test("isRetiredAnt — unrelated assets are NOT de-listed", () => {
  assert.equal(isRetiredAnt("SomeOtherAssetKey1111111111111111111111111"), false);
  assert.equal(isRetiredAnt(""), false);
  // guard against prototype-key false positives
  assert.equal(isRetiredAnt("hasOwnProperty"), false);
  assert.equal(isRetiredAnt("toString"), false);
});

test("every retired entry is a base58 mint with an ArNS name, none manually delivered", () => {
  const keys = Object.keys(RETIRED_ANTS);
  assert.equal(keys.length, 582);
  for (const [key, name] of Object.entries(RETIRED_ANTS)) {
    assert.match(key, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, `${key} is base58`);
    assert.match(name, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, `${key} has an ArNS name`);
    assert.ok(!Object.prototype.hasOwnProperty.call(MANUALLY_DELIVERED, key), `${key} not also manually delivered`);
  }
});
