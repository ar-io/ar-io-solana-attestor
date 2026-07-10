import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  isEthereumAddress,
  makeNormalizedAddressMap,
  normalizeSourceAddress,
} from "./normalize.js";

const AR = "9N1zO4VAUkzweAA6kedaEF1bVXdr1S6V980srj8tfUQ";
const ETH_MIXED = "0x6C785A62A9dB4E4E1F1D5EbFbEd5e0aB0B0b0B0b";
const ETH_LOWER = "0x6c785a62a9dbe4e4e1f1d5ebfbed5e0ab0b0b0b0"; // any lowercase 40-hex

describe("normalize-address", () => {
  it("detects Ethereum addresses", () => {
    assert.equal(isEthereumAddress(ETH_MIXED), true);
    assert.equal(isEthereumAddress(AR), false);
    assert.equal(isEthereumAddress("0xnothex"), false);
  });

  it("lowercases ETH, leaves Arweave/base58 unchanged", () => {
    assert.equal(normalizeSourceAddress(ETH_MIXED), ETH_MIXED.toLowerCase());
    assert.equal(normalizeSourceAddress(AR), AR); // case-sensitive
  });

  it("makeNormalizedAddressMap does case-insensitive ETH lookups (B6Nf lesson)", () => {
    // Map keyed in checksum (mixed) case; probe in lowercase and vice-versa.
    const map = makeNormalizedAddressMap<string>({ [ETH_MIXED]: "SolanaDest" });
    assert.equal(map[ETH_MIXED.toLowerCase()], "SolanaDest");
    assert.equal(map[ETH_MIXED], "SolanaDest");
    assert.equal(ETH_MIXED.toLowerCase() in map, true);
    // AR keys stay case-sensitive.
    const arMap = makeNormalizedAddressMap<string>({ [AR]: "x" });
    assert.equal(arMap[AR], "x");
    assert.equal(arMap[AR.toLowerCase()], undefined);
  });

  it("ETH_LOWER round-trips", () => {
    assert.equal(normalizeSourceAddress(ETH_LOWER), ETH_LOWER);
  });
});
