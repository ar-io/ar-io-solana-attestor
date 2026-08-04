import { test } from "node:test";
import assert from "node:assert/strict";
import { composePendingReviewSlackMessage } from "./routes.js";

test("pending-review msg — token shows ARIO amount, full dest, source+protocol", () => {
  const m = composePendingReviewSlackMessage({
    claimId: "8274576c-78b1-4baa-b989-9427648a896f",
    assetType: "token",
    amountMario: "5000000",
    antName: null,
    antMint: null,
    claimant: "4Jp8zuRj8RdCHLMU6DzdLrMh5fLegFbcLC7hsEX6aF1g",
    protocol: 0,
    sourceAddress: "iLbxuKikVoM2-NZatTbVKIUg50rsbnJ07SsIUAWvIJg",
  });
  assert.match(m.text, /Token — 5 ARIO/);
  assert.match(m.text, /To: 4Jp8zuRj8RdCHLMU6DzdLrMh5fLegFbcLC7hsEX6aF1g/); // FULL dest
  assert.match(m.text, /\(Arweave\)/);
  assert.match(m.text, /dispatch:approve 8274576c-78b1-4baa-b989-9427648a896f/);
});

test("pending-review msg — ANT with ArNS name + /admin hint", () => {
  const m = composePendingReviewSlackMessage({
    claimId: "45086345-6d76-4766-b636-1c388ba17f25",
    assetType: "ant", amountMario: null, antName: "coolname",
    antMint: "5xSFSvh1EEV1111111111111111111111111111111eEV",
    claimant: "4Jp8zuRj8RdCHLMU6DzdLrMh5fLegFbcLC7hsEX6aF1g",
    protocol: 0, sourceAddress: "iLbxuKikVoM2-NZatTbVKIUg50rsbnJ07SsIUAWvIJg",
  });
  assert.match(m.text, /ANT — ArNS “coolname”/);
  assert.match(m.text, /\/admin/);
  assert.doesNotMatch(m.text, /ARIO/);
});

test("pending-review msg — ANT without name falls back to mint; ethereum protocol", () => {
  const m = composePendingReviewSlackMessage({
    claimId: "x", assetType: "ant", amountMario: null, antName: null,
    antMint: "5xSFSvAbCdEfGh1111111111111111111111111111eEV",
    claimant: "dest", protocol: 1, sourceAddress: "0xabcdef0123456789",
  });
  assert.match(m.text, /mint 5xSFSv…/);
  assert.match(m.text, /\(Ethereum\)/);
});
