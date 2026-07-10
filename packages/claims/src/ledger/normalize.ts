//! Canonical source-address normalization for the AO->Solana migration.
//!
//! SELF-CONTAINED reimplementation of the authoritative cross-repo contract in
//! `solana-ar-io/migration/import/src/normalize-address.ts`. The claims service
//! must not depend on the solana-ar-io repo at runtime, so this is copied
//! verbatim (byte-for-byte behavior). The independent M1 reconciler
//! (`src/reconcile/`) imports the ORIGINAL from solana-ar-io and diffs, so any
//! drift between this copy and the authoritative source is caught bit-exact.
//!
//! Canonical form (CROSS-REPO CONTRACT — batch-escrow <-> attestor <-> claims
//! MUST all agree): Ethereum -> lowercase `0x` + 40 lowercase hex; everything
//! else (Arweave 43-char base64url, Solana, ...) -> returned unchanged
//! (case-sensitive). The B6Nf casing incident is the reason this exists.

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isEthereumAddress(addr: string): boolean {
  return ETH_ADDRESS_RE.test(addr);
}

export function normalizeSourceAddress(addr: string): string {
  return ETH_ADDRESS_RE.test(addr) ? addr.toLowerCase() : addr;
}

/** Normalize every key of an address-map (returns a new map). */
export function normalizeAddressMapKeys<T>(
  map: Record<string, T>,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(map)) out[normalizeSourceAddress(k)] = v;
  return out;
}

/**
 * Wrap an address-map so BOTH its keys (normalized on construction) AND every
 * probe address (normalized on access via `map[addr]` / `addr in map`) are
 * canonicalized — case-insensitive ETH lookups at every call site. A single
 * missed normalization would mis-classify a mapped ETH owner as unmapped
 * (-> escrow -> dropped).
 */
export function makeNormalizedAddressMap<T>(
  raw: Record<string, T>,
): Record<string, T> {
  const target = normalizeAddressMapKeys(raw);
  return new Proxy(target, {
    get(t, prop) {
      return typeof prop === "string"
        ? t[normalizeSourceAddress(prop)]
        : (t as Record<string | symbol, unknown>)[prop as never];
    },
    has(t, prop) {
      return typeof prop === "string"
        ? normalizeSourceAddress(prop) in t
        : prop in t;
    },
  }) as Record<string, T>;
}
