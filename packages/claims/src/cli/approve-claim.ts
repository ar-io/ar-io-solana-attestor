//! Operator tool: approve a pending_review claim so the worker will dispatch it
//! (M4). Covers both the >100k big-claim brake and the operator-gated ANT path.
//!
//!   DATABASE_URL=... tsx src/cli/approve-claim.ts <claimId> [--by <operator>]

import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { DispatchWorker } from "../dispatch/worker.js";
import { makeSlackNotifier } from "../ops/slack.js";
import { composeApprovalSlackMessage } from "../ops/claim-format.js";

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
        const r = await db.pool.query<{
          asset_type: string; amount: string | null; ant_name: string | null; ant_mint: string | null;
          claimant: string; protocol: number; source_address: string;
        }>(
          `SELECT a.asset_type, a.amount::text AS amount, a.ant_name, a.ant_mint,
                  c.claimant, rc.protocol, rc.source_address
             FROM claims c
             JOIN assets a ON a.asset_key = c.asset_key
             JOIN recipients rc ON rc.recipient_id = a.recipient_id
            WHERE c.claim_id = $1`,
          [claimId],
        );
        const row = r.rows[0];
        if (row) {
          const slack = makeSlackNotifier(config.slackWebhookUrl, (m, meta) =>
            // eslint-disable-next-line no-console
            console.error(JSON.stringify({ msg: m, meta })),
          );
          slack(
            composeApprovalSlackMessage(claimId, approvedBy, {
              assetType: row.asset_type,
              amountMario: row.amount,
              antName: row.ant_name,
              antMint: row.ant_mint,
              claimant: row.claimant,
              protocol: row.protocol,
              sourceAddress: row.source_address,
            }),
          );
          // Short-lived CLI: the POST is fire-and-forget, so give it a bounded moment
          // to flush before the process exits (never longer than the 5s notifier timeout).
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
