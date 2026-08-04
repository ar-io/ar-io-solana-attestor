//! Opt-in Slack notifications for operator-visible events (ANT batch submissions,
//! big-claim approvals). This is ADJACENT to the money path, so the one rule that
//! governs everything here: a Slack outage or misconfig must NEVER block, delay, or
//! break dispatch/approve.
//!
//! Enforcement:
//!   * OFF by default — an empty/undefined `SLACK_WEBHOOK_URL` yields a no-op notifier
//!     (feature is opt-in, exactly like `CORS_ALLOWED_ORIGINS`).
//!   * FIRE-AND-FORGET — the returned function kicks off the POST and returns
//!     immediately. Callers MUST NOT await it and it NEVER throws.
//!   * SWALLOW — a non-2xx response or a network/timeout error is caught, logged via
//!     the optional `log` hook, and never propagated (no unhandled rejection either,
//!     because `postSlack` catches internally).
//!
//! Dependency-free: global `fetch` + `AbortSignal.timeout` (Node ≥20).

/** A fire-and-forget Slack sink. Never throws, never returns a promise to await. */
export type SlackNotify = (msg: { text: string; blocks?: unknown[] }) => void;

/**
 * Build a Slack notifier. When `webhookUrl` is empty/undefined, returns a no-op
 * (the feature is opt-in and off by default). Otherwise returns a fire-and-forget
 * function that POSTs each message to the webhook without ever blocking or throwing.
 */
export function makeSlackNotifier(
  webhookUrl: string | undefined,
  log?: (m: string, meta?: unknown) => void,
): SlackNotify {
  const url = webhookUrl?.trim();
  if (!url) return () => {}; // opt-in: no webhook => no-op, posts nothing.
  return (msg) => {
    // Kick off the POST and return immediately. `postSlack` catches everything, so
    // this can never throw here or leave an unhandled rejection.
    void postSlack(url, msg, log);
  };
}

/**
 * POST one message to a Slack incoming webhook. Bounded by a 5s timeout. On any
 * non-2xx response or network/timeout error the failure is swallowed and logged —
 * it is NEVER propagated, so a Slack problem cannot surface on the money path.
 */
async function postSlack(
  url: string,
  msg: { text: string; blocks?: unknown[] },
  log?: (m: string, meta?: unknown) => void,
): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: msg.text, blocks: msg.blocks }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`slack webhook HTTP ${res.status}`);
  } catch (err) {
    log?.("slack notify failed", { err });
  }
}
