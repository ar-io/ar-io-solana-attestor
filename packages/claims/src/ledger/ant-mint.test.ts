import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  ANT_MINT_FIXTURES,
  ANT_MINT_TEST_SECRET,
  assertAntMintDerivation,
  deriveAntMintBase58,
  loadAntMintSecret,
} from "./ant-mint.js";

describe("ant-mint derivation", () => {
  it("matches the frozen golden fixtures (== web3.js Keypair.fromSeed)", () => {
    // These fixtures are the same values as the authoritative
    // migration/import + migration/snapshot derive-ant-mint.ts fixtures, which
    // were produced by web3.js. Passing here proves the noble/kit derivation is
    // byte-identical to the deployed one — no web3.js in claims runtime.
    for (const { aoProcessId, expectedPubkey } of ANT_MINT_FIXTURES) {
      assert.equal(deriveAntMintBase58(aoProcessId, ANT_MINT_TEST_SECRET), expectedPubkey);
    }
  });

  it("assertAntMintDerivation() does not throw", () => {
    assert.doesNotThrow(() => assertAntMintDerivation());
  });

  it("different secret => different mint", () => {
    const other = new Uint8Array(32).fill(7);
    assert.notEqual(
      deriveAntMintBase58("a", ANT_MINT_TEST_SECRET),
      deriveAntMintBase58("a", other),
    );
  });

  it("loadAntMintSecret validates base64 + length", () => {
    assert.throws(() => loadAntMintSecret({}), /required/);
    assert.throws(() => loadAntMintSecret({ ANT_MINT_SECRET: "not base64!!" }), /base64/);
    assert.throws(
      () => loadAntMintSecret({ ANT_MINT_SECRET: Buffer.alloc(16).toString("base64") }),
      /32 bytes/,
    );
    const ok = Buffer.alloc(32, 3).toString("base64");
    assert.equal(loadAntMintSecret({ ANT_MINT_SECRET: ok }).length, 32);
  });
});
