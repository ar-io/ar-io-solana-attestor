/**
 * Cross-language canonical-message equivalence test for the attestor.
 *
 * The SDK has its own cross-test (`sdk/src/solana/canonical-message.cross.test.ts`)
 * that pins SDK ↔ Rust byte parity. This test does the same for
 * **attestor ↔ Rust** — independent implementation of the same spec,
 * so drift between attestor and on-chain canonical messages would
 * silently make every attestation fail to verify on-chain.
 *
 * Self-bootstrapping: builds the Rust `canonical` example binary on
 * demand. Skips when cargo isn't available so unit-test runs on
 * machines without the Rust toolchain don't need to install it.
 */

import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { before, describe, it } from 'node:test';

import { buildAntEscrowClaimMessage, buildEscrowClaimMessage } from './canonical.js';

/**
 * Locate the ar-io-solana-contracts repo. The attestor used to live in
 * `solana-ar-io/migration/attestor/`; after the extraction (this repo
 * lives at `~/source/ar-io-solana-attestor/`), the canonical sibling
 * lookup is `<this-repo>/../ar-io-solana-contracts/`.
 *
 * `CONTRACTS_REPO_DIR` env override wins so CI and unusual layouts can
 * point anywhere.
 */
const REPO_ROOT = resolve(import.meta.dirname ?? '.', '..');

function findContractsDir(): string | null {
  const envOverride = process.env.CONTRACTS_REPO_DIR;
  const candidates = [
    ...(envOverride ? [envOverride] : []),
    resolve(REPO_ROOT, '..', 'ar-io-solana-contracts'),
  ];
  for (const dir of candidates) {
    if (existsSync(resolve(dir, 'programs/ario-ant-escrow/examples/canonical.rs'))) {
      return dir;
    }
  }
  return null;
}

const CONTRACTS_DIR = findContractsDir();
const RUST_BIN = CONTRACTS_DIR
  ? resolve(CONTRACTS_DIR, 'target/debug/examples/canonical')
  : '';

let cargoAvailable = true;

before(() => {
  // Layout we couldn't auto-detect — skip gracefully. (The user can
  // re-run with CONTRACTS_REPO_DIR pointing at their checkout.)
  if (!CONTRACTS_DIR) {
    cargoAvailable = false;
    return;
  }
  if (existsSync(RUST_BIN)) return;
  // Try to build. If cargo isn't on PATH, mark all tests as skipped
  // (vs the SDK test which fails loud). The attestor doesn't ship
  // the Rust toolchain in its Docker image, so being kind here.
  const probe = spawnSync('cargo', ['--version'], { stdio: 'ignore' });
  if (probe.error || probe.status !== 0) {
    cargoAvailable = false;
    return;
  }
  const build = spawnSync(
    'cargo',
    ['build', '--example', 'canonical', '-p', 'ario-ant-escrow'],
    { cwd: CONTRACTS_DIR, stdio: 'inherit' },
  );
  if (build.error || build.status !== 0 || !existsSync(RUST_BIN)) {
    throw new Error(
      `Failed to build the Rust canonical example for attestor ↔ Rust\n` +
        `parity verification. Manual build:\n` +
        `  cd ${CONTRACTS_DIR} && cargo build --example canonical -p ario-ant-escrow\n` +
        `Or set CONTRACTS_REPO_DIR=<path-to-ar-io-solana-contracts-checkout>.`,
    );
  }
});

function rustAntCanonical(
  antMintBase58: string,
  claimantBase58: string,
  nonceHex: string,
  recipientPubkeyHex: string,
): Uint8Array {
  const out = execFileSync(
    RUST_BIN,
    [antMintBase58, claimantBase58, nonceHex, recipientPubkeyHex],
    { encoding: 'buffer' },
  );
  return new Uint8Array(out);
}

function rustEscrowCanonical(
  assetType: 'token' | 'vault',
  assetIdHex: string,
  amount: string,
  claimantBase58: string,
  nonceHex: string,
  recipientPubkeyHex: string,
): Uint8Array {
  const out = execFileSync(
    RUST_BIN,
    ['--escrow', assetType, assetIdHex, amount, claimantBase58, nonceHex, recipientPubkeyHex],
    { encoding: 'buffer' },
  );
  return new Uint8Array(out);
}

/// Stable Arweave-shaped recipient bytes: 512 bytes of 0xAB.
/// Same value used in the Rust canonical_message_changes_with_recipient_pubkey
/// test, so cross-language drift here surfaces immediately.
const RECIPIENT_AB512_HEX = 'ab'.repeat(512);
const RECIPIENT_AB512 = decodeHexLong(RECIPIENT_AB512_HEX);

function decodeHexLong(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// Fixed test vectors that exercise the full byte width of each field.
const ANT_VECTORS: Array<{
  name: string;
  antMintBase58: string;
  claimantBase58: string;
  nonceHex: string;
}> = [
  {
    name: 'design doc example',
    antMintBase58: '9PnRFwk2Yp7QyU3sQzXwUhJj6tVyM4nN2KqL5fT8RbAW',
    claimantBase58: 'Hk6RfBp4FpvF2hYBmJ9kqyL5dE3xR8wPzN7sV6cTqL2A',
    nonceHex: 'a3f1c8d92e0b4f7a8e1d6c5b4a3920817f6e5d4c3b2a19188776655443322110',
  },
  {
    name: 'all-zero nonce',
    antMintBase58: 'F1ipQp4Bz9rYy3o9nz28sR8XqGXpKj7aXQH9aT8z2pn1',
    claimantBase58: 'GpRq5C5cAaR1nL2A8bJh9kE3yz6T2sP4MqVxKn9wB8jF',
    nonceHex: '00'.repeat(32),
  },
  {
    name: 'all-ff nonce',
    antMintBase58: 'F1ipQp4Bz9rYy3o9nz28sR8XqGXpKj7aXQH9aT8z2pn1',
    claimantBase58: 'GpRq5C5cAaR1nL2A8bJh9kE3yz6T2sP4MqVxKn9wB8jF',
    nonceHex: 'ff'.repeat(32),
  },
];

const ESCROW_VECTORS: Array<{
  name: string;
  assetType: 'token' | 'vault';
  assetIdHex: string;
  amount: string;
  claimantBase58: string;
  nonceHex: string;
}> = [
  {
    name: 'token, 1 mARIO',
    assetType: 'token',
    assetIdHex: '01'.repeat(32),
    amount: '1',
    claimantBase58: 'GpRq5C5cAaR1nL2A8bJh9kE3yz6T2sP4MqVxKn9wB8jF',
    nonceHex: 'aa'.repeat(32),
  },
  {
    name: 'vault, max u64',
    assetType: 'vault',
    assetIdHex: 'de'.repeat(32),
    amount: '18446744073709551615',
    claimantBase58: 'Hk6RfBp4FpvF2hYBmJ9kqyL5dE3xR8wPzN7sV6cTqL2A',
    nonceHex: 'cc'.repeat(32),
  },
  {
    name: 'token, mid-range amount',
    assetType: 'token',
    assetIdHex: '7f'.repeat(32),
    amount: '500000000',
    claimantBase58: 'GpRq5C5cAaR1nL2A8bJh9kE3yz6T2sP4MqVxKn9wB8jF',
    nonceHex: '11'.repeat(32),
  },
];

import bs58 from 'bs58';

function decodeHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

describe('attestor ↔ Rust canonical message parity (ANT)', () => {
  // The Rust example is compiled with whatever feature set
  // `cargo build --example canonical` resolves to. Default workspace
  // features pick `network-mainnet` for ario-ant-escrow per its
  // Cargo.toml; pass the same network to the TS side for byte parity.
  const NETWORK = 'solana-mainnet';

  for (const v of ANT_VECTORS) {
    it(`byte-equals Rust for: ${v.name}`, () => {
      if (!cargoAvailable) return;
      const tsBytes = buildAntEscrowClaimMessage({
        antMint: bs58.decode(v.antMintBase58),
        claimant: bs58.decode(v.claimantBase58),
        nonce: decodeHex(v.nonceHex),
        network: NETWORK,
        recipientPubkey: RECIPIENT_AB512,
      });
      const rustBytes = rustAntCanonical(
        v.antMintBase58,
        v.claimantBase58,
        v.nonceHex,
        RECIPIENT_AB512_HEX,
      );
      assert.deepEqual(tsBytes, rustBytes);
    });
  }
});

describe('attestor ↔ Rust canonical message parity (token/vault)', () => {
  const NETWORK = 'solana-mainnet';

  for (const v of ESCROW_VECTORS) {
    it(`byte-equals Rust for: ${v.name}`, () => {
      if (!cargoAvailable) return;
      const tsBytes = buildEscrowClaimMessage({
        assetType: v.assetType,
        assetId: decodeHex(v.assetIdHex),
        amount: BigInt(v.amount),
        claimant: bs58.decode(v.claimantBase58),
        nonce: decodeHex(v.nonceHex),
        network: NETWORK,
        recipientPubkey: RECIPIENT_AB512,
      });
      const rustBytes = rustEscrowCanonical(
        v.assetType,
        v.assetIdHex,
        v.amount,
        v.claimantBase58,
        v.nonceHex,
        RECIPIENT_AB512_HEX,
      );
      assert.deepEqual(tsBytes, rustBytes);
    });
  }
});
