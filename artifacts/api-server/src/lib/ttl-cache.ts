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

  constructor(private ttlMs: number, private name = '', private maxEntries?: number) {}

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

    const startEpoch = this.epoch;
    const promise: Promise<T> = Promise.resolve()
      // Deferred so a compute that throws synchronously still lands after inflight.set()
      // below — otherwise cleanup ran first and the rejected promise stuck forever.
      .then(compute)
      .then(value => {
        if (this.epoch === startEpoch) this.set(key, value);
        return value;
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
    return pruned;
  }

  setTtl(ms: number) {
    this.ttlMs = ms;
  }

  delete(key: string) {
    this.store.delete(key);
    this.inflight.delete(key);
    this.epoch++;
  }

  clear() {
    this.store.clear();
    this.inflight.clear();
    this.epoch++;
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
