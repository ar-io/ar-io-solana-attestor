//! Operator tool: publish the signed ledger commitment (M6, §6.5.1).
//!
//! Reads the persisted M1 ledger, builds the canonical leaf set + Merkle root,
//! signs the manifest with the LEDGER-PUBLISHER key, persists an immutable
//! snapshot to `published_ledger`, and writes the third-party-verifiable artifact
//! JSON to disk (upload it to Arweave/IPFS/etc. for permanence).
//!
//! Usage:
//!   LEDGER_PUBLISHER_SEED_BASE64=... DATABASE_URL=... NETWORK=solana-mainnet \
//!     tsx src/cli/publish-ledger.ts --out ledger-artifact.json [--version 2026-07-10]
//!   (or LEDGER_PUBLISHER_KEY_SEALED_PATH + LEDGER_PUBLISHER_KEY_PASSPHRASE)
//!
//! Optional LEDGER_FINGERPRINTS_PATH: a JSON map of frozen-input sha256s to embed
//! in the manifest for provenance.

import { readFileSync, writeFileSync } from "node:fs";

import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { loadTransparencyKeypair } from "../transparency/keys.js";
import { buildLeavesFromDb, persistPublishedLedger } from "../transparency/store.js";
import { buildLedgerArtifact, verifyLedgerArtifact } from "../transparency/ledger-artifact.js";
import { toHex } from "../transparency/merkle.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

  const publisher = loadTransparencyKeypair("publisher");
  if (!publisher) {
    throw new Error(
      "no publisher key: set LEDGER_PUBLISHER_SEED_BASE64, or LEDGER_PUBLISHER_KEY_SEALED_PATH + LEDGER_PUBLISHER_KEY_PASSPHRASE",
    );
  }

  const out = arg("--out") ?? `ledger-artifact.${new Date().toISOString().slice(0, 10)}.json`;
  const ledgerVersion = arg("--version") ?? process.env.LEDGER_VERSION ?? new Date().toISOString();

  let inputFingerprints: Record<string, string> = {};
  const fpPath = process.env.LEDGER_FINGERPRINTS_PATH;
  if (fpPath) inputFingerprints = JSON.parse(readFileSync(fpPath, "utf8")) as Record<string, string>;

  const db = createDb(config.databaseUrl);
  try {
    const leaves = await buildLeavesFromDb(db.pool);
    if (leaves.length === 0) throw new Error("ledger is empty — build it first (yarn build:ledger)");

    const artifact = buildLedgerArtifact({
      leaves,
      network: config.network,
      ledgerVersion,
      inputFingerprints,
      publisher,
    });

    // Self-verify before persisting (never publish an artifact we can't verify).
    const check = verifyLedgerArtifact(artifact, toHex(publisher.publicKey));
    if (!check.ok) throw new Error(`self-verification failed: ${check.issues.join("; ")}`);

    const id = await persistPublishedLedger(db.pool, artifact);
    writeFileSync(out, JSON.stringify(artifact, null, 2) + "\n");

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          ok: true,
          publishedLedgerId: id,
          ledgerVersion,
          network: config.network,
          entryCount: artifact.manifest.entryCount,
          availableCount: artifact.manifest.availableCount,
          manualReviewCount: artifact.manifest.manualReviewCount,
          totalClaimableMario: artifact.manifest.totalClaimableMario,
          rootHex: artifact.manifest.rootHex,
          publisherPubkeyHex: artifact.publisherPubkeyHex,
          artifactFile: out,
        },
        null,
        2,
      ),
    );
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("publish-ledger failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
