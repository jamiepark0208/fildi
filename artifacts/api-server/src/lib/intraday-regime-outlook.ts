/**
 * Empirical next-slot frequencies for pending intraday-regime checkpoints.
 * Prefer path-matched historical app_config days; fall back to unconditional
 * base rates. SPY grades (fwd returns) are optional — missing table must not
 * blank the whole outlook (local DBs often lack the migration).
 *
 * Not a forecast — historical frequency only (A74 empirical P for display).
 */
import { and, desc, eq, inArray, like } from "drizzle-orm";
import { db, appConfig, intradayCheckpointGrades } from "@workspace/db";
import { etDateKey } from "./market-hours.js";
import { logger } from "./logger.js";
import type { Direction, RegimeCheckpoint } from "./intraday-regime.js";

const N_FLOOR = 8;
const HISTORY_CAP = 200;
const GRADES_LOOKBACK = 120;

export type SlotOutlook = {
  pBull: number;
  pMix: number;
  pBear: number;
  n: number;
  /** path = matched today's resolved prefix; base = unconditional historical rate */
  mode: "path" | "base";
  /** Optional empirical forward-return band (%), when grades table has data. */
  fwdCloseP25?: number | null;
  fwdCloseP75?: number | null;
} | null;

export type RegimeOutlook = Record<number, SlotOutlook>;

function isDirection(v: unknown): v is Direction {
  return v === "bullish" || v === "bearish" || v === "mixed";
}

/** Resolved non-null directions in checkpoint order (null leans omitted from the key). */
export function resolvedPrefix(checkpoints: RegimeCheckpoint[]): Array<{ min: number; dir: Direction }> {
  return checkpoints
    .filter((c) => c.status === "resolved" && isDirection(c.direction))
    .sort((a, b) => a.minAfterOpen - b.minAfterOpen)
    .map((c) => ({ min: c.minAfterOpen, dir: c.direction as Direction }));
}

export function outlookCacheKey(checkpoints: RegimeCheckpoint[]): string {
  const date = etDateKey();
  const prefix = resolvedPrefix(checkpoints)
    .map((p) => `${p.min}:${p.dir}`)
    .join("|");
  // v2: grades-table miss no longer blanks outlook (was caching all-null for 6h).
  return `v2:${date}:${prefix || "empty"}`;
}

type HistDay = { date: string; byMin: Map<number, Direction> };

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

function freqsFromDays(
  days: HistDay[],
  min: number,
  mode: "path" | "base",
): NonNullable<SlotOutlook> | null {
  let bull = 0;
  let mix = 0;
  let bear = 0;
  let n = 0;
  for (const h of days) {
    const d = h.byMin.get(min);
    if (!d) continue;
    n += 1;
    if (d === "bullish") bull += 1;
    else if (d === "mixed") mix += 1;
    else bear += 1;
  }
  if (n < N_FLOOR) return null;
  return {
    pBull: Math.round((100 * bull) / n),
    pMix: Math.round((100 * mix) / n),
    pBear: Math.round((100 * bear) / n),
    n,
    mode,
  };
}

async function loadHistoricalDays(excludeDate: string): Promise<HistDay[]> {
  const rows = await db
    .select({ key: appConfig.key, value: appConfig.value })
    .from(appConfig)
    .where(like(appConfig.key, "intraday_regime_%"))
    .limit(HISTORY_CAP);

  const out: HistDay[] = [];
  for (const row of rows) {
    const date = String(row.key).replace(/^intraday_regime_/, "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date === excludeDate) continue;
    const cps = (row.value as { checkpoints?: Array<{ minAfterOpen?: number; direction?: unknown }> } | null)
      ?.checkpoints ?? [];
    const byMin = new Map<number, Direction>();
    for (const c of cps) {
      if (typeof c.minAfterOpen !== "number" || !isDirection(c.direction)) continue;
      byMin.set(c.minAfterOpen, c.direction);
    }
    if (byMin.size > 0) out.push({ date, byMin });
  }
  return out;
}

/** Optional — table may be missing on some DBs. Never throw to caller. */
async function loadSpyGradeDays(excludeDate: string): Promise<HistDay[]> {
  try {
    const rows = await db
      .select({
        date: intradayCheckpointGrades.date,
        minAfterOpen: intradayCheckpointGrades.minAfterOpen,
        direction: intradayCheckpointGrades.direction,
      })
      .from(intradayCheckpointGrades)
      .where(eq(intradayCheckpointGrades.ticker, "SPY"))
      .orderBy(desc(intradayCheckpointGrades.date))
      .limit(GRADES_LOOKBACK * 12);

    const byDate = new Map<string, Map<number, Direction>>();
    for (const r of rows) {
      const date = String(r.date);
      if (date === excludeDate || !isDirection(r.direction)) continue;
      let m = byDate.get(date);
      if (!m) {
        m = new Map();
        byDate.set(date, m);
      }
      m.set(r.minAfterOpen, r.direction);
    }
    return [...byDate.entries()].map(([date, byMin]) => ({ date, byMin }));
  } catch (err) {
    logger.debug({ err: String((err as Error)?.message ?? err) }, "regime-outlook: grades unavailable — app_config only");
    return [];
  }
}

/** Optional fwd-close percentile band when grades table exists. */
async function fwdCloseBand(min: number, matchDates: string[]): Promise<{ p25: number | null; p75: number | null }> {
  if (matchDates.length < N_FLOOR) return { p25: null, p75: null };
  try {
    const rows = await db
      .select({ fwd: intradayCheckpointGrades.fwdClosePct })
      .from(intradayCheckpointGrades)
      .where(and(
        eq(intradayCheckpointGrades.ticker, "SPY"),
        eq(intradayCheckpointGrades.minAfterOpen, min),
        inArray(intradayCheckpointGrades.date, matchDates.slice(0, 80)),
      ));
    const vals = rows
      .map((r) => (r.fwd == null ? null : Number(r.fwd)))
      .filter((v): v is number => v != null && Number.isFinite(v))
      .sort((a, b) => a - b);
    if (vals.length < N_FLOOR) return { p25: null, p75: null };
    return {
      p25: Math.round(percentile(vals, 0.25)! * 100) / 100,
      p75: Math.round(percentile(vals, 0.75)! * 100) / 100,
    };
  } catch {
    return { p25: null, p75: null };
  }
}

/**
 * For each pending slot, return next-slot direction frequencies.
 * Null only when every fallback is under N_FLOOR.
 */
export async function computeRegimeOutlook(checkpoints: RegimeCheckpoint[]): Promise<RegimeOutlook> {
  const today = etDateKey();
  const prefix = resolvedPrefix(checkpoints);
  const pendingMins = checkpoints
    .filter((c) => c.status === "pending")
    .map((c) => c.minAfterOpen);

  const empty: RegimeOutlook = Object.fromEntries(pendingMins.map((m) => [m, null]));
  if (pendingMins.length === 0) return {};

  let histories: HistDay[] = [];
  try {
    histories = await loadHistoricalDays(today);
  } catch (err) {
    logger.warn({ err: String((err as Error)?.message ?? err) }, "regime-outlook: app_config load failed");
    return empty;
  }

  const grades = await loadSpyGradeDays(today);

  const pathMatched = histories.filter((h) =>
    prefix.every((p) => h.byMin.get(p.min) === p.dir),
  );

  const out: RegimeOutlook = {};
  for (const min of pendingMins) {
    const slot =
      freqsFromDays(pathMatched, min, "path")
      ?? freqsFromDays(histories, min, "base")
      ?? freqsFromDays(grades, min, "base");

    if (!slot) {
      out[min] = null;
      continue;
    }

    const matchDates = (slot.mode === "path" ? pathMatched : histories)
      .filter((h) => h.byMin.has(min))
      .map((h) => h.date);
    const band = await fwdCloseBand(min, matchDates);
    out[min] = {
      ...slot,
      fwdCloseP25: band.p25,
      fwdCloseP75: band.p75,
    };
  }
  return out;
}
