//! Unit tests for audit-chain verification + anchor-extension (M6). No DB.

import { strict as assert } from "node:assert";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";

import { computeEntryHash, UNSIGNED_PLACEHOLDER } from "../api/audit.js";
import { keypairFromSeed } from "./keys.js";
import { checkExtendsAnchor, verifyAuditChain, type AuditRow } from "./audit-chain.js";

const AUDIT = keypairFromSeed("audit", new Uint8Array(32).fill(3));
const ZERO32 = Buffer.alloc(32);

/** Build a valid, optionally-signed chain of `n` rows. */
function buildChain(n: number, sign = true): AuditRow[] {
  const rows: AuditRow[] = [];
  let prev: Buffer = ZERO32;
  for (let i = 1; i <= n; i++) {
    const entry = { ts: `2026-07-10T00:00:0${i % 10}.000Z`, event: "claim.test", claimId: `c${i}`, seq: i };
    const entryHash = computeEntryHash(prev, entry);
    const signature = sign ? Buffer.from(AUDIT.sign(entryHash)) : UNSIGNED_PLACEHOLDER;
    rows.push({ seq: String(i), prevHash: prev, entry, entryHash, signature });
    prev = entryHash;
  }
  return rows;
}

describe("audit chain: verification", () => {
  it("a well-formed signed chain verifies", () => {
    const rows = buildChain(5);
    const v = verifyAuditChain(rows, AUDIT.publicKey);
    assert.ok(v.ok, v.issues.join("; "));
    assert.equal(v.count, 5);
    assert.equal(v.signedCount, 5);
    assert.equal(v.signatureValidCount, 5);
    assert.equal(v.head?.seq, "5");
  });

  it("placeholder rows verify structurally but count as unsigned", () => {
    const rows = buildChain(3, false);
    const v = verifyAuditChain(rows, AUDIT.publicKey);
    assert.ok(v.ok);
    assert.equal(v.signedCount, 0);
    assert.equal(v.signatureValidCount, 0);
  });

  it("altered entry content breaks the entry_hash", () => {
    const rows = buildChain(4);
    // Tamper the content of row 2 WITHOUT recomputing its hash.
    (rows[1].entry as { event: string }).event = "claim.EVIL";
    const v = verifyAuditChain(rows, AUDIT.publicKey);
    assert.equal(v.ok, false);
    assert.equal(v.firstBadSeq, "2");
    assert.ok(v.issues.some((i) => i.includes("entry_hash mismatch")));
  });

  it("a broken prev_hash link is detected", () => {
    const rows = buildChain(4);
    rows[2].prevHash = Buffer.alloc(32, 0xab); // wrong link
    // recompute this row's own hash so only the LINK is broken
    rows[2].entryHash = computeEntryHash(rows[2].prevHash, rows[2].entry);
    rows[2].signature = Buffer.from(AUDIT.sign(rows[2].entryHash));
    const v = verifyAuditChain(rows, AUDIT.publicKey);
    assert.equal(v.ok, false);
    assert.equal(v.firstBadSeq, "3");
  });

  it("a forged signature (wrong key) is rejected", () => {
    const rows = buildChain(3);
    const evil = keypairFromSeed("audit", new Uint8Array(32).fill(9));
    rows[1].signature = Buffer.from(evil.sign(rows[1].entryHash));
    const v = verifyAuditChain(rows, AUDIT.publicKey);
    assert.equal(v.ok, false);
    assert.ok(v.issues.some((i) => i.includes("signature invalid")));
  });
});

describe("audit chain: extends-anchor", () => {
  it("a log that appended rows still extends an earlier anchored head", () => {
    const rows = buildChain(8);
    const anchoredSeq = "5";
    const anchoredHash = rows[4].entryHash.toString("hex");
    const ext = checkExtendsAnchor(rows, anchoredSeq, anchoredHash, AUDIT.publicKey);
    assert.ok(ext.ok, ext.issues.join("; "));
    assert.ok(ext.chainOk && ext.anchoredSeqFound && ext.hashMatches);
  });

  it("rewriting history at/before the anchor is detected", () => {
    const rows = buildChain(8);
    const anchoredSeq = "5";
    const anchoredHash = rows[4].entryHash.toString("hex"); // the ORIGINAL head hash

    // Operator rewrites row 3's content and re-chains rows 3..8 so the local
    // chain still looks internally consistent — but the head at seq 5 changed.
    let prev = rows[1].entryHash;
    for (let i = 2; i < rows.length; i++) {
      if (i === 2) (rows[i].entry as { event: string }).event = "claim.REWRITTEN";
      rows[i].prevHash = prev;
      rows[i].entryHash = computeEntryHash(prev, rows[i].entry);
      rows[i].signature = Buffer.from(AUDIT.sign(rows[i].entryHash));
      prev = rows[i].entryHash;
    }
    const rechained = verifyAuditChain(rows, AUDIT.publicKey);
    assert.ok(rechained.ok, "internally the rewritten chain re-links");

    // But it no longer extends the on-chain anchored head.
    const ext = checkExtendsAnchor(rows, anchoredSeq, anchoredHash, AUDIT.publicKey);
    assert.equal(ext.ok, false);
    assert.equal(ext.hashMatches, false);
    assert.ok(ext.issues.some((i) => i.includes("history was rewritten")));
  });

  it("an anchor for an unknown seq is flagged", () => {
    const rows = buildChain(3);
    const ext = checkExtendsAnchor(rows, "99", "ab".repeat(32), AUDIT.publicKey);
    assert.equal(ext.ok, false);
    assert.equal(ext.anchoredSeqFound, false);
  });
});
