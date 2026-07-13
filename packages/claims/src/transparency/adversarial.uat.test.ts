//! M6 TESTER/UAT — adversarial validation of the transparency layer.
//!
//! Third-party-verifiability is the whole point, so these tests attack the
//! artifacts as an untrusting outsider would: forge a second-preimage, re-sign a
//! tampered ledger, rewrite the audit log, and inflate reserves. The tests
//! originally named `weakness:` characterized the exploits the tester found; the
//! dev has since FIXED them (MEDIUM #1 mandatory publisher pin, MEDIUM #2 anchor
//! signer pin, MEDIUM #3 distinct-custody guard, LOW-MED #4 sampled-only ANT
//! coverage) and these tests (now `FIXED:`) assert the SECURED behavior — each is
//! a regression that fails if the exploit is reintroduced.

import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { after, before, describe, it } from "node:test";
import {
  generateKeyPairSigner,
  getAddressEncoder,
  type Address,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";

import {
  fromHex,
  hashLeaf,
  hashNode,
  merkleRoot,
  toHex,
  verifyMerkleProof,
} from "./merkle.js";
import { keypairFromSeed } from "./keys.js";
import {
  buildLedgerArtifact,
  canonicalLeafBytes,
  commitLedger,
  proveMembership,
  verifyLedgerArtifact,
  verifyMembership,
  type LedgerArtifact,
  type LedgerLeaf,
} from "./ledger-artifact.js";
import { checkExtendsAnchor, type AuditRow } from "./audit-chain.js";
import { anchorSignedBy, auditHeadMemo, parseAnchorMemo, type FetchedAnchor } from "./anchor.js";
import { addressFromPublicKey } from "./anchor.js";
import { computeEntryHash, _canonicalJsonForTest as canonicalJson } from "../api/audit.js";
import { computeReserves, readLiabilities } from "./reserves.js";
import { getAssociatedTokenAddress } from "../dispatch/instructions.js";
import type { ChainGateway } from "../dispatch/chain.js";
import { createDb, type Db } from "../db.js";
import { cleanup, insertAsset, insertRecipient, randomClaimant } from "../api/proof-testkit.js";

const PUB = keypairFromSeed("publisher", new Uint8Array(32).fill(11));
const EVIL = keypairFromSeed("publisher", new Uint8Array(32).fill(66));
const AUDIT = keypairFromSeed("audit", new Uint8Array(32).fill(5));
const HAS_DB = !!process.env.DATABASE_URL;

/** Realistic committed set incl. an AT-RISK manual_review + an ANT (amount null). */
function leaves(): LedgerLeaf[] {
  return [
    { recipientId: "arRecipientHandle00000000000000000000000000A", protocol: 0, assetKey: "aa-token", assetType: "token", amount: "1234567890", antMint: null, vaultEndTs: null, status: "available" },
    { recipientId: "arRecipientHandle00000000000000000000000000A", protocol: 0, assetKey: "bb-ant", assetType: "ant", amount: null, antMint: "bb-ant-mint", vaultEndTs: null, status: "available" },
    { recipientId: "ethRecipientHandle0x000000000000000000000000", protocol: 1, assetKey: "cc-vault", assetType: "vault", amount: "5000000000", antMint: null, vaultEndTs: 1795000000, status: "available" },
    { recipientId: "atRiskRecipientHandle000000000000000000000000", protocol: 0, assetKey: "dd-atrisk", assetType: "token", amount: "6250000000000", antMint: null, vaultEndTs: null, status: "manual_review" },
    { recipientId: "arRecipientHandle00000000000000000000000000B", protocol: 0, assetKey: "ee-token", assetType: "token", amount: "42", antMint: null, vaultEndTs: null, status: "claiming" },
  ];
}
function build(pub = PUB): LedgerArtifact {
  return buildLedgerArtifact({ leaves: leaves(), network: "solana-mainnet", ledgerVersion: "uat-v1", generatedAt: "2026-07-10T00:00:00.000Z", publisher: pub });
}

// ─────────────────────────────────────────────────────────────────────────────
describe("M6 UAT — second-preimage / domain separation (highest priority)", () => {
  it("the RAW merkle primitive would fold an INTERNAL NODE to the root (why 0x00/0x01 is load-bearing)", () => {
    // 4 leaves so the tree is [ [H0 H1]->N01 , [H2 H3]->N23 ] -> root(N01,N23).
    const ls = [0, 1, 2, 3].map((i) => hashLeaf(new TextEncoder().encode(`x${i}`)));
    const n01 = hashNode(ls[0], ls[1]);
    const n23 = hashNode(ls[2], ls[3]);
    const root = toHex(merkleRoot(ls));
    assert.equal(root, toHex(hashNode(n01, n23)));
    // The classic CVE-2012-2459 forgery: present N01 as if it were a leaf and
    // fold N23 as its sibling. The dumb primitive accepts it — proof the caller
    // MUST re-apply the leaf prefix, which is exactly what the real API does.
    assert.equal(verifyMerkleProof(n01, [{ hashHex: toHex(n23), side: "right" }], root), true);
  });

  it("DEFENSE: no LedgerLeaf hash can equal an internal node (leaf=0x00.. , node=0x01..)", () => {
    const { sortedLeaves, leafHashes } = commitLedger(leaves());
    const nodes: Uint8Array[] = [];
    for (let i = 0; i + 1 < leafHashes.length; i += 2) nodes.push(hashNode(leafHashes[i], leafHashes[i + 1]));
    for (const lh of leafHashes) for (const nd of nodes) assert.notEqual(toHex(lh), toHex(nd));
    // And every real leaf hash starts from the 0x00 domain: recompute one by hand.
    const idx = sortedLeaves.findIndex((l) => l.assetKey === "aa-token");
    const raw = canonicalLeafBytes(sortedLeaves[idx]);
    const byHand = createHash("sha256").update(Buffer.concat([Buffer.from([0x00]), Buffer.from(raw)])).digest("hex");
    assert.equal(toHex(leafHashes[idx]), byHand);
  });

  it("DEFENSE: verifyMembership rejects a proof that claims an internal node as its leaf hash", () => {
    const art = build();
    const m = proveMembership(art, "aa-token");
    const { leafHashes } = commitLedger(art.leaves);
    const internalNode = toHex(hashNode(leafHashes[0], leafHashes[1]));
    // Attacker swaps in the internal-node hash but keeps a real leaf: the API
    // re-derives hashLeaf(leaf) and finds it != claimed leafHashHex -> false.
    assert.equal(verifyMembership({ ...m, leafHashHex: internalNode }, art.manifest.rootHex), false);
  });

  it("forged membership for an asset NOT in the committed set is rejected", () => {
    const art = build();
    const ghost: LedgerLeaf = { recipientId: "ghost", protocol: 0, assetKey: "zz-ghost", assetType: "token", amount: "999999999999", antMint: null, vaultEndTs: null, status: "available" };
    const forged = { assetKey: "zz-ghost", leaf: ghost, leafHashHex: toHex(hashLeaf(canonicalLeafBytes(ghost))), proof: [], rootHex: art.manifest.rootHex };
    assert.equal(verifyMembership(forged, art.manifest.rootHex), false);
    assert.throws(() => proveMembership(art, "zz-ghost"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("M6 UAT — published ledger tamper + re-sign forgery", () => {
  it("altering an amount breaks the root; signature (over the old manifest) no longer matches", () => {
    const art = build();
    const t: LedgerArtifact = { ...art, leaves: art.leaves.map((l) => (l.assetKey === "aa-token" ? { ...l, amount: "9999999999" } : l)) };
    const v = verifyLedgerArtifact(t, art.publisherPubkeyHex);
    assert.equal(v.rootMatches, false);
    assert.equal(v.ok, false);
  });

  it("altering a recipient is caught by the root", () => {
    const art = build();
    const t: LedgerArtifact = { ...art, leaves: art.leaves.map((l) => (l.assetKey === "cc-vault" ? { ...l, recipientId: "attackerWallet" } : l)) };
    assert.equal(verifyLedgerArtifact(t, art.publisherPubkeyHex).rootMatches, false);
  });

  it("hiding an AT-RISK entry (manual_review->available, or dropping it) is caught", () => {
    const art = build();
    const flipped: LedgerArtifact = { ...art, leaves: art.leaves.map((l) => (l.status === "manual_review" ? { ...l, status: "available" } : l)) };
    assert.equal(verifyLedgerArtifact(flipped, art.publisherPubkeyHex).rootMatches, false);
    const dropped: LedgerArtifact = { ...art, leaves: art.leaves.filter((l) => l.status !== "manual_review") };
    const vd = verifyLedgerArtifact(dropped, art.publisherPubkeyHex);
    assert.equal(vd.ok, false);
    assert.ok(vd.issues.some((i) => i.includes("root mismatch") || i.includes("entryCount")));
  });

  it("FIXED: a fully re-signed forgery is REJECTED — unpinned verify never returns ok", () => {
    // Attacker rewrites leaves, recomputes the root, rebuilds the manifest and
    // signs it with THEIR OWN key, swapping publisherPubkeyHex to match.
    const evilLeaves = leaves().map((l) => (l.assetKey === "aa-token" ? { ...l, amount: "1" } : l));
    const forged = buildLedgerArtifact({ leaves: evilLeaves, network: "solana-mainnet", ledgerVersion: "uat-v1", generatedAt: "2026-07-10T00:00:00.000Z", publisher: EVIL });
    // UNPINNED (no known-good key): MUST refuse — the forgery is self-consistent.
    const unpinned = verifyLedgerArtifact(forged);
    assert.equal(unpinned.ok, false, "unpinned verify must never pass a self-signed forgery");
    assert.equal(unpinned.pinned, false);
    assert.ok(unpinned.issues.some((i) => i.includes("UNPINNED")));
    // PINNED to the REAL publisher key: rejected (key swap + signature invalid).
    const pinned = verifyLedgerArtifact(forged, toHex(PUB.publicKey));
    assert.equal(pinned.ok, false);
    assert.equal(pinned.pubkeyMatches, false);
    assert.equal(pinned.signatureValid, false);
    // And the GENUINE artifact, pinned, still verifies.
    assert.equal(verifyLedgerArtifact(build(), toHex(PUB.publicKey)).ok, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("M6 UAT — leaf invariants (no secrets; AT-RISK committed + marked)", () => {
  it("canonical leaf bytes carry ONLY the 8 public fields — no nonce / modulus / secret", () => {
    const json = new TextDecoder().decode(canonicalLeafBytes(leaves()[3]));
    const keys = Object.keys(JSON.parse(json)).sort();
    assert.deepEqual(keys, ["amount", "antMint", "assetKey", "assetType", "protocol", "recipientId", "status", "vaultEndTs"]);
    for (const forbidden of ["nonce", "modulus", "secret", "signature", "privateKey", "seed"]) {
      assert.equal(json.toLowerCase().includes(forbidden.toLowerCase()), false, `leaf must not expose ${forbidden}`);
    }
  });

  it("an AT-RISK (manual_review) entry is IN the committed set, marked, and provable", () => {
    const art = build();
    const atRisk = art.leaves.find((l) => l.assetKey === "dd-atrisk");
    assert.ok(atRisk && atRisk.status === "manual_review");
    assert.equal(art.manifest.manualReviewCount, 1);
    const m = proveMembership(art, "dd-atrisk");
    assert.ok(verifyMembership(m, art.manifest.rootHex));
    // Its amount is inside totalClaimableMario (operator cannot silently drop it).
    assert.ok(BigInt(art.manifest.totalClaimableMario) >= 6250000000000n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("M6 UAT — audit-chain rewrite + anchor-binding gap", () => {
  const ZERO32 = Buffer.alloc(32);
  function chain(n: number): AuditRow[] {
    const rows: AuditRow[] = [];
    let prev: Buffer = ZERO32;
    for (let i = 1; i <= n; i++) {
      const entry = { ts: `2026-07-10T00:00:0${i % 10}.000Z`, event: "claim.test", claimId: `c${i}` };
      const entryHash = computeEntryHash(prev, entry);
      rows.push({ seq: String(i), prevHash: prev, entry, entryHash, signature: Buffer.from(AUDIT.sign(entryHash)) });
      prev = entryHash;
    }
    return rows;
  }

  it("independently recomputes the sha256 chain (no module) and it links", () => {
    const rows = chain(6);
    let prev: Buffer = Buffer.alloc(32);
    for (const r of rows) {
      const h = createHash("sha256").update(prev).update(Buffer.from(canonicalJson(r.entry), "utf8")).digest();
      assert.equal(h.toString("hex"), r.entryHash.toString("hex"), `seq ${r.seq} hash`);
      assert.equal(r.prevHash.toString("hex"), prev.toString("hex"), `seq ${r.seq} link`);
      prev = r.entryHash;
    }
  });

  it("rewriting content at/before the anchored seq is flagged by checkExtendsAnchor", () => {
    const rows = chain(8);
    const anchoredHash = rows[4].entryHash.toString("hex"); // seq 5, ORIGINAL
    let prev = rows[1].entryHash;
    for (let i = 2; i < rows.length; i++) {
      if (i === 2) (rows[i].entry as { event: string }).event = "claim.REWRITTEN";
      rows[i].prevHash = prev;
      rows[i].entryHash = computeEntryHash(prev, rows[i].entry);
      rows[i].signature = Buffer.from(AUDIT.sign(rows[i].entryHash));
      prev = rows[i].entryHash;
    }
    const ext = checkExtendsAnchor(rows, "5", anchoredHash, AUDIT.publicKey);
    assert.equal(ext.ok, false);
    assert.equal(ext.hashMatches, false);
  });

  it("FIXED: a freshly-forged anchor is caught — the verifier pins the on-chain SIGNER", () => {
    // Anchor memo content is fully attacker-controllable (any funded key can post
    // it). An operator rewrites history and posts a NEW memo carrying the rewritten
    // head. The memo parses and the log "extends" it (the raw primitive) — but the
    // SECURE verifier requires the anchor tx to be SIGNED by the KNOWN publisher/
    // anchor key, which the attacker's memo tx is not.
    const rows = chain(6);
    let prev: Buffer = Buffer.alloc(32);
    for (let i = 0; i < rows.length; i++) {
      if (i === 1) (rows[i].entry as { event: string }).event = "claim.REWRITTEN";
      rows[i].prevHash = prev;
      rows[i].entryHash = computeEntryHash(prev, rows[i].entry);
      rows[i].signature = Buffer.from(AUDIT.sign(rows[i].entryHash));
      prev = rows[i].entryHash;
    }
    const forgedMemo = auditHeadMemo(rows[5].seq, rows[5].entryHash.toString("hex"), "solana-mainnet");
    const parsed = parseAnchorMemo(forgedMemo);
    assert.ok(parsed && parsed.kind === "audit-head");
    const extPrimitive = checkExtendsAnchor(rows, parsed.ref, parsed.hashHex, AUDIT.publicKey);
    assert.equal(extPrimitive.ok, true, "the raw extends-primitive still matches (memo body is forgeable)");

    // The DEFENSE: the verifier pins the KNOWN publisher/anchor address. An anchor
    // tx posted by an ATTACKER key fails the signer check -> forgery rejected.
    const operatorAnchorAddr = addressFromPublicKey(keypairFromSeed("publisher", new Uint8Array(32).fill(11)).publicKey);
    const attackerAnchorAddr = addressFromPublicKey(EVIL.publicKey);
    const attackerAnchorTx: FetchedAnchor = { memo: forgedMemo, slot: 1n, err: null, feePayer: attackerAnchorAddr, signers: [attackerAnchorAddr] };
    assert.equal(anchorSignedBy(attackerAnchorTx, operatorAnchorAddr), false, "attacker-posted anchor rejected by signer pin");

    // A genuine anchor posted by the operator key passes the signer pin.
    const genuineAnchorTx: FetchedAnchor = { memo: forgedMemo, slot: 1n, err: null, feePayer: operatorAnchorAddr, signers: [operatorAnchorAddr] };
    assert.equal(anchorSignedBy(genuineAnchorTx, operatorAnchorAddr), true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("M6 UAT — reserves false-surplus", { skip: !HAS_DB }, () => {
  let db: Db;

  // Own, ISOLATED ledger fixture. This suite shares one Postgres with the other
  // DB suites, so reading the GLOBAL liability / outstanding-ANT aggregate would
  // be poisoned by their (concurrently mutating) rows — flaking the shortfall and
  // sampled-fraction assertions. Every reserves call below is scoped to exactly
  // these asset keys via `assetScope`, so the aggregates are deterministic.
  const fixtureAssets: string[] = [];
  const fixtureRecipients: string[] = [];
  const FIXTURE_OUTSTANDING = 1_000_000n; // mARIO owed by the fixture (one token asset)
  const FIXTURE_ANTS = 4; // outstanding ANTs in the fixture (> sampleSize below)

  before(async () => {
    db = createDb(process.env.DATABASE_URL as string);
    const recipientId = `resv_${randomBytes(8).toString("hex")}`;
    await insertRecipient(db.pool, {
      recipientId, protocol: 1, sourceAddress: recipientId, recipientPubkey: new Uint8Array(randomBytes(20)),
    });
    const tokenKey = randomBytes(32).toString("hex");
    await insertAsset(db.pool, recipientId, {
      assetKey: tokenKey, assetType: "token", amount: FIXTURE_OUTSTANDING, status: "available",
    });
    fixtureAssets.push(tokenKey);
    for (let i = 0; i < FIXTURE_ANTS; i++) {
      const antKey = randomClaimant();
      await insertAsset(db.pool, recipientId, {
        assetKey: antKey, assetType: "ant", antMint: randomClaimant(), amount: null, status: "available",
      });
      fixtureAssets.push(antKey);
    }
    fixtureRecipients.push(recipientId);
  });
  after(async () => {
    if (fixtureAssets.length) await cleanup(db.pool, fixtureAssets, fixtureRecipients);
    await db.close();
  });

  class MapGateway implements ChainGateway {
    constructor(private readonly bal: Map<string, bigint>) {}
    async getTokenBalance(a: Address): Promise<bigint> { return this.bal.get(a as string) ?? 0n; }
    async accountExists(): Promise<boolean> { return true; }
    async getBlockHeight(): Promise<bigint> { return 1n; }
    async signTransaction(): Promise<never> { throw new Error("unused"); }
    async broadcast(): Promise<void> {}
    async confirmSignature(): Promise<"confirmed"> { return "confirmed"; }
    async findConfirmedOutflow(): Promise<null> { return null; }
  }

  it("FIXED: cold reserve owner == hot dispenser owner is REJECTED (no double-count)", async () => {
    const mint = (await generateKeyPairSigner()).address;
    const owner = (await generateKeyPairSigner()).address; // one owner used as BOTH hot + cold
    const ata = await getAssociatedTokenAddress(owner, mint);
    const B = 1_000_000_000_000n;
    // The distinct-custody guard refuses to sum the same account twice.
    await assert.rejects(
      computeReserves({
        pool: db.pool, gateway: new MapGateway(new Map([[ata as string, B]])),
        network: "solana-mainnet", mint, hotDispenser: owner, coldReserve: owner, antCheck: { mode: "off" },
        assetScope: fixtureAssets,
      }),
      /coldReserve owner == hotDispenser|counted twice/,
    );
    // With DISTINCT owners the same physical B is counted once (hot only).
    const cold = (await generateKeyPairSigner()).address;
    const r = await computeReserves({
      pool: db.pool, gateway: new MapGateway(new Map([[ata as string, B]])),
      network: "solana-mainnet", mint, hotDispenser: owner, coldReserve: cold, antCheck: { mode: "off" },
      assetScope: fixtureAssets,
    });
    assert.equal(r.reserves.hotFloatMario, B.toString());
    assert.equal(r.reserves.coldReserveMario, "0"); // distinct cold ATA is empty
    assert.equal(r.reserves.totalReserveMario, B.toString()); // counted ONCE
  });

  it("FIXED: a same-address config can no longer MASK a shortfall (false surplus)", async () => {
    // Liability is read from the SCOPED fixture (deterministic == FIXTURE_OUTSTANDING).
    const liab = await readLiabilities(db.pool, fixtureAssets);
    assert.equal(liab.outstandingMario, FIXTURE_OUTSTANDING, "scoped fixture liability is deterministic");
    const mint = (await generateKeyPairSigner()).address;
    const owner = (await generateKeyPairSigner()).address;
    const ata = await getAssociatedTokenAddress(owner, mint);
    const B = liab.outstandingMario - 1n; // one mARIO short
    // The exploit (cold=hot to double B over the liability) is now rejected.
    await assert.rejects(
      computeReserves({
        pool: db.pool, gateway: new MapGateway(new Map([[ata as string, B]])),
        network: "solana-mainnet", mint, hotDispenser: owner, coldReserve: owner, antCheck: { mode: "off" },
        assetScope: fixtureAssets,
      }),
    );
    // The TRUE distinct reserve is correctly reported as a shortfall.
    const r = await computeReserves({
      pool: db.pool, gateway: new MapGateway(new Map([[ata as string, B]])),
      network: "solana-mainnet", mint, hotDispenser: owner, antCheck: { mode: "off" },
      assetScope: fixtureAssets,
    });
    assert.equal(r.coverage.tokenVaultCovered, false, "genuine shortfall is flagged");
    assert.ok(BigInt(r.coverage.surplusMario) < 0n, "negative surplus (real shortfall)");
  });

  it("FIXED: ANT sampling never reports antCovered=true (sampled-only, not a coverage claim)", async () => {
    // Sample fewer than the fixture's outstanding ANTs so the sample is provably
    // partial regardless of what else is in the shared DB (aggregate is scoped).
    const sampleSize = FIXTURE_ANTS - 1;
    const ADDR = getAddressEncoder();
    const mint = (await generateKeyPairSigner()).address;
    const authority = (await generateKeyPairSigner()).address;
    const ata = await getAssociatedTokenAddress(authority, mint);
    // Fake RPC: EVERY sampled ANT resolves to Owner == authority.
    const ownerB64 = Buffer.from(ADDR.encode(authority)).toString("base64");
    const fakeRpc = {
      getAccountInfo: () => ({ send: async () => ({ value: { data: [ownerB64, "base64"] } }) }),
    } as unknown as Rpc<SolanaRpcApi>;
    const r = await computeReserves({
      pool: db.pool, gateway: new MapGateway(new Map([[ata as string, 0n]])),
      rpc: fakeRpc, network: "solana-mainnet", mint, hotDispenser: authority, antAuthority: authority,
      antCheck: { mode: "sample", sampleSize }, assetScope: fixtureAssets,
    });
    const ah = r.reserves.antHoldings as { method: string; checked: number; matchingAuthority: number; outstandingTotal: number };
    assert.equal(ah.method, "sample");
    assert.equal(ah.outstandingTotal, FIXTURE_ANTS, "scoped outstanding count is deterministic");
    assert.ok(ah.checked < ah.outstandingTotal, "only a fraction was sampled");
    // A partial sample proves the sampled few are owned, NOT holdings >= outstanding.
    // Coverage MUST NOT read `true` under sampling.
    assert.notEqual(r.coverage.antCovered, true);
    assert.equal(r.coverage.antCovered, "sampled-only");
  });
});
