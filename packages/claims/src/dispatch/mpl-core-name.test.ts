//! Unit tests for the MPL Core AssetV1 `name` decoder (display-only ANT name).
//! The primary fixture is REAL account data fetched once from the devnet staging
//! test ANT `6sAUvkhqkq2AC9BNd3QTFG47DGHNAdp1DLzcD7UrEsY1` (name `stg-user-ant`,
//! update_authority = Address). The synthetic fixtures cover the None and
//! Collection update-authority variants + malformed inputs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import { decodeMplCoreName, decodeMplCoreNameFromBase64, MplCoreNameError } from "./mpl-core-name.js";

// Real devnet account data for 6sAUvkhqkq2AC9BNd3QTFG47DGHNAdp1DLzcD7UrEsY1.
// key=1, owner(32), ua tag=1 Address(32), name="stg-user-ant", uri="https://ar.io/ant.json".
const STG_USER_ANT_B64 =
  "AUmU+Vsl+XHqQwSr84APUc92o60u/PsMRNLJsGFEcfZwAUmU+Vsl+XHqQwSr84APUc92o60u/PsMRNLJsGFEcfZwDAAAAHN0Zy11c2VyLWFudBYAAABodHRwczovL2FyLmlvL2FudC5qc29uAA==";

/** Build a synthetic AssetV1 header for the given update-authority tag + name. */
function makeAssetV1(uaTag: 0 | 1 | 2, name: string, uri = "https://ar.io/ant.json"): Uint8Array {
  const parts: number[] = [];
  parts.push(1); // key = AssetV1
  for (let i = 0; i < 32; i++) parts.push(7); // owner
  parts.push(uaTag);
  if (uaTag === 1 || uaTag === 2) for (let i = 0; i < 32; i++) parts.push(9); // ua pubkey
  const nameBytes = Buffer.from(name, "utf8");
  const nameLen = Buffer.alloc(4);
  nameLen.writeUInt32LE(nameBytes.length, 0);
  parts.push(...nameLen, ...nameBytes);
  const uriBytes = Buffer.from(uri, "utf8");
  const uriLen = Buffer.alloc(4);
  uriLen.writeUInt32LE(uriBytes.length, 0);
  parts.push(...uriLen, ...uriBytes);
  parts.push(0); // trailing option/seq (ignored)
  return new Uint8Array(parts);
}

test("decodes the real staging ANT name (update_authority = Address)", () => {
  assert.equal(decodeMplCoreNameFromBase64(STG_USER_ANT_B64), "stg-user-ant");
});

test("decodes update_authority = None", () => {
  assert.equal(decodeMplCoreName(makeAssetV1(0, "permaweb")), "permaweb");
});

test("decodes update_authority = Address", () => {
  assert.equal(decodeMplCoreName(makeAssetV1(1, "wolfethyst")), "wolfethyst");
});

test("decodes update_authority = Collection", () => {
  assert.equal(decodeMplCoreName(makeAssetV1(2, "ardrive")), "ardrive");
});

test("decodes an empty name", () => {
  assert.equal(decodeMplCoreName(makeAssetV1(1, "")), "");
});

test("decodes multi-byte UTF-8 names", () => {
  assert.equal(decodeMplCoreName(makeAssetV1(0, "café-ω")), "café-ω");
});

test("rejects a non-AssetV1 key", () => {
  const bytes = makeAssetV1(1, "x");
  bytes[0] = 0; // Uninitialized
  assert.throws(() => decodeMplCoreName(bytes), MplCoreNameError);
});

test("rejects an unknown update_authority variant", () => {
  const bytes = makeAssetV1(1, "x");
  bytes[33] = 9; // ua tag position (1 + 32)
  assert.throws(() => decodeMplCoreName(bytes), MplCoreNameError);
});

test("rejects truncated data before the name length", () => {
  assert.throws(() => decodeMplCoreName(makeAssetV1(1, "x").subarray(0, 35)), MplCoreNameError);
});

test("rejects a name length that overruns the buffer", () => {
  const bytes = makeAssetV1(0, "hello");
  // name length is at offset 1 + 32 + 1 = 34 for the None variant.
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).writeUInt32LE(9999, 34);
  assert.throws(() => decodeMplCoreName(bytes), MplCoreNameError);
});

test("rejects empty data", () => {
  assert.throws(() => decodeMplCoreName(new Uint8Array()), MplCoreNameError);
});
