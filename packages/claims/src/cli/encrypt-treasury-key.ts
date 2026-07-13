//! Operator tool: seal a dispenser keypair seed to an encrypted-at-rest blob (M4).
//!
//! The plaintext 32-byte Ed25519 seed NEVER touches disk in the clear. This
//! writes the AES-256-GCM SealedKey envelope (crypto-box.ts) that the worker
//! opens at runtime with a separately-injected passphrase. Mirrors the attestor's
//! keygen discipline, one at-rest encryption layer heavier (this key moves money).
//!
//! Usage (never commit the output; passphrase from a secret manager):
//!   TREASURY_KEY_PASSPHRASE=... tsx src/cli/encrypt-treasury-key.ts \
//!       --out keys/treasury.sealed.json [--generate | --seed-base64 <b64>]
//!
//! RE-KEY an existing blob (rotate the KEK / upgrade to stronger scrypt params):
//!   TREASURY_KEY_PASSPHRASE_OLD=<old> TREASURY_KEY_PASSPHRASE=<new> \
//!     tsx src/cli/encrypt-treasury-key.ts --reseal keys/treasury.sealed.json \
//!       --out keys/treasury.sealed.new.json
//!
//! Prints ONLY the derived public address — never the seed.

import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";

import { reseal, sealSecret, type SealedKey } from "../dispatch/crypto-box.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const out = arg("--out");
  if (!out) throw new Error("--out <path> is required");
  const passphrase = process.env.TREASURY_KEY_PASSPHRASE ?? process.env.ANT_SIGNER_KEY_PASSPHRASE;
  if (!passphrase) throw new Error("set TREASURY_KEY_PASSPHRASE (the runtime KEK) in the environment");

  // --- RE-KEY: open an existing blob with the OLD KEK, re-seal under the NEW ---
  const resealPath = arg("--reseal");
  if (resealPath) {
    const oldPass = process.env.TREASURY_KEY_PASSPHRASE_OLD ?? process.env.ANT_SIGNER_KEY_PASSPHRASE_OLD;
    if (!oldPass) throw new Error("set TREASURY_KEY_PASSPHRASE_OLD (the current KEK) to re-key; TREASURY_KEY_PASSPHRASE is the NEW KEK");
    const oldSealed = JSON.parse(readFileSync(resealPath, "utf8")) as SealedKey;
    const rekeyed = reseal(oldSealed, oldPass, passphrase); // strong-KEK enforced on the new one
    writeFileSync(out, JSON.stringify(rekeyed, null, 2) + "\n", { mode: 0o600 });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ok: true, out, resealedFrom: resealPath, n: rekeyed.n, note: "re-keyed at current scrypt params; swap in the new KEK + bounce the worker" }, null, 2));
    return;
  }

  let seed: Uint8Array;
  const seedB64 = arg("--seed-base64");
  if (process.argv.includes("--generate")) {
    seed = new Uint8Array(randomBytes(32));
  } else if (seedB64) {
    seed = new Uint8Array(Buffer.from(seedB64, "base64"));
    if (seed.length !== 32) throw new Error(`--seed-base64 must decode to 32 bytes, got ${seed.length}`);
  } else {
    throw new Error("provide --generate or --seed-base64 <b64>");
  }

  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const sealed = sealSecret(seed, passphrase);
  seed.fill(0);

  writeFileSync(out, JSON.stringify(sealed, null, 2) + "\n", { mode: 0o600 });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ok: true, out, address: signer.address, note: "seed sealed; keep the passphrase separate" }, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("encrypt-treasury-key failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
