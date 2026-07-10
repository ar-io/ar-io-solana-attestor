//! HTTP error taxonomy for the claims API (M3).
//!
//! `ApiError` is a deterministic, client-facing rejection carrying a stable
//! machine `code` and the HTTP status the route should return. The M2
//! `VerificationError` codes map 1:1 onto HTTP statuses here (pivot plan §4.1):
//!   401  proof did not verify (RSA/ETH signature invalid, address mismatch)
//!   409  state conflict (already claimed, in-flight, nonce/challenge)
//!   422  malformed-but-typed proof (protocol/recipient mismatch, high-S, …)
//!   400  structurally invalid request
//!   404  unknown asset / claim / recipient
//!   429  rate limited
//!
//! Anything NOT an ApiError bubbling out of a handler is an infrastructure
//! fault (500) — never a "this claim is invalid" signal.

import { VerificationError, type VerificationErrorCode } from "../verify/index.js";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** HTTP status for each M2 verification code (pivot plan §4.1 status table). */
const VERIFY_STATUS: Record<VerificationErrorCode, number> = {
  // Signature simply does not authorize the release → 401 Unauthorized.
  RSA_SIGNATURE_INVALID: 401,
  SIGNATURE_VERIFICATION_FAILED: 401,
  ETHEREUM_ADDRESS_MISMATCH: 401,
  // Typed-but-wrong proof fields → 422 Unprocessable Entity.
  PROTOCOL_MISMATCH: 422,
  ASSET_TYPE_MISMATCH: 422,
  RECIPIENT_ID_MISMATCH: 422,
  MODULUS_MISMATCH: 422,
  INVALID_RECOVERY_ID: 422,
  ECDSA_HIGH_S: 422,
  UNSUPPORTED_SALT_LENGTH: 422,
  LOCK_DURATION_TOO_LONG: 422,
  // Stale nonce is a state conflict → 409 Conflict.
  NONCE_MISMATCH: 409,
  // Structurally malformed input → 400 Bad Request.
  INVALID_INPUT: 400,
};

/** Convert an M2 `VerificationError` into the API's HTTP shape. */
export function fromVerificationError(e: VerificationError): ApiError {
  const status = VERIFY_STATUS[e.code] ?? 401;
  return new ApiError(status, e.code, e.message);
}

/** Wrap any thrown value as an ApiError (VerificationError → mapped; else 500). */
export function toApiError(e: unknown): ApiError {
  if (isApiError(e)) return e;
  if (e instanceof VerificationError) return fromVerificationError(e);
  return new ApiError(500, "INTERNAL", (e as Error)?.message ?? "internal error");
}
