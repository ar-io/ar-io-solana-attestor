//! Runtime configuration for the claims service.
//!
//! Env-driven, no secrets checked in. See `.env.example` for the full
//! list. M0 only wires the transport + storage plumbing; ledger,
//! treasury, and attestor-integration settings arrive in later
//! milestones and will extend this interface.
//!
//! Required env vars:
//!   DATABASE_URL — Postgres connection string. In docker-compose this is
//!                  injected pointing at the `postgres` service; locally it
//!                  defaults to a dev instance (see DEFAULT_DATABASE_URL).
//!
//! Optional:
//!   PORT            — HTTP port (default 3040; distinct from the attestor's 3030)
//!   HOST            — bind address (default 0.0.0.0 so the container is reachable)
//!   LOG_LEVEL       — pino log level (default "info")
//!   NETWORK         — "solana-mainnet" | "solana-devnet" | "localnet" (default "localnet")
//!   SOLANA_RPC_URL  — @solana/kit RPC endpoint (default per NETWORK)

export interface Config {
  port: number;
  host: string;
  logLevel: string;
  network: Network;
  databaseUrl: string;
  solanaRpcUrl: string;
  /** M3: TTL of the single-use claim challenge (ms). Default 15 min. */
  challengeTtlMs: number;
  /** M3: claims with amount (or recipient total) above this route to
   *  pending_review (the §4.3 big-claim brake). mARIO bigint. Default 100k ARIO. */
  bigClaimThresholdMario: bigint;
  /** M3: per-IP requests/min (mirrors the attestor's RATE_LIMIT_PER_MIN). */
  rateLimitPerMin: number;
  /** M3: per-identity requests/min (recipient/source address dimension). */
  rateLimitIdentityPerMin: number;
  /** M3: value for the Access-Control-Allow-Origin header ("*" or an origin). */
  corsOrigin: string;
}

export type Network = "solana-mainnet" | "solana-devnet" | "localnet";

const VALID_NETWORKS: readonly Network[] = [
  "solana-mainnet",
  "solana-devnet",
  "localnet",
];

/**
 * Dev-only fallback so `yarn dev` / the placeholder test boot without a
 * pre-set env. NEVER a production credential — production MUST inject
 * DATABASE_URL from a secret manager. The password here is a throwaway
 * that only matches the local docker-compose Postgres.
 */
const DEFAULT_DATABASE_URL =
  "postgres://claims:claims@localhost:5432/claims";

const DEFAULT_RPC_BY_NETWORK: Record<Network, string> = {
  "solana-mainnet": "https://api.mainnet-beta.solana.com",
  "solana-devnet": "https://api.devnet.solana.com",
  localnet: "http://127.0.0.1:8899",
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const network = (env.NETWORK ?? "localnet") as Network;
  if (!VALID_NETWORKS.includes(network)) {
    throw new Error(
      `NETWORK must be one of ${VALID_NETWORKS.join(", ")}, got "${network}"`,
    );
  }

  const port = parseInt(env.PORT ?? "3040", 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be a valid port number, got "${env.PORT}"`);
  }

  const challengeTtlMs = parseInt(env.CLAIM_CHALLENGE_TTL_MS ?? "900000", 10); // 15 min
  if (!Number.isInteger(challengeTtlMs) || challengeTtlMs <= 0) {
    throw new Error(`CLAIM_CHALLENGE_TTL_MS must be a positive integer, got "${env.CLAIM_CHALLENGE_TTL_MS}"`);
  }

  // 100,000 ARIO = 100_000 * ONE_TOKEN(1e6) mARIO.
  const bigClaimThresholdMario = BigInt(env.BIG_CLAIM_THRESHOLD_MARIO ?? "100000000000");
  if (bigClaimThresholdMario < 0n) {
    throw new Error(`BIG_CLAIM_THRESHOLD_MARIO must be >= 0, got "${env.BIG_CLAIM_THRESHOLD_MARIO}"`);
  }

  return {
    port,
    host: env.HOST ?? "0.0.0.0",
    logLevel: env.LOG_LEVEL ?? "info",
    network,
    databaseUrl: env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    solanaRpcUrl: env.SOLANA_RPC_URL ?? DEFAULT_RPC_BY_NETWORK[network],
    challengeTtlMs,
    bigClaimThresholdMario,
    rateLimitPerMin: parseInt(env.RATE_LIMIT_PER_MIN ?? "60", 10),
    rateLimitIdentityPerMin: parseInt(env.RATE_LIMIT_IDENTITY_PER_MIN ?? "20", 10),
    corsOrigin: env.CORS_ORIGIN ?? "*",
  };
}
