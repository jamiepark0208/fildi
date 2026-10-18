/**
 * Cache Monitor overview (Jamie 10-16: "useless as it is" → total + breakdown + is each cache worth it).
 * Four layers, each with a subtotal:
 *   memory — TTLCache instances (est size, hit rate, upstream calls saved)
 *   disk   — JSON cache files next to the api-server (size, age, what refills them)
 *   db     — *_cache tables, plus history/snapshot tables listed as "data, not cache"
 *   mac    — dev caches on the Mac from scripts/resource-audit.py's latest snapshot (not fildi data)
 * Pure helpers (verdict / summarize) are exported for tests; I/O stays in buildCacheOverview().
 */
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import type { CacheStats } from "./ttl-cache.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAY_MS = 86_400_000;
const MB = 1_000_000;

export type Verdict = "needed" | "ok" | "low-value" | "too early";

export interface MemoryRow {
  name: string; displayName: string; ttlMs: number; entries: number; estBytes: number | null;
  hits: number | null; misses: number | null; savedRate: number | null; callsSaved: number;
  callsSavedPerDay: number | null; uptimeDays: number | null; verdict: Verdict; why: string;
}
export interface DiskRow {
  file: string; name: string | null; label: string; kind: "cache" | "state"; refill: string;
  bytes: number; ageSec: number | null; exists: boolean; verdict: Verdict; why: string;
}
export interface DbRow { table: string; bytes: number; rows: number; kind: "cache" | "data" }
export interface MacRow { label: string; bytes: number; needed: boolean; note: string; clearHint: string | null }

export interface CacheOverview {
  generatedAt: number;
  totals: {
    fildiCacheBytes: number; callsSavedPerDay: number; macDevBytes: number;
    memoryBytes: number; diskBytes: number; dbCacheBytes: number; dbDataBytes: number; dbTotalBytes: number | null;
  };
  memory: MemoryRow[];
  disk: DiskRow[];
  db: DbRow[];
  mac: { asOf: string | null; rows: MacRow[] };
}

/** Upstream is slow, rate-limited, or costs money → keep even with a modest hit rate. */
const EXPENSIVE = new Set([
  "options", "schwab-options-chain", "options-expiry", "options-iv-term", "breakdown",
  "peer-map", "peer-profile", "ticker-classify", "ticker-news", "fair-value-yields",
  "macro-indicator-history", "macro-sep-actuals", "macro-sector-rotation", "macro-bank-news",
  "technicals-rankings", "track-record",
]);

/** needed = saves ≥ 20 % of lookups or refill is expensive; low-value = < 5 % after ≥ 1 day of traffic. */
export function verdictFor(name: string, savedRate: number | null, lookups: number, uptimeDays: number | null): { verdict: Verdict; why: string } {
  if (savedRate === null || uptimeDays === null) return { verdict: "too early", why: "no counters" };
  if (lookups === 0) return { verdict: "too early", why: "not used since server start" };
  if (savedRate >= 0.2) return { verdict: "needed", why: `saves ${Math.round(savedRate * 100)} % of lookups` };
  if (EXPENSIVE.has(name)) return { verdict: "needed", why: "refill is slow / rate-limited" };
  if (uptimeDays < 1) return { verdict: "too early", why: "< 1 day of data" };
  if (savedRate < 0.05) return { verdict: "low-value", why: `only ${Math.round(savedRate * 100)} % of lookups served` };
  return { verdict: "ok", why: `saves ${Math.round(savedRate * 100)} % of lookups` };
}

export function memoryRows(stats: CacheStats[], now = Date.now()): MemoryRow[] {
  return stats
    .filter(s => s.hits !== null)                 // file / single-object entries go to the disk layer
    .map(s => {
      const hits = s.hits ?? 0, misses = s.misses ?? 0;
      const lookups = hits + misses;
      // A coalesced caller also counted a miss first, so saved/lookups is the share served without a new upstream call.
      const savedRate = lookups === 0 ? 0 : Math.min(1, s.callsSaved / lookups);
      const uptimeDays = s.startedAt ? Math.max((now - s.startedAt) / DAY_MS, 1 / 24) : null;
      const v = verdictFor(s.name, savedRate, lookups, uptimeDays);
      return {
        name: s.name, displayName: s.displayName ?? s.name, ttlMs: s.ttlMs, entries: s.entryCount,
        estBytes: s.estBytes, hits: s.hits, misses: s.misses, savedRate: lookups === 0 ? null : savedRate,
        callsSaved: s.callsSaved, callsSavedPerDay: uptimeDays ? Math.round(s.callsSaved / uptimeDays) : null,
        uptimeDays, ...v,
      };
    })
    .sort((a, b) => (b.estBytes ?? 0) - (a.estBytes ?? 0));
}

const FILE_CACHES: Array<{ file: string; name: string | null; label: string; kind: "cache" | "state"; refill: string }> = [
  { file: "macro-charts.json",          name: "macro-charts", label: "Macro charts (VIX, rates, spreads…)", kind: "cache", refill: "auto every 4 h (FRED + Yahoo)" },
  { file: "cot-cache.json",             name: "macro-cot",    label: "COT positioning (CFTC)",              kind: "cache", refill: "auto weekly (CFTC, Fridays)" },
  { file: "macro-data.json",            name: "macro-data",   label: "Macro data (FRED + Yahoo)",           kind: "cache", refill: "auto every 4 h" },
  { file: "macro-sector-rotation.json", name: null,           label: "Sector rotation heatmap",             kind: "cache", refill: "on Macro tab load" },
  { file: "macro-highlights.json",      name: null,           label: "Macro highlights (AI summary)",       kind: "cache", refill: "on request (Haiku — saves AI calls)" },
  { file: "macro-bank-research.json",   name: null,           label: "Bank research notes",                 kind: "cache", refill: "on request" },
  { file: "desk-daily-news.json",       name: null,           label: "Daily news summary (AI)",             kind: "cache", refill: "per desk session (Haiku — saves AI calls)" },
  { file: "brief-context.json",         name: null,           label: "Daily brief context",                 kind: "state", refill: "daily brief run — app state, not a cache" },
  { file: "brief-history.json",         name: null,           label: "Daily brief history",                 kind: "state", refill: "daily brief run — app state, not a cache" },
];
const NOT_CACHE_JSON = new Set(["package.json", "tsconfig.json", "package-lock.json"]);

function diskRows(now = Date.now()): DiskRow[] {
  const known = new Set(FILE_CACHES.map(f => f.file));
  let extra: string[] = [];
  try { extra = readdirSync(ROOT).filter(f => f.endsWith(".json") && !known.has(f) && !NOT_CACHE_JSON.has(f)); } catch { /* ignore */ }
  const all = [...FILE_CACHES, ...extra.map(file => ({ file, name: null, label: file, kind: "cache" as const, refill: "unknown — not in the monitor's list" }))];
  return all.map(f => {
    const path = join(ROOT, f.file);
    const exists = existsSync(path);
    let bytes = 0, ageSec: number | null = null;
    if (exists) { try { const st = statSync(path); bytes = st.size; ageSec = Math.round((now - st.mtimeMs) / 1000); } catch { /* ignore */ } }
    const v: { verdict: Verdict; why: string } = f.kind === "state"
      ? { verdict: "needed", why: "app state" }
      : !exists ? { verdict: "too early", why: "not written yet" }
      : { verdict: "needed", why: "avoids refetching on every restart" };
    return { ...f, bytes, ageSec, exists, ...v };
  }).sort((a, b) => b.bytes - a.bytes);
}

type SqlRows<T> = T[] | { rows?: T[] };
const rowsOf = <T,>(r: SqlRows<T>): T[] => (Array.isArray(r) ? r : r.rows ?? []);

async function dbRows(): Promise<{ rows: DbRow[]; total: number | null }> {
  try {
    const r = rowsOf<{ t: string; bytes: string; n: string; kind: string }>(await db.execute(sql`
      SELECT n.nspname || '.' || c.relname AS t, pg_total_relation_size(c.oid)::bigint AS bytes,
             GREATEST(c.reltuples, 0)::bigint AS n,
             CASE WHEN c.relname ILIKE '%cache%' THEN 'cache' ELSE 'data' END AS kind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND (c.relname ILIKE '%cache%' OR c.relname ILIKE '%history%' OR c.relname ILIKE '%snapshot%')
      ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 25`) as SqlRows<{ t: string; bytes: string; n: string; kind: string }>);
    const tot = rowsOf<{ b: string }>(await db.execute(sql`SELECT pg_database_size(current_database())::bigint AS b`) as SqlRows<{ b: string }>);
    return {
      rows: r.map(x => ({ table: x.t, bytes: Number(x.bytes), rows: Number(x.n), kind: x.kind === "cache" ? "cache" : "data" })),
      total: tot[0] ? Number(tot[0].b) : null,
    };
  } catch {
    return { rows: [], total: null };
  }
}

/** Mac dev caches: label in resource-latest.json "outside" → needed? + note. */
const MAC_NOTES: Array<{ match: RegExp; label: string; needed: boolean; note: string; clearHint: string | null }> = [
  { match: /ShipIt/i,        label: "Cursor updater",           needed: false, note: "old update downloads; Cursor re-downloads only on its next update", clearHint: "rm -rf ~/Library/Caches/com.todesktop.*.ShipIt" },
  { match: /^pip/i,          label: "pip download cache",       needed: false, note: "package downloads; refills only when installing Python packages",  clearHint: "pip cache purge" },
  { match: /^pnpm/i,         label: "pnpm download cache",      needed: false, note: "package downloads; refills only on pnpm install",                    clearHint: "pnpm store prune" },
  { match: /playwright/i,    label: "Crawl4AI browser",         needed: true,  note: "headless Chromium for scripts/fetch-page.sh",                        clearHint: null },
  { match: /huggingface/i,   label: "Hugging Face (OpenJev)",   needed: true,  note: "OpenJev 26B model weights — re-download is ~18 GB",                  clearHint: null },
];

export function macRows(snapshot: unknown): { asOf: string | null; rows: MacRow[] } {
  const snap = (snapshot ?? {}) as { ts?: string; outside?: Record<string, number> };
  const outside = snap.outside ?? {};
  const rows: MacRow[] = [];
  for (const [key, mb] of Object.entries(outside)) {
    const n = MAC_NOTES.find(m => m.match.test(key));
    if (!n || typeof mb !== "number") continue;
    rows.push({ label: n.label, bytes: Math.round(mb * MB), needed: n.needed, note: n.note, clearHint: n.clearHint });
  }
  return { asOf: snap.ts ?? null, rows: rows.sort((a, b) => b.bytes - a.bytes) };
}

export function summarize(memory: MemoryRow[], disk: DiskRow[], dbr: DbRow[], dbTotal: number | null, mac: MacRow[]): CacheOverview["totals"] {
  const memoryBytes = memory.reduce((s, r) => s + (r.estBytes ?? 0), 0);
  const diskBytes = disk.filter(r => r.kind === "cache").reduce((s, r) => s + r.bytes, 0);
  const dbCacheBytes = dbr.filter(r => r.kind === "cache").reduce((s, r) => s + r.bytes, 0);
  const dbDataBytes = dbr.filter(r => r.kind === "data").reduce((s, r) => s + r.bytes, 0);
  return {
    fildiCacheBytes: memoryBytes + diskBytes + dbCacheBytes,
    callsSavedPerDay: memory.reduce((s, r) => s + (r.callsSavedPerDay ?? 0), 0),
    macDevBytes: mac.reduce((s, r) => s + r.bytes, 0),
    memoryBytes, diskBytes, dbCacheBytes, dbDataBytes, dbTotalBytes: dbTotal,
  };
}

function readResourceSnapshot(): unknown {
  try { return JSON.parse(readFileSync(join(homedir(), ".fildi", "resource-latest.json"), "utf-8")); } catch { return null; }
}

export async function buildCacheOverview(stats: CacheStats[]): Promise<CacheOverview> {
  const now = Date.now();
  const memory = memoryRows(stats, now);
  const disk = diskRows(now);
  const { rows: dbr, total } = await dbRows();
  const mac = macRows(readResourceSnapshot());
  return { generatedAt: now, totals: summarize(memory, disk, dbr, total, mac.rows), memory, disk, db: dbr, mac };
}
