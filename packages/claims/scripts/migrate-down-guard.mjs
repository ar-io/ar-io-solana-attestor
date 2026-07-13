#!/usr/bin/env node
// Destructive down-migration guard (adversarial-pass item E).
//
// A `migrate:down` runs the migrations' Down bodies, several of which DROP
// columns/indexes/constraints — irreversible data loss on a live custodial DB.
// The ledger + audit tables are APPEND-ONLY in production and the app DB role
// SHOULD NOT hold DROP at all (defense in depth). This wrapper refuses to run a
// down-migration unless BOTH:
//
//   * ALLOW_DESTRUCTIVE_DOWN=1  (explicit operator opt-in), AND
//   * NETWORK != "solana-mainnet"  (never on mainnet, even with the flag)
//
// Down bodies remain in the migration files for local/dev rollbacks; this guard
// is the runner. Any extra CLI args (e.g. a count) are passed through to
// node-pg-migrate.

import { spawnSync } from "node:child_process";

const network = process.env.NETWORK ?? "localnet";
const allow = process.env.ALLOW_DESTRUCTIVE_DOWN === "1";
const passthrough = process.argv.slice(2);

function refuse(reason) {
  console.error(
    `[migrate:down] REFUSED — ${reason}\n` +
      `  Destructive down-migrations are gated. To run one on a NON-mainnet DB:\n` +
      `    ALLOW_DESTRUCTIVE_DOWN=1 NETWORK=<localnet|solana-devnet> yarn migrate:down\n` +
      `  In production the app DB role should not hold DROP; ledger/audit are append-only.`,
  );
  process.exit(1);
}

if (network === "solana-mainnet") {
  refuse("NETWORK=solana-mainnet — down-migrations are NEVER permitted on mainnet (even with ALLOW_DESTRUCTIVE_DOWN=1).");
}
if (!allow) {
  refuse("ALLOW_DESTRUCTIVE_DOWN is not set to 1.");
}

console.error(
  `[migrate:down] permitted on NETWORK=${network} with ALLOW_DESTRUCTIVE_DOWN=1 — running node-pg-migrate down ${passthrough.join(" ")}`.trim(),
);
const res = spawnSync("node-pg-migrate", ["down", ...passthrough], { stdio: "inherit", env: process.env });
process.exit(res.status ?? 1);
