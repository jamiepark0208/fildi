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
  entries: Array<{ key: string; expiresAt: number; expiresInSec: number }>;
}

export class TTLCache<T> {
  private store = new Map<string, CacheEntry<T>>();
  private hits = 0;
  private misses = 0;

  constructor(private ttlMs: number, private name = '', private maxEntries?: number) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) { this.misses++; return undefined; }
    if (Date.now() > entry.expiresAt) { this.store.delete(key); this.misses++; return undefined; }
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
      if (oldestKey !== undefined) this.store.delete(oldestKey);
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /** Remove expired entries. Safe to call on an interval; does not touch unexpired keys. */
  pruneExpired(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) { this.store.delete(key); pruned++; }
    }
    return pruned;
  }

  setTtl(ms: number) {
    this.ttlMs = ms;
  }

  delete(key: string) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
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
      entries: Array.from(this.store.entries()).map(([key, entry]) => ({
        key,
        expiresAt: entry.expiresAt,
        expiresInSec: Math.round(Math.max(0, entry.expiresAt - now) / 1000),
      })),
    };
  }
}
