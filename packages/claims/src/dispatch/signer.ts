//! Pluggable dispenser-signer interface (M4).
//!
//! The dispatch worker signs on-chain transactions through a `DispenserSigner`
//! rather than a concrete keypair, so the custody backend can change WITHOUT a
//! worker rewrite (pivot plan §4.3: "KMS / Squads-multisig can slot in later").
//! The default backend is the encrypted-hot-key (`EncryptedKeypairSigner`);
//! `KmsSigner` / `SquadsSigner` are interface-only stubs showing the shape a
//! real integration fills in.
//!
//! Two custody ROLES, deliberately separable (different blast radii):
//!   * `token` — the HOT dispenser. Holds ONLY the bounded ARIO float (≤500k)
//!     + signs SPL transfers and vault `vaulted_transfer` CPIs. Its worst-case
//!     loss is the float, never the 48.3M cold pool.
//!   * `ant`   — the ANT custody signer. Holds the 2,269 non-fungible ANTs (or,
//!     per the recommended proposal, does NOT hold them at all and is an
//!     operator/cold/Squads signer brought online per-batch). NEVER the hot key
//!     — see the ANT-custody note in SPEC.md. The worker gates ANT dispatches on
//!     operator approval by default so an NFT is never auto-dispensed from a hot
//!     key.
//!
//! A `DispenserSigner` exposes its `address` synchronously (so the worker can
//! derive ATAs / check balances without unlocking the key) and yields a kit
//! `TransactionSigner` on demand via `getSigner()`.

import {
  createKeyPairSignerFromPrivateKeyBytes,
  type Address,
  type TransactionSigner,
} from "@solana/kit";

import { openSecret, type SealedKey } from "./crypto-box.js";

export type SignerRole = "token" | "ant";
export type SignerKind = "encrypted-hot-key" | "kms" | "squads" | "in-memory";

export interface DispenserSigner {
  /** The on-chain address this signer authorizes for (available without unlock). */
  readonly address: Address;
  /** Custody backend identifier (for audit / ops visibility). */
  readonly kind: SignerKind;
  /** Which custody role this signer fills. */
  readonly role: SignerRole;
  /**
   * Yield a kit `TransactionSigner`. For the encrypted-hot-key this decrypts the
   * seed on first call and caches the unlocked signer in memory for the process
   * lifetime; a KMS/Squads backend would instead return a signer that delegates
   * each signature to the remote signer. Throws if the key cannot be unlocked.
   */
  getSigner(): Promise<TransactionSigner>;
}

// ---------------------------------------------------------------------------
// EncryptedKeypairSigner — the default hot-key backend.
// ---------------------------------------------------------------------------
/**
 * Loads a `SealedKey` (AES-256-GCM at rest, see crypto-box.ts) and decrypts it
 * with a runtime passphrase to produce a kit Ed25519 signer. The plaintext seed
 * exists only in memory after `getSigner()`; the sealed blob + a separately
 * injected passphrase are the only things that ever persist.
 */
export class EncryptedKeypairSigner implements DispenserSigner {
  readonly kind: SignerKind = "encrypted-hot-key";
  readonly role: SignerRole;
  readonly address: Address;
  #sealed: SealedKey;
  #passphrase: string;
  #signer: TransactionSigner | null = null;

  private constructor(role: SignerRole, address: Address, sealed: SealedKey, passphrase: string) {
    this.role = role;
    this.address = address;
    this.#sealed = sealed;
    this.#passphrase = passphrase;
  }

  /**
   * Construct + eagerly verify the passphrase (unlock once so a bad passphrase
   * fails at boot, not on the first claim). The unlocked signer is cached.
   */
  static async load(role: SignerRole, sealed: SealedKey, passphrase: string): Promise<EncryptedKeypairSigner> {
    const seed = openSecret(sealed, passphrase); // throws on bad passphrase / tamper
    const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
    // Wipe the local seed copy; the unlocked signer holds a non-extractable key.
    seed.fill(0);
    const self = new EncryptedKeypairSigner(role, signer.address, sealed, passphrase);
    self.#signer = signer;
    return self;
  }

  async getSigner(): Promise<TransactionSigner> {
    if (this.#signer) return this.#signer;
    const seed = openSecret(this.#sealed, this.#passphrase);
    const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
    seed.fill(0);
    this.#signer = signer;
    return signer;
  }
}

// ---------------------------------------------------------------------------
// InMemoryKeypairSigner — tests / localnet only (a bare seed, never for prod).
// ---------------------------------------------------------------------------
/**
 * A signer from a raw 32-byte seed with NO at-rest encryption. Intended for
 * localnet proofs and tests where the key is ephemeral. Prod paths use
 * `EncryptedKeypairSigner`.
 */
export class InMemoryKeypairSigner implements DispenserSigner {
  readonly kind: SignerKind = "in-memory";
  readonly role: SignerRole;
  readonly address: Address;
  #signer: TransactionSigner;

  private constructor(role: SignerRole, signer: TransactionSigner) {
    this.role = role;
    this.address = signer.address;
    this.#signer = signer;
  }

  static async fromSeed(role: SignerRole, seed: Uint8Array): Promise<InMemoryKeypairSigner> {
    if (seed.length !== 32) throw new Error(`seed must be 32 bytes, got ${seed.length}`);
    const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
    return new InMemoryKeypairSigner(role, signer);
  }

  async getSigner(): Promise<TransactionSigner> {
    return this.#signer;
  }
}

// ---------------------------------------------------------------------------
// Remote-backend stubs — interface only (no rewrite needed to slot them in).
// ---------------------------------------------------------------------------
/**
 * Sketch of a cloud-KMS backend. A real impl builds a kit `TransactionSigner`
 * whose `signTransactions` delegates the raw-message signature to the KMS
 * `Sign` API (the private key never leaves the HSM). Left unimplemented because
 * it needs a cloud dependency; the point is the worker consumes `DispenserSigner`,
 * so this drops in unchanged.
 */
export class KmsSigner implements DispenserSigner {
  readonly kind: SignerKind = "kms";
  constructor(
    readonly role: SignerRole,
    readonly address: Address,
    private readonly keyId: string,
  ) {}
  getSigner(): Promise<TransactionSigner> {
    throw new Error(`KmsSigner not implemented (keyId=${this.keyId}); provide a KMS-delegating TransactionSigner`);
  }
}

/**
 * Sketch of a Squads-multisig backend (ADR-026 makes the authority a Squads
 * vault). A real impl proposes a Squads transaction and returns once the
 * threshold approves; for the ANT role especially this is a natural fit
 * (operator-gated, cold, multi-eyes). Interface-only here.
 */
export class SquadsSigner implements DispenserSigner {
  readonly kind: SignerKind = "squads";
  constructor(
    readonly role: SignerRole,
    readonly address: Address,
    private readonly multisig: Address,
  ) {}
  getSigner(): Promise<TransactionSigner> {
    throw new Error(`SquadsSigner not implemented (multisig=${this.multisig}); wire the Squads propose/execute flow`);
  }
}

// ---------------------------------------------------------------------------
// SignerRegistry — the worker's view of custody (token + ant roles).
// ---------------------------------------------------------------------------
export interface SignerRegistry {
  /** Hot dispenser: SPL token + vault CPIs. Holds only the float. */
  readonly token: DispenserSigner;
  /**
   * ANT custody signer. Distinct from `token` (never the hot key). May be the
   * same class (EncryptedKeypairSigner) pointed at a different key, or a
   * Squads/KMS/cold backend. `undefined` when ANT dispatch is disabled on this
   * deployment (token-only worker).
   */
  readonly ant?: DispenserSigner;
}

/** Guard: the token + ant signers MUST be different addresses (blast-radius). */
export function assertSeparableRoles(reg: SignerRegistry): void {
  if (reg.ant && reg.ant.address === reg.token.address) {
    throw new Error(
      "ANT custody signer must NOT be the hot token dispenser (separate blast radii; see §4.3)",
    );
  }
}
