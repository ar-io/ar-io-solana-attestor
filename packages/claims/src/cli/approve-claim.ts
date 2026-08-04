//! Operator tool: approve a pending_review claim so the worker will dispatch it
//! (M4). Covers both the >100k big-claim brake and the operator-gated ANT path.
//!
//!   DATABASE_URL=... tsx src/cli/approve-claim.ts <claimId> [--by <operator>]

import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { DispatchWorker } from "../dispatch/worker.js";
import { makeSlackNotifier } from "../ops/slack.js";

/** Format integer mARIO as a human ARIO decimal string (6 decimals, trailing 0s trimmed). */
function marioToArio(mario: bigint): string {
  const ONE = 1_000_000n;
  const whole = mario / ONE;
  const frac = mario % ONE;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(6, "0").replace(/0+$/, "")}`;
}

/** Short base58 id for the recipient in an operator-readable Slack line. */
function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}

async function main(): Promise<void> {
  const claimId = process.argv[2];
  if (!claimId || claimId.startsWith("--")) throw new Error("usage: approve-claim <claimId> [--by <operator>]");
  const byIdx = process.argv.indexOf("--by");
  const approvedBy = byIdx >= 0 ? process.argv[byIdx + 1] : process.env.OPERATOR ?? "operator";

  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  try {
    await DispatchWorker.approveClaim(db.pool, claimId, approvedBy);

    // Opt-in Slack notification — best-effort and fire-and-forget. A Slack failure
    // must NEVER fail the CLI: the approval already committed above, the notifier
    // never throws, and any DB-read error here is swallowed. Exit 0 stays 0.
    if (config.slackWebhookUrl) {
      try {
        const r = await db.pool.query<{ asset_type: string; amount: string | null; recipient_id: string | null }>(
          `SELECT a.asset_type, a.amount::text AS amount, c.recipient_id
             FROM claims c JOIN assets a ON a.asset_key = c.asset_key
            WHERE c.claim_id = $1`,
          [claimId],
        );
        const row = r.rows[0];
        if (row) {
          const amountPart = row.amount ? ` ${marioToArio(BigInt(row.amount))} ARIO` : "";
          const recipient = row.recipient_id ? shortId(row.recipient_id) : "unknown";
          const slack = makeSlackNotifier(config.slackWebhookUrl, (m, meta) =>
            // eslint-disable-next-line no-console
            console.error(JSON.stringify({ msg: m, meta })),
          );
          slack({
            text: `✅ Claim ${claimId.slice(0, 8)} approved by ${approvedBy} — ${row.asset_type}${amountPart} → ${recipient}`,
          });
          // Short-lived CLI: the POST is fire-and-forget, so give it a bounded moment
          // to flush before the process exits (never longer than the 5s notifier timeout + slack).
          await new Promise((resolve) => setTimeout(resolve, 6000));
        }
      } catch {
        // A notification problem must never affect the approval outcome.
      }
    }

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
