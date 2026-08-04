import { test } from "node:test";
import assert from "node:assert/strict";
import { composePendingReviewSlackMessage } from "./routes.js";

test("composePendingReviewSlackMessage — token claim with amount", () => {
  const m = composePendingReviewSlackMessage({
    claimId: "abcdef12-3456-7890-abcd-ef1234567890",
    assetKey: "00031f90ac0576dcafa06f529aa613fb355d5c4cff863fe5659f96b491401167",
    claimant: "l2tiFfrcrpurxthYU8us_SC0lKhLox1rQeKh-m2r3Bc",
    settlement: "93416701",
  });
  assert.match(m.text, /New claim awaiting approval/);
  assert.match(m.text, /93\.416701 ARIO/);
  assert.match(m.text, /dispatch:approve abcdef12-3456-7890-abcd-ef1234567890/);
});

test("composePendingReviewSlackMessage — ANT (null settlement, no amount)", () => {
  const m = composePendingReviewSlackMessage({
    claimId: "11112222-3333-4444-5555-666677778888",
    assetKey: "E4J7qeMYFac3YCMsH3KEkemxcQhMFfAzrpMNiba7hDNN",
    claimant: "2DXykUor86ZNK2Wfy9VVWFmQdvwRx8eteu1jJFPDrqeV",
    settlement: null,
  });
  assert.doesNotMatch(m.text, /ARIO/);
  assert.match(m.text, /🟡/);
});
