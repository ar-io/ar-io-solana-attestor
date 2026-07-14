//! Audit canonical-JSON determinism (the hash-chain input must be stable).

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { _canonicalJsonForTest as canonicalJson } from "./audit.js";

describe("audit canonicalJson", () => {
  it("sorts object keys recursively (order-independent)", () => {
    const a = canonicalJson({ b: 1, a: { d: 4, c: 3 } });
    const b = canonicalJson({ a: { c: 3, d: 4 }, b: 1 });
    assert.equal(a, b);
    assert.equal(a, '{"a":{"c":3,"d":4},"b":1}');
  });

  it("drops undefined but keeps null; preserves arrays in order", () => {
    assert.equal(canonicalJson({ x: undefined, y: null, z: [3, 1, 2] }), '{"y":null,"z":[3,1,2]}');
  });

  it("emits money-as-string verbatim (never coerces)", () => {
    assert.equal(canonicalJson({ amount: "18446744073709551615" }), '{"amount":"18446744073709551615"}');
  });
});
