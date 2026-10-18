/**
 * A126 — session VWAP + volume profile + estimated delta.
 * Prefers Polygon 1m from DB (Phase 1b); falls back to Yahoo 5m (Phase 1a).
 */
import { TTLCache } from "./ttl-cache.js";
import { etDateOf, fetchIntradayHistory } from "./intraday-history.js";
import { fetchPolygon1mSessions } from "./intraday-bars-1m.js";
import type { Bar } from "./intraday-regime.js";

export interface SessionFlowPoint {
  time: number; // unix seconds
  value: number;
}

export interface VolumeProfileLevel {
  price: number;
  volume: number;
}

export interface SessionFlowResult {
  ticker: string;
  sessionDate: string;
  source: "polygon-1m" | "yahoo-5m";
  barCount: number;
  vwap: SessionFlowPoint[];
  /** Volume-weighted POC (highest volume bin mid). */
  poc: number | null;
  vah: number | null;
  val: number | null;
  profile: VolumeProfileLevel[];
  /** Per-bar estimated buy/sell volume (tick rule). Labeled estimated in UI. */
  estimatedDelta: Array<{ time: number; buy: number; sell: number; delta: number }>;
  note: string;
}

const cache = new TTLCache<SessionFlowResult>(5 * 60_000, "session-flow", 200);
const PROFILE_BINS = 24;
/** Value area = bins covering this fraction of session volume around POC. */
const VALUE_AREA_FRAC = 0.7;

/** Tick-rule / Lee-Ready style: uptick → buy, downtick → sell, flat → prior. */
export function estimateDelta(bars: Bar[]): SessionFlowResult["estimatedDelta"] {
  const out: SessionFlowResult["estimatedDelta"] = [];
  let prevClose: number | null = null;
  let lastSide: "buy" | "sell" = "buy";
  for (const b of bars) {
    const vol = Math.max(0, b.volume ?? 0);
    let side: "buy" | "sell" = lastSide;
    if (prevClose != null) {
      if (b.close > prevClose) side = "buy";
      else if (b.close < prevClose) side = "sell";
    } else if (b.close >= b.open) side = "buy";
    else side = "sell";
    lastSide = side;
    prevClose = b.close;
    const buy = side === "buy" ? vol : 0;
    const sell = side === "sell" ? vol : 0;
    out.push({
      time: Math.floor(b.time / 1000),
      buy,
      sell,
      delta: buy - sell,
    });
  }
  return out;
}

export function computeSessionVwap(bars: Bar[]): SessionFlowPoint[] {
  const pts: SessionFlowPoint[] = [];
  let cumPV = 0;
  let cumV = 0;
  for (const b of bars) {
    const vol = Math.max(0, b.volume ?? 0);
    if (vol <= 0) continue;
    const typical = (b.high + b.low + b.close) / 3;
    cumPV += typical * vol;
    cumV += vol;
    if (cumV > 0) pts.push({ time: Math.floor(b.time / 1000), value: cumPV / cumV });
  }
  return pts;
}

export function computeVolumeProfile(bars: Bar[], bins = PROFILE_BINS): {
  profile: VolumeProfileLevel[];
  poc: number | null;
  vah: number | null;
  val: number | null;
} {
  if (bars.length === 0) return { profile: [], poc: null, vah: null, val: null };
  let lo = Infinity;
  let hi = -Infinity;
  let totalVol = 0;
  for (const b of bars) {
    lo = Math.min(lo, b.low);
    hi = Math.max(hi, b.high);
    totalVol += Math.max(0, b.volume ?? 0);
  }
  if (!(hi > lo) || totalVol <= 0) return { profile: [], poc: null, vah: null, val: null };

  const width = (hi - lo) / bins;
  const vols = new Array(bins).fill(0) as number[];
  for (const b of bars) {
    const vol = Math.max(0, b.volume ?? 0);
    if (vol <= 0) continue;
    const mid = (b.high + b.low + b.close) / 3;
    let i = Math.floor((mid - lo) / width);
    if (i < 0) i = 0;
    if (i >= bins) i = bins - 1;
    vols[i]! += vol;
  }

  const profile: VolumeProfileLevel[] = vols.map((volume, i) => ({
    price: lo + (i + 0.5) * width,
    volume,
  }));

  let pocIdx = 0;
  for (let i = 1; i < bins; i++) {
    if (vols[i]! > vols[pocIdx]!) pocIdx = i;
  }
  const poc = profile[pocIdx]!.price;

  // Expand value area around POC until ~70% of volume.
  let loI = pocIdx;
  let hiI = pocIdx;
  let covered = vols[pocIdx]!;
  const target = totalVol * VALUE_AREA_FRAC;
  while (covered < target && (loI > 0 || hiI < bins - 1)) {
    const left = loI > 0 ? vols[loI - 1]! : -1;
    const right = hiI < bins - 1 ? vols[hiI + 1]! : -1;
    if (right >= left) {
      hiI += 1;
      covered += vols[hiI]!;
    } else {
      loI -= 1;
      covered += vols[loI]!;
    }
  }

  return {
    profile,
    poc,
    vah: profile[hiI]!.price,
    val: profile[loI]!.price,
  };
}

export function buildSessionFlow(
  ticker: string,
  sessionDate: string,
  bars: Bar[],
  source: SessionFlowResult["source"] = "yahoo-5m",
): SessionFlowResult {
  const vwap = computeSessionVwap(bars);
  const { profile, poc, vah, val } = computeVolumeProfile(bars);
  const note =
    source === "polygon-1m"
      ? "Polygon 1m RTH (DB) — estimated delta via tick rule (not true footprint)."
      : "Yahoo 5m RTH session — estimated delta via tick rule (not true footprint).";
  return {
    ticker: ticker.toUpperCase(),
    sessionDate,
    source,
    barCount: bars.length,
    vwap,
    poc,
    vah,
    val,
    profile,
    estimatedDelta: estimateDelta(bars),
    note,
  };
}

function pickLatestSession(
  sessions: Map<string, Bar[]>,
  minBars: number,
  source: SessionFlowResult["source"],
  ticker: string,
): SessionFlowResult | null {
  const dates = [...sessions.keys()].sort();
  for (let i = dates.length - 1; i >= 0; i--) {
    const date = dates[i]!;
    const bars = sessions.get(date) ?? [];
    if (bars.length >= minBars) return buildSessionFlow(ticker, date, bars, source);
  }
  return null;
}

/** Latest ET session — Polygon 1m DB first (≈390 RTH bars), else Yahoo 5m. */
export async function getSessionFlow(ticker: string): Promise<SessionFlowResult | null> {
  const key = ticker.toUpperCase();
  return cache.getOrCompute(key, async () => {
    try {
      const poly = await fetchPolygon1mSessions(key, 10);
      // ~1h of 1m tape
      const hit = pickLatestSession(poly, 60, "polygon-1m", key);
      if (hit) return hit;
    } catch {
      // table missing / DB blip → Yahoo
    }
    const sessions = await fetchIntradayHistory(key, 10);
    const hit = pickLatestSession(sessions, 12, "yahoo-5m", key);
    if (hit) return hit;
    return {
      ticker: key,
      sessionDate: etDateOf(Date.now()),
      source: "yahoo-5m",
      barCount: 0,
      vwap: [],
      poc: null,
      vah: null,
      val: null,
      profile: [],
      estimatedDelta: [],
      note: "No RTH session in Polygon 1m DB or Yahoo 5m window",
    };
  });
}
