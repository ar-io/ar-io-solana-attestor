//! Decode the on-chain `name` field of an MPL Core asset (AssetV1) — the ANT's
//! ArNS name. DISPLAY-ONLY: this is never consumed by the money path (custody,
//! settlement, verification, reconciliation, canonical bytes). Used solely by
//! the `backfill:ant-names` CLI to populate `assets.ant_name` for the API/UI.
//!
//! AssetV1 account layout (Metaplex Core, borsh):
//!   key:              u8         (1 = AssetV1)
//!   owner:            Pubkey     (32)
//!   update_authority: enum tag u8 — 0 = None (+0), 1 = Address (+32), 2 = Collection (+32)
//!   name:             String     (u32 LE length + UTF-8 bytes)
//!   uri:              String     (u32 LE length + UTF-8 bytes)
//!   ...trailing plugin/seq data we do not touch.
//!
//! We decode only through `name` — enough to display it, robust to whatever
//! follows. Every offset is bounds-checked; malformed/foreign account data
//! throws rather than reading past the buffer.

import { Buffer } from "node:buffer";

const KEY_ASSET_V1 = 1;

/** Thrown when the bytes are not a decodable MPL Core AssetV1 name. */
export class MplCoreNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MplCoreNameError";
  }
}

/**
 * Decode the `name` from raw MPL Core AssetV1 account data.
 *
 * @param data raw account bytes (e.g. `Buffer.from(getAccountInfo.data[0], "base64")`).
 * @returns the UTF-8 `name` string.
 * @throws MplCoreNameError if the bytes are not a well-formed AssetV1 header.
 */
export function decodeMplCoreName(data: Uint8Array): string {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);

  // key
  if (buf.length < 1) throw new MplCoreNameError("empty account data");
  const key = buf[0];
  if (key !== KEY_ASSET_V1) {
    throw new MplCoreNameError(`not an MPL Core AssetV1 account (key=${key})`);
  }

  // owner (32)
  let off = 1 + 32;

  // update_authority enum: tag then 0 or 32 bytes.
  if (off + 1 > buf.length) throw new MplCoreNameError("truncated before update_authority");
  const uaTag = buf[off];
  off += 1;
  if (uaTag === 0) {
    // None — no address follows.
  } else if (uaTag === 1 || uaTag === 2) {
    off += 32; // Address / Collection pubkey.
  } else {
    throw new MplCoreNameError(`unknown update_authority variant ${uaTag}`);
  }

  // name: u32 LE length + UTF-8.
  if (off + 4 > buf.length) throw new MplCoreNameError("truncated before name length");
  const nameLen = buf.readUInt32LE(off);
  off += 4;
  if (off + nameLen > buf.length) {
    throw new MplCoreNameError(`name length ${nameLen} exceeds account data`);
  }
  return buf.subarray(off, off + nameLen).toString("utf8");
}

/** Convenience: decode from a base64 account-data string (RPC `encoding: "base64"`). */
export function decodeMplCoreNameFromBase64(base64: string): string {
  return decodeMplCoreName(new Uint8Array(Buffer.from(base64, "base64")));
}
