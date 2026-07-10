//! Operator tool: anchor the audit-log head on-chain (M6, §6.5.2).
//!
//! Steps (idempotent, safe to run on the configured cadence — e.g. daily cron):
//!   1. back-fill any placeholder audit_log.signature with the AUDIT key.
//!   2. verify the FULL hash chain (+ audit signatures) — refuse to anchor a
//!      broken chain.
//!   3. post the current chain HEAD (seq + entry_hash) as a Solana Memo tx signed
//!      by the PUBLISHER/anchor key, and record the tx in `audit_anchors`.
//!   Optional --ledger-root: also anchor the latest published ledger root.
//!
//! Usage:
//!   AUDIT_SEED_BASE64=... LEDGER_PUBLISHER_SEED_BASE64=... \
//!   DATABASE_URL=... NETWORK=solana-devnet SOLANA_RPC_URL=https://api.devnet.solana.com \
//!     tsx src/cli/anchor-audit-log.ts [--ledger-root] [--dry-run]
//!
//! Anchor cadence + target are configurable (ANCHOR_TARGET, ANCHOR_MEMO_PROGRAM,
//! cron interval). Arweave data-item anchoring is a documented extension (the
//! plan's "and/or"); this ships the Solana-memo path, proven on devnet/testnet.

import { loadConfig } from "../config.js";
import { createDb } from "../db.js";
import { loadTransparencyKeypair, assertTransparencyKeysSeparable, assertTransparencyKeysDistinct, loadReservedAddresses } from "../transparency/keys.js";
import { loadTransparencyConfig } from "../transparency/config.js";
import {
  getAuditHead,
  loadAuditRows,
  signUnsignedAuditRows,
  verifyAuditChain,
} from "../transparency/audit-chain.js";
import { anchorMemoWithRpc, auditHeadMemo, ledgerRootMemo } from "../transparency/anchor.js";
import { getLatestPublishedLedger, recordAnchor } from "../transparency/store.js";
import { createRpc } from "../solana.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const tconfig = loadTransparencyConfig();
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const dryRun = process.argv.includes("--dry-run");
  const alsoLedgerRoot = process.argv.includes("--ledger-root");

  const audit = loadTransparencyKeypair("audit");
  if (!audit) throw new Error("no audit key: set AUDIT_SEED_BASE64 (or AUDIT_KEY_SEALED_PATH + AUDIT_KEY_PASSPHRASE)");
  const publisher = loadTransparencyKeypair("publisher");
  if (!publisher && !dryRun) {
    throw new Error("no publisher/anchor key: set LEDGER_PUBLISHER_SEED_BASE64 (or the sealed pair)");
  }
  const reserved = loadReservedAddresses();
  if (publisher) {
    assertTransparencyKeysSeparable(audit, publisher);
    assertTransparencyKeysDistinct([audit, publisher], reserved);
  } else {
    assertTransparencyKeysDistinct([audit], reserved);
  }

  const db = createDb(config.databaseUrl);
  try {
    // 1. Sign any placeholder rows.
    const signed = await signUnsignedAuditRows(db.pool, audit);

    // 2. Verify the full chain before anchoring anything.
    const rows = await loadAuditRows(db.pool, {});
    const chain = verifyAuditChain(rows, audit.publicKey);
    if (!chain.ok) {
      throw new Error(`refusing to anchor: audit chain invalid at seq ${chain.firstBadSeq}: ${chain.issues.join("; ")}`);
    }
    const head = await getAuditHead(db.pool);
    if (!head) throw new Error("audit log is empty — nothing to anchor");

    const results: Record<string, unknown> = {
      signedRows: signed,
      chain: { ok: chain.ok, count: chain.count, signedCount: chain.signedCount, signatureValidCount: chain.signatureValidCount },
      head,
      anchorTarget: tconfig.anchorTarget,
    };

    if (dryRun || tconfig.anchorTarget === "none") {
      results.anchored = false;
      results.reason = dryRun ? "dry-run" : "ANCHOR_TARGET=none";
    } else if (tconfig.anchorTarget === "solana-memo") {
      const rpc = createRpc(config.solanaRpcUrl);
      const memo = auditHeadMemo(head.seq, head.entryHashHex, config.network);
      const anchor = await anchorMemoWithRpc({
        rpc,
        seed: publisher!.secretKey,
        memoText: memo,
        memoProgram: tconfig.anchorMemoProgram,
      });
      const id = await recordAnchor(db.pool, {
        kind: "audit-head",
        anchoredRef: head.seq,
        headHashHex: head.entryHashHex,
        target: "solana-memo",
        network: config.network,
        txid: anchor.signature,
        slot: null,
        memo,
        confirmed: anchor.confirmed,
      });
      results.anchored = true;
      results.auditAnchor = { id, signature: anchor.signature, confirmed: anchor.confirmed, memo };

      if (alsoLedgerRoot) {
        const latest = await getLatestPublishedLedger(db.pool);
        if (latest) {
          const rMemo = ledgerRootMemo(latest.ledgerVersion, latest.rootHex, config.network);
          const rAnchor = await anchorMemoWithRpc({
            rpc,
            seed: publisher!.secretKey,
            memoText: rMemo,
            memoProgram: tconfig.anchorMemoProgram,
          });
          const rid = await recordAnchor(db.pool, {
            kind: "ledger-root",
            anchoredRef: latest.id,
            headHashHex: latest.rootHex,
            target: "solana-memo",
            network: config.network,
            txid: rAnchor.signature,
            slot: null,
            memo: rMemo,
            confirmed: rAnchor.confirmed,
          });
          results.ledgerRootAnchor = { id: rid, signature: rAnchor.signature, confirmed: rAnchor.confirmed, memo: rMemo };
        } else {
          results.ledgerRootAnchor = "skipped (no published ledger)";
        }
      }
    } else {
      throw new Error(`anchor target "${tconfig.anchorTarget}" not implemented (use solana-memo or none)`);
    }

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ok: true, ...results }, null, 2));
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("anchor-audit-log failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
