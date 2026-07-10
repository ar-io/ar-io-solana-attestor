//! chain: TOCTOU-safe expiry classification (the fix for the double-send seam).
//!
//! `confirmSignature` must sample block HEIGHT *before* the status read, and only
//! call a not-found signature `expired` when the height sampled BEFORE the read
//! was already strictly past `lastValidBlockHeight`. Otherwise a tx landing in
//! its final valid slot between the two reads is misclassified `expired` -> the
//! worker re-signs -> DOUBLE SEND.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { Rpc, SolanaRpcApi } from "@solana/kit";

import { SolanaChainGateway } from "./chain.js";

type StatusValue = { err: unknown; confirmationStatus: string | null } | null;

/** Minimal KitRpc stub recording call order; getBlockHeight + getSignatureStatuses only. */
function stubRpc(opts: { height: bigint; status: StatusValue }): { rpc: Rpc<SolanaRpcApi>; calls: string[] } {
  const calls: string[] = [];
  const rpc = {
    getBlockHeight: () => ({
      send: async () => {
        calls.push("getBlockHeight");
        return opts.height;
      },
    }),
    getSignatureStatuses: (_sigs: unknown, _cfg: unknown) => ({
      send: async () => {
        calls.push("getSignatureStatuses");
        return { value: [opts.status] };
      },
    }),
  } as unknown as Rpc<SolanaRpcApi>;
  return { rpc, calls };
}

const SIG = "5".repeat(64);

describe("SolanaChainGateway.confirmSignature — TOCTOU-safe expiry", () => {
  it("samples getBlockHeight BEFORE getSignatureStatuses (order matters)", async () => {
    const { rpc, calls } = stubRpc({ height: 50n, status: null });
    const gw = new SolanaChainGateway(rpc, { confirmTimeoutMs: 0, confirmPollMs: 1 });
    await gw.confirmSignature(SIG, 100n);
    assert.deepEqual(calls, ["getBlockHeight", "getSignatureStatuses"]);
  });

  it("last-slot land: not-found at height == lastValid -> PENDING, never expired", async () => {
    // height (sampled first) == lastValidBlockHeight (NOT strictly greater), sig
    // not yet visible -> must be pending (the tx can still land at this slot).
    const { rpc } = stubRpc({ height: 100n, status: null });
    const gw = new SolanaChainGateway(rpc, { confirmTimeoutMs: 0, confirmPollMs: 1 });
    const state = await gw.confirmSignature(SIG, 100n);
    assert.equal(state, "pending");
  });

  it("provably dead: not-found at height strictly > lastValid -> EXPIRED", async () => {
    const { rpc } = stubRpc({ height: 101n, status: null });
    const gw = new SolanaChainGateway(rpc, { confirmTimeoutMs: 0, confirmPollMs: 1 });
    const state = await gw.confirmSignature(SIG, 100n);
    assert.equal(state, "expired");
  });

  it("a tx that DID land at its last slot is confirmed regardless of height", async () => {
    const { rpc } = stubRpc({ height: 101n, status: { err: null, confirmationStatus: "confirmed" } });
    const gw = new SolanaChainGateway(rpc, { confirmTimeoutMs: 0, confirmPollMs: 1 });
    const state = await gw.confirmSignature(SIG, 100n);
    assert.equal(state, "confirmed");
  });

  it("an on-chain error is reported failed, never expired/pending", async () => {
    const { rpc } = stubRpc({ height: 200n, status: { err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" } });
    const gw = new SolanaChainGateway(rpc, { confirmTimeoutMs: 0, confirmPollMs: 1 });
    const state = await gw.confirmSignature(SIG, 100n);
    assert.equal(state, "failed");
  });
});
