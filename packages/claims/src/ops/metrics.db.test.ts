//! Ops metrics collector — DB-backed shape + robust presence, plus pure rendering.
//!
//! Shares one Postgres with the other suites, so aggregate assertions are LOWER
//! bounds keyed to this test's own unique rows (which only ADD to the global
//! counts) — never exact-equality against the whole shared table.

import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { after, before, describe, it } from "node:test";

import { createDb, type Db } from "../db.js";
import { cleanup, insertAsset, insertRecipient, randomClaimant } from "../api/proof-testkit.js";
import { collectDbMetrics, collectMetrics, renderPrometheus, type MetricsSnapshot } from "./metrics.js";

const HAS_DB = !!process.env.DATABASE_URL;
const ONE_TOKEN = 1_000_000n;

let db: Db;
const seededAssets: string[] = [];
const seededRecipients: string[] = [];

async function seedTokenClaim(status: string, amount: bigint, opts: { assetStatus?: string; settlement?: bigint } = {}): Promise<void> {
  const recipientId = `mx_${randomBytes(8).toString("hex")}`;
  await insertRecipient(db.pool, { recipientId, protocol: 1, sourceAddress: recipientId, recipientPubkey: new Uint8Array(randomBytes(20)) });
  const assetKey = randomBytes(32).toString("hex");
  await insertAsset(db.pool, recipientId, { assetKey, assetType: "token", amount, status: opts.assetStatus ?? "available" });
  const settlement = opts.settlement ?? amount;
  await db.pool.query(
    `INSERT INTO claims (asset_key, claimant, canonical_message, recipient_id, protocol, status, verified_at, confirmed_at, dispatch_signature, settlement_amount, dispatch_started_at)
     VALUES ($1,$2,$3,$4,1,$5, now(), CASE WHEN $5='confirmed' THEN now() ELSE NULL END,
             CASE WHEN $5 IN ('confirmed','dispatching') THEN 'SIG_'||$1 ELSE NULL END,
             CASE WHEN $5 IN ('confirmed','dispatching') THEN $6::numeric ELSE NULL END,
             CASE WHEN $5='dispatching' THEN now() - interval '1 hour' ELSE NULL END)`,
    [assetKey, randomClaimant(), Buffer.from("mx"), recipientId, status, settlement.toString()],
  );
  seededAssets.push(assetKey);
  seededRecipients.push(recipientId);
}

describe("ops metrics collector (DB)", { skip: !HAS_DB }, () => {
  before(async () => {
    db = createDb(process.env.DATABASE_URL as string);
    // A self-contained fixture: 2 confirmed (claimed) token dispenses, 1 failed,
    // 1 unapproved pending_review, 1 dispatching (stalled 1h).
    await seedTokenClaim("confirmed", 1000n * ONE_TOKEN, { assetStatus: "claimed" });
    await seedTokenClaim("confirmed", 2000n * ONE_TOKEN, { assetStatus: "claimed" });
    await seedTokenClaim("failed", 500n * ONE_TOKEN, { assetStatus: "available" });
    await seedTokenClaim("pending_review", 750n * ONE_TOKEN, { assetStatus: "available" });
    await seedTokenClaim("dispatching", 300n * ONE_TOKEN, { assetStatus: "claiming" });
  });
  after(async () => {
    if (seededAssets.length) await cleanup(db.pool, seededAssets, seededRecipients);
    await db.close();
  });

  it("returns a complete, well-typed snapshot with all claim statuses present", async () => {
    const m = await collectDbMetrics(db.pool);
    for (const s of ["received", "verified", "pending_review", "dispatching", "confirmed", "rejected", "failed"]) {
      assert.equal(typeof m.claims.byStatus[s], "number", `status ${s} present`);
    }
    // Money fields are decimal strings (never JS numbers).
    assert.match(m.dispatch.dispatchedTotalMario, /^-?\d+$/);
    assert.match(m.liabilities.outstandingMario, /^\d+$/);
    // driftMario parses as a bigint.
    assert.doesNotThrow(() => BigInt(m.dispatch.driftMario));
  });

  it("reflects this fixture's rows in the aggregates (lower bounds)", async () => {
    const m = await collectDbMetrics(db.pool);
    assert.ok(m.claims.confirmed >= 2, `confirmed >= 2, got ${m.claims.confirmed}`);
    assert.ok(m.dispatch.failed >= 1, "failed >= 1");
    assert.ok(m.claims.reviewQueueDepth >= 1, "review queue >= 1");
    assert.ok(m.claims.oldestReviewAgeSec !== null, "oldest review age set");
    assert.ok(m.claims.dispatchingCount >= 1, "dispatching >= 1");
    assert.ok((m.claims.oldestDispatchingAgeSec ?? 0) >= 3000, "dispatching age ~1h");
    // Two claimed token assets worth 3000 ARIO -> claimed liability includes them.
    assert.ok(BigInt(m.liabilities.claimedMario) >= 3000n * ONE_TOKEN, "claimed liability >= fixture");
    // Outstanding includes the available failed(500) + pending(750) + dispatching(300).
    assert.ok(BigInt(m.liabilities.outstandingMario) >= 1550n * ONE_TOKEN, "outstanding includes fixture");
  });

  it("collectMetrics folds in optional float + reserves blocks", async () => {
    const m = await collectMetrics(db.pool, {
      float: { balanceMario: 300_000n * ONE_TOKEN, reservedMario: 0n, availableMario: 300_000n * ONE_TOKEN, capMario: 500_000n * ONE_TOKEN, refillNeeded: false, overCap: false },
      reserves: {
        network: "solana-mainnet", generatedAt: new Date().toISOString(), mint: "M",
        reserves: { hotDispenser: "H", hotFloatMario: "1", coldReserve: null, coldReserveMario: "0", totalReserveMario: "1", antHoldings: null },
        liabilities: { outstandingMario: "0", claimedMario: "0", totalLedgerMario: "0", outstandingAnts: 0, claimedAnts: 0, totalAnts: 0 },
        coverage: { tokenVaultCovered: true, surplusMario: "1", antCovered: null },
      },
    });
    assert.equal(m.float?.availableMario, (300_000n * ONE_TOKEN).toString());
    assert.equal(m.reserves?.tokenVaultCovered, true);
  });

  it("renderPrometheus emits the expected metric families", async () => {
    const m = await collectMetrics(db.pool, {
      float: { balanceMario: 300_000n * ONE_TOKEN, reservedMario: 0n, availableMario: 250_000n * ONE_TOKEN, capMario: 500_000n * ONE_TOKEN, refillNeeded: false, overCap: false },
    });
    const text = renderPrometheus(m);
    for (const name of ["claims_up", "claims_by_status", "claims_dispatch_confirmed_total", "claims_dispatch_drift_mario", "claims_review_queue_depth", "claims_outstanding_ario", "claims_float_available_ario"]) {
      assert.ok(text.includes(name), `prometheus output has ${name}`);
    }
    // Well-formed lines: `name{labels} value` or `name value`.
    for (const l of text.split("\n").filter((x) => x && !x.startsWith("#"))) {
      assert.match(l, /^claims_[a-z0-9_]+(\{[^}]*\})? -?\d+$/, `line: ${l}`);
    }
  });
});

// Pure rendering sanity (no DB) so the exposition format is asserted even without Postgres.
describe("renderPrometheus (pure)", () => {
  it("renders a minimal snapshot without a float/reserves block", () => {
    const s: MetricsSnapshot = {
      generatedAt: "t",
      claims: { byStatus: { confirmed: 1 }, total: 1, confirmed: 1, failed: 0, rejected: 0, dispatching: 0, verified: 0, pendingReview: 0, confirmedLastHour: 0, confirmedLast24h: 1, createdLastHour: 0, reviewQueueDepth: 0, oldestReviewAgeSec: null, dispatchingCount: 0, oldestDispatchingAgeSec: null },
      assets: { byStatus: { claimed: 1 }, total: 1 },
      dispatch: { confirmed: 1, failed: 0, inFlight: 0, dispatchedTotalMario: "0", claimedTotalMario: "0", driftMario: "0" },
      liabilities: { outstandingMario: "0", claimedMario: "0", outstandingAnts: 0, claimedAnts: 0 },
      audit: { headSeq: null, unsignedRows: 0 },
      anchors: { lastAuditHeadAnchorAt: null, lastAuditHeadAnchorAgeSec: null, lastAuditHeadAnchorConfirmed: null },
    };
    const text = renderPrometheus(s);
    assert.ok(text.includes("claims_up 1"));
    assert.ok(text.includes("claims_anchor_age_seconds -1")); // never anchored -> -1 sentinel
    assert.equal(text.includes("claims_float_"), false); // no float block
  });
});
