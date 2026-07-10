//! Reconciliation-after-dispatch report (M4). Exit 0 = clean, 1 = discrepancy.
//!
//!   DATABASE_URL=... tsx src/cli/reconcile-dispatch.ts

import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { reconcileDispatch } from "../dispatch/reconcile-dispatch.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  try {
    const r = await reconcileDispatch(db.pool);
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          ok: r.ok,
          confirmedClaims: r.confirmedClaims,
          claimedAssets: r.claimedAssets,
          antConfirmed: r.antConfirmed,
          dispatchedTotalMario: r.dispatchedTotalMario.toString(),
          claimedTotalMario: r.claimedTotalMario.toString(),
          issues: r.issues,
        },
        null,
        2,
      ),
    );
    process.exitCode = r.ok ? 0 : 1;
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("reconcile-dispatch failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
