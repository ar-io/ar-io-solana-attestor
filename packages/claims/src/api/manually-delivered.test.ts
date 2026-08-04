import { test } from "node:test";
import assert from "node:assert/strict";
import { isManuallyDelivered, MANUALLY_DELIVERED } from "./manually-delivered.js";

test("isManuallyDelivered — the swap ANT is de-listed", () => {
  assert.equal(isManuallyDelivered("E4J7qeMYFac3YCMsH3KEkemxcQhMFfAzrpMNiba7hDNN"), true);
});

test("isManuallyDelivered — unrelated assets are NOT de-listed", () => {
  assert.equal(isManuallyDelivered("SomeOtherAssetKey1111111111111111111111111"), false);
  assert.equal(isManuallyDelivered(""), false);
  // guard against prototype-key false positives
  assert.equal(isManuallyDelivered("hasOwnProperty"), false);
  assert.equal(isManuallyDelivered("toString"), false);
});

test("every de-list entry documents delivery (recipient + date + note)", () => {
  for (const [key, rec] of Object.entries(MANUALLY_DELIVERED)) {
    assert.ok(key.length > 0, "asset_key present");
    assert.ok(rec.deliveredTo.length > 0, `${key} has deliveredTo`);
    assert.match(rec.deliveredAt, /^\d{4}-\d{2}-\d{2}$/, `${key} has ISO date`);
    assert.ok(rec.note.length > 0, `${key} has a note`);
  }
});
