//! Unit tests for anchor memo payloads + instruction bytes (M6). No chain.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { AccountRole, type Address } from "@solana/kit";

import {
  LIVE_MEMO_PROGRAM,
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

  it("the live memo program differs from the (non-existent) v2 id in instructions.ts", async () => {
    const { MEMO_PROGRAM } = await import("../dispatch/instructions.js");
    assert.notEqual(LIVE_MEMO_PROGRAM as string, MEMO_PROGRAM as string);
  });
});
