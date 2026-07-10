//! Deterministic ANT mint pubkey derivation (kit-compatible, no web3.js).
//!
//! Each Arweave Name Token on Solana is a Metaplex Core asset whose address is
//! the ed25519 public key of the keypair that signed its CreateV1. The signing
//! keypair is `Keypair.fromSeed(sha256("ant-mint:" || aoProcessId || SECRET))`.
//! `Keypair.fromSeed(seed)` is exactly an ed25519 keypair whose 32-byte private
//! key IS `seed`; its public key is `ed25519.getPublicKey(seed)`. We compute it
//! with @noble/ed25519 (no @solana/web3.js in claims runtime code) and prove
//! byte-equivalence to web3.js's `Keypair.fromSeed` via ANT_MINT_FIXTURES.
//!
//! The 32-byte ANT_MINT_SECRET (env, base64) MUST stay private — anyone who
//! learns it can pre-create the asset at the expected address. See the
//! authoritative source `solana-ar-io/migration/import/src/derive-ant-mint.ts`.

import { sha256, sha512 } from "@noble/hashes/sha2";
import * as ed25519 from "@noble/ed25519";
import bs58 from "bs58";

// @noble/ed25519 v2 needs sha512 wired in for the synchronous getPublicKey.
// Idempotent: the same wiring the attestor's attest.ts installs.
ed25519.etc.sha512Sync = (...m) => sha512(ed25519.etc.concatBytes(...m));

/** Domain-separator. Do not change without re-snapshotting + re-minting. */
export const ANT_MINT_SEED_PREFIX = "ant-mint:";

const SECRET_LENGTH = 32;

/** Fixed test secret (32 zero bytes) — drift-detection fixtures only. */
export const ANT_MINT_TEST_SECRET: Uint8Array = new Uint8Array(SECRET_LENGTH);

/**
 * Golden vectors computed under ANT_MINT_TEST_SECRET (32 zero bytes). MUST stay
 * byte-identical to `ANT_MINT_DERIVATION_FIXTURES` in the two authoritative
 * copies (migration/import + migration/snapshot derive-ant-mint.ts). Verified
 * to equal web3.js `Keypair.fromSeed(...).publicKey.toBase58()`.
 */
export const ANT_MINT_FIXTURES: ReadonlyArray<{
  aoProcessId: string;
  expectedPubkey: string;
}> = [
  { aoProcessId: "", expectedPubkey: "GoPtfBY5tmUetUpRVVQkq1duz9jMBkAVaZuwB1v2GZ1W" },
  { aoProcessId: "a", expectedPubkey: "GmZLLptHfJUxaYfMgW9vmKjAg8xQmf3gfSJvHFDTpWti" },
  {
    aoProcessId: "wELqkslJQiVMlS2l8nmUirGbOKGTK_xcEHd2RuDfovg",
    expectedPubkey: "DHj973XNyXShG3LHe6ACg6WSiePBdN8tK1WB3mNyyUmN",
  },
  {
    aoProcessId: "--55AVXmgefk61QNMDJ15llgjdcCT5ehhWxKeDLEpx4",
    expectedPubkey: "FBCrWKmwXoy7PJUxRBVXfwpee3c7YuLNZ1JG2SJSJm42",
  },
];

/** Concatenate `ant-mint:<processId>` utf8 bytes with the 32-byte secret. */
function seedFor(aoProcessId: string, secret: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(ANT_MINT_SEED_PREFIX + aoProcessId);
  const buf = new Uint8Array(prefix.length + secret.length);
  buf.set(prefix, 0);
  buf.set(secret, prefix.length);
  return sha256(buf);
}

/** Derive the ANT mint (Metaplex Core asset) pubkey as raw 32 bytes. */
export function deriveAntMintBytes(aoProcessId: string, secret: Uint8Array): Uint8Array {
  if (secret.length !== SECRET_LENGTH) {
    throw new Error(
      `deriveAntMint: secret must be ${SECRET_LENGTH} bytes; got ${secret.length}.`,
    );
  }
  return ed25519.getPublicKey(seedFor(aoProcessId, secret));
}

/** Derive the ANT mint base58 (the on-chain asset address / DB asset_key). */
export function deriveAntMintBase58(aoProcessId: string, secret: Uint8Array): string {
  return bs58.encode(deriveAntMintBytes(aoProcessId, secret));
}

/**
 * Load the production ANT mint secret from `process.env.ANT_MINT_SECRET`
 * (base64 of exactly 32 bytes). Strict round-trip decode, matching the
 * authoritative loader.
 */
export function loadAntMintSecret(env: NodeJS.ProcessEnv = process.env): Uint8Array {
  const b64 = env.ANT_MINT_SECRET;
  if (b64 === undefined || b64.length === 0) {
    throw new Error(
      "ANT_MINT_SECRET environment variable is required.\n" +
        "  Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"\n" +
        "  Must be the SAME value the snapshot/import operator used.",
    );
  }
  const decoded = Buffer.from(b64, "base64");
  if (decoded.toString("base64") !== b64) {
    throw new Error("ANT_MINT_SECRET is not valid base64 (round-trip mismatch).");
  }
  if (decoded.length !== SECRET_LENGTH) {
    throw new Error(
      `ANT_MINT_SECRET must be exactly ${SECRET_LENGTH} bytes; got ${decoded.length}.`,
    );
  }
  return new Uint8Array(decoded);
}

/** Startup drift check: this derivation must match the frozen fixtures. */
export function assertAntMintDerivation(): void {
  for (const { aoProcessId, expectedPubkey } of ANT_MINT_FIXTURES) {
    const actual = deriveAntMintBase58(aoProcessId, ANT_MINT_TEST_SECRET);
    if (actual !== expectedPubkey) {
      throw new Error(
        `ANT-mint derivation drifted for ${JSON.stringify(aoProcessId)}: ` +
          `expected ${expectedPubkey}, got ${actual}.`,
      );
    }
  }
}
