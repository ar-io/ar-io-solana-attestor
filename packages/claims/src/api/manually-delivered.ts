//! Manually-delivered asset de-list (API-level).
//!
//! Some assets are delivered OUT-OF-BAND (hand-delivered on-chain to the rightful
//! owner outside the claim flow). Once delivered, custody no longer holds them, so
//! a claim would only fail at dispatch — but it must not even be OFFERED: the API
//! hides these asset_keys as a 404, exactly like `manual_review`.
//!
//! WHY an API allowlist rather than a DB status change: the bit-exact reconcile gate
//! (`src/reconcile/reconcile.ts`) counts assets by `status = 'available'`. Flipping a
//! delivered asset to a non-available status would drop the DB count below the frozen
//! authoritative derivation and FAIL reconcile. Keeping the row `available` (untouched)
//! preserves reconcile bit-for-bit; the de-list lives purely in the serving layer.
//! The frozen inputs are NEVER mutated.
//!
//! Each entry documents the delivery for audit (recipient, date, note).

export interface ManualDelivery {
  /** Human note: what happened + verification. */
  note: string;
  /** On-chain recipient the asset was delivered to (owner + update-authority). */
  deliveredTo: string;
  /** ISO date of the off-flow delivery. */
  deliveredAt: string;
}

/**
 * asset_key -> delivery record. For ANTs, asset_key == the ANT mint.
 * VERIFY on-chain before adding: custody must NOT still own the asset.
 */
export const MANUALLY_DELIVERED: Readonly<Record<string, ManualDelivery>> = {
  // Swap ANT hand-delivered 2026-07-29 to 2DXykUor. Verified on-chain: owner AND
  // update-authority both == 2DXykUor (NOT custody), so a claim's dispatch transfer
  // would fail on-chain anyway — this de-list stops it being offered/claimed at all.
  E4J7qeMYFac3YCMsH3KEkemxcQhMFfAzrpMNiba7hDNN: {
    note: "swap ANT, hand-delivered off-flow; on-chain owner+UA == 2DXykUor (verified), custody no longer holds it",
    deliveredTo: "2DXykUor86ZNK2Wfy9VVWFmQdvwRx8eteu1jJFPDrqeV",
    deliveredAt: "2026-07-29",
  },
};

/** True if this asset_key was delivered out-of-band and must be hidden (404). */
export function isManuallyDelivered(assetKey: string): boolean {
  return Object.prototype.hasOwnProperty.call(MANUALLY_DELIVERED, assetKey);
}
