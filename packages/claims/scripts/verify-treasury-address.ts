//! verify-treasury-address.ts — Prove the sealed treasury key matches the funding
//! target WITHOUT the passphrase ever reaching argv, an env var, shell history, or
//! any agent's context.
//!
//! It unseals TREASURY_KEY_SEALED_PATH via the DISPATCH WORKER'S OWN code path
//! (`EncryptedKeypairSigner.load` -> `openSecret` + `createKeyPairSignerFromPrivateKeyBytes`,
//! i.e. exactly what the worker runs to sign dispenses) and prints ONLY the derived
//! Solana address. Compare that address to your expected TREASURY_ADDRESS yourself.
//!
//! The passphrase (KEK) is read from STDIN so it is never an argument, never an
//! env var, and never stored in shell history. Run it like this — the `read -rs`
//! prompt keeps the secret off the terminal and out of history:
//!
//!     read -rs -p "Treasury KEK passphrase: " P; echo
//!     printf %s "$P" | node --import tsx packages/claims/scripts/verify-treasury-address.ts
//!     unset P
//!
//! Optional: override the sealed blob path with TREASURY_KEY_SEALED_PATH
//! (default /opt/claims-secure/treasury.sealed.json). Exit codes: 0 printed an
//! address; 1 unseal failed (bad passphrase / tampered blob); 2 no passphrase on stdin.

import { readFileSync } from "node:fs";
import { EncryptedKeypairSigner } from "../src/dispatch/signer.js";
import type { SealedKey } from "../src/dispatch/crypto-box.js";

const sealedPath = process.env.TREASURY_KEY_SEALED_PATH ?? "/opt/claims-secure/treasury.sealed.json";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  // Passphrase comes ONLY from stdin (fed by `read -rs`). Strip a single trailing newline.
  const passphrase = (await readStdin()).replace(/\r?\n$/, "");
  if (!passphrase) {
    console.error("no passphrase on stdin — run:  read -rs P; echo; printf %s \"$P\" | node --import tsx <this>");
    process.exit(2);
  }
  const sealed = JSON.parse(readFileSync(sealedPath, "utf8")) as SealedKey;
  // The worker's exact unseal path. `.load` throws on a wrong passphrase or a
  // tampered blob (GCM auth-tag failure), so a printed address is itself proof
  // the passphrase is correct and the blob is intact.
  const signer = await EncryptedKeypairSigner.load("token", sealed, passphrase);
  // Print ONLY the address — nothing else.
  console.log(signer.address);
}

main().catch((e) => {
  console.error("unseal FAILED:", (e as Error).message);
  process.exit(1);
});
