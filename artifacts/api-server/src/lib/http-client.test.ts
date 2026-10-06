import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { redactUrl, retryAfterMs, fetchJsonWithRetry, acquireProviderSlot } from "./http-client.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockFetch(responses: Array<() => Response>): { calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    return responses[Math.min(i++, responses.length - 1)]!();
  }) as typeof fetch;
  return { calls };
}

describe("redactUrl", () => {
  it("masks every credential param name in use", () => {
    assert.equal(redactUrl("https://x/a?symbol=A&apikey=SECRET"), "https://x/a?symbol=A&apikey=***");
    assert.equal(redactUrl("https://x/a?apiKey=SECRET&limit=1"), "https://x/a?apiKey=***&limit=1");
    assert.equal(redactUrl("https://x/a?symbol=A&token=SECRET"), "https://x/a?symbol=A&token=***");
    assert.equal(redactUrl("https://x/a?api_key=SECRET"), "https://x/a?api_key=***");
    assert.equal(redactUrl("https://x/a?symbol=TOKEN"), "https://x/a?symbol=TOKEN");
  });
});

describe("retryAfterMs", () => {
  it("parses seconds, caps at 30s, falls back when absent", () => {
    assert.equal(retryAfterMs(new Response(null, { headers: { "retry-after": "3" } })), 3000);
    assert.equal(retryAfterMs(new Response(null, { headers: { "retry-after": "999" } })), 30_000);
    assert.equal(retryAfterMs(new Response(null)), 2000);
    assert.equal(retryAfterMs(new Response(null), 50), 50);
  });
});

describe("fetchJsonWithRetry", () => {
  it("never puts the key in a thrown error", async () => {
    mockFetch([() => new Response("no", { status: 403 })]);
    await assert.rejects(
      fetchJsonWithRetry("https://fmp/x?symbol=A&apikey=SECRET", { provider: "FMP-test", maxRetries: 2 }),
      (err: Error) => !err.message.includes("SECRET") && err.message.includes("apikey=***"),
    );
  });

  it("fails fast on permanent 4xx (one call)", async () => {
    const { calls } = mockFetch([() => new Response("no", { status: 402 })]);
    await assert.rejects(fetchJsonWithRetry("https://x", { provider: "t", maxRetries: 3, baseDelayMs: 1 }));
    assert.equal(calls.length, 1);
  });

  it("returns null on 404 only when nullOn404", async () => {
    mockFetch([() => new Response("nf", { status: 404 })]);
    assert.equal(await fetchJsonWithRetry("https://x", { provider: "t", nullOn404: true }), null);
    mockFetch([() => new Response("nf", { status: 404 })]);
    await assert.rejects(fetchJsonWithRetry("https://x", { provider: "t", baseDelayMs: 1 }));
  });

  it("honors Retry-After on 429 then succeeds", async () => {
    const { calls } = mockFetch([
      () => new Response("slow", { status: 429, headers: { "retry-after": "0" } }),
      () => Response.json({ ok: 1 }),
    ]);
    const t0 = Date.now();
    assert.deepEqual(await fetchJsonWithRetry("https://x", { provider: "t", baseDelayMs: 10_000 }), { ok: 1 });
    assert.equal(calls.length, 2);
    assert.ok(Date.now() - t0 < 1000, "used Retry-After: 0, not the 10s backoff");
  });

  it("retries 5xx", async () => {
    const { calls } = mockFetch([() => new Response("", { status: 500 }), () => Response.json([1])]);
    assert.deepEqual(await fetchJsonWithRetry("https://x", { provider: "t", baseDelayMs: 1 }), [1]);
    assert.equal(calls.length, 2);
  });
});

describe("acquireProviderSlot", () => {
  it("is a no-op for unlimited providers", async () => {
    const t0 = Date.now();
    for (let i = 0; i < 50; i++) await acquireProviderSlot("FMP");
    assert.ok(Date.now() - t0 < 100);
  });

  it("caps EDGAR at 9 per second across concurrent callers", async () => {
    const t0 = Date.now();
    const done: number[] = [];
    await Promise.all(Array.from({ length: 12 }, () => acquireProviderSlot("EDGAR").then(() => done.push(Date.now() - t0))));
    done.sort((a, b) => a - b);
    assert.ok(done[8]! < 200, "first 9 immediate");
    assert.ok(done[9]! >= 950, "10th waits for the window");
  });
});
