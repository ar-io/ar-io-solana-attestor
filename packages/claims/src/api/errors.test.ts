//! ApiError mapping unit tests.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { VerificationError } from "../verify/index.js";
import { ApiError, fromVerificationError, isApiError, toApiError } from "./errors.js";

describe("error mapping", () => {
  it("maps signature failures to 401", () => {
    for (const code of ["RSA_SIGNATURE_INVALID", "SIGNATURE_VERIFICATION_FAILED", "ETHEREUM_ADDRESS_MISMATCH"] as const) {
      const a = fromVerificationError(new VerificationError(code, "x"));
      assert.equal(a.status, 401);
      assert.equal(a.code, code);
    }
  });

  it("maps typed-proof faults to 422", () => {
    for (const code of ["PROTOCOL_MISMATCH", "ECDSA_HIGH_S", "INVALID_RECOVERY_ID", "RECIPIENT_ID_MISMATCH", "UNSUPPORTED_SALT_LENGTH"] as const) {
      assert.equal(fromVerificationError(new VerificationError(code, "x")).status, 422);
    }
  });

  it("maps stale nonce to 409 and malformed input to 400", () => {
    assert.equal(fromVerificationError(new VerificationError("NONCE_MISMATCH", "x")).status, 409);
    assert.equal(fromVerificationError(new VerificationError("INVALID_INPUT", "x")).status, 400);
  });

  it("toApiError passes ApiError through and wraps VerificationError; unknown -> 500", () => {
    const a = new ApiError(409, "ALREADY_CLAIMED", "x");
    assert.equal(toApiError(a), a);
    assert.equal(toApiError(new VerificationError("ECDSA_HIGH_S", "x")).status, 422);
    const five = toApiError(new Error("boom"));
    assert.equal(five.status, 500);
    assert.equal(isApiError(five), true);
  });
});
