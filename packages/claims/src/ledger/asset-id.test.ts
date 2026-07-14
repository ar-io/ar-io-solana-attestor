import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  deriveStakeAssetId,
  deriveTokenAssetId,
  deriveVaultAssetId,
  toHex,
} from "./asset-id.js";

// Golden vectors computed independently (Python hashlib) — pin the exact seed
// format the deployed on-chain path (batch-escrow.ts) uses.
const AR = "9N1zO4VAUkzweAA6kedaEF1bVXdr1S6V980srj8tfUQ";
const ETH_MIXED = "0x6C785A62A9dB4E4E1F1D5EbFbEd5e0aB0B0b0B0b";

describe("asset-id derivation", () => {
  it("token asset_id == sha256(\"token-escrow:\"+addr)", () => {
    assert.equal(
      toHex(deriveTokenAssetId(AR)),
      "a8c4c200bba144a3b68ca6c15078c3b296881b85ed976f9ab1119b42b0d3ea90",
    );
  });

  it("vault asset_id == sha256(\"vault-escrow:\"+addr+\":\"+vaultId)", () => {
    assert.equal(
      toHex(deriveVaultAssetId(AR, "vault-1")),
      "18343e2c10d22b83601d0e0be6ec36123c0ba1dd040dd6ab17b8ef110fa8b1b6",
    );
  });

  it("stake asset_id == sha256(assetIdSeed)", () => {
    assert.equal(
      toHex(deriveStakeAssetId(`stake-escrow:${AR}:operator-min`)),
      "4b18ca45a53accfe2db641c1cbfd372157713f9370bce085dd3c4123f9875ed8",
    );
  });

  it("ETH token id is case-stable (checksum == lowercase) — the B6Nf lesson", () => {
    const mixed = toHex(deriveTokenAssetId(ETH_MIXED));
    const lower = toHex(deriveTokenAssetId(ETH_MIXED.toLowerCase()));
    assert.equal(mixed, lower);
    assert.equal(mixed, "a7ec39a64167b89a8a91a27898afb4fc01f0b296b03b966d0498074b9319e124");
  });

  it("produces 32 bytes", () => {
    assert.equal(deriveTokenAssetId(AR).length, 32);
    assert.equal(toHex(deriveTokenAssetId(AR)).length, 64);
  });
});
