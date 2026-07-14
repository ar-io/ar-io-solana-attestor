//! assertSourceGuards must be APPEND-PROOF — the exact failure the tester found
//! (a bare-substring guard passing on a `+ ':v2'` superset). These tests use a
//! synthetic batch-escrow.ts (no solana-ar-io needed) containing the pinned
//! snippets, and prove a superset append FAILS the guard.

import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { assertSourceGuards } from "./authoritative.js";

// A minimal source that contains every byte-exact snippet the guard pins.
const VALID = [
  "const isExpired = vault.endTimestamp <= nowMs;",
  "        BigInt(",
  "          Math.ceil((vault.endTimestamp - nowMs) / 1000),",
  "        );",
  "    const assetId = createHash('sha256').update(v.assetIdSeed).digest();",
  "    const assetId = createHash('sha256').update(l.assetIdSeed).digest();",
  "      let lockDuration = BigInt(v.unlockTs - sendTs);",
  "      const isLockedOperatorExit =",
  "        v.kind.startsWith('withdrawal:operator-exit:') &&",
  "        v.amountMario >= MIN_VAULT_SIZE_MARIO &&",
  "        lockDuration > 0n;",
  "      if (isLockedOperatorExit && lockDuration < BigInt(MIN_VAULT_LOCK_SECONDS)) {",
  "        lockDuration = BigInt(MIN_VAULT_LOCK_SECONDS);",
  "const AO_PROCESS_ID =",
  "  process.env.AO_PROCESS_ID || 'qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE';",
].join("\n");

const dirs: string[] = [];
function writeSrc(text: string): string {
  const d = mkdtempSync(join(tmpdir(), "m1-guard-"));
  dirs.push(d);
  writeFileSync(join(d, "batch-escrow.ts"), text);
  return d;
}

describe("assertSourceGuards (append-proof byte pins)", () => {
  after(() => {
    // temp dirs are small; leave to OS cleanup if unlink races.
  });

  it("passes on the valid pinned source and extracts the AO id", () => {
    const { aoProcessId } = assertSourceGuards(writeSrc(VALID));
    assert.equal(aoProcessId, "qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE");
  });

  it("FAILS on a superset APPEND to the lock formula (the :v2-class attack)", () => {
    // Change `/ 1000),` -> `/ 1000) + 1,` — a real behavior change that a bare
    // substring of the old text would have missed. The delimiter (`,`) moves.
    const tampered = VALID.replace(
      "Math.ceil((vault.endTimestamp - nowMs) / 1000),",
      "Math.ceil((vault.endTimestamp - nowMs) / 1000) + 1,",
    );
    assert.throws(() => assertSourceGuards(writeSrc(tampered)), /source-guard FAILED/);
  });

  it("FAILS on a superset APPEND to the stake sha256 seed", () => {
    const tampered = VALID.replace(
      "createHash('sha256').update(v.assetIdSeed).digest();",
      "createHash('sha256').update(v.assetIdSeed + ':v2').digest();",
    );
    assert.throws(() => assertSourceGuards(writeSrc(tampered)), /source-guard FAILED/);
  });

  it("FAILS when the operator-exit condition changes", () => {
    const tampered = VALID.replace(
      "v.kind.startsWith('withdrawal:operator-exit:') &&",
      "v.kind.startsWith('withdrawal:operator-exit:v2') &&",
    );
    assert.throws(() => assertSourceGuards(writeSrc(tampered)), /source-guard FAILED/);
  });

  it("FAILS when batch-escrow.ts is missing", () => {
    assert.throws(() => assertSourceGuards(join(tmpdir(), "does-not-exist-m1")), /not found/);
  });
});
