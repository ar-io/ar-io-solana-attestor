//! Postgres connection plumbing for the claims service.
//!
//! M0 scaffold: creates a lazily-connecting `pg.Pool` and exposes a
//! liveness `ping`. No schema access yet — the ledger tables (§3.1 of the
//! pivot plan) are added by the M1 migrations. The pool does NOT connect
//! at import time, so the service boots and serves `/health` even when
//! Postgres is unreachable (readiness is reported separately).

import { Pool, type PoolConfig } from "pg";

export interface Db {
  readonly pool: Pool;
  /** Round-trips a trivial query. Resolves true if the DB answered. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export function createDb(connectionString: string, extra: PoolConfig = {}): Db {
  const pool = new Pool({
    connectionString,
    // Keep the M0 footprint tiny; real pool tuning arrives with the
    // ledger/claims workload in M1+.
    max: 5,
    // Fail fast instead of hanging a health check when the DB is down.
    connectionTimeoutMillis: 3000,
    ...extra,
  });

  // A pool-level error handler is mandatory: without it, an idle-client
  // error (e.g. Postgres restart) crashes the process.
  pool.on("error", (err) => {
    // Deliberately swallow here; callers decide how to surface it. The
    // structured logger is wired in index.ts, not this pure module.
    void err;
  });

  return {
    pool,
    async ping(): Promise<boolean> {
      const client = await pool.connect();
      try {
        await client.query("SELECT 1");
        return true;
      } finally {
        client.release();
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
