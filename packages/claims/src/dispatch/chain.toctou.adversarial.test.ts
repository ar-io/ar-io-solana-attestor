//! chain — ADVERSARIAL TOCTOU re-attack (tester round 2).
//!
//! The fix samples getBlockHeight BEFORE getSignatureStatuses and only calls a
//! not-found sig `expired` when the pre-read height was already strictly past
//! lastValidBlockHeight. The dev's chain.test.ts stubs FIXED values; this suite
//! attacks the actual race with a CONSISTENT node whose height advances BETWEEN
//! the two reads inside one classify() — the exact timing that could
//! misclassify a last-valid-slot landing as `expired` -> re-sign -> double-send.
//!
//! Invariant proven: on a single consistent (monotonic) RPC, a tx that landed in
//! any valid slot is NEVER classified `expired`. The one way to still break it is
//! an INCONSISTENT multi-endpoint pool — the documented CONFIRM_RPC_URL /
//! assertSingleConfirmRpc operational requirement — asserted last to lock it in.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { Rpc, SolanaRpcApi } from "@solana/kit";

import { SolanaChainGateway } from "./chain.js";

const SIG = "5".repeat(64);

/**
 * A CONSISTENT node: ONE monotonically-advancing block height. A tx that landed
 * at `landSlot` becomes visible to getSignatureStatuses(searchTransactionHistory)
 * once the node's height >= landSlot. Each getBlockHeight advances the chain by
 * `advancePerCall`, modelling the chain moving between the height-read and the
 * status-read within a single #statusOnce.
 */
function consistentNode(opts: { start: bigint; advancePerCall: bigint; landSlot: bigint | null }): Rpc<SolanaRpcApi> {
  let h = opts.start;
  return {
    getBlockHeight: () => ({
      send: async () => {
        const cur = h;
        h += opts.advancePerCall;
        return cur;
      },
    }),
    getSignatureStatuses: (_s: unknown, _c: unknown) => ({
      send: async () => {
        const landed = opts.landSlot !== null && h >= opts.landSlot;
        return { value: [landed ? { err: null, confirmationStatus: "confirmed" } : null] };
      },
    }),
  } as unknown as Rpc<SolanaRpcApi>;
}

function gw(rpc: Rpc<SolanaRpcApi>): SolanaChainGateway {
  return new SolanaChainGateway(rpc, { confirmTimeoutMs: 0, confirmPollMs: 1 });
}

describe("chain TOCTOU — consistent-node re-attack (no landed tx is ever 'expired')", () => {
  it("tx lands at EXACTLY lastValid, height read == lastValid, chain advances -> confirmed", async () => {
    // height-read sees 100 (== lastValid, NOT strictly greater); status read at
    // 101 sees the landing at slot 100 -> confirmed. Never expired.
    const state = await gw(consistentNode({ start: 100n, advancePerCall: 1n, landSlot: 100n })).confirmSignature(SIG, 100n);
    assert.equal(state, "confirmed");
  });

  it("height already > lastValid but the tx DID land at lastValid (consistent) -> confirmed, not expired", async () => {
    // The dangerous case: pre-read height 101 > lastValid 100. On a consistent
    // node the status read (height >= 101) still sees the slot-100 landing.
    const state = await gw(consistentNode({ start: 101n, advancePerCall: 1n, landSlot: 100n })).confirmSignature(SIG, 100n);
    assert.equal(state, "confirmed");
  });

  it("not-found at height == lastValid -> pending (the tx can still land this slot)", async () => {
    const state = await gw(consistentNode({ start: 100n, advancePerCall: 0n, landSlot: null })).confirmSignature(SIG, 100n);
    assert.equal(state, "pending");
  });

  it("never lands + height strictly > lastValid -> expired (genuinely dead)", async () => {
    const state = await gw(consistentNode({ start: 101n, advancePerCall: 1n, landSlot: null })).confirmSignature(SIG, 100n);
    assert.equal(state, "expired");
  });

  it("RESIDUAL: an INCONSISTENT pool (ahead height + behind status) can still misclassify a landed tx", async () => {
    // Documents the operational requirement: the confirm reads MUST be a single
    // consistent endpoint (assertSingleConfirmRpc / CONFIRM_RPC_URL). A pool that
    // serves getBlockHeight from an AHEAD replica and getSignatureStatuses from a
    // BEHIND replica (which has not yet indexed the landing) returns `expired` for
    // a tx that actually landed -> the worker would re-sign. This is NOT fixable
    // in the classifier; it is why production must pin a single consistent RPC.
    const inconsistentPool = {
      getBlockHeight: () => ({ send: async () => 101n }), // ahead replica
      getSignatureStatuses: (_s: unknown, _c: unknown) => ({ send: async () => ({ value: [null] }) }), // behind replica misses the landing
    } as unknown as Rpc<SolanaRpcApi>;
    const state = await gw(inconsistentPool).confirmSignature(SIG, 100n);
    assert.equal(state, "expired", "documents the single-consistent-RPC requirement (multi-endpoint pool breaks 'provably dead')");
  });
});
