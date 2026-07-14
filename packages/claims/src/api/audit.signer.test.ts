//! Pure test for audit sign-on-write (M6): `appendAudit` signs `entry_hash` with
//! the registered audit signer, else stores the zero placeholder. No DB — a mock
//! PoolClient captures the INSERT params (the real hash-chain + concurrency is
//! covered by the DB tests; this pins the signing hook without touching the
//! shared append-only chain).

import { strict as assert } from "node:assert";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import type { PoolClient } from "pg";

import { appendAudit, setAuditSigner, UNSIGNED_PLACEHOLDER, _canonicalJsonForTest as canonicalJson } from "./audit.js";
import { keypairFromSeed } from "../transparency/keys.js";

const AUDIT = keypairFromSeed("audit", new Uint8Array(32).fill(5));

/** Mock client: no-op locks/selects, captures the INSERT bindings. */
function mockClient(): { client: PoolClient; captured: () => unknown[] } {
  let insertParams: unknown[] = [];
  const client = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: async (sql: string, params?: unknown[]): Promise<any> => {
      if (sql.startsWith("INSERT INTO audit_log")) insertParams = params ?? [];
      if (sql.includes("SELECT entry_hash")) return { rows: [] }; // genesis
      return { rows: [] };
    },
  } as unknown as PoolClient;
  return { client, captured: () => insertParams };
}

afterEach(() => setAuditSigner(null));

describe("audit sign-on-write", () => {
  it("stores the 64-byte zero placeholder when no signer is registered", async () => {
    const { client, captured } = mockClient();
    await appendAudit(client, { event: "x.test" });
    const [, , , signature] = captured();
    assert.ok(Buffer.isBuffer(signature));
    assert.ok((signature as Buffer).equals(UNSIGNED_PLACEHOLDER));
  });

  it("signs entry_hash with the audit key when a signer is registered", async () => {
    setAuditSigner({ signEntryHash: (h) => Buffer.from(AUDIT.sign(h)) });
    const { client, captured } = mockClient();
    await appendAudit(client, { event: "x.test", claimId: "abc" });
    const [prevHash, json, entryHash, signature] = captured() as [Buffer, string, Buffer, Buffer];

    // entry_hash = sha256(prev_hash || canonical_json(entry)); prev = genesis zeros.
    const expectedHash = createHash("sha256").update(prevHash).update(Buffer.from(json, "utf8")).digest();
    assert.ok(entryHash.equals(expectedHash));
    // signature is a valid Ed25519 over entry_hash by the audit key.
    const expectedSig = Buffer.from(AUDIT.sign(entryHash));
    assert.ok(signature.equals(expectedSig));
    // and the stored json is canonical (sorted keys).
    assert.equal(json, canonicalJson(JSON.parse(json)));
  });
});
