//! Unit tests for the opt-in Slack notifier. The whole point of the module is that
//! it can NEVER block or break the money path, so the tests assert exactly that:
//! off-by-default (no fetch), fire-and-forget delivery, and total failure-swallowing.

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import { makeSlackNotifier } from "./slack.js";

const WEBHOOK = "https://hooks.slack.test/services/T000/B000/xxxx";

/** Let queued microtasks/timers run so the fire-and-forget POST is observable. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("makeSlackNotifier", () => {
  it("returns a no-op that posts nothing when the webhook is undefined (opt-in off)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const notify = makeSlackNotifier(undefined);
    notify({ text: "should not send" });
    await tick();

    assert.equal(calls, 0, "no webhook => fetch must never be called");
  });

  it("treats an empty/whitespace webhook as off", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    makeSlackNotifier("   ")({ text: "nope" });
    await tick();

    assert.equal(calls, 0);
  });

  it("POSTs once to the webhook with a JSON body containing the text", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const notify = makeSlackNotifier(WEBHOOK);
    const ret = notify({ text: "hello ops" });
    assert.equal(ret, undefined, "notifier is fire-and-forget (returns void)");

    await tick();

    assert.equal(seen.length, 1, "exactly one POST");
    assert.equal(seen[0].url, WEBHOOK);
    assert.equal((seen[0].init.method ?? "").toUpperCase(), "POST");
    const body = JSON.parse(seen[0].init.body as string) as { text: string };
    assert.equal(body.text, "hello ops");
  });

  it("does NOT throw and swallows a rejected fetch (network error)", async () => {
    const logged: { m: string; meta?: unknown }[] = [];
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;

    const notify = makeSlackNotifier(WEBHOOK, (m, meta) => logged.push({ m, meta }));
    // Must not throw synchronously.
    assert.doesNotThrow(() => notify({ text: "will fail" }));
    await tick();

    assert.equal(logged.length, 1, "the failure is logged, not propagated");
    assert.equal(logged[0].m, "slack notify failed");
  });

  it("does NOT throw and swallows a non-2xx response (500)", async () => {
    const logged: string[] = [];
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;

    const notify = makeSlackNotifier(WEBHOOK, (m) => logged.push(m));
    assert.doesNotThrow(() => notify({ text: "server error" }));
    await tick();

    assert.equal(logged.length, 1, "a 500 is swallowed + logged, never thrown");
  });
});
