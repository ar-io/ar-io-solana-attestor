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
  /**
   * Fastify `trustProxy` posture (drives which client IP the rate limiter keys
   * on). Default `false` — the socket peer IP is authoritative, so a directly
   * reachable listener can NOT be spoofed via `X-Forwarded-For`. Set `TRUST_PROXY`
   * to the trusted proxy hop count, `loopback`, or the specific proxy IP/CIDR
   * (comma-separated allowed) so XFF is honored ONLY from that hop. The fronting
   * WAF/proxy MUST overwrite (not append) `X-Forwarded-For`. Blanket `true` is
   * discouraged (it trusts XFF from anyone) — see MEDIUM-3.
   * Optional so bare test Config literals default to Fastify's `false`.
   */
  trustProxy?: boolean | string | number;
  /**
   * Bearer token gating `/metrics` + `/metrics.json` (ops-only, leaks
   * float/reserves/liabilities). When set, requests must carry
   * `Authorization: Bearer <token>`. When UNSET, metrics are served unauthenticated
   * ONLY on `localnet`; on any real network the endpoints are refused (403) so the
   * ops boundary is enforced, not merely documented (MEDIUM-4).
   */
  metricsAuthToken?: string;
  /**
   * ANT dispatch custody mode (ANT_OPERATOR_SIGNING_SPEC.md §7.5). `cli-cold`
   * (DEFAULT) keeps the existing break-glass `dispatch:ants` path with an
   * operator-supplied cold keypair; `operator-wallet` enables the wallet-signed
   * admin flow and boot REFUSES any persistent server-held ANT key. Default is
   * `cli-cold` so production behavior is unchanged until explicitly flipped.
   */
  antDispatchMode?: AntDispatchMode;
  /** Gate ANT eligibility on operator approval. Default false (decided): the
   *  operator signing session IS the human gate; verified ANTs flow straight in. */
  antRequiresApproval?: boolean;
  /** Max txs offered per operator build/sign session (ANT_BATCH_MAX). Default 50. */
  antBatchMax?: number;
  /** Reservation TTL (ms): an abandoned batch frees its claims after this. Default 10 min. */
  antReservationTtlMs?: number;
  /** The ANT-authority pubkey (base58). Required when antDispatchMode=operator-wallet. */
  antColdAddress?: string;
}

export type Network = "solana-mainnet" | "solana-devnet" | "localnet";
export type AntDispatchMode = "operator-wallet" | "cli-cold";
const VALID_ANT_MODES: readonly AntDispatchMode[] = ["operator-wallet", "cli-cold"];

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
  // A value of 0 would DISABLE the whale brake (the >threshold gates are
  // `threshold > 0n`), silently auto-dispensing arbitrarily large claims — reject
  // it. To route everything to manual review instead, set a threshold of 1.
  const bigClaimThresholdMario = BigInt(env.BIG_CLAIM_THRESHOLD_MARIO ?? "100000000000");
  if (bigClaimThresholdMario <= 0n) {
    throw new Error(
      `BIG_CLAIM_THRESHOLD_MARIO must be a positive integer (0 would disable the ` +
        `whale brake and auto-dispense any amount); got "${env.BIG_CLAIM_THRESHOLD_MARIO}". ` +
        `Use 1 to route every claim to manual review.`,
    );
  }

  const antDispatchMode = (env.ANT_DISPATCH_MODE ?? "cli-cold") as AntDispatchMode;
  if (!VALID_ANT_MODES.includes(antDispatchMode)) {
    throw new Error(`ANT_DISPATCH_MODE must be one of ${VALID_ANT_MODES.join(", ")}, got "${env.ANT_DISPATCH_MODE}"`);
  }
  const antBatchMax = parseInt(env.ANT_BATCH_MAX ?? "50", 10);
  if (!Number.isInteger(antBatchMax) || antBatchMax <= 0) {
    throw new Error(`ANT_BATCH_MAX must be a positive integer, got "${env.ANT_BATCH_MAX}"`);
  }
  const antReservationTtlMs = parseInt(env.ANT_RESERVATION_TTL_MS ?? "600000", 10);
  if (!Number.isInteger(antReservationTtlMs) || antReservationTtlMs <= 0) {
    throw new Error(`ANT_RESERVATION_TTL_MS must be a positive integer, got "${env.ANT_RESERVATION_TTL_MS}"`);
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
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    metricsAuthToken: env.METRICS_AUTH_TOKEN && env.METRICS_AUTH_TOKEN.length > 0 ? env.METRICS_AUTH_TOKEN : undefined,
    antDispatchMode,
    antRequiresApproval: (env.ANT_REQUIRES_APPROVAL ?? "false") === "true",
    antBatchMax,
    antReservationTtlMs,
    antColdAddress: env.ANT_COLD_ADDRESS && env.ANT_COLD_ADDRESS.length > 0 ? env.ANT_COLD_ADDRESS : undefined,
  };
}

/**
 * Parse `TRUST_PROXY` into a Fastify `trustProxy` value. Default (unset/empty/
 * false) is `false` — do NOT trust `X-Forwarded-For`, key the rate limiter on the
 * socket peer IP. A hop count, `loopback`, or an explicit IP/CIDR (comma-separated)
 * scopes XFF trust to that proxy. Blanket `true` is accepted only if explicitly
 * requested and is discouraged (MEDIUM-3).
 */
export function parseTrustProxy(raw: string | undefined): boolean | string | number {
  if (raw === undefined) return false;
  const v = raw.trim();
  if (v === "") return false;
  const lower = v.toLowerCase();
  if (["false", "0", "off", "no"].includes(lower)) return false;
  if (["true", "on", "yes"].includes(lower)) return true; // blanket trust — discouraged
  if (/^\d+$/.test(v)) return parseInt(v, 10); // number of proxy hops
  return v; // "loopback" | IP | CIDR | comma-separated list — Fastify parses it
}
