/**
 * Cross-language canonical-message parity for the attestor.
 *
 * The canonical claim format is byte-pinned to the on-chain Rust
 * (`ario-ant-escrow`); any drift silently makes every attestation fail to
 * verify on-chain, so this parity check is a stated non-negotiable and is
 * load-bearing for the claims service (M2) too.
 *
 * TWO layers, so parity is FAIL-CLOSED in CI (which ships no Rust
 * toolchain) yet still catches contract-side drift where the toolchain
 * exists:
 *
 *   1. Golden-vector parity — ALWAYS runs, no cargo needed. The TS
 *      builders must reproduce `canonical.cross.golden.json` byte-for-byte.
 *      Those vectors were generated from the on-chain Rust `canonical`
 *      example and pin the FROZEN, deployed-contract format. A TS drift
 *      from that format hard-fails here on every CI run. This is the
 *      guarantee that replaces the old, vacuous `if (!cargo) return;`
 *      (which reported "pass" while checking nothing).
 *
 *   2. Live-Rust drift check — re-derives each vector from a freshly built
 *      Rust binary and asserts it still equals the golden bytes, catching
 *      an intentional/accidental contract-side canonical change the frozen
 *      file wouldn't otherwise see. It runs when cargo + the contracts repo
 *      are present; otherwise each case is a VISIBLE `skip` — UNLESS
 *      `REQUIRE_RUST_PARITY=1`, which turns a missing toolchain/repo (or a
 *      failed build) into a HARD FAIL. Release/verification jobs flip that
 *      switch to force real cross-language checking.
 *
 * Regenerate the golden file when the contract canonical format changes on
 * purpose (see SPEC.md for the command).
 */

import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { before, describe, it, type TestContext } from 'node:test';
import bs58 from 'bs58';

import { buildAntEscrowClaimMessage, buildEscrowClaimMessage } from './canonical.js';

// ---------------------------------------------------------------------------
// Golden vectors (frozen deployed-contract format). Read via fs so tsc never
// tries to emit the JSON and there's no ESM import-assertion ceremony.
// ---------------------------------------------------------------------------

interface AntVector {
  name: string;
  antMintBase58: string;
  claimantBase58: string;
  nonceHex: string;
  canonicalHex: string;
}
interface EscrowVector {
  name: string;
  assetType: 'token' | 'vault';
  assetIdHex: string;
  amount: string;
  claimantBase58: string;
  nonceHex: string;
  canonicalHex: string;
}
interface Golden {
  network: string;
  recipientPubkeyHex: string;
  ant: AntVector[];
  escrow: EscrowVector[];
}

const GOLDEN: Golden = JSON.parse(
  readFileSync(resolve(import.meta.dirname ?? '.', 'canonical.cross.golden.json'), 'utf8'),
) as Golden;

const NETWORK = GOLDEN.network;
const RECIPIENT_HEX = GOLDEN.recipientPubkeyHex;
const RECIPIENT = decodeHex(RECIPIENT_HEX);

function decodeHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function tsAntHex(v: AntVector): string {
  return toHex(
    buildAntEscrowClaimMessage({
      antMint: bs58.decode(v.antMintBase58),
      claimant: bs58.decode(v.claimantBase58),
      nonce: decodeHex(v.nonceHex),
      network: NETWORK,
      recipientPubkey: RECIPIENT,
    }),
  );
}
function tsEscrowHex(v: EscrowVector): string {
  return toHex(
    buildEscrowClaimMessage({
      assetType: v.assetType,
      assetId: decodeHex(v.assetIdHex),
      amount: BigInt(v.amount),
      claimant: bs58.decode(v.claimantBase58),
      nonce: decodeHex(v.nonceHex),
      network: NETWORK,
      recipientPubkey: RECIPIENT,
    }),
  );
}

// ---------------------------------------------------------------------------
// Layer 1: TS builders vs committed golden vectors. ALWAYS runs (CI gate).
// ---------------------------------------------------------------------------

describe('TS canonical == committed golden vectors (frozen contract format)', () => {
  it('has vectors to check (guards against an empty/corrupt golden file)', () => {
    assert.ok(GOLDEN.ant.length >= 3, 'expected >=3 ANT golden vectors');
    assert.ok(GOLDEN.escrow.length >= 3, 'expected >=3 escrow golden vectors');
    assert.equal(RECIPIENT.length, 512, 'recipient modulus must be 512 bytes');
  });

  for (const v of GOLDEN.ant) {
    it(`ANT byte-equals golden for: ${v.name}`, () => {
      assert.equal(tsAntHex(v), v.canonicalHex);
    });
  }

  for (const v of GOLDEN.escrow) {
    it(`escrow byte-equals golden for: ${v.name}`, () => {
      assert.equal(tsEscrowHex(v), v.canonicalHex);
    });
  }
});

// ---------------------------------------------------------------------------
// Layer 2: live Rust vs golden (drift detector). Fail-closed under
// REQUIRE_RUST_PARITY=1; visible skip otherwise when the toolchain/repo is
// absent.
// ---------------------------------------------------------------------------

const REQUIRE_RUST = process.env.REQUIRE_RUST_PARITY === '1';

/**
 * Locate the ar-io-solana-contracts repo. When `CONTRACTS_REPO_DIR` is set
 * it is the ONLY candidate (explicit wins; no silent sibling fallback, so a
 * bad override is detectable). Otherwise probe the sibling clone
 * `<repo-root>/../ar-io-solana-contracts` — this file sits at
 * `packages/canonical/src/`, hence three `..` hops to the repo root.
 */
function findContractsDir(): string | null {
  const envOverride = process.env.CONTRACTS_REPO_DIR;
  const candidates = envOverride
    ? [envOverride]
    : [resolve(import.meta.dirname ?? '.', '..', '..', '..', '..', 'ar-io-solana-contracts')];
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

/** Set true in before() once a runnable Rust binary is confirmed/built. */
let rustReady = false;

function rustAntHex(v: AntVector): string {
  const out = execFileSync(
    RUST_BIN,
    [v.antMintBase58, v.claimantBase58, v.nonceHex, RECIPIENT_HEX],
    { encoding: 'buffer' },
  );
  return toHex(new Uint8Array(out));
}
function rustEscrowHex(v: EscrowVector): string {
  const out = execFileSync(
    RUST_BIN,
    ['--escrow', v.assetType, v.assetIdHex, v.amount, v.claimantBase58, v.nonceHex, RECIPIENT_HEX],
    { encoding: 'buffer' },
  );
  return toHex(new Uint8Array(out));
}

describe('live Rust == committed golden vectors (contract-drift detector)', () => {
  before(() => {
    if (!CONTRACTS_DIR) {
      if (REQUIRE_RUST) {
        throw new Error(
          'REQUIRE_RUST_PARITY=1 but the ar-io-solana-contracts repo was not found. ' +
            'Provide it (sibling clone or CONTRACTS_REPO_DIR=<path>) so live-Rust parity ' +
            'can be verified — this is a hard failure by design, not a skip.',
        );
      }
      return; // dev box without the contracts repo: cases skip visibly.
    }
    if (existsSync(RUST_BIN)) {
      rustReady = true;
      return;
    }
    const probe = spawnSync('cargo', ['--version'], { stdio: 'ignore' });
    if (probe.error || probe.status !== 0) {
      if (REQUIRE_RUST) {
        throw new Error(
          'REQUIRE_RUST_PARITY=1 but cargo is not on PATH; cannot build the Rust ' +
            'canonical example to verify live parity. Install the Rust toolchain.',
        );
      }
      return; // no cargo: cases skip visibly.
    }
    const build = spawnSync(
      'cargo',
      ['build', '--example', 'canonical', '-p', 'ario-ant-escrow'],
      { cwd: CONTRACTS_DIR, stdio: 'inherit' },
    );
    if (build.error || build.status !== 0 || !existsSync(RUST_BIN)) {
      // A present-but-broken toolchain is ALWAYS a hard failure (matches
      // the original behavior) — a build we started but couldn't finish is
      // a real problem, not a "toolchain absent" graceful path.
      throw new Error(
        `Failed to build the Rust canonical example for attestor <-> Rust parity.\n` +
          `Manual build:\n` +
          `  cd ${CONTRACTS_DIR} && cargo build --example canonical -p ario-ant-escrow`,
      );
    }
    rustReady = true;
  });

  for (const v of GOLDEN.ant) {
    it(`ANT: live Rust matches golden for: ${v.name}`, (t: TestContext) => {
      if (!rustReady) {
        t.skip('Rust toolchain/contracts repo not available (set REQUIRE_RUST_PARITY=1 to enforce)');
        return;
      }
      assert.equal(rustAntHex(v), v.canonicalHex);
    });
  }

  for (const v of GOLDEN.escrow) {
    it(`escrow: live Rust matches golden for: ${v.name}`, (t: TestContext) => {
      if (!rustReady) {
        t.skip('Rust toolchain/contracts repo not available (set REQUIRE_RUST_PARITY=1 to enforce)');
        return;
      }
      assert.equal(rustEscrowHex(v), v.canonicalHex);
    });
  }
});
