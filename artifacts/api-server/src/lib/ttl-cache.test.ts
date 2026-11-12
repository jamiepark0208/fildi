import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { TTLCache } from "./ttl-cache.ts";

describe("TTLCache.pruneExpired", () => {
  it("removes only expired entries, leaves unexpired ones", () => {
    mock.timers.enable({ apis: ["Date"] });
    const cache = new TTLCache<number>(1000, "test");
    for (let i = 0; i < 100; i++) cache.set(`key${i}`, i);
    assert.equal(cache.getStats().entryCount, 100);

    mock.timers.tick(1500);
    const pruned = cache.pruneExpired();

    assert.equal(pruned, 100);
    assert.equal(cache.getStats().entryCount, 0);
    mock.timers.reset();
  });

  it("does not touch entries still within TTL", () => {
    mock.timers.enable({ apis: ["Date"] });
    const cache = new TTLCache<number>(10_000, "test");
    cache.set("fresh", 1);
    mock.timers.tick(1000);
    const pruned = cache.pruneExpired();

    assert.equal(pruned, 0);
    assert.equal(cache.get("fresh"), 1);
    mock.timers.reset();
  });
});

describe("TTLCache maxEntries (LRU eviction)", () => {
  it("evicts the least-recently-used entry once the cap is reached", () => {
    const cache = new TTLCache<number>(60_000, "test", 3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.get("a"); // "a" is now most-recently-used; "b" is oldest
    cache.set("d", 4); // should evict "b"

    assert.equal(cache.get("b"), undefined);
    assert.equal(cache.get("a"), 1);
    assert.equal(cache.get("c"), 3);
    assert.equal(cache.get("d"), 4);
    assert.equal(cache.getStats().entryCount, 3);
  });

  it("does not evict when no maxEntries is set (unbounded)", () => {
    const cache = new TTLCache<number>(60_000, "test");
    for (let i = 0; i < 500; i++) cache.set(`key${i}`, i);
    assert.equal(cache.getStats().entryCount, 500);
  });
});

describe("TTLCache cache hits within TTL", () => {
  it("returns cached value and increments hit count", () => {
    const cache = new TTLCache<string>(60_000, "test");
    cache.set("k", "v");
    assert.equal(cache.get("k"), "v");
    assert.equal(cache.getStats().hits, 1);
    assert.equal(cache.getStats().misses, 0);
  });
});

describe("TTLCache.getOrCompute", () => {
  it("coalesces concurrent misses into a single compute call", async () => {
    const cache = new TTLCache<number>(60_000, "test");
    let calls = 0;
    const compute = async () => { calls++; await Promise.resolve(); return 42; };

    const [a, b, c] = await Promise.all([
      cache.getOrCompute("k", compute),
      cache.getOrCompute("k", compute),
      cache.getOrCompute("k", compute),
    ]);

    assert.equal(calls, 1);            // three concurrent callers, one upstream call
    assert.deepEqual([a, b, c], [42, 42, 42]);
    assert.equal(cache.get("k"), 42);  // result cached for later callers
  });

  it("does not cache on rejection; fails fast during the cooldown, then the next caller retries", async () => {
    const cache = new TTLCache<number>(60_000, "test");
    let calls = 0;
    const flaky = async () => { calls++; if (calls === 1) throw new Error("boom"); return 7; };

    await assert.rejects(cache.getOrCompute("k", flaky));
    assert.equal(cache.get("k"), undefined); // failure left nothing cached
    await assert.rejects(cache.getOrCompute("k", flaky), /boom/); // inside cooldown: same error, no vendor call
    assert.equal(calls, 1);
    const saved = TTLCache.FAIL_COOLDOWN_MS;
    TTLCache.FAIL_COOLDOWN_MS = 0;
    try {
      assert.equal(await cache.getOrCompute("k", flaky), 7); // after cooldown: retry succeeds
    } finally { TTLCache.FAIL_COOLDOWN_MS = saved; }
    assert.equal(calls, 2);
  });

  it("serves the last good value when a refresh fails after expiry", async () => {
    const cache = new TTLCache<number>(200, "test");          // grace 1.2 s, cooldown 200 ms
    assert.equal(await cache.getOrCompute("k", async () => 1), 1);
    await new Promise(r => setTimeout(r, 250));               // expired
    let calls = 0;
    const down = async () => { calls++; throw new Error("vendor down"); };
    assert.equal(await cache.getOrCompute("k", down), 1);     // last good instead of an error
    assert.equal(await cache.getOrCompute("k", down), 1);     // cooldown: still last good, no new call
    assert.equal(calls, 1);
    assert.deepEqual(cache.getFailureStats(), { staleServed: 2, failFast: 1 });
  });

  it("delete() drops the last good value too", async () => {
    const cache = new TTLCache<number>(1, "test");
    await cache.getOrCompute("k", async () => 1);
    cache.delete("k");
    await assert.rejects(cache.getOrCompute("k", async () => { throw new Error("x"); }));
  });

  it("does not write back a result computed across clear()", async () => {
    const cache = new TTLCache<number>(60_000, "test");
    let release!: (v: number) => void;
    const pending = cache.getOrCompute("k", () => new Promise<number>(r => { release = r; }));
    await new Promise(r => setTimeout(r, 0));
    cache.clear();
    release(1);
    assert.equal(await pending, 1);          // the waiting caller still gets its value
    assert.equal(cache.get("k"), undefined);  // but the stale result is not cached
    assert.equal(await cache.getOrCompute("k", async () => 2), 2);
    assert.equal(cache.get("k"), 2);
  });

  it("does not wedge on a compute that throws synchronously", async () => {
    const cache = new TTLCache<number>(60_000, "test");
    const syncThrow = (() => { throw new Error("sync"); }) as () => Promise<number>;
    await assert.rejects(cache.getOrCompute("k", syncThrow));
    const saved = TTLCache.FAIL_COOLDOWN_MS;
    TTLCache.FAIL_COOLDOWN_MS = 0;
    try {
      assert.equal(await cache.getOrCompute("k", async () => 5), 5);
    } finally { TTLCache.FAIL_COOLDOWN_MS = saved; }
  });
});

describe("TTLCache.getOrComputeStale", () => {
  it("expired key returns last value at once and refreshes behind; cold key waits", async () => {
    const c = new TTLCache<number>(20, "swr-test");
    let n = 0;
    const compute = async () => { await new Promise(r => setTimeout(r, 30)); return ++n; };
    assert.equal(await c.getOrComputeStale("k", compute), 1);          // cold: waits
    await new Promise(r => setTimeout(r, 25));                          // expire
    const t0 = Date.now();
    assert.equal(await c.getOrComputeStale("k", compute), 1);          // stale served immediately
    assert.ok(Date.now() - t0 < 15);
    await new Promise(r => setTimeout(r, 45));                          // background refresh landed
    assert.equal(await c.getOrComputeStale("k", compute), 2);
  });
});
