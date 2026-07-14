//! Solana RPC plumbing for the claims service.
//!
//! Uses `@solana/kit` (NOT `@solana/web3.js`) per the migration's
//! new-code mandate. M0 scaffold: builds the RPC client from config so
//! the wiring + dependency graph are proven, but performs no on-chain
//! reads yet. Reserve-proof reads, `ArioConfig.min_vault_duration`
//! lookups, and dispatch land in M1-M4.

import { createSolanaRpc, type Rpc, type SolanaRpcApi } from "@solana/kit";

export type SolanaRpc = Rpc<SolanaRpcApi>;

/** Build a kit RPC client for the configured endpoint. Lazily used. */
export function createRpc(url: string): SolanaRpc {
  return createSolanaRpc(url);
}
