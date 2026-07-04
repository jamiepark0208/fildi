import { TTLCache } from "./ttl-cache.js";

// 15-minute TTL — safety net only. Primary invalidation is provenanceCache.delete(ticker)
// called by the override PUT/DELETE routes and by merge-trusted.ts after each batch write.
export const provenanceCache = new TTLCache<object>(15 * 60 * 1000, "provenance");
