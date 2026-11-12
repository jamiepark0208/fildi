interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface CacheStats {
  name: string;
  displayName?: string;
  ttlMs: number;
  entryCount: number;
  maxEntries?: number;
  hits: number | null;
  misses: number | null;
  hitRate: string;
  /** Counters since server start (startedAt). Each hit or coalesced call = one upstream call avoided. */
  sets: number;
  evictions: number;
  coalesced: number;
  callsSaved: number;
  startedAt: number;
  /** Rough in-memory size: average sampled JSON size × entries. null = never measured. */
  estBytes: number | null;
  entries: Array<{ key: string; expiresAt: number; expiresInSec: number; label?: string; stale?: boolean }>;
}

export class TTLCache<T> {
  private store = new Map<string, CacheEntry<T>>();
  private inflight = new Map<string, Promise<T>>();
  private hits = 0;
  private misses = 0;
  // Bumped by delete()/clear(): a compute that started before an invalidation must not
  // write its (possibly stale) result back afterwards — e.g. admin "Clear cache" mid-fetch.
  private epoch = 0;
  private sets = 0;
  private evictions = 0;
  private coalesced = 0;
  private readonly startedAt = Date.now();
  // Size estimate: JSON-size sample on the first SAMPLE_FIRST sets, then every SAMPLE_EVERY-th
  // set (stringify of a big breakdown costs ms — keep it rare). Running average, not exact.
  private sizeSamples = 0;
  private avgEntryBytes = 0;

  // Failure handling (10-28, Jamie: budget overruns + retry loops): an expired value is kept as `lastGood` for a grace
  // window; when compute() fails, getOrCompute serves it instead of an error, and for FAIL_COOLDOWN_MS after a failure
  // further callers get lastGood (or the same error) without calling the vendor again. Success paths are unchanged.
  private lastGood = new Map<string, { value: T; at: number }>();
  private failedAt = new Map<string, { at: number; err: unknown }>();
  private staleServed = 0;
  private failFast = 0;
  /** Mutable for tests only. */
  static FAIL_COOLDOWN_MS = 15_000;
  private get graceMs(): number { return Math.min(24 * 3_600_000, this.ttlMs * 6); }

  constructor(private ttlMs: number, private name = '', private maxEntries?: number) {}

  private keepLastGood(key: string, value: T) {
    this.lastGood.delete(key);
    if (this.maxEntries && this.lastGood.size >= this.maxEntries) {
      const oldest = this.lastGood.keys().next().value;
      if (oldest !== undefined) this.lastGood.delete(oldest);
    }
    this.lastGood.set(key, { value, at: Date.now() });
  }

  private freshLastGood(key: string): T | undefined {
    const g = this.lastGood.get(key);
    return g && Date.now() - g.at < this.graceMs ? g.value : undefined;
  }

  /**
   * Stale-while-revalidate (8c "serve stored value + refresh behind"): a fresh hit returns as usual; an expired key with a
   * lastGood inside the grace window returns that value now and refreshes in the background (coalesced). Only a key never
   * seen (or past grace) waits on compute().
   */
  async getOrComputeStale(key: string, compute: () => Promise<T>): Promise<T> {
    if (this.get(key) === undefined) {
      const stale = this.freshLastGood(key);
      if (stale !== undefined) {
        this.staleServed++;
        void this.getOrCompute(key, compute).catch(() => undefined);
        return stale;
      }
    }
    return this.getOrCompute(key, compute);
  }

  /**
   * Cache-aside with in-flight coalescing: on a miss, concurrent callers for the same
   * key share ONE `compute()` promise instead of each firing a duplicate upstream call
   * (thundering herd when a popular key expires under load). Only successful results are
   * cached; a rejection is surfaced to all waiters and leaves the cache untouched so the
   * next caller retries.
   */
  async getOrCompute(key: string, compute: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const pending = this.inflight.get(key);
    if (pending) { this.coalesced++; return pending; }

    const failed = this.failedAt.get(key);
    if (failed && Date.now() - failed.at < Math.min(TTLCache.FAIL_COOLDOWN_MS, this.ttlMs)) {
      this.failFast++;
      const stale = this.freshLastGood(key);
      if (stale !== undefined) { this.staleServed++; return stale; }
      throw failed.err;
    }

    const startEpoch = this.epoch;
    const promise: Promise<T> = Promise.resolve()
      // Deferred so a compute that throws synchronously still lands after inflight.set()
      // below — otherwise cleanup ran first and the rejected promise stuck forever.
      .then(compute)
      .then(value => {
        if (this.epoch === startEpoch) this.set(key, value);
        this.failedAt.delete(key);
        return value;
      }, (err: unknown) => {
        if (this.epoch === startEpoch) this.failedAt.set(key, { at: Date.now(), err });
        const stale = this.freshLastGood(key);
        if (stale !== undefined) { this.staleServed++; return stale; }
        throw err;
      })
      .finally(() => {
        // Only remove our own entry — an invalidation may have let a newer compute start.
        if (this.inflight.get(key) === promise) this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) { this.misses++; return undefined; }
    if (Date.now() > entry.expiresAt) { this.store.delete(key); this.misses++; this.evictions++; return undefined; }
    this.hits++;
    // refresh recency for LRU ordering (Map iteration order = insertion order)
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T) {
    this.store.delete(key);
    if (this.maxEntries && this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) { this.store.delete(oldestKey); this.evictions++; }
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    this.keepLastGood(key, value);
    this.sets++;
    if (this.sets <= TTLCache.SAMPLE_FIRST || this.sets % TTLCache.SAMPLE_EVERY === 0) this.sampleSize(value);
  }

  static readonly SAMPLE_FIRST = 5;
  static readonly SAMPLE_EVERY = 20;

  private sampleSize(value: T) {
    let bytes: number;
    try {
      const json = JSON.stringify(value);
      if (json === undefined) return;
      bytes = json.length;
    } catch { return; }
    this.sizeSamples++;
    this.avgEntryBytes += (bytes - this.avgEntryBytes) / this.sizeSamples;
  }

  /** Remove expired entries. Safe to call on an interval; does not touch unexpired keys. */
  pruneExpired(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) { this.store.delete(key); pruned++; this.evictions++; }
    }
    for (const [key, g] of this.lastGood) if (now - g.at >= this.graceMs) this.lastGood.delete(key);
    for (const [key, f] of this.failedAt) if (now - f.at >= TTLCache.FAIL_COOLDOWN_MS) this.failedAt.delete(key);
    return pruned;
  }

  setTtl(ms: number) {
    this.ttlMs = ms;
  }

  delete(key: string) {
    this.store.delete(key);
    this.inflight.delete(key);
    this.lastGood.delete(key);
    this.failedAt.delete(key);
    this.epoch++;
  }

  clear() {
    this.store.clear();
    this.inflight.clear();
    this.lastGood.clear();
    this.failedAt.clear();
    this.epoch++;
  }

  /** Failure-path counters (served last-good on error / calls skipped during the post-failure cooldown). */
  getFailureStats(): { staleServed: number; failFast: number } {
    return { staleServed: this.staleServed, failFast: this.failFast };
  }

  getStats(): CacheStats {
    const total = this.hits + this.misses;
    const now = Date.now();
    return {
      name: this.name,
      ttlMs: this.ttlMs,
      entryCount: this.store.size,
      ...(this.maxEntries ? { maxEntries: this.maxEntries } : {}),
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? '—' : `${Math.round((this.hits / total) * 100)}%`,
      sets: this.sets,
      evictions: this.evictions,
      coalesced: this.coalesced,
      callsSaved: this.hits + this.coalesced,
      startedAt: this.startedAt,
      estBytes: this.sizeSamples === 0 ? null : Math.round(this.avgEntryBytes * this.store.size),
      entries: Array.from(this.store.entries()).map(([key, entry]) => ({
        key,
        expiresAt: entry.expiresAt,
        expiresInSec: Math.round(Math.max(0, entry.expiresAt - now) / 1000),
      })),
    };
  }
}
