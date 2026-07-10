//! INDEPENDENT authoritative would-be-deposit derivation for the M1 gate.
//!
//! This is the reconciliation's whole point: it must NOT reuse the ledger
//! builder's code, so a bug in that reimplementation is caught. It re-derives
//! the exact set of on-chain deposits `batch-escrow.ts` (FROZEN mode) would make
//! by importing the AUTHORITATIVE, deployed-path modules straight out of the
//! solana-ar-io repo:
//!
//!   - normalize-address.ts     (normalizeSourceAddress / makeNormalizedAddressMap)
//!   - derive-ant-mint.ts       (deriveAntMintPubkey — web3.js Keypair.fromSeed)
//!   - planning/escrow-extract.ts (stake/withdrawal set + seeds)
//!   - planning/vault-plan.ts   (vaultEscrowFallsBackToLiquid + constants)
//!
//! The escrow asset_id (the money identifier) is ALSO authoritative: batch-escrow
//! now `export`s `deriveTokenAssetId` / `deriveVaultAssetId`, so this reconciler
//! IMPORTS and calls the real deployed functions rather than re-deriving the
//! seed formula. (An earlier substring source-guard passed on a superset change
//! `+ ':v2'` -> false PASS; importing the function closes that hole for good.)
//!
//! The only pieces of batch-escrow.ts that remain INLINE (no exported function,
//! not in a shared module) are: the stake asset_id's `sha256(<authoritative
//! seed>)` step, the vault expired check + ms->s lock formula, and the
//! stake operator-exit extension. Those are re-derived here BUT pinned to the
//! live `batch-escrow.ts` text via `assertSourceGuards`, using DELIMITER-BOUNDED
//! byte-exact snippets (each snippet includes its surrounding `const …;` /
//! `),` boundaries) so an append/superset — the exact class the tester exploited
//! — fails the match. Net: every money identifier and bug-prone predicate is the
//! authoritative code; only trivial arithmetic remains, and it is byte-pinned.
//!
//! Path override: SOLANA_AR_IO_IMPORT_SRC (default the standard checkout).

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_IMPORT_SRC =
  "/home/vilenarios/source/solana-ar-io/migration/import/src";

export type AssetType = "ant" | "token" | "vault";

export interface AuthoritativeDeposit {
  assetType: AssetType;
  assetKey: string; // ant-mint base58 | 64-hex asset_id
  amount: bigint | null; // null for ANTs
  recipientHex: string; // hex of the 512B modulus (AR) or 20B addr (ETH)
}

export interface AuthoritativeResult {
  /** keyed by assetKey (globally unique). Only DEPOSITED (resolvable) entries. */
  deposits: Map<string, AuthoritativeDeposit>;
  counters: { ant: number; tokenEscrowed: number; vaultEscrowed: number; stakeEscrowed: number };
  phase2TokenOutflowMario: bigint;
  onchainSeedCounts: { ant: number; token: number; vault: number };
  importSrc: string;
}

interface AuthoritativeModules {
  normalizeSourceAddress: (a: string) => string;
  isEthereumAddress: (a: string) => boolean;
  makeNormalizedAddressMap: <T>(raw: Record<string, T>) => Record<string, T>;
  deriveAntMintPubkey: (processId: string, secret: Buffer) => { toBase58(): string };
  deriveTokenAssetId: (address: string) => Uint8Array;
  deriveVaultAssetId: (address: string, vaultId: string) => Uint8Array;
  collectStakeWithdrawalEscrow: (artifact: unknown) => {
    vaults: { arweaveAddr: string; assetIdSeed: string; amountMario: bigint; unlockTs: number; kind: string }[];
    liquid: { arweaveAddr: string; assetIdSeed: string; amountMario: bigint; kind: string }[];
  };
  assertUniqueAssetSeeds: (set: unknown) => void;
  vaultEscrowFallsBackToLiquid: (amt: bigint, rem: bigint | number) => boolean;
  MIN_VAULT_SIZE_MARIO: bigint;
  MIN_VAULT_LOCK_SECONDS: number;
}

async function loadAuthoritativeModules(src: string): Promise<AuthoritativeModules> {
  const imp = async (rel: string): Promise<Record<string, unknown>> => {
    const p = resolve(src, rel);
    if (!existsSync(p)) {
      throw new Error(
        `authoritative module not found: ${p}\n` +
          `Set SOLANA_AR_IO_IMPORT_SRC to the solana-ar-io/migration/import/src path.`,
      );
    }
    return (await import(pathToFileURL(p).href)) as Record<string, unknown>;
  };
  const norm = await imp("normalize-address.ts");
  const dam = await imp("derive-ant-mint.ts");
  const ex = await imp("planning/escrow-extract.ts");
  const vp = await imp("planning/vault-plan.ts");
  // batch-escrow.ts exports deriveTokenAssetId/deriveVaultAssetId; importing it
  // does NOT run main() (its argv-guarded entrypoint sees a different argv[1]).
  const be = await imp("batch-escrow.ts");
  return {
    normalizeSourceAddress: norm.normalizeSourceAddress as AuthoritativeModules["normalizeSourceAddress"],
    isEthereumAddress: norm.isEthereumAddress as AuthoritativeModules["isEthereumAddress"],
    makeNormalizedAddressMap: norm.makeNormalizedAddressMap as AuthoritativeModules["makeNormalizedAddressMap"],
    deriveAntMintPubkey: dam.deriveAntMintPubkey as AuthoritativeModules["deriveAntMintPubkey"],
    deriveTokenAssetId: be.deriveTokenAssetId as AuthoritativeModules["deriveTokenAssetId"],
    deriveVaultAssetId: be.deriveVaultAssetId as AuthoritativeModules["deriveVaultAssetId"],
    collectStakeWithdrawalEscrow: ex.collectStakeWithdrawalEscrow as AuthoritativeModules["collectStakeWithdrawalEscrow"],
    assertUniqueAssetSeeds: ex.assertUniqueAssetSeeds as AuthoritativeModules["assertUniqueAssetSeeds"],
    vaultEscrowFallsBackToLiquid: vp.vaultEscrowFallsBackToLiquid as AuthoritativeModules["vaultEscrowFallsBackToLiquid"],
    MIN_VAULT_SIZE_MARIO: vp.MIN_VAULT_SIZE_MARIO as bigint,
    MIN_VAULT_LOCK_SECONDS: vp.MIN_VAULT_LOCK_SECONDS as number,
  };
}

/**
 * Byte-pin the INLINE bits of batch-escrow.ts that this reconciler re-derives
 * (the ones with no exported function / shared module). Each snippet below is a
 * VERBATIM slice of the deployed source INCLUDING its bounding delimiters
 * (`const … ;`, a trailing `),`, the full multi-line block, …). Because the
 * boundary is part of the match, an append/superset — e.g. changing
 * `…/ 1000),` to `…/ 1000) + 1,` — shifts the delimiter and FAILS the check.
 * This closes the class the tester exploited (a bare-substring guard passed on a
 * `+ ':v2'` append). The asset_id money identifiers themselves are no longer
 * pinned here at all — they are imported and called (deriveTokenAssetId /
 * deriveVaultAssetId), which is strictly stronger.
 */
export function assertSourceGuards(src: string): { aoProcessId: string } {
  const path = resolve(src, "batch-escrow.ts");
  if (!existsSync(path)) {
    throw new Error(`batch-escrow.ts not found at ${path} for source-guarding`);
  }
  const text = readFileSync(path, "utf-8");
  const guards: [string, string][] = [
    // Phase 3 vault routing (asset_type only; asset_id + amount are authoritative).
    ["vault expired check", "const isExpired = vault.endTimestamp <= nowMs;"],
    ["vault ms->s lock", "Math.ceil((vault.endTimestamp - nowMs) / 1000),"],
    // Phase 4 stake: asset_id = sha256(<authoritative escrow-extract seed>).
    // The seed content is authoritative (collectStakeWithdrawalEscrow); only the
    // sha256-of-seed step is inline, pinned here with its `const … ;` bounds.
    ["stake vault sha256", "const assetId = createHash('sha256').update(v.assetIdSeed).digest();"],
    ["stake liquid sha256", "const assetId = createHash('sha256').update(l.assetIdSeed).digest();"],
    // Phase 4 stake lock + operator-exit extension (asset_type only).
    ["stake base lock", "let lockDuration = BigInt(v.unlockTs - sendTs);"],
    [
      "operator-exit condition",
      "const isLockedOperatorExit =\n" +
        "        v.kind.startsWith('withdrawal:operator-exit:') &&\n" +
        "        v.amountMario >= MIN_VAULT_SIZE_MARIO &&\n" +
        "        lockDuration > 0n;",
    ],
    [
      "operator-exit extension",
      "if (isLockedOperatorExit && lockDuration < BigInt(MIN_VAULT_LOCK_SECONDS)) {",
    ],
    ["operator-exit extend value", "lockDuration = BigInt(MIN_VAULT_LOCK_SECONDS);"],
  ];
  for (const [name, needle] of guards) {
    if (!text.includes(needle)) {
      throw new Error(
        `source-guard FAILED: batch-escrow.ts no longer contains the byte-exact ${name} ` +
          `snippet. The deployed inline derivation drifted — update the reconciler and ` +
          `re-review before trusting the ledger.`,
      );
    }
  }
  // AO self-balance exclusion default id — extracted (fail-closed) from source.
  const m = text.match(/process\.env\.AO_PROCESS_ID \|\| '([0-9A-Za-z_-]{43})'/);
  if (!m) {
    throw new Error("source-guard FAILED: could not extract AO_PROCESS_ID default");
  }
  return { aoProcessId: process.env.AO_PROCESS_ID || m[1] };
}

const sha256Hex = (s: string): string =>
  createHash("sha256").update(s, "utf8").digest("hex");
const bytesHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

interface AoVault {
  balance: number;
  endTimestamp: number;
}

export async function deriveAuthoritativeDeposits(opts: {
  frozenDir: string;
  antMintSecret: Buffer;
  nowMs: number;
  importSrc?: string;
}): Promise<AuthoritativeResult> {
  const src = opts.importSrc ?? process.env.SOLANA_AR_IO_IMPORT_SRC ?? DEFAULT_IMPORT_SRC;
  const M = await loadAuthoritativeModules(src);
  const { aoProcessId } = assertSourceGuards(src);
  const nowMs = opts.nowMs;
  const nowS = Math.floor(nowMs / 1000);

  const dir = opts.frozenDir;
  const readJson = <T>(name: string): T =>
    JSON.parse(readFileSync(join(dir, name), "utf-8")) as T;

  const addressMap = M.makeNormalizedAddressMap(
    readJson<Record<string, string>>("address-map.json"),
  );
  const modulus = readJson<Record<string, string>>("escrow-recipient-modulus.json");
  const atRisk = new Set(readJson<string[]>("escrow-recipient-AT-RISK.json"));

  // Frozen-mode recipient resolution (authoritative normalize for ETH).
  const resolve_ = (owner: string): Uint8Array | null => {
    if (M.isEthereumAddress(owner)) {
      return new Uint8Array(Buffer.from(M.normalizeSourceAddress(owner).slice(2), "hex"));
    }
    const b64 = modulus[owner];
    if (b64) {
      const bytes = new Uint8Array(Buffer.from(b64, "base64url"));
      if (bytes.length !== 512) throw new Error(`bad modulus length for ${owner}`);
      return bytes;
    }
    return null;
  };

  const deposits = new Map<string, AuthoritativeDeposit>();
  const counters = { ant: 0, tokenEscrowed: 0, vaultEscrowed: 0, stakeEscrowed: 0 };
  const onchainSeedCounts = { ant: 0, token: 0, vault: 0 };
  let phase2 = 0n;

  const add = (
    d: AuthoritativeDeposit,
    seed: "ant" | "token" | "vault",
  ): void => {
    if (deposits.has(d.assetKey)) {
      throw new Error(`authoritative: duplicate assetKey ${d.assetKey}`);
    }
    deposits.set(d.assetKey, d);
    onchainSeedCounts[seed]++;
  };

  // Only DEPOSITED (resolvable) owners produce a deposit; AT-RISK are skipped
  // by batch-escrow, exactly as here.
  const depositedRecipient = (owner: string): Uint8Array | null => {
    const pub = resolve_(owner);
    if (pub) return pub;
    if (!atRisk.has(owner)) {
      throw new Error(`authoritative: unresolvable owner ${JSON.stringify(owner)} not AT-RISK`);
    }
    return null;
  };

  // Phase 1: ANTs.
  const antsDir = join(dir, "ants");
  for (const f of readdirSync(antsDir)) {
    if (!f.endsWith(".json") || f === "ant-mint-map.json" || f === "failed-ants.json") continue;
    const a = JSON.parse(readFileSync(join(antsDir, f), "utf-8")) as {
      processId: string;
      Owner: string;
    };
    if (addressMap[a.Owner]) continue;
    const pub = depositedRecipient(a.Owner);
    if (!pub) continue;
    const antMint = M.deriveAntMintPubkey(a.processId, opts.antMintSecret).toBase58();
    add({ assetType: "ant", assetKey: antMint, amount: null, recipientHex: bytesHex(pub) }, "ant");
    counters.ant++;
  }

  // Phase 2: token balances (from snapshot-summary; AO self-balance excluded).
  const summary = readJson<Record<string, { balance: number }>>("snapshot-summary.json");
  const balances: Record<string, number> = {};
  for (const [addr, e] of Object.entries(summary)) if (e && e.balance > 0) balances[addr] = e.balance;
  if (aoProcessId in balances) delete balances[aoProcessId];
  for (const [addr, amount] of Object.entries(balances)) {
    if (addressMap[addr] || amount <= 0) continue;
    const pub = depositedRecipient(addr);
    if (!pub) continue;
    const assetKey = bytesHex(M.deriveTokenAssetId(addr)); // authoritative import
    const amt = BigInt(amount);
    add({ assetType: "token", assetKey, amount: amt, recipientHex: bytesHex(pub) }, "token");
    counters.tokenEscrowed++;
    phase2 += amt;
  }

  // Phase 3: personal vaults.
  const vaults = readJson<Record<string, Record<string, AoVault>>>("raw-vaults.json");
  for (const [owner, ownerVaults] of Object.entries(vaults)) {
    if (addressMap[owner]) continue;
    for (const [vaultId, v] of Object.entries(ownerVaults)) {
      const amount = BigInt(v.balance);
      if (amount <= 0n) continue;
      const pub = depositedRecipient(owner);
      if (!pub) continue;
      const assetKey = bytesHex(M.deriveVaultAssetId(owner, vaultId)); // authoritative import
      const recipientHex = bytesHex(pub);
      if (v.endTimestamp <= nowMs) {
        add({ assetType: "token", assetKey, amount, recipientHex }, "token");
        counters.tokenEscrowed++;
        continue;
      }
      const lock = BigInt(Math.ceil((v.endTimestamp - nowMs) / 1000));
      if (M.vaultEscrowFallsBackToLiquid(amount, lock)) {
        add({ assetType: "token", assetKey, amount, recipientHex }, "token");
      } else {
        add({ assetType: "vault", assetKey, amount, recipientHex }, "vault");
      }
      counters.vaultEscrowed++;
    }
  }

  // Phase 4: stake + withdrawal escrow.
  const plan = readJson("delivery-escrow-plan.json");
  const set = M.collectStakeWithdrawalEscrow(plan);
  M.assertUniqueAssetSeeds(set);
  for (const v of set.vaults) {
    const pub = depositedRecipient(v.arweaveAddr);
    if (!pub) continue;
    const assetKey = sha256Hex(v.assetIdSeed);
    const recipientHex = bytesHex(pub);
    let lock = BigInt(v.unlockTs - nowS);
    const isLockedOpExit =
      v.kind.startsWith("withdrawal:operator-exit:") &&
      v.amountMario >= M.MIN_VAULT_SIZE_MARIO &&
      lock > 0n;
    if (isLockedOpExit && lock < BigInt(M.MIN_VAULT_LOCK_SECONDS)) {
      lock = BigInt(M.MIN_VAULT_LOCK_SECONDS);
    }
    if (M.vaultEscrowFallsBackToLiquid(v.amountMario, lock)) {
      add({ assetType: "token", assetKey, amount: v.amountMario, recipientHex }, "token");
    } else {
      add({ assetType: "vault", assetKey, amount: v.amountMario, recipientHex }, "vault");
    }
    counters.stakeEscrowed++;
  }
  for (const l of set.liquid) {
    const pub = depositedRecipient(l.arweaveAddr);
    if (!pub) continue;
    add(
      {
        assetType: "token",
        assetKey: sha256Hex(l.assetIdSeed),
        amount: l.amountMario,
        recipientHex: bytesHex(pub),
      },
      "token",
    );
    counters.stakeEscrowed++;
  }

  return { deposits, counters, phase2TokenOutflowMario: phase2, onchainSeedCounts, importSrc: src };
}
