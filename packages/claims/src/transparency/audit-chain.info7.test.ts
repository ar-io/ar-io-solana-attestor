//! INFO-7: the audit chain hashes the EXACT canonical-JSON bytes stored in
//! `entry_canonical`, not a re-serialization of the `entry` jsonb (which a
//! future float/bignum/dup-key entry could make diverge). DB-free.

import { strict as assert } from "node:assert";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";

import { hashCanonical, _canonicalJsonForTest as canonicalJson } from "../api/audit.js";
import { verifyAuditChain, type AuditRow } from "./audit-chain.js";

const ZERO32 = Buffer.alloc(32);
const UNSIGNED = Buffer.alloc(64);

describe("INFO-7 audit-chain canonical-bytes hashing", () => {
  it("verifies against entry_canonical even when the entry jsonb reserializes differently", () => {
    // Signed bytes carried a STRING amount; imagine the jsonb round-trip rehydrated
    // it as a number — the exact fragility INFO-7 removes.
    const canonical = '{"amount":"1.0","event":"claim.verified"}';
    const entryHash = hashCanonical(ZERO32, canonical);
    const divergentEntry = { amount: 1, event: "claim.verified" };
    // The legacy reserialize path would NOT reproduce the signed bytes.
    assert.notEqual(canonicalJson(divergentEntry), canonical);

    const row: AuditRow = {
      seq: "1", prevHash: ZERO32, entry: divergentEntry,
      entryCanonical: canonical, entryHash, signature: UNSIGNED,
    };
    assert.equal(verifyAuditChain([row]).ok, true, "must verify using the exact canonical bytes");
  });

  it("legacy rows (no entry_canonical) still verify via the jsonb fallback", () => {
    const entry = { amount: "5", event: "claim.rejected" };
    const entryHash = hashCanonical(ZERO32, canonicalJson(entry));
    const row: AuditRow = { seq: "1", prevHash: ZERO32, entry, entryHash, signature: UNSIGNED };
    assert.equal(verifyAuditChain([row]).ok, true);
  });

  it("a tampered entry_canonical breaks the chain", () => {
    const entryHash = hashCanonical(ZERO32, '{"event":"x"}');
    const row: AuditRow = {
      seq: "1", prevHash: ZERO32, entry: {},
      entryCanonical: '{"event":"y"}', entryHash, signature: UNSIGNED,
    };
    assert.equal(verifyAuditChain([row]).ok, false);
  });
});
