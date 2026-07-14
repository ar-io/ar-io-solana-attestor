//! Unit tests for anchor memo payloads + instruction bytes (M6). No chain.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { AccountRole, type Address } from "@solana/kit";

import {
  LIVE_MEMO_PROGRAM,
  anchorSignedBy,
  auditHeadMemo,
  ledgerRootMemo,
  memoIx,
  parseAnchorMemo,
} from "./anchor.js";

describe("anchor: memo payloads", () => {
  it("audit-head memo round-trips through parse", () => {
    const hash = "ab".repeat(32);
    const memo = auditHeadMemo("454", hash, "solana-devnet");
    assert.equal(memo, `ar.io-audit-anchor:v1:solana-devnet:454:${hash}`);
    const p = parseAnchorMemo(memo);
    assert.deepEqual(p, { kind: "audit-head", network: "solana-devnet", ref: "454", hashHex: hash });
  });

  it("ledger-root memo round-trips through parse", () => {
    const root = "cd".repeat(32);
    const memo = ledgerRootMemo("2026-07-10", root, "solana-mainnet");
    const p = parseAnchorMemo(memo);
    assert.deepEqual(p, { kind: "ledger-root", network: "solana-mainnet", ref: "2026-07-10", hashHex: root });
  });

  it("rejects non-anchor memos", () => {
    assert.equal(parseAnchorMemo("hello world"), null);
    assert.equal(parseAnchorMemo("ar.io-audit-anchor:v2:x:1:ff"), null);
    assert.equal(parseAnchorMemo("ar.io-other:v1:net:1:ff"), null);
  });
});

describe("anchor: memo instruction", () => {
  it("uses the live memo program and carries the memo bytes, signer-attributed", () => {
    const signer = "Hk6RfBp4FpvF2hYBmJ9kqyL5dE3xR8wPzN7sV6cTqL2A" as Address;
    const memo = auditHeadMemo("1", "00".repeat(32), "localnet");
    const ix = memoIx(memo, signer);
    assert.equal(ix.programAddress, LIVE_MEMO_PROGRAM);
    assert.equal(ix.accounts?.length, 1);
    assert.equal(ix.accounts?.[0].address, signer);
    assert.equal(ix.accounts?.[0].role, AccountRole.READONLY_SIGNER);
    assert.deepEqual([...(ix.data ?? [])], [...new TextEncoder().encode(memo)]);
  });

  it("anchor + dispatch share ONE live memo program (the v2 id was dead on both clusters)", async () => {
    const { MEMO_PROGRAM } = await import("../dispatch/instructions.js");
    // Single source of truth — they must AGREE, and it must be the live program
    // (`Memo1Uhk…`), NOT the dead `MemoSq4g…` v2 id.
    assert.equal(LIVE_MEMO_PROGRAM as string, MEMO_PROGRAM as string);
    assert.equal(LIVE_MEMO_PROGRAM as string, "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo");
  });
});

describe("anchor: signer verification (MEDIUM #2 — memo body is forgeable)", () => {
  it("anchorSignedBy accepts the pinned signer and rejects an attacker's key", () => {
    const operator = "Hk6RfBp4FpvF2hYBmJ9kqyL5dE3xR8wPzN7sV6cTqL2A";
    const attacker = "4Yk9HoDSfJv9QcmJbLcXdWVgS7nfvdUqiVcvbSu8VBru";
    const asOperator = { memo: "x", slot: 1n, err: null, feePayer: operator, signers: [operator] };
    const asAttacker = { memo: "x", slot: 1n, err: null, feePayer: attacker, signers: [attacker] };
    assert.equal(anchorSignedBy(asOperator, operator), true);
    // A rewritten-history memo posted by ANY funded key does NOT satisfy the
    // signer pin -> the forged anchor is rejected.
    assert.equal(anchorSignedBy(asAttacker, operator), false);
  });
});
