/**
 * A126 — read 5m rollup bars from watchlist_sync.intraday_bars_5m.
 */
import { pool } from "@workspace/db";
import type { Bar } from "./intraday-regime.js";
import { etDateOf } from "./intraday-history.js";

function isRth(ms: number): boolean {
  const et = new Date(new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York" }));
  const minutes = et.getHours() * 60 + et.getMinutes();
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

export async function fetchPolygon5mSessions(
  ticker: string,
  days = 60,
): Promise<Map<string, Bar[]>> {
  const t = ticker.toUpperCase();
  const { rows } = await pool.query<{
    ts: Date; o: number; h: number; l: number; c: number; v: number;
  }>(
    `SELECT ts, o, h, l, c, v
     FROM watchlist_sync.intraday_bars_5m
     WHERE ticker = $1
       AND ts >= (CURRENT_DATE - $2::int)
     ORDER BY ts ASC`,
    [t, days],
  );
  const bySession = new Map<string, Bar[]>();
  for (const r of rows) {
    const time = new Date(r.ts).getTime();
    if (!isRth(time)) continue;
    const key = etDateOf(time);
    const arr = bySession.get(key) ?? [];
    arr.push({
      time,
      open: Number(r.o),
      high: Number(r.h),
      low: Number(r.l),
      close: Number(r.c),
      volume: Number(r.v) || 0,
    });
    bySession.set(key, arr);
  }
  return bySession;
}
