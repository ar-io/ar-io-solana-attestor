//! One-shot CLI: generate an Ed25519 keypair for the attestor.
//!
//! Usage: `yarn keygen`
//!
//! Prints the secret seed (base58) and public key (base58) to stdout.
//!
//! - The SECRET goes into the deployment's secret store. Set it as
//!   `ATTESTOR_SECRET_BASE58` when running the service.
//! - The PUBLIC KEY gets baked into the on-chain program as the
//!   `ATTESTOR_PUBKEY` constant before deploy.
//!
//! Anyone with the secret can produce attestations; treat it accordingly.

import { randomBytes } from "node:crypto";
import * as ed25519 from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2";
import bs58 from "bs58";

ed25519.etc.sha512Sync = (...m) => sha512(ed25519.etc.concatBytes(...m));

const seed = randomBytes(32);
const publicKey = ed25519.getPublicKey(seed);

console.log("# Generated attestor keypair");
console.log("# Treat the SECRET as a private key — do not commit, log, or share.");
console.log("");
console.log(`ATTESTOR_SECRET_BASE58=${bs58.encode(seed)}`);
console.log(`ATTESTOR_PUBKEY_BASE58=${bs58.encode(publicKey)}`);
