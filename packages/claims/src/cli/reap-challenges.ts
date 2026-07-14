//! CLI: reap expired `claiming` challenges (low/info hardening). Run on a
//! schedule (cron/systemd timer) so un-completed challenges don't accumulate.
//!
//!   DATABASE_URL=... tsx src/cli/reap-challenges.ts
//!
//! Exit 0 always (a maintenance sweep). Prints the number reaped.

import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { reapAllExpiredChallenges } from "../api/reaper.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  try {
    const reaped = await reapAllExpiredChallenges(db.pool);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ msg: "reaped expired challenges", reaped }));
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("reap-challenges failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
