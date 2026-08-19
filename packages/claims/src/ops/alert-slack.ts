//! Route firing ops alerts to Slack — opt-in + best-effort (M7 ops hardening).
//!
//! Bridges `evaluateAlerts()` (src/ops/alerts.ts) to the opt-in Slack notifier
//! (src/ops/slack.ts). Only WARNING and CRITICAL alerts are posted (info/none
//! never are). Every rule from slack.ts still holds: when `SLACK_WEBHOOK_URL` is
//! unset the notifier is a no-op, and posting is strictly fire-and-forget — a
//! Slack outage or misconfig can NEVER block, delay, or break dispatch. This
//! module never awaits the notifier and never throws.
//!
//! DE-DUP (anti-spam): a balance-low condition persists across worker ticks (every
//! ~30s). Posting the identical alert every tick would flood the channel, so the
//! long-running worker shares ONE `SlackAlertRouter` whose in-memory map records
//! the last time each alert NAME was posted:
//!   * an alert is posted the FIRST time it fires, then
//!   * at most once per `repostIntervalMs` (default 30 min) while it keeps firing
//!     — or per that alert's own entry in `repostIntervalMsByName`, which lets a
//!     slow-moving operator chore (e.g. `float-low`, which needs a 4-eyes refill
//!     and stays true for hours) repost far less often than a fast-moving one,
//!   * and its memory is cleared as soon as it stops firing, so a later re-fire
//!     posts immediately (not silenced by a stale timestamp).
//! A stateless `ops:metrics` CLI run constructs a FRESH router, so it posts each
//! firing alert once per invocation — acceptable, since it isn't a tight loop.

import type { Alert, AlertSeverity } from "./alerts.js";
import type { SlackNotify } from "./slack.js";

const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  critical: "🔴",
  warning: "🟠",
  info: "⚪",
};

/** Alerts at these severities are routed to Slack; info/none are not. */
export function isRoutableToSlack(a: Alert): boolean {
  return a.severity === "critical" || a.severity === "warning";
}

/**
 * A single Slack message for one firing alert: a severity emoji, the alert name,
 * the observed value vs its threshold, and the one-line meaning (the alert's own
 * message, which already reads as a human explanation).
 */
export function formatSlackAlert(a: Alert): string {
  const emoji = SEVERITY_EMOJI[a.severity] ?? "⚪";
  const valueVsThreshold =
    a.threshold !== undefined && a.threshold !== null
      ? `${a.value} (threshold ${a.threshold})`
      : `${a.value}`;
  return `${emoji} *${a.name}* [${a.severity}] — ${valueVsThreshold}\n${a.message}`;
}

/** Default minimum spacing between reposts of the same still-firing alert. */
export const DEFAULT_REPOST_INTERVAL_MS = 30 * 60 * 1000; // 30 min

export interface SlackAlertRouterOptions {
  /** The opt-in notifier (a no-op when SLACK_WEBHOOK_URL is unset). */
  notify: SlackNotify;
  /** Minimum ms between reposts of the SAME still-firing alert (default 30 min). */
  repostIntervalMs?: number;
  /**
   * Per-alert-name overrides of `repostIntervalMs`, by exact alert name. An alert
   * with no entry falls back to `repostIntervalMs`. Only the REPOST cadence is
   * affected — every alert still posts immediately the first time it fires, and
   * still clears when it stops firing, so nothing is ever silenced outright.
   */
  repostIntervalMsByName?: Readonly<Record<string, number>>;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * De-dupes firing alerts across ticks within one process run and posts the ones
 * that should surface to Slack. Never throws (the notifier swallows everything).
 */
export class SlackAlertRouter {
  #notify: SlackNotify;
  #interval: number;
  #intervalByName: Readonly<Record<string, number>>;
  #now: () => number;
  #lastPosted = new Map<string, number>();

  constructor(opts: SlackAlertRouterOptions) {
    this.#notify = opts.notify;
    this.#interval = opts.repostIntervalMs ?? DEFAULT_REPOST_INTERVAL_MS;
    this.#intervalByName = opts.repostIntervalMsByName ?? {};
    this.#now = opts.now ?? (() => Date.now());
  }

  /** The repost quiet-window for one alert name (its override, else the default). */
  #intervalFor(name: string): number {
    const override = this.#intervalByName[name];
    return typeof override === "number" && Number.isFinite(override) && override >= 0
      ? override
      : this.#interval;
  }

  /**
   * Post the routable (warning+critical) alerts that are due, de-duped by name.
   * Returns the names actually posted this call (for observability / tests).
   */
  post(alerts: Alert[]): string[] {
    const now = this.#now();
    const firing = new Set(alerts.filter(isRoutableToSlack).map((a) => a.name));

    // Forget alerts that have stopped firing, so a future re-fire is treated as a
    // fresh first occurrence and posts at once (not muted by a stale timestamp).
    for (const name of [...this.#lastPosted.keys()]) {
      if (!firing.has(name)) this.#lastPosted.delete(name);
    }

    const posted: string[] = [];
    for (const a of alerts) {
      if (!isRoutableToSlack(a)) continue;
      const last = this.#lastPosted.get(a.name);
      if (last !== undefined && now - last < this.#intervalFor(a.name)) continue; // still within the quiet window
      this.#lastPosted.set(a.name, now);
      this.#notify({ text: formatSlackAlert(a) }); // fire-and-forget; never awaited
      posted.push(a.name);
    }
    return posted;
  }
}
