import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composePendingReviewSlackMessage,
  composeApprovalSlackMessage,
  composeDispensedSlackMessage,
} from "./claim-format.js";

const TOKEN = {
  assetType: "token", amountMario: "5000000", antName: null, antMint: null,
  claimant: "4Jp8zuRj8RdCHLMU6DzdLrMh5fLegFbcLC7hsEX6aF1g", protocol: 0,
  sourceAddress: "iLbxuKikVoM2-NZatTbVKIUg50rsbnJ07SsIUAWvIJg",
} as const;
const ANT = {
  assetType: "ant", amountMario: null, antName: "sacred-archives-chris-comish",
  antMint: "5xSFSvqf1eEV", claimant: "4Jp8zuRj8RdCHLMU6DzdLrMh5fLegFbcLC7hsEX6aF1g",
  protocol: 0, sourceAddress: "iLbxuKikVoM2-NZatTbVKIUg50rsbnJ07SsIUAWvIJg",
} as const;

test("pending-review: token shows amount, FULL dest, source+protocol", () => {
  const t = composePendingReviewSlackMessage({ ...TOKEN, claimId: "8274576c-x" }).text;
  assert.match(t, /New claim awaiting approval/);
  assert.match(t, /Token — 5 ARIO/);
  assert.match(t, /To: 4Jp8zuRj8RdCHLMU6DzdLrMh5fLegFbcLC7hsEX6aF1g/);
  assert.match(t, /From: iLbxuKik…AWvIJg \(Arweave\)/);
  assert.match(t, /dispatch:approve 8274576c-x/);
});
test("approval: shows approver, type/amount, full dest — NOT the source as '→'", () => {
  const t = composeApprovalSlackMessage("8274576c-78b1", "philip", TOKEN).text;
  assert.match(t, /approved by philip/);
  assert.match(t, /Token — 5 ARIO/);
  assert.match(t, /To: 4Jp8zuRj8RdCHLMU6DzdLrMh5fLegFbcLC7hsEX6aF1g/); // dest, not recipient_id
  assert.match(t, /Dispensing now/);
});
test("approval: ANT shows backfilled ArNS name + /admin next step", () => {
  const t = composeApprovalSlackMessage("45086345", "philip", ANT).text;
  assert.match(t, /ANT — ArNS “sacred-archives-chris-comish”/);
  assert.match(t, /\/admin/);
});
test("dispensed: shows tx explorer link (mainnet no cluster suffix)", () => {
  const t = composeDispensedSlackMessage("8274576c", TOKEN, "4tCyYu9xSIG", "solana-mainnet").text;
  assert.match(t, /Dispensed/);
  assert.match(t, /explorer\.solana\.com\/tx\/4tCyYu9xSIG$/m);
  assert.doesNotMatch(t, /cluster=devnet/);
});
