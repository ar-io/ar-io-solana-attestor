//! Operator report: the manual vault-delivery queue (adversarial-pass item V).
//!
//! Lists every claim in `awaiting_manual_vault_delivery` with the exact
//! hand-delivery instruction: claimant, amount, and the CORRECT ABSOLUTE unlock
//! timestamp (== the escrow's original vault_end_timestamp). A vault whose unlock
//! has already passed is flagged deliver-UNLOCKED (liquid) instead of a re-lock.
//!
//!   DATABASE_URL=... tsx src/cli/vault-manual-queue.ts
//!
//! Exit 0 always (a report, not a gate). Use --json for machine output.

import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { vaultManualDeliveryQueue } from "../dispatch/vault-manual-queue.js";

async function main(): Promise<void> {
  const asJson = process.argv.includes("--json");
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  try {
    const q = await vaultManualDeliveryQueue(db.pool);
    if (asJson) {
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          {
            now: q.now.toString(),
            relockCount: q.relockCount,
            liquidUnlockedCount: q.liquidUnlockedCount,
            totalMario: q.totalMario.toString(),
            items: q.items.map((i) => ({
              claimId: i.claimId,
              assetKey: i.assetKey,
              claimant: i.claimant,
              amountMario: i.amountMario.toString(),
              unlockTimestamp: i.unlockTimestamp.toString(),
              unlockIso: new Date(Number(i.unlockTimestamp) * 1000).toISOString(),
              deliverKind: i.deliverKind,
              lockDurationSeconds: i.lockDurationSeconds.toString(),
            })),
          },
          null,
          2,
        ),
      );
      return;
    }
    const line = "=".repeat(72);
    // eslint-disable-next-line no-console
    console.log(line);
    // eslint-disable-next-line no-console
    console.log("MANUAL VAULT-DELIVERY QUEUE");
    // eslint-disable-next-line no-console
    console.log(line);
    // eslint-disable-next-line no-console
    console.log(`now: ${q.now} (${new Date(Number(q.now) * 1000).toISOString()})`);
    // eslint-disable-next-line no-console
    console.log(`items: ${q.items.length}  relock: ${q.relockCount}  deliver-unlocked(liquid): ${q.liquidUnlockedCount}  Σ mARIO: ${q.totalMario}`);
    for (const i of q.items) {
      const when = new Date(Number(i.unlockTimestamp) * 1000).toISOString();
      const action =
        i.deliverKind === "relock"
          ? `TRANSFER TOKENS LOCKED until ${when} (${i.lockDurationSeconds}s remaining)`
          : `DELIVER UNLOCKED (liquid) — original unlock ${when} already passed`;
      // eslint-disable-next-line no-console
      console.log(
        `\n- claim ${i.claimId}\n    claimant : ${i.claimant}\n    amount   : ${i.amountMario} mARIO\n    action   : ${action}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(`\n${line}`);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("vault-manual-queue failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
