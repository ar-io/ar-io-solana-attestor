//! Unit tests for the ACL heal sweep orchestration (fake pool, injected heal).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "@solana/kit";
import { AntAclHealer, type HealOneResult, type HealAlert } from "./ant-acl-healer.js";
import { ARIO_ANT_PROGRAM_MAINNET } from "./ant-acl-instructions.js";

const A = (s: string) => s as Address;
const oldOwner = A("45ZuEb1Jk7pbjshD1BVasBekAXhimdWuJjyswQzMyTB1");
const treasury = A("H9QfodffCVtQiov99rwcxaqegLbrorbjNoDqk3ZFbEwt");

interface Row { claim_id: string; claimant: string; ant_mint: string; ant_name: string | null; attempts: number }
function fakePool(pending: Row[]) {
  const updates: Array<{ sql: string; params: unknown[] }> = [];
  return {
    updates,
    query: async (sql: string, params: unknown[] = []) => {
      if (/ant_acl_healed_at IS NULL/.test(sql) && /SELECT/i.test(sql)) return { rows: pending };
      if (/UPDATE claims SET/.test(sql)) updates.push({ sql, params });
      return { rows: [] };
    },
  } as unknown as import("pg").Pool & { updates: Array<{ sql: string; params: unknown[] }> };
}

function healer(pending: Row[], outcomes: Record<string, HealOneResult | (() => Promise<HealOneResult>)>, maxAttempts = 5) {
  const pool = fakePool(pending);
  const alerts: HealAlert[] = [];
  const h = new AntAclHealer({
    pool,
    antProgram: ARIO_ANT_PROGRAM_MAINNET,
    oldOwner,
    treasuryAddress: treasury,
    maxAttempts,
    healOne: async (p) => {
      const o = outcomes[p.mint as string];
      if (typeof o === "function") return o();
      if (!o) throw new Error("boom");
      return o;
    },
    alert: (a) => alerts.push(a),
  });
  return { h, pool, alerts };
}
// Valid base58 mints (the sweep runs address() over them before healOne).
const MINT = {
  healed: "So11111111111111111111111111111111111111112",
  already: "CXG2t4bvC2SMeiuh3eSk7DLzac7rMp56BqDVFPTUe7G",
  aborted: "DcNnMuFxwhgV4WY1HVSaSEgr92bv2b1vUvEKiNxWqHdF",
  fail: "2MWexMHfMhGJwMHv9Qm9YAVCqjUFUJwDJAysW4oCUGk5",
  dead: "45ZuEb1Jk7pbjshD1BVasBekAXhimdWuJjyswQzMyTB1",
  thrown: "H9QfodffCVtQiov99rwcxaqegLbrorbjNoDqk3ZFbEwt",
} as const;
const row = (mint: string, attempts = 0): Row => ({ claim_id: `claim-${mint}`, claimant: "GuGsC1UK8TfRwYfENT5mTErAtD1cytAJDs3B6VLRZXxS", ant_mint: mint, ant_name: mint, attempts });
const didMarkDone = (u: { sql: string; params: unknown[] }[], claimId: string) =>
  u.some((x) => /ant_acl_healed_at = now\(\)/.test(x.sql) && x.params[0] === claimId);

test("healed / already / aborted all mark the claim done (healed_at set)", async () => {
  const { h, pool } = healer(
    [row(MINT.healed), row(MINT.already), row(MINT.aborted)],
    {
      [MINT.healed]: { outcome: "healed", signature: "sig1" },
      [MINT.already]: { outcome: "already" },
      [MINT.aborted]: { outcome: "aborted", note: "owner moved on" },
    },
  );
  const s = await h.sweepOnce(10);
  assert.deepEqual({ healed: s.healed, already: s.already, aborted: s.aborted, failed: s.failed }, { healed: 1, already: 1, aborted: 1, failed: 0 });
  for (const c of [MINT.healed, MINT.already, MINT.aborted]) assert.ok(didMarkDone(pool.updates, `claim-${c}`), `${c} marked done`);
});

test("transient failure under maxAttempts: NOT marked done, attempts incremented, no alert", async () => {
  const { h, pool, alerts } = healer([row(MINT.fail, 1)], { [MINT.fail]: { outcome: "failed", note: "rpc blip" } }, 5);
  const s = await h.sweepOnce();
  assert.equal(s.failed, 1);
  assert.ok(!didMarkDone(pool.updates, `claim-${MINT.fail}`), "not parked yet");
  assert.equal(pool.updates[0].params[1], 2, "attempts incremented to 2");
  assert.equal(alerts.length, 0);
});

test("failure reaching maxAttempts: parked (healed_at set) + alert fired", async () => {
  const { h, pool, alerts } = healer([row(MINT.dead, 4)], { [MINT.dead]: { outcome: "failed", note: "still bad" } }, 5);
  await h.sweepOnce();
  assert.ok(didMarkDone(pool.updates, `claim-${MINT.dead}`), "parked");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].name, "ant-acl-heal-failed");
});

test("thrown error is caught and recorded as a failure", async () => {
  const { h, alerts } = healer([row(MINT.thrown)], {}); // no outcome → healOne throws
  const s = await h.sweepOnce();
  assert.equal(s.failed, 1);
  assert.equal(alerts.length, 0); // attempts 0→1, below max
});
