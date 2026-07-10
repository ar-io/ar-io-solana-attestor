//! Standalone third-party verifier (M6, §6.5). Independently checks the
//! transparency artifacts WITHOUT trusting the operator's process:
//!
//!   verify-transparency artifact <file> [--asset <assetKey>] [--publisher <hex>]
//!       Re-derive the Merkle root from the artifact's leaves, confirm it matches
//!       the signed manifest, verify the publisher signature, and (with --asset)
//!       prove + verify that asset's membership. Detects any tamper (a changed
//!       leaf / count breaks the root => signature no longer matches).
//!
//!   verify-transparency audit [--rpc <url>] [--audit-pubkey <hex>]
//!       (needs DATABASE_URL) Verify the full audit hash-chain + signatures, read
//!       the latest recorded anchor, fetch its memo FROM CHAIN, and confirm the
//!       live log extends the anchored head.
//!
//!   verify-transparency audit-log <log.json> --anchor-sig <sig> --rpc <url> \
//!       [--audit-pubkey <hex>] [--memo-program <id>]
//!       Pure third-party: verify a SERVED /v1/transparency/log dump against an
//!       on-chain anchor tx — no DB, no operator trust.
//!
//! Exit 0 = all checks PASS; exit 1 = any FAIL (a tamper was detected).

import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";

import {
  proveMembership,
  verifyLedgerArtifact,
  verifyMembership,
  type LedgerArtifact,
} from "../transparency/ledger-artifact.js";
import {
  checkExtendsAnchor,
  loadAuditRows,
  verifyAuditChain,
  type AuditRow,
} from "../transparency/audit-chain.js";
import { fetchAnchorMemo, parseAnchorMemo, LIVE_MEMO_PROGRAM } from "../transparency/anchor.js";
import { createRpc } from "../solana.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hexToBytes(hex?: string): Uint8Array | undefined {
  if (!hex) return undefined;
  return new Uint8Array(Buffer.from(hex, "hex"));
}

let failed = false;
function check(name: string, ok: boolean, detail?: string): void {
  if (!ok) failed = true;
  // eslint-disable-next-line no-console
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}

async function verifyArtifactMode(): Promise<void> {
  const file = process.argv[3];
  if (!file) throw new Error("usage: verify-transparency artifact <file> [--asset <assetKey>]");
  const artifact = JSON.parse(readFileSync(file, "utf8")) as LedgerArtifact;
  const expectedPub = arg("--publisher");

  const v = verifyLedgerArtifact(artifact, expectedPub);
  check("ledger root re-derives from leaves", v.rootMatches, `root=${v.recomputedRootHex}`);
  check("whole-set digest matches", v.digestMatches);
  check("entry count matches", v.countMatches, `count=${artifact.manifest.entryCount}`);
  check("publisher signature valid over manifest", v.signatureValid);
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        ledgerVersion: artifact.manifest.ledgerVersion,
        network: artifact.manifest.network,
        entryCount: artifact.manifest.entryCount,
        totalClaimableMario: artifact.manifest.totalClaimableMario,
        rootHex: artifact.manifest.rootHex,
        publisherPubkeyHex: artifact.publisherPubkeyHex,
      },
      null,
      2,
    ),
  );

  const assetKey = arg("--asset");
  if (assetKey) {
    try {
      const m = proveMembership(artifact, assetKey);
      const ok = verifyMembership(m, artifact.manifest.rootHex);
      check(`membership proof for ${assetKey}`, ok, `proof depth=${m.proof.length}`);
    } catch (e) {
      check(`membership proof for ${assetKey}`, false, (e as Error).message);
    }
  }
}

function auditRowsFromLogDump(log: {
  entries: { seq: string; prevHashHex: string; entryHashHex: string; signatureHex: string; entry: unknown }[];
}): AuditRow[] {
  return log.entries.map((e) => ({
    seq: e.seq,
    prevHash: Buffer.from(e.prevHashHex, "hex"),
    entry: e.entry,
    entryHash: Buffer.from(e.entryHashHex, "hex"),
    signature: Buffer.from(e.signatureHex, "hex"),
  }));
}

async function verifyExtension(
  rows: AuditRow[],
  anchorSig: string,
  rpcUrl: string,
  auditPubkey?: Uint8Array,
  memoProgram: string = LIVE_MEMO_PROGRAM as string,
): Promise<void> {
  const chain = verifyAuditChain(rows, auditPubkey);
  check("audit hash-chain linkage valid", chain.ok, chain.issues.join("; ") || `count=${chain.count}`);
  if (auditPubkey) {
    check(
      "audit-key signatures valid",
      chain.signatureValidCount === chain.signedCount && chain.signedCount > 0,
      `${chain.signatureValidCount}/${chain.signedCount} signed rows valid`,
    );
  }

  const rpc = createRpc(rpcUrl);
  const fetched = await fetchAnchorMemo(rpc, anchorSig, memoProgram);
  if (!fetched) {
    check("on-chain anchor tx found", false, `sig ${anchorSig} not found on ${rpcUrl}`);
    return;
  }
  check("on-chain anchor tx confirmed (err=null)", fetched.err === null, `slot=${fetched.slot}`);
  const parsed = parseAnchorMemo(fetched.memo);
  if (!parsed || parsed.kind !== "audit-head") {
    check("anchor memo is an ar.io audit-head anchor", false, `memo="${fetched.memo}"`);
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`  anchored on-chain: seq=${parsed.ref} entry_hash=${parsed.hashHex} (memo="${fetched.memo}")`);
  const ext = checkExtendsAnchor(rows, parsed.ref, parsed.hashHex, auditPubkey);
  check("live log EXTENDS the on-chain anchored head", ext.ok, ext.issues.join("; "));
}

async function auditDbMode(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("audit mode needs DATABASE_URL (or use audit-log <file>)");
  const { createDb } = await import("../db.js");
  const { getAnchors } = await import("../transparency/store.js");
  const { loadConfig } = await import("../config.js");
  const config = loadConfig();
  const rpcUrl = arg("--rpc") ?? config.solanaRpcUrl;
  const auditPubkey = hexToBytes(arg("--audit-pubkey") ?? process.env.AUDIT_PUBKEY_HEX);

  const db = createDb(config.databaseUrl);
  try {
    const rows = await loadAuditRows(db.pool, {});
    const anchors = await getAnchors(db.pool, { kind: "audit-head", limit: 1 });
    if (anchors.length === 0) {
      check("a recorded audit-head anchor exists", false, "run anchor-audit-log first");
      return;
    }
    const a = anchors[0];
    if (!a.txid) {
      check("anchor has an on-chain txid", false);
      return;
    }
    await verifyExtension(rows, a.txid, rpcUrl, auditPubkey, LIVE_MEMO_PROGRAM as string);
  } finally {
    await db.close();
  }
}

async function auditLogFileMode(): Promise<void> {
  const file = process.argv[3];
  if (!file) throw new Error("usage: verify-transparency audit-log <log.json> --anchor-sig <sig> --rpc <url>");
  const anchorSig = arg("--anchor-sig");
  const rpcUrl = arg("--rpc");
  if (!anchorSig || !rpcUrl) throw new Error("--anchor-sig <sig> and --rpc <url> are required");
  const auditPubkey = hexToBytes(arg("--audit-pubkey"));
  const memoProgram = arg("--memo-program") ?? (LIVE_MEMO_PROGRAM as string);
  const log = JSON.parse(readFileSync(file, "utf8")) as {
    entries: { seq: string; prevHashHex: string; entryHashHex: string; signatureHex: string; entry: unknown }[];
  };
  await verifyExtension(auditRowsFromLogDump(log), anchorSig, rpcUrl, auditPubkey, memoProgram);
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === "artifact") await verifyArtifactMode();
  else if (mode === "audit") await auditDbMode();
  else if (mode === "audit-log") await auditLogFileMode();
  else throw new Error("usage: verify-transparency <artifact|audit|audit-log> ...");

  // eslint-disable-next-line no-console
  console.log(failed ? "\nVERIFICATION FAILED" : "\nALL CHECKS PASSED");
  if (failed) process.exit(1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("verify-transparency error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
