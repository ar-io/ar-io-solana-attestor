//! Extra adversarial edges (tester/UAT — M2). Targets boundaries the dev's
//! suites do not pin exactly against the contract:
//!   - the EIP-2 low-S n/2 boundary (n/2 accepted-past-low-S vs n/2+1 rejected)
//!   - full v-normalization edges beyond v=5 (2, 3, 26, 29, 255)
//!   - s >= n treated as high-S (guard fires before recover)
//!   - a contract-signed proof replayed cross-asset / cross-amount is rejected
//!   - the amount == MIN_VAULT_SIZE vault boundary (must RE-LOCK, not liquid)
//!
//! Base signatures are CONTRACT-produced (ethereum.contract.golden.json).

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { deriveRecipientIdB64Url } from "@ar.io/attestor-canonical";

import { verifyEthereumProof } from "./ethereum.js";
import { computeVaultSettlement } from "./vault-settlement.js";
import { VerificationError } from "./errors.js";
import { MIN_VAULT_SIZE_MARIO, MIN_VAULT_LOCK_SECONDS } from "../ledger/vault-rules.js";
import type { AssetView, RecipientView } from "./types.js";

interface Vector {
  name: string;
  shape: "ant" | "token" | "vault";
  addrHex: string;
  claimantBase58: string;
  nonceHex: string;
  antMintBase58: string | null;
  assetType: "token" | "vault" | null;
  assetIdHex: string | null;
  amount: string | null;
  canonicalHex: string;
  validSigHex: string;
}
const G = JSON.parse(
  readFileSync(resolve(import.meta.dirname ?? ".", "ethereum.contract.golden.json"), "utf8"),
) as { network: string; vectors: Vector[] };
const NETWORK = G.network;

// secp256k1 order n and n/2 (from verify/ethereum.rs SECP256K1_N / _N_HALF).
const SECP256K1_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_N_HALF =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

function decodeHex(s: string): Uint8Array {
  const h = s.replace(/^0x/, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bigToBe32(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}
const TOKEN = G.vectors.find((v) => v.shape === "token")!;
const VAULT = G.vectors.find((v) => v.shape === "vault")!;

function recipientOf(v: Vector): RecipientView {
  const addr = decodeHex(v.addrHex);
  return {
    protocol: 1,
    recipientPubkey: addr,
    recipientId: deriveRecipientIdB64Url(addr),
    sourceAddress: "0x" + v.addrHex,
  };
}
function assetOf(v: Vector): AssetView {
  return {
    assetType: v.assetType!,
    assetKey: v.assetIdHex!,
    antMint: null,
    amount: BigInt(v.amount!),
    nonce: decodeHex(v.nonceHex),
    vaultEndTs: v.shape === "vault" ? 9_999_999_999 : null,
  };
}
/** Build a 65-byte sig with a chosen s and v, reusing a real contract r. */
function sigWithS(baseSigHex: string, s: bigint, v: number): Uint8Array {
  const out = new Uint8Array(decodeHex(baseSigHex)); // copy r||s||v
  out.set(bigToBe32(s), 32);
  out[64] = v;
  return out;
}
function runToken(sig: Uint8Array) {
  return verifyEthereumProof({
    recipient: recipientOf(TOKEN),
    asset: assetOf(TOKEN),
    proof: { claimant: TOKEN.claimantBase58, signature: sig },
    network: NETWORK,
  });
}
function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof VerificationError) return e.code;
    return `NON_VERIFICATION_ERROR:${(e as Error).message}`;
  }
  return "NO_THROW";
}

// ---------------------------------------------------------------------------
// EIP-2 low-S boundary — must match the contract's SECP256K1_N_HALF exactly.
// ---------------------------------------------------------------------------

describe("ETH low-S boundary at n/2 (contract SECP256K1_N_HALF)", () => {
  it("s == n/2 is NOT high-S (passes low-S; fails later at address, not ECDSA_HIGH_S)", () => {
    // r is a real contract r so fromCompact/recover succeed; s == n/2 exactly.
    const code = codeOf(() => runToken(sigWithS(TOKEN.validSigHex, SECP256K1_N_HALF, 0)));
    assert.notEqual(code, "ECDSA_HIGH_S");
    assert.notEqual(code, "NO_THROW"); // arbitrary s still fails address compare
  });

  it("s == n/2 + 1 IS high-S -> ECDSA_HIGH_S", () => {
    const code = codeOf(() => runToken(sigWithS(TOKEN.validSigHex, SECP256K1_N_HALF + 1n, 0)));
    assert.equal(code, "ECDSA_HIGH_S");
  });

  it("s == n-1 -> ECDSA_HIGH_S", () => {
    assert.equal(codeOf(() => runToken(sigWithS(TOKEN.validSigHex, SECP256K1_N - 1n, 0))), "ECDSA_HIGH_S");
  });

  it("s == n (>= n) -> ECDSA_HIGH_S (low-S guard fires before recover)", () => {
    assert.equal(codeOf(() => runToken(sigWithS(TOKEN.validSigHex, SECP256K1_N, 0))), "ECDSA_HIGH_S");
  });

  it("s == 0 (low, but unrecoverable) -> SIGNATURE_VERIFICATION_FAILED", () => {
    assert.equal(codeOf(() => runToken(sigWithS(TOKEN.validSigHex, 0n, 0))), "SIGNATURE_VERIFICATION_FAILED");
  });
});

// ---------------------------------------------------------------------------
// v-normalization — only {0,1,27,28} accepted; everything else rejected.
// ---------------------------------------------------------------------------

describe("ETH recovery-id normalization edges", () => {
  for (const v of [2, 3, 4, 26, 29, 30, 255]) {
    it(`v=${v} -> INVALID_RECOVERY_ID`, () => {
      const sig = new Uint8Array(decodeHex(TOKEN.validSigHex));
      sig[64] = v;
      assert.equal(codeOf(() => runToken(sig)), "INVALID_RECOVERY_ID");
    });
  }
});

// ---------------------------------------------------------------------------
// Cross-asset / cross-amount replay of a CONTRACT-signed proof.
// ---------------------------------------------------------------------------

describe("ETH proof cannot be replayed across assets (canonical binding)", () => {
  it("token sig presented against the vault asset -> rejected", () => {
    // Keep the token recipient (addr), swap the asset to the vault asset: the
    // rebuilt canonical differs (type/asset/amount) so the recovered address
    // no longer matches the stored token address.
    const code = codeOf(() =>
      verifyEthereumProof({
        recipient: recipientOf(TOKEN),
        asset: assetOf(VAULT),
        proof: { claimant: TOKEN.claimantBase58, signature: decodeHex(TOKEN.validSigHex) },
        network: NETWORK,
      }),
    );
    assert.equal(code, "ETHEREUM_ADDRESS_MISMATCH");
  });

  it("token sig with amount bumped +1 -> rejected", () => {
    const asset = assetOf(TOKEN);
    asset.amount = BigInt(TOKEN.amount!) + 1n;
    const code = codeOf(() =>
      verifyEthereumProof({
        recipient: recipientOf(TOKEN),
        asset,
        proof: { claimant: TOKEN.claimantBase58, signature: decodeHex(TOKEN.validSigHex) },
        network: NETWORK,
      }),
    );
    assert.equal(code, "ETHEREUM_ADDRESS_MISMATCH");
  });

  it("token sig verified under a different network string -> rejected", () => {
    const code = codeOf(() =>
      verifyEthereumProof({
        recipient: recipientOf(TOKEN),
        asset: assetOf(TOKEN),
        proof: { claimant: TOKEN.claimantBase58, signature: decodeHex(TOKEN.validSigHex) },
        network: "solana-devnet",
      }),
    );
    assert.equal(code, "ETHEREUM_ADDRESS_MISMATCH");
  });
});

// ---------------------------------------------------------------------------
// Vault settlement: the amount == MIN_VAULT_SIZE boundary (contract create_vault
// / vaulted_transfer use `amount >= MIN_VAULT_SIZE`, so == is claimable → relock).
// ---------------------------------------------------------------------------

describe("vault settlement amount boundary (>= MIN_VAULT_SIZE)", () => {
  const MIN = BigInt(MIN_VAULT_LOCK_SECONDS);
  const MAX = BigInt(200 * 365 * 86_400);
  const NOW = 1_783_641_600n;

  it("amount == MIN_VAULT_SIZE with healthy duration -> RE-LOCK (not liquid)", () => {
    const s = computeVaultSettlement({
      vaultEndTs: NOW + MIN + 1000n,
      amount: MIN_VAULT_SIZE_MARIO,
      minVaultDuration: MIN,
      maxVaultDuration: MAX,
      now: NOW,
    });
    assert.equal(s.kind, "relock");
  });

  it("amount == MIN_VAULT_SIZE - 1 -> liquid (below_min_amount)", () => {
    const s = computeVaultSettlement({
      vaultEndTs: NOW + MIN + 1000n,
      amount: MIN_VAULT_SIZE_MARIO - 1n,
      minVaultDuration: MIN,
      maxVaultDuration: MAX,
      now: NOW,
    });
    assert.equal(s.kind === "liquid" && s.reason, "below_min_amount");
  });

  it("remaining == min_vault_duration AND amount == MIN_VAULT_SIZE -> RE-LOCK (both boundaries)", () => {
    const s = computeVaultSettlement({
      vaultEndTs: NOW + MIN,
      amount: MIN_VAULT_SIZE_MARIO,
      minVaultDuration: MIN,
      maxVaultDuration: MAX,
      now: NOW,
    });
    assert.equal(s.kind, "relock");
    if (s.kind === "relock") assert.equal(s.lockDurationSeconds, MIN);
  });
});
