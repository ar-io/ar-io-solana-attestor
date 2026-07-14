//! Operator tool: approve a pending_review claim so the worker will dispatch it
//! (M4). Covers both the >100k big-claim brake and the operator-gated ANT path.
//!
//!   DATABASE_URL=... tsx src/cli/approve-claim.ts <claimId> [--by <operator>]

import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { DispatchWorker } from "../dispatch/worker.js";

async function main(): Promise<void> {
  const claimId = process.argv[2];
  if (!claimId || claimId.startsWith("--")) throw new Error("usage: approve-claim <claimId> [--by <operator>]");
  const byIdx = process.argv.indexOf("--by");
  const approvedBy = byIdx >= 0 ? process.argv[byIdx + 1] : process.env.OPERATOR ?? "operator";

  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  try {
    await DispatchWorker.approveClaim(db.pool, claimId, approvedBy);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ok: true, claimId, approvedBy }));
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("approve-claim failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
