// AntAdminPanel — REFERENCE ONLY (not compiled by the backend tsconfig).
//
// Operator admin view for the wallet-signed ANT dispatch flow
// (docs/claims/ANT_OPERATOR_SIGNING_SPEC.md §8). Folds into the rebuilt claim
// frontend as a gated `/admin/ants` route. Not browser-tested in this repo — it is
// a clean, reviewable spec of the exact client<->server protocol.
//
// WRITE actions are each INDIVIDUALLY wallet-authorized (this is deliberate — every
// money-moving action gets its own signature):
//   build  → a challenge sig bound to "build"
//   submit → a challenge sig bound to "submit"
//   plus   → one wallet.signAllTransactions over the batch (the on-chain authority)
// READ polling uses a short-lived read token (POST /session, one sig) — no wallet
// prompt per poll.
//
// So a batch costs THREE wallet interactions: sign(build-challenge),
// signAllTransactions(batch), sign(submit-challenge). (Plus one sign for the read
// session, reused across polls.) It is NOT "one prompt per batch".
//
// HARD RULE: sign-only, never signAndSend — the SERVER broadcasts, preserving
// persist-before-broadcast (exactly-once). And NO blind-signing: the operator
// reviews the decoded batch (recipient, mint, count) before authorizing.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { VersionedTransaction } from "@solana/web3.js";

const ANT_COLD_ADDRESS = (import.meta as { env?: Record<string, string> }).env?.VITE_ANT_COLD_ADDRESS ?? "";
const API_BASE = (import.meta as { env?: Record<string, string> }).env?.VITE_CLAIMS_API_BASE ?? "";
const CHALLENGE_PREFIX = "ar.io-ant-admin:";
const POLL_MS = 4000;

type Action = "session" | "build" | "submit";

interface BatchItem {
  claimId: string;
  assetKey: string;
  antMint: string;
  claimant: string;
  txBase64: string;
  txid: string;
  lastValidBlockHeight: string;
}
interface SubmitResult { txid?: string; claimId?: string; outcome: string; signature?: string; detail?: string }
interface BatchStatus {
  batchId: string;
  status: string;
  submittedAt: string | null;
  claimCount: number;
  claims: { claimId: string; status: string; dispatchSignature: string | null }[];
}

const b64 = {
  encode: (b: Uint8Array): string => btoa(String.fromCharCode(...b)),
  decode: (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};

const TERMINAL_CLAIM = new Set(["confirmed", "failed", "needs_operator", "claimed"]);
const TERMINAL_BATCH = new Set(["completed", "expired"]);
function batchIsTerminal(s: BatchStatus | null): boolean {
  if (!s) return false;
  if (TERMINAL_BATCH.has(s.status)) return true;
  return s.claims.length > 0 && s.claims.every((c) => TERMINAL_CLAIM.has(c.status));
}

// Outcome → display: never render a success-looking explorer link for a
// non-success outcome (F7).
function outcomeStyle(outcome: string): { color: string; label: string; link: boolean } {
  if (outcome === "confirmed" || outcome === "recovered_confirmed") return { color: "#127c2b", label: "confirmed", link: true };
  if (outcome === "already_confirmed") return { color: "#555", label: "already confirmed", link: true };
  if (outcome === "awaiting_confirmation") return { color: "#8a6d00", label: "confirming…", link: true };
  if (outcome === "released_for_rebuild") return { color: "#8a6d00", label: "released — rebuild", link: false };
  return { color: "#b00", label: outcome, link: false }; // failed / needs_operator / rejected_*
}

export function AntAdminPanel(): JSX.Element {
  const { publicKey, signMessage, signAllTransactions, connected } = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ count: number; oldestAgeSeconds: number | null } | null>(null);
  const [batch, setBatch] = useState<{ batchId: string; items: BatchItem[] } | null>(null);
  const [results, setResults] = useState<SubmitResult[] | null>(null);
  const [status, setStatus] = useState<BatchStatus | null>(null);
  const [submitUnknown, setSubmitUnknown] = useState(false);
  const readTokenRef = useRef<{ token: string; expiresAt: number } | null>(null);

  const walletOk = useMemo(
    () => connected && !!publicKey && publicKey.toBase58() === ANT_COLD_ADDRESS,
    [connected, publicKey],
  );

  // F4 — reset ALL batch/session state when the wallet changes or disconnects.
  useEffect(() => {
    readTokenRef.current = null;
    setBatch(null);
    setResults(null);
    setStatus(null);
    setSubmitUnknown(false);
    setError(null);
  }, [publicKey, connected]);

  // Sign an action-bound challenge (build/submit/session each get their own sig).
  const signChallenge = useCallback(async (action: Action): Promise<{ nonce: string; sig: string }> => {
    if (!signMessage) throw new Error("wallet cannot signMessage");
    const res = await fetch(`${API_BASE}/v1/admin/ant/challenge`);
    if (!res.ok) throw new Error(`challenge failed: ${res.status}`);
    const { nonce } = (await res.json()) as { nonce: string };
    const sigBytes = await signMessage(new TextEncoder().encode(`${CHALLENGE_PREFIX}${action}:${nonce}`));
    return { nonce, sig: b64.encode(sigBytes) };
  }, [signMessage]);

  const ensureReadToken = useCallback(async (): Promise<string> => {
    const cached = readTokenRef.current;
    if (cached && cached.expiresAt - 15_000 > Date.now()) return cached.token;
    const auth = await signChallenge("session");
    const res = await fetch(`${API_BASE}/v1/admin/ant/session`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(auth),
    });
    if (!res.ok) throw new Error(`session failed: ${res.status}`);
    const { readToken, expiresAt } = (await res.json()) as { readToken: string; expiresAt: string };
    readTokenRef.current = { token: readToken, expiresAt: new Date(expiresAt).getTime() };
    return readToken;
  }, [signChallenge]);

  // GET a read route with the session token; on 401 (e.g. ops restart) drop the
  // token and retry ONCE (F2).
  const readGet = useCallback(async (path: string): Promise<Response> => {
    let token = await ensureReadToken();
    let res = await fetch(`${API_BASE}${path}`, { headers: { "x-ant-read-token": token } });
    if (res.status === 401) {
      readTokenRef.current = null;
      token = await ensureReadToken();
      res = await fetch(`${API_BASE}${path}`, { headers: { "x-ant-read-token": token } });
    }
    return res;
  }, [ensureReadToken]);

  const refreshPending = useCallback(async () => {
    setError(null);
    try {
      const res = await readGet("/v1/admin/ant/pending");
      if (!res.ok) throw new Error(`pending failed: ${res.status}`);
      setPending((await res.json()) as { count: number; oldestAgeSeconds: number | null });
    } catch (e) { setError((e as Error).message); }
  }, [readGet]);

  const pollStatus = useCallback(async (id: string) => {
    try {
      const res = await readGet(`/v1/admin/ant/batch/${id}`);
      if (res.ok) setStatus((await res.json()) as BatchStatus);
    } catch (e) { setError((e as Error).message); }
  }, [readGet]);

  // Step 1: BUILD (a "build"-bound challenge). Renders the batch for REVIEW — the
  // operator must then explicitly confirm before any transaction is signed (F1).
  const buildBatch = useCallback(async () => {
    if (busy) return;
    if (!walletOk) { setError("connect the ANT authority wallet (pubkey must equal ANT_COLD_ADDRESS)"); return; }
    setBusy(true); setError(null); setResults(null); setStatus(null); setSubmitUnknown(false);
    try {
      const auth = await signChallenge("build");
      const res = await fetch(`${API_BASE}/v1/admin/ant/batch`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(auth),
      });
      if (!res.ok) throw new Error(`build failed: ${res.status} ${await res.text()}`);
      const b = (await res.json()) as { batchId: string; items: BatchItem[] };
      setBatch(b);
      if (b.items.length === 0) setError("no ANT claims are currently eligible");
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, [busy, walletOk, signChallenge]);

  // Step 2: after REVIEW, confirm → signAllTransactions (sign-only) → submit.
  const confirmSignSubmit = useCallback(async () => {
    if (busy) return; // F5 — no double-submit re-entrancy
    if (!batch || batch.items.length === 0) return;
    if (!signAllTransactions) { setError("wallet cannot signAllTransactions"); return; }
    setBusy(true); setError(null); setSubmitUnknown(false);
    try {
      const txs = batch.items.map((it) => VersionedTransaction.deserialize(b64.decode(it.txBase64)));
      const signed = await signAllTransactions(txs);
      const signedTxs = signed.map((t) => b64.encode(t.serialize()));
      const auth = await signChallenge("submit");
      let res: Response;
      try {
        res = await fetch(`${API_BASE}/v1/admin/ant/batch/${batch.batchId}/submit`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...auth, signedTxs }),
        });
      } catch (netErr) {
        // F3 — the request may have reached the server; do NOT imply nothing happened.
        setSubmitUnknown(true);
        throw new Error(`submit request failed (result UNKNOWN): ${(netErr as Error).message}`);
      }
      if (!res.ok) throw new Error(`submit failed: ${res.status} ${await res.text()}`);
      setResults(((await res.json()) as { results: SubmitResult[] }).results);
      await pollStatus(batch.batchId);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, [busy, batch, signAllTransactions, signChallenge, pollStatus]);

  // F6 — bounded auto-poll while the batch status is non-terminal.
  useEffect(() => {
    if (!batch || batchIsTerminal(status)) return;
    if (!results && !submitUnknown) return; // only poll once a submit has been attempted
    const h = setInterval(() => void pollStatus(batch.batchId), POLL_MS);
    return () => clearInterval(h);
  }, [batch, status, results, submitUnknown, pollStatus]);

  return (
    <div style={{ maxWidth: 820, margin: "2rem auto", fontFamily: "system-ui" }}>
      <h1>ANT dispatch — operator console</h1>
      <p style={{ color: "#666" }}>
        Connect the ANT <strong>authority</strong> wallet. The treasury pays fees; your wallet only
        authorizes the transfers. Each action (build, submit) is signed separately, and you review the
        batch before signing — nothing is sent by your wallet, the server broadcasts.
      </p>

      <WalletMultiButton />
      {connected && !walletOk && (
        <p style={{ color: "#b00" }}>
          Connected wallet {publicKey?.toBase58()} is NOT the ANT authority. Connect <code>{ANT_COLD_ADDRESS}</code>.
        </p>
      )}

      <div style={{ marginTop: 16, display: "flex", gap: 12 }}>
        <button onClick={refreshPending} disabled={!walletOk || busy}>Refresh pending</button>
        <button onClick={buildBatch} disabled={!walletOk || busy}>{busy ? "Working…" : "Build batch"}</button>
        {batch && <button onClick={() => pollStatus(batch.batchId)} disabled={busy}>Refresh status</button>}
      </div>

      {pending && (
        <p style={{ marginTop: 12 }}>
          <strong>{pending.count}</strong> ANT claim(s) awaiting dispatch
          {pending.oldestAgeSeconds != null && ` · oldest ~${Math.round(pending.oldestAgeSeconds / 3600)}h`}.
        </p>
      )}
      {error && <pre style={{ color: "#b00", whiteSpace: "pre-wrap" }}>{error}</pre>}

      {/* F1 — REVIEW the decoded batch before signing. Catch "50 when I expected 3". */}
      {batch && !results && batch.items.length > 0 && (
        <div style={{ marginTop: 16, border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
          <h3>Review {batch.items.length} transfer(s) before signing</h3>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
            <thead>
              <tr><th align="left">Claim</th><th align="left">ANT mint</th><th align="left">→ recipient</th><th align="left">asset</th></tr>
            </thead>
            <tbody>
              {batch.items.map((it) => (
                <tr key={it.claimId} style={{ borderTop: "1px solid #eee" }}>
                  <td><code>{it.claimId.slice(0, 8)}</code></td>
                  <td><code>{it.antMint}</code></td>
                  <td><code>{it.claimant}</code></td>
                  <td><code>{it.assetKey.slice(0, 10)}…</code></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 12, display: "flex", gap: 12 }}>
            <button onClick={confirmSignSubmit} disabled={busy} style={{ fontWeight: 600 }}>
              Confirm &amp; sign {batch.items.length} transfer{batch.items.length === 1 ? "" : "s"}
            </button>
            <button onClick={() => setBatch(null)} disabled={busy}>Cancel</button>
          </div>
        </div>
      )}

      {/* F3 — submit outcome unknown: keep the batchId prominent, don't imply nothing landed. */}
      {submitUnknown && batch && (
        <p style={{ marginTop: 12, color: "#8a6d00" }}>
          Submit result UNKNOWN for batch <code>{batch.batchId}</code> — the request may have reached the
          server. Press <strong>Refresh status</strong> to see what actually landed. Do NOT rebuild blindly.
        </p>
      )}

      {results && (
        <table style={{ marginTop: 16, borderCollapse: "collapse", width: "100%" }}>
          <thead><tr><th align="left">Claim</th><th align="left">Outcome</th><th align="left">Tx</th></tr></thead>
          <tbody>
            {results.map((r, i) => {
              const s = outcomeStyle(r.outcome);
              return (
                <tr key={i} style={{ borderTop: "1px solid #eee" }}>
                  <td><code>{r.claimId?.slice(0, 8) ?? "—"}</code></td>
                  <td style={{ color: s.color }}>{s.label}</td>
                  <td>
                    {s.link && r.signature
                      ? <a href={`https://explorer.solana.com/tx/${r.signature}`} target="_blank" rel="noreferrer">{r.signature.slice(0, 8)}…</a>
                      : <span style={{ color: "#999" }}>{r.detail ?? "—"}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {status && (
        <p style={{ marginTop: 12, color: "#666" }}>
          Batch <code>{status.batchId.slice(0, 8)}</code> · {status.status} ·{" "}
          {status.claims.filter((c) => c.status === "confirmed").length}/{status.claimCount} confirmed
          {batchIsTerminal(status) ? " · done" : " · polling…"}
        </p>
      )}
    </div>
  );
}
