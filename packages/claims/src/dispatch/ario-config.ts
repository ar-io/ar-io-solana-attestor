//! Live ario-core `ArioConfig` vault-duration read + boot reconciliation (item F).
//!
//! The vault SETTLEMENT decision (liquid vs re-lock) keys off
//! `ArioConfig.min_vault_duration` / `max_vault_duration`. Those were previously
//! read from STATIC env (`VAULT_MIN/MAX_DURATION_SECONDS`) while the code comments
//! claimed they were "read live at dispatch" — a false claim, and a stale env
//! `min` could misclassify a STILL-LOCKED vault as liquid (releasing a locked
//! position). Since vault re-lock is now manual delivery (item V), we do not need
//! them live per-dispatch, but we MUST guarantee the configured values equal the
//! on-chain truth: this module reads the live `ArioConfig` and the worker boot
//! FAILS FAST on any mismatch.
//!
//! Layout (ario-core `state/mod.rs::ArioConfig`, counting from byte 0 incl. the
//! 8-byte Anchor discriminator):
//!   disc(8) authority(32) mint(32) arns_program(32) treasury(32)
//!   total_supply(u64) protocol_balance(u64) circulating_supply(u64)
//!   locked_supply(u64) min_vault_duration(i64) max_vault_duration(i64) ...
//! => min at offset 168, max at offset 176; both little-endian i64 seconds.

import { Buffer } from "node:buffer";
import type { Address } from "@solana/kit";

import type { SolanaRpc } from "../solana.js";
import { deriveArioConfig } from "./instructions.js";
import type { VaultDurations } from "./worker.js";

export const MIN_VAULT_DURATION_OFFSET = 168;
export const MAX_VAULT_DURATION_OFFSET = 176;

/** Decode min/max vault duration (i64 LE seconds) from raw ArioConfig bytes. */
export function decodeVaultDurations(data: Uint8Array): VaultDurations {
  if (data.length < MAX_VAULT_DURATION_OFFSET + 8) {
    throw new Error(
      `ArioConfig account too short (${data.length} bytes) to decode vault durations ` +
        `(need >= ${MAX_VAULT_DURATION_OFFSET + 8})`,
    );
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    minVaultDuration: view.getBigInt64(MIN_VAULT_DURATION_OFFSET, true),
    maxVaultDuration: view.getBigInt64(MAX_VAULT_DURATION_OFFSET, true),
  };
}

/** Fetch the live ArioConfig account and decode its vault durations. */
export async function fetchArioConfigVaultDurations(
  rpc: SolanaRpc,
  arioCoreProgram: Address,
): Promise<{ config: Address; durations: VaultDurations }> {
  const config = await deriveArioConfig(arioCoreProgram);
  const res = await rpc.getAccountInfo(config, { encoding: "base64" }).send();
  if (!res.value) {
    throw new Error(`ArioConfig account ${config} not found on-chain (ario-core program ${arioCoreProgram})`);
  }
  const data = new Uint8Array(Buffer.from(res.value.data[0], "base64"));
  return { config, durations: decodeVaultDurations(data) };
}

/** Throw unless the configured vault durations match the on-chain ArioConfig. */
export function assertVaultDurationsMatchChain(configured: VaultDurations, onChain: VaultDurations): void {
  if (
    configured.minVaultDuration !== onChain.minVaultDuration ||
    configured.maxVaultDuration !== onChain.maxVaultDuration
  ) {
    throw new Error(
      `vault-duration mismatch — the worker's configured min/max ` +
        `(${configured.minVaultDuration}/${configured.maxVaultDuration}s) do NOT equal the live ` +
        `on-chain ArioConfig (${onChain.minVaultDuration}/${onChain.maxVaultDuration}s). A wrong ` +
        `min could misclassify a still-locked vault as liquid. Fix VAULT_MIN_DURATION_SECONDS / ` +
        `VAULT_MAX_DURATION_SECONDS to match on-chain before dispatching.`,
    );
  }
}
