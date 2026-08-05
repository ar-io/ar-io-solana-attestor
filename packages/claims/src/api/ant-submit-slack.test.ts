import { test } from "node:test";
import assert from "node:assert/strict";
import { composeAntSubmitSlackMessage } from "./routes.js";

const results = [{ claimId: "c1", outcome: "confirmed", signature: "SIG111", assetKey: "5xSF" }] as any;
const status = {
  batchId: "43c97166", status: "submitted", submittedAt: null, claimCount: 1,
  claims: [{ claimId: "c1", status: "confirmed", dispatchSignature: null, reservedTxid: null,
             antMint: "5xSFSvqf1eEV", antName: "sacred-archives-chris-comish", claimant: "4Jp8" }],
} as any;

test("ANT submit: mainnet shows <name>.ar.io link + tx", () => {
  const t = composeAntSubmitSlackMessage("43c97166", results, status, "solana-mainnet").text;
  assert.match(t, /1\/1 confirmed/);
  assert.match(t, /https:\/\/sacred-archives-chris-comish\.ar\.io/);
  assert.match(t, /explorer\.solana\.com\/tx\/SIG111/);
});
test("ANT submit: devnet falls back to plain name (no .ar.io)", () => {
  const t = composeAntSubmitSlackMessage("43c97166", results, status, "solana-devnet").text;
  assert.doesNotMatch(t, /\.ar\.io/);
  assert.match(t, /sacred-archives-chris-comish/);
  assert.match(t, /cluster=devnet/);
});
test("ANT submit: no name → falls back to mint label, no .ar.io", () => {
  const s2 = { ...status, claims: [{ ...status.claims[0], antName: null }] } as any;
  const t = composeAntSubmitSlackMessage("43c97166", results, s2, "solana-mainnet").text;
  assert.doesNotMatch(t, /\.ar\.io/);
});
