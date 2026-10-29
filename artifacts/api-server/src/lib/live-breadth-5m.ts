/**
 * A314 — live breadth % above session VWAP from Schwab 1m bars (no extra vendor calls).
 * Rolls up polled watchlist_sync.intraday_bars_1m → optlab.breadth_5m rows for grading.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool } from "@workspace/db";
import type { Bar } from "./intraday-regime.js";
import { etDateKey } from "./market-hours.js";
import { schwab1mUniverse } from "./schwab-1m-poll.js";
import { logger } from "./logger.js";

import {
  BREADTH_DROP_PP,
  breadthChg30,
  isBreadthDrop,
  type BreadthVwapPoint,
} from "./intraday-breadth-drop.js";

export { BREADTH_DROP_PP, breadthChg30, isBreadthDrop };

export const LIVE_BREADTH_SRC = "live19";

export interface BreadthSnapshot {
  aboveVwap: number;
  chg30: number;
  drop: boolean;
}

export interface BreadthRow {
  ts: Date;
  n: number;
  upOpen: number;
  aboveVwap: number;
  meanRet: number;
}

const TICKER_CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "../data/a314-breadth-live-tickers.json");

/** Same set as Schwab 1m poll minus SPY; JSON is kept in sync for study scripts. */
function loadConfiguredTickers(): string[] {
  const schwab = schwab1mUniverse().filter(t => t !== "SPY");
  try {
    const raw = JSON.parse(readFileSync(TICKER_CONFIG_PATH, "utf8")) as { tickers?: string[] };
    const schwSet = new Set(schwab);
    const fromFile = (raw.tickers ?? []).map(t => t.toUpperCase()).filter(t => schwSet.has(t));
    if (fromFile.length === schwab.length) return fromFile;
  } catch {
    /* fall through */
  }
  return schwab;
}

let liveBreadthTickersCache: string[] | undefined;

function getLiveBreadthTickers(): string[] {
  if (!liveBreadthTickersCache) liveBreadthTickersCache = loadConfiguredTickers();
  return liveBreadthTickersCache;
}

function isRthEt(ms: number): boolean {
  const et = new Date(new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York" }));
  const minutes = et.getHours() * 60 + et.getMinutes();
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

export function rollup1mTo5m(bars: Bar[]): Bar[] {
  const byBucket = new Map<number, Bar[]>();
  for (const b of bars) {
    if (!isRthEt(b.time)) continue;
    const bucket = Math.floor(b.time / 300_000) * 300_000;
    const arr = byBucket.get(bucket) ?? [];
    arr.push(b);
    byBucket.set(bucket, arr);
  }
  const out: Bar[] = [];
  for (const [time, chunk] of [...byBucket.entries()].sort((a, b) => a[0] - b[0])) {
    chunk.sort((a, b) => a.time - b.time);
    out.push({
      time,
      open: chunk[0].open,
      high: Math.max(...chunk.map(x => x.high)),
      low: Math.min(...chunk.map(x => x.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, x) => s + x.volume, 0),
    });
  }
  return out;
}

export function tickerBreadthFlags(bars5m: Bar[]): { aboveOpen: number; aboveVwap: number; meanRet: number } | null {
  if (bars5m.length === 0) return null;
  const open = bars5m[0].open;
  const last = bars5m[bars5m.length - 1];
  let cumPv = 0;
  let cumV = 0;
  for (const b of bars5m) {
    cumPv += b.close * b.volume;
    cumV += b.volume;
  }
  const vwap = cumV > 0 ? cumPv / cumV : last.close;
  return {
    aboveOpen: last.close >= open ? 1 : 0,
    aboveVwap: last.close >= vwap ? 1 : 0,
    meanRet: last.close / open - 1,
  };
}

async function fetchToday1m(ticker: string, dateKey: string): Promise<Bar[]> {
  const { rows } = await pool.query<{ ts: Date; o: number; h: number; l: number; c: number; v: number }>(
    `SELECT ts, o, h, l, c, v FROM watchlist_sync.intraday_bars_1m
     WHERE ticker = $1 AND (ts AT TIME ZONE 'America/New_York')::date = $2::date
     ORDER BY ts ASC`,
    [ticker.toUpperCase(), dateKey],
  );
  return rows.map(r => ({
    time: new Date(r.ts).getTime(),
    open: Number(r.o),
    high: Number(r.h),
    low: Number(r.l),
    close: Number(r.c),
    volume: Number(r.v) || 0,
  }));
}

/** One cross-sectional breadth row for the latest completed 5m bar (all configured tickers). */
export async function computeLiveBreadthCrossSection(dateKey: string = etDateKey()): Promise<BreadthRow | null> {
  const tickers = getLiveBreadthTickers();
  if (tickers.length === 0) return null;

  let upOpenSum = 0;
  let aboveVwapSum = 0;
  let retSum = 0;
  let n = 0;
  let barStart = 0;

  await Promise.all(
    tickers.map(async (t) => {
      const bars1m = await fetchToday1m(t, dateKey);
      const bars5m = rollup1mTo5m(bars1m);
      const now = Date.now();
      const completed = bars5m.filter(b => b.time + 300_000 <= now);
      if (completed.length < 1) return;
      const snap = tickerBreadthFlags(completed);
      if (!snap) return;
      upOpenSum += snap.aboveOpen;
      aboveVwapSum += snap.aboveVwap;
      retSum += snap.meanRet;
      n += 1;
      barStart = Math.max(barStart, completed[completed.length - 1].time);
    }),
  );

  if (n < 8) return null;
  return {
    ts: new Date(barStart),
    n,
    upOpen: upOpenSum / n,
    aboveVwap: aboveVwapSum / n,
    meanRet: retSum / n,
  };
}

export async function upsertBreadth5mRow(row: BreadthRow, dateKey: string = etDateKey()): Promise<void> {
  await pool.query(`DELETE FROM optlab.breadth_5m WHERE ts = $1 AND src = $2`, [row.ts, LIVE_BREADTH_SRC]);
  await pool.query(
    `INSERT INTO optlab.breadth_5m (ts, d, n, up_open, above_vwap, mean_ret, src)
     VALUES ($1, $2::date, $3, $4, $5, $6, $7)`,
    [row.ts, dateKey, row.n, row.upOpen, row.aboveVwap, row.meanRet, LIVE_BREADTH_SRC],
  );
}

async function todayLiveBreadthSeries(dateKey: string): Promise<BreadthVwapPoint[]> {
  const { rows } = await pool.query<{ ts: Date; above_vwap: number }>(
    `SELECT ts, above_vwap FROM optlab.breadth_5m
     WHERE d = $1::date AND src = $2 ORDER BY ts ASC`,
    [dateKey, LIVE_BREADTH_SRC],
  );
  return rows.map(r => ({ tsMs: new Date(r.ts).getTime(), aboveVwap: Number(r.above_vwap) }));
}

/** Cached snapshot for Live risk — never throws. */
let cached: { at: number; snap: BreadthSnapshot | null } = { at: 0, snap: null };

export async function getLiveBreadthSnapshot(force = false): Promise<BreadthSnapshot | null> {
  const now = Date.now();
  if (!force && now - cached.at < 45_000) return cached.snap;
  try {
    const dateKey = etDateKey();
    const series = await todayLiveBreadthSeries(dateKey);
    if (series.length < 1) {
      cached = { at: now, snap: null };
      return null;
    }
    const aboveVwap = series[series.length - 1].aboveVwap;
    const chg30 = breadthChg30(series);
    cached = {
      at: now,
      snap: { aboveVwap, chg30: chg30 ?? 0, drop: isBreadthDrop(chg30) },
    };
    return cached.snap;
  } catch (err) {
    logger.warn({ err: String(err) }, "live-breadth: snapshot unavailable");
    cached = { at: now, snap: null };
    return null;
  }
}

/** Called after each Schwab 1m poll — DB only, zero extra Schwab calls. */
export async function refreshLiveBreadthFromSchwabBars(): Promise<void> {
  try {
    const dateKey = etDateKey();
    const row = await computeLiveBreadthCrossSection(dateKey);
    if (!row) return;
    await upsertBreadth5mRow(row, dateKey);
    await getLiveBreadthSnapshot(true);
  } catch (err) {
    logger.warn({ err: String(err) }, "live-breadth: refresh failed");
  }
}
