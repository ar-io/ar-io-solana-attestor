//! Standalone third-party verifier (M6, §6.5). Independently checks the
//! transparency artifacts WITHOUT trusting the operator's process. The trust
//! anchors — the publisher key and the ORIGINAL anchor txid — MUST be supplied by
//! the verifier (or pinned from an independent on-chain anchor). A self-consistent
//! forgery (rewritten + re-signed with the attacker's key, or a fresh memo posted
//! by any funded key) MUST fail.
//!
//!   verify-transparency artifact <file> [--asset <assetKey>] \
//!       ( --publisher <hex> | LEDGER_PUBLISHER_PUBKEY_HEX \
//!         | --ledger-anchor-sig <sig> --rpc <url> [--anchor-address <addr>] )
//!       PINNING IS MANDATORY: verifies the signature against the KNOWN publisher
//!       key, and/or pins the root from an on-chain ledger-root anchor. WITHOUT a
//!       pin it REFUSES to print PASS (a self-signed forgery would otherwise pass).
//!
//!   verify-transparency audit-log <log.json> --anchor-sig <sig> --rpc <url> \
//!       ( --anchor-address <addr> | --publisher <hex> ) [--audit-pubkey <hex>]
//!       Pure third-party: verify a SERVED /v1/transparency/log dump against the
//!       verifier-pinned anchor tx — checks the tx was SIGNED by the known anchor
//!       key (memo content alone is forgeable) and the log extends the anchored head.
//!
//!   verify-transparency audit --anchor-sig <sig> ( --anchor-address <addr> \
//!       | --publisher <hex> ) [--rpc <url>] [--audit-pubkey <hex>]
//!       Operator convenience: sources the log from DATABASE_URL, but the anchor
//!       txid + signer are still verifier-pinned (never read from the operator DB
//!       for the trust verdict).
//!
//! Exit 0 = all checks PASS; exit 1 = any FAIL / unpinned / forgery detected.

import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import bs58 from "bs58";

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
import { anchorSignedBy, fetchAnchorMemo, parseAnchorMemo, LIVE_MEMO_PROGRAM } from "../transparency/anchor.js";
import { createRpc } from "../solana.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hexToBytes(hex?: string): Uint8Array | undefined {
  if (!hex) return undefined;
  return new Uint8Array(Buffer.from(hex, "hex"));
}
/** The known publisher/anchor Solana address, from --anchor-address (base58) or a
 *  pinned publisher pubkey hex (--publisher / LEDGER_PUBLISHER_PUBKEY_HEX). */
function resolveAnchorAddress(): string | undefined {
  const explicit = arg("--anchor-address");
  if (explicit) return explicit;
  const pubHex = arg("--publisher") ?? process.env.LEDGER_PUBLISHER_PUBKEY_HEX;
  return pubHex ? bs58.encode(Buffer.from(pubHex, "hex")) : undefined;
}

let failed = false;
function check(name: string, ok: boolean, detail?: string): void {
  if (!ok) failed = true;
  // eslint-disable-next-line no-console
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}

async function verifyArtifactMode(): Promise<void> {
  const file = process.argv[3];
  if (!file) throw new Error("usage: verify-transparency artifact <file> [--asset <k>] (--publisher <hex> | --ledger-anchor-sig <sig> --rpc <url>)");
  const artifact = JSON.parse(readFileSync(file, "utf8")) as LedgerArtifact;
  const pinnedPub = arg("--publisher") ?? process.env.LEDGER_PUBLISHER_PUBKEY_HEX;
  const ledgerAnchorSig = arg("--ledger-anchor-sig");
  const rpcUrl = arg("--rpc");

  // PIN #1 — root from an independent on-chain ledger-root anchor (optional).
  let rootPinned = false;
  if (ledgerAnchorSig) {
    if (!rpcUrl) throw new Error("--ledger-anchor-sig requires --rpc <url>");
    const rpc = createRpc(rpcUrl);
    const fetched = await fetchAnchorMemo(rpc, ledgerAnchorSig, LIVE_MEMO_PROGRAM as string);
    if (!fetched || fetched.err !== null) {
      check("ledger-root anchor tx confirmed", false, `sig ${ledgerAnchorSig}`);
    } else {
      const parsed = parseAnchorMemo(fetched.memo);
      const anchorAddress = resolveAnchorAddress();
      // The memo BODY is forgeable by ANY funded key (~5000 lamports); the ONLY
      // binding to the operator is the on-chain SIGNER. An anchor whose signer we
      // cannot pin is NOT a root pin — refuse it, exactly as the audit-log
      // extension path does. Without this, a self-signed forged ledger + a memo
      // posted from a random wallet would print ALL CHECKS PASSED.
      if (!anchorAddress) {
        check("ledger-root anchor SIGNER pinned (--anchor-address / --publisher)", false,
          "a --ledger-anchor-sig with no pinned signer proves nothing: any funded key can post the memo body");
        return; // never treat an unverifiable anchor as a root pin
      }
      const anchorSignedByPinned = anchorSignedBy(fetched, anchorAddress);
      check("ledger-root anchor SIGNED by the pinned publisher/anchor key", anchorSignedByPinned,
        `signer=${fetched.feePayer} expected=${anchorAddress}`);
      if (parsed && parsed.kind === "ledger-root") {
        // Pin ONLY when the anchor was signed by the pinned key AND the root matches.
        rootPinned = anchorSignedByPinned && parsed.hashHex === artifact.manifest.rootHex.toLowerCase();
        check("artifact root == ON-CHAIN anchored ledger root", rootPinned, `onchain=${parsed.hashHex} artifact=${artifact.manifest.rootHex}`);
      } else {
        check("anchor is an ar.io ledger-root anchor", false, `memo="${fetched.memo}"`);
      }
    }
  }

  // PIN #2 — publisher signature over the manifest (mandatory unless root-pinned).
  if (!pinnedPub && !rootPinned) {
    check(
      "publisher key PINNED (independent trust anchor supplied)",
      false,
      "supply --publisher <hex> / LEDGER_PUBLISHER_PUBKEY_HEX, or pin the root via --ledger-anchor-sig. Refusing to trust the artifact's embedded key.",
    );
    return; // never print PASS unpinned
  }

  const v = verifyLedgerArtifact(artifact, pinnedPub);
  check("ledger root re-derives from leaves", v.rootMatches, `root=${v.recomputedRootHex}`);
  check("whole-set digest matches", v.digestMatches);
  check("entry count matches", v.countMatches, `count=${artifact.manifest.entryCount}`);
  if (pinnedPub) {
    check("artifact publisher pubkey == pinned key (no key-swap)", v.pubkeyMatches);
    check("publisher signature valid over manifest (pinned key)", v.signatureValid);
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ledgerVersion: artifact.manifest.ledgerVersion, network: artifact.manifest.network,
    entryCount: artifact.manifest.entryCount, totalClaimableMario: artifact.manifest.totalClaimableMario,
    rootHex: artifact.manifest.rootHex, publisherPubkeyHex: artifact.publisherPubkeyHex,
    pinnedBy: [pinnedPub ? "publisher-key" : null, rootPinned ? "onchain-ledger-root" : null].filter(Boolean),
  }, null, 2));

  const assetKey = arg("--asset");
  if (assetKey) {
    try {
      const m = proveMembership(artifact, assetKey);
      check(`membership proof for ${assetKey}`, verifyMembership(m, artifact.manifest.rootHex), `proof depth=${m.proof.length}`);
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

interface ExtensionOpts {
  anchorSig: string;
  rpcUrl: string;
  anchorAddress?: string;
  auditPubkey?: Uint8Array;
  memoProgram: string;
}

async function verifyExtension(rows: AuditRow[], opts: ExtensionOpts): Promise<void> {
  const chain = verifyAuditChain(rows, opts.auditPubkey);
  check("audit hash-chain linkage valid", chain.ok, chain.issues.slice(0, 2).join("; ") || `count=${chain.count}`);
  if (opts.auditPubkey) {
    check(
      "audit-key signatures valid",
      chain.signatureValidCount === chain.signedCount && chain.signedCount > 0,
      `${chain.signatureValidCount}/${chain.signedCount} signed rows valid`,
    );
  }

  const rpc = createRpc(opts.rpcUrl);
  const fetched = await fetchAnchorMemo(rpc, opts.anchorSig, opts.memoProgram);
  if (!fetched) {
    check("verifier-pinned anchor tx found on-chain", false, `sig ${opts.anchorSig} not on ${opts.rpcUrl}`);
    return;
  }
  check("anchor tx confirmed (err=null)", fetched.err === null, `slot=${fetched.slot}`);

  // The memo BODY is forgeable by any funded key; the ONLY binding to the operator
  // is the on-chain SIGNER. Require the known anchor key to have signed the tx.
  if (!opts.anchorAddress) {
    check("anchor SIGNER pinned (--anchor-address / --publisher)", false, "cannot establish the anchor was posted by the operator's key");
    return;
  }
  check("anchor tx SIGNED by the pinned publisher/anchor key", anchorSignedBy(fetched, opts.anchorAddress), `signer=${fetched.feePayer} expected=${opts.anchorAddress}`);

  const parsed = parseAnchorMemo(fetched.memo);
  if (!parsed || parsed.kind !== "audit-head") {
    check("anchor memo is an ar.io audit-head anchor", false, `memo="${fetched.memo}"`);
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`  anchored on-chain: seq=${parsed.ref} entry_hash=${parsed.hashHex} signer=${fetched.feePayer}`);
  const ext = checkExtendsAnchor(rows, parsed.ref, parsed.hashHex, opts.auditPubkey);
  check("live log EXTENDS the on-chain anchored head", ext.ok, ext.issues.join("; "));
}

async function auditDbMode(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("audit mode needs DATABASE_URL (or use audit-log <file>)");
  const anchorSig = arg("--anchor-sig");
  if (!anchorSig) {
    // A trust verdict requires the verifier to pin the ORIGINAL txid independently
    // (reading it from the operator DB is circular). Refuse without it.
    check("anchor txid PINNED by the verifier (--anchor-sig)", false, "reading the txid from the operator DB is circular; pin the original anchor tx");
    return;
  }
  const { createDb } = await import("../db.js");
  const { loadConfig } = await import("../config.js");
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  try {
    const rows = await loadAuditRows(db.pool, {});
    await verifyExtension(rows, {
      anchorSig,
      rpcUrl: arg("--rpc") ?? config.solanaRpcUrl,
      anchorAddress: resolveAnchorAddress(),
      auditPubkey: hexToBytes(arg("--audit-pubkey") ?? process.env.AUDIT_PUBKEY_HEX),
      memoProgram: LIVE_MEMO_PROGRAM as string,
    });
  } finally {
    await db.close();
  }
}

async function auditLogFileMode(): Promise<void> {
  const file = process.argv[3];
  if (!file) throw new Error("usage: verify-transparency audit-log <log.json> --anchor-sig <sig> --rpc <url> (--anchor-address <addr> | --publisher <hex>)");
  const anchorSig = arg("--anchor-sig");
  const rpcUrl = arg("--rpc");
  if (!anchorSig || !rpcUrl) throw new Error("--anchor-sig <sig> and --rpc <url> are required");
  const log = JSON.parse(readFileSync(file, "utf8")) as {
    entries: { seq: string; prevHashHex: string; entryHashHex: string; signatureHex: string; entry: unknown }[];
  };
  await verifyExtension(auditRowsFromLogDump(log), {
    anchorSig,
    rpcUrl,
    anchorAddress: resolveAnchorAddress(),
    auditPubkey: hexToBytes(arg("--audit-pubkey")),
    memoProgram: arg("--memo-program") ?? (LIVE_MEMO_PROGRAM as string),
  });
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
