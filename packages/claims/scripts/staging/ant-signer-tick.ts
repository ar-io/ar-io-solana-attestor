//! Gentle staging ANT auto-signer tick (systemd oneshot, ~60s cadence). The escrow
//! frontend is the CLAIMANT app (no operator admin UI), so nobody drives the
//! operator-wallet ANT signing from the browser. For STAGING convenience this stands
//! in: it checks the DB for ANT claims that reached `verified` and, ONLY when there
//! is work, runs the operator-signer (ant-operator-sign.ts) with the staging ANT
//! authority to dispense them. When idle it does ZERO on-chain / admin work (no empty
//! batch, no blockhash fetch) so it never hammers QuickNode. DEVNET ONLY.
//!
//!   DATABASE_URL=<claims_staging> ADMIN_URL=http://127.0.0.1:3051 SECURE_DIR=... \
//!     node --import tsx scripts/staging/ant-signer-tick.ts

import { Client } from "pg";
import { operatorSign } from "./ant-operator-sign.js";

const DATABASE_URL = process.env.DATABASE_URL!;
const ADMIN_URL = process.env.ADMIN_URL ?? "http://127.0.0.1:3051";
const SECURE_DIR = process.env.SECURE_DIR ?? "/opt/claims-secure/staging";

async function pendingAntCount(): Promise<number> {
  const db = new Client({ connectionString: DATABASE_URL });
  await db.connect();
  try {
    const who = (await db.query("SELECT current_database() db")).rows[0].db;
    if (who !== "claims_staging") throw new Error(`REFUSING: current_database()=${who}, expected claims_staging`);
    const r = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM claims c JOIN assets a ON a.asset_key = c.asset_key
        WHERE a.asset_type = 'ant'
          AND a.status IN ('claiming', 'pending_review')
          AND c.dispatch_signature IS NULL
          AND c.ant_batch_id IS NULL
          AND (c.status = 'verified' OR (c.status = 'pending_review' AND c.approved_at IS NOT NULL))`,
    );
    return parseInt(r.rows[0].n, 10);
  } finally {
    await db.end();
  }
}

async function main(): Promise<void> {
  const n = await pendingAntCount();
  if (n === 0) {
    console.log(JSON.stringify({ msg: "ant-signer tick: no pending ANT claims (idle)" }));
    return;
  }
  console.log(JSON.stringify({ msg: "ant-signer tick: dispatching", pending: n }));
  const r = await operatorSign({ adminUrl: ADMIN_URL, secureDir: SECURE_DIR, log: (m) => console.log(m) });
  for (const x of r.results) console.log(JSON.stringify({ msg: "ant-signer result", claimId: x.claimId, outcome: x.outcome, txid: x.txid }));
}

main().catch((e) => { console.error("ant-signer-tick failed:", e instanceof Error ? e.message : e); process.exit(1); });
