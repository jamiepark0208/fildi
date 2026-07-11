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
