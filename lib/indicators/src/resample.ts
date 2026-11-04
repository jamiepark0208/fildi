import type { TvBar } from "./types.ts";

/** A resampled bar: `time` = first constituent bar, `lastTime` = last constituent bar, `end` = nominal bucket end. */
export type ResampledBar = TvBar & { lastTime: number; end: number; n: number };

const etParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

/** [ET date key, minutes since midnight ET] for a unix-second time (DST-safe). */
export function etClock(sec: number): [string, number] {
  let y = "", mo = "", d = "", h = 0, mi = 0;
  for (const p of etParts.formatToParts(new Date(sec * 1000))) {
    if (p.type === "year") y = p.value;
    else if (p.type === "month") mo = p.value;
    else if (p.type === "day") d = p.value;
    else if (p.type === "hour") h = Number(p.value);
    else if (p.type === "minute") mi = Number(p.value);
  }
  return [`${y}-${mo}-${d}`, h * 60 + mi];
}

const RTH_OPEN_MIN = 9 * 60 + 30;

/**
 * Resample ascending 5m bars into `minutes`-minute buckets anchored at the US RTH open (09:30 ET each day, so 1h =
 * 09:30, 10:30 …). OHLC aggregated, volume summed, the last partial bucket of a session is kept.
 */
export function resample(bars: TvBar[], minutes: number): ResampledBar[] {
  const out: ResampledBar[] = [];
  let key = "";
  for (const b of bars) {
    const [day, m] = etClock(b.time);
    const idx = Math.floor((m - RTH_OPEN_MIN) / minutes);
    const k = `${day}|${idx}`;
    const vol = b.volume ?? 0;
    if (k !== key || !out.length) {
      key = k;
      const start = b.time - (m - RTH_OPEN_MIN - idx * minutes) * 60;
      out.push({ time: b.time, lastTime: b.time, end: start + minutes * 60, open: b.open, high: b.high, low: b.low, close: b.close, volume: vol, n: 1 });
    } else {
      const r = out[out.length - 1]!;
      if (b.high > r.high) r.high = b.high;
      if (b.low < r.low) r.low = b.low;
      r.close = b.close;
      r.volume = (r.volume ?? 0) + vol;
      r.lastTime = b.time;
      r.n += 1;
    }
  }
  return out;
}

/** Timeframe → minutes (5m = no resample). */
export const TF_MINUTES: Record<string, number> = { "5m": 5, "15m": 15, "1h": 60 };
