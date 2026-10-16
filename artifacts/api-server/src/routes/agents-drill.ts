/**
 * Settings › Agents › Stage drill-down (J4 step 1, Claude 2026-10-16). Loaded only when the APIs node is clicked; no polling.
 * GET /api/agents/drill/apis          → one row per vendor seen in api_usage (7 d) + capped sources: calls today, cap, last call, badge.
 * GET /api/agents/drill/apis/:source  → calls by day (7 d), last error, which triggers (jobs/agents) called it today.
 * Caps = data_sources.daily_limit (< 9999) + LSEG 10k (API Monitor SOURCE_META). Errors/callers = in-memory since server start.
 * Jobs drill reuses GET /api/admin/scheduled-tasks (+ /:id/logs) directly.
 */
import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { getApiSourceStats } from "../lib/api-logger.js";
import { normalizeUsageSource } from "../lib/api-usage.js";
import { usageCalendarDate } from "../lib/usage-date.js";

const router = Router();
type SqlRows<T> = T[] | { rows?: T[] };
const rowsOf = <T,>(r: SqlRows<T>): T[] => (Array.isArray(r) ? r : r.rows ?? []);

const LABELS: Record<string, string> = {
  polygon: "Polygon", lseg: "LSEG", fmp: "FMP", finnhub: "Finnhub", yahoo: "Yahoo", av: "Alpha Vantage", anthropic: "Anthropic",
  factset: "FactSet", fred: "FRED", edgar: "SEC EDGAR", nyfed: "NY Fed", cnn: "CNN", wrds: "WRDS", schwab: "Schwab",
};
const EXTRA_CAPS: Record<string, number> = { lseg: 10_000 };

async function caps(): Promise<Record<string, number>> {
  const out: Record<string, number> = { ...EXTRA_CAPS };
  const rows = rowsOf<{ name: string; daily_limit: number; is_active: boolean }>(
    (await db.execute(sql`SELECT name, daily_limit, is_active FROM data_sources`)) as SqlRows<never>);
  for (const r of rows) if (r.is_active && r.daily_limit > 0 && r.daily_limit < 9999) out[normalizeUsageSource(r.name)] = Number(r.daily_limit);
  return out;
}

router.get("/agents/drill/apis", requireAdmin, async (_req, res, next) => {
  try {
    const today = usageCalendarDate();
    const rows = rowsOf<{ source: string; date: string; calls: number; updated_at: string | null }>((await db.execute(sql`
      SELECT source, date::text AS date, calls_made::int AS calls, updated_at::text AS updated_at
      FROM api_usage WHERE date >= ${today}::date - 6`)) as SqlRows<never>);
    const cap = await caps();
    const stats = getApiSourceStats();
    const pt = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
    const srcs = new Set([...rows.map((r) => normalizeUsageSource(r.source)), ...Object.keys(cap).filter((k) => k !== "edgar")]);
    const vendors = [...srcs].map((source) => {
      const mine = rows.filter((r) => normalizeUsageSource(r.source) === source);
      const t = mine.find((r) => r.date === today);
      const todayCalls = t?.calls ?? 0;
      const priorDays = new Set(mine.filter((r) => r.date !== today && r.calls > 0).map((r) => r.date)).size;
      const s = stats[source];
      const c = cap[source] ?? null;
      let badge: { tone: "red" | "amber"; reason: string } | null = null;
      if (c && todayCalls >= c) badge = { tone: "red", reason: "at daily cap" };
      else if (s?.errors) badge = { tone: s.errors >= 5 ? "red" : "amber", reason: `${s.errors} error${s.errors > 1 ? "s" : ""} today` };
      else if (c && todayCalls >= 0.8 * c) badge = { tone: "amber", reason: `${Math.round((100 * todayCalls) / c)}% of cap` };
      else if (!todayCalls && priorDays >= 5 && pt.getHours() >= 12) badge = { tone: "amber", reason: "no calls today" };
      return { source, label: LABELS[source] ?? source, today: todayCalls, cap: c, lastCall: t?.updated_at ?? null, errorsToday: s?.errors ?? 0, badge };
    }).sort((a, b) => b.today - a.today);
    res.json({ vendors });
  } catch (e) { next(e); }
});

router.get("/agents/drill/apis/:source", requireAdmin, async (req, res, next) => {
  try {
    const source = normalizeUsageSource(String(req.params.source));
    const today = usageCalendarDate();
    const rows = rowsOf<{ date: string; calls: number }>((await db.execute(sql`
      SELECT date::text AS date, SUM(calls_made)::int AS calls FROM api_usage
      WHERE date >= ${today}::date - 6 AND lower(source) IN (${source}, ${req.params.source}) GROUP BY 1 ORDER BY 1 DESC`)) as SqlRows<never>);
    const s = getApiSourceStats()[source];
    const users = Object.entries(s?.triggers ?? {}).map(([trigger, calls]) => ({ trigger, calls })).sort((a, b) => b.calls - a.calls);
    res.json({ source, label: LABELS[source] ?? source, days: rows, lastError: s?.lastError ?? null, lastErrorAt: s?.lastErrorAt ?? null, users });
  } catch (e) { next(e); }
});

export default router;
