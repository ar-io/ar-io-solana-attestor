//! Slack alert routing — posts warning+critical (never info), de-dupes within a
//! run, and (like the notifier it wraps) can NEVER throw on a broken webhook.

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import type { Alert } from "./alerts.js";
import { makeSlackNotifier } from "./slack.js";
import {
  DEFAULT_REPOST_INTERVAL_MS,
  SlackAlertRouter,
  formatSlackAlert,
  isRoutableToSlack,
} from "./alert-slack.js";

const alert = (name: string, severity: Alert["severity"], extra: Partial<Alert> = {}): Alert => ({
  name,
  severity,
  message: `${name} meaning`,
  value: extra.value ?? "1",
  threshold: extra.threshold,
});

/** A notifier that records posts synchronously (no real fetch). */
function recordingNotifier(): { notify: ReturnType<typeof makeSlackNotifier>; texts: string[] } {
  const texts: string[] = [];
  return { notify: (msg) => { texts.push(msg.text); }, texts };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("formatSlackAlert", () => {
  it("uses a severity emoji and includes name, value/threshold, and the meaning", () => {
    const crit = formatSlackAlert(alert("dispenser-sol-low", "critical", { value: "10", threshold: "500" }));
    assert.ok(crit.includes("🔴"), "critical => red");
    assert.ok(crit.includes("dispenser-sol-low"));
    assert.ok(crit.includes("10 (threshold 500)"));
    assert.ok(crit.includes("dispenser-sol-low meaning"));

    const warn = formatSlackAlert(alert("float-low", "warning", { value: "7" }));
    assert.ok(warn.includes("🟠"), "warning => orange");
    assert.ok(warn.includes("float-low"));
    assert.ok(!warn.includes("threshold"), "no threshold clause when threshold is undefined");
  });
});

describe("isRoutableToSlack", () => {
  it("routes critical + warning, never info", () => {
    assert.equal(isRoutableToSlack(alert("a", "critical")), true);
    assert.equal(isRoutableToSlack(alert("b", "warning")), true);
    assert.equal(isRoutableToSlack(alert("c", "info")), false);
  });
});

describe("SlackAlertRouter", () => {
  it("posts warning + critical but NOT info", () => {
    const { notify, texts } = recordingNotifier();
    const router = new SlackAlertRouter({ notify });
    const posted = router.post([
      alert("dispenser-sol-low", "critical"),
      alert("float-low", "warning"),
      alert("some-info", "info"),
    ]);
    assert.deepEqual(posted.sort(), ["dispenser-sol-low", "float-low"]);
    assert.equal(texts.length, 2);
    assert.equal(texts.some((t) => t.includes("some-info")), false);
  });

  it("de-dupes: a persistent alert is NOT reposted on an immediate second eval", () => {
    let clock = 1_000_000;
    const { notify, texts } = recordingNotifier();
    const router = new SlackAlertRouter({ notify, now: () => clock });

    assert.deepEqual(router.post([alert("dispenser-sol-low", "critical")]), ["dispenser-sol-low"]);
    clock += 30_000; // ~one worker tick later, still firing
    assert.deepEqual(router.post([alert("dispenser-sol-low", "critical")]), [], "no repost within the quiet window");
    assert.equal(texts.length, 1, "posted exactly once");
  });

  it("reposts once the repost interval elapses while still firing", () => {
    let clock = 0;
    const { notify, texts } = recordingNotifier();
    const router = new SlackAlertRouter({ notify, now: () => clock });

    router.post([alert("float-low", "warning")]);
    clock += DEFAULT_REPOST_INTERVAL_MS + 1;
    const posted = router.post([alert("float-low", "warning")]);
    assert.deepEqual(posted, ["float-low"]);
    assert.equal(texts.length, 2);
  });

  it("re-fires immediately after the condition clears and returns (memory reset)", () => {
    let clock = 0;
    const { notify, texts } = recordingNotifier();
    const router = new SlackAlertRouter({ notify, now: () => clock });

    router.post([alert("float-low", "warning")]);           // first fire -> posts
    clock += 1000;
    router.post([]);                                         // condition cleared -> memory forgotten
    clock += 1000;
    const posted = router.post([alert("float-low", "warning")]); // re-fires -> posts again at once
    assert.deepEqual(posted, ["float-low"]);
    assert.equal(texts.length, 2);
  });

  it("a rejecting fetch through the real notifier does NOT throw", async () => {
    globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;
    const logged: string[] = [];
    const notify = makeSlackNotifier("https://hooks.slack.test/x", (m) => logged.push(m));
    const router = new SlackAlertRouter({ notify });

    assert.doesNotThrow(() => router.post([alert("dispenser-sol-low", "critical")]));
    await tick();
    assert.equal(logged.length, 1, "the failure is swallowed + logged, never propagated");
    assert.equal(logged[0], "slack notify failed");
  });

  it("is a no-op (posts nothing) when the webhook is unset (opt-in off)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response("ok"); }) as typeof fetch;
    const router = new SlackAlertRouter({ notify: makeSlackNotifier(undefined) });
    // The router still tracks names, but the underlying notifier sends nothing.
    router.post([alert("dispenser-sol-low", "critical")]);
    await tick();
    assert.equal(calls, 0, "no webhook => no fetch");
  });
});
