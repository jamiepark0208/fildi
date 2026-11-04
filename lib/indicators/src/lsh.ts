/**
 * Liquidity Sweep Hunter — port of "Liquidity Sweep Hunter Algo [AlgoAlpha]" (Pine v6).
 * This Pine Script code is subject to the terms of the Mozilla Public License 2.0 at https://mozilla.org/MPL/2.0/
 * © AlgoAlpha
 *
 * Ported: level detection (fast/mid/slow highest/lowest shifts), level memory (merge, age prune, wick/close
 * mitigation), the directional-volume strength model, the heatmap-cell state the script uses to decide which levels
 * are "visibly distinct" (cell height, 5-bar cadence — boxes themselves are not drawn), and the sweep + reclaim signals
 * of the two alertconditions. Skipped on purpose: heatmap boxes, TP/SL trade drawings and their milestone checkmarks.
 * `bar_index` is the index in the bars passed in (TradingView's counts from the first loaded bar).
 */
import { atr } from "./ut-st.ts";
import { highest, lowest, sma, type Series } from "./pine.ts";
import type { IndicatorDef, TvBar } from "./types.ts";

export type LshOptions = {
  shortBars: number; mediumBars: number; longBars: number; keepLevelsForBars: number;
  removeLevelWhen: "Wick" | "Close";
  heatmapLookback: number; heatmapResolution: number; heatmapCellBars: number;
  filterSweepsByStrength: boolean; minimumSweepStrength: number;
  /** syminfo.mintick (US equities 0.01). */
  mintick: number;
};
export const LSH_DEFAULTS: LshOptions = {
  shortBars: 14, mediumBars: 42, longBars: 120, keepLevelsForBars: 1000, removeLevelWhen: "Wick",
  heatmapLookback: 777, heatmapResolution: 200, heatmapCellBars: 5,
  filterSweepsByStrength: true, minimumSweepStrength: 33, mintick: 0.01,
};

const SHIFT_COMPARISON_BARS = 3;
const LEVEL_MERGE_TICKS = 2;
const CLEANUP_BARS = 10;
const VOLUME_AVERAGE_BARS = 100;
const MAX_VOLUME_SCORE_PER_BAR = 3.0;
const FULL_HEATMAP_STRENGTH = 50.0;
const MIN_LEVELS_FOR_SIGNAL = 2;
const SIGNAL_RECLAIM_BARS = 2;
const SIGNAL_ATR_LENGTH = 14;
const SIGNAL_OFFSET_MULTIPLIER = 0.15;
const LEVEL_WEIGHTS = [1.0, 0.25, 0.05];

export type LshLevel = {
  side: "high" | "low";
  price: number;
  src: "fast" | "mid" | "slow";
  /** Bar the level was first created, and the bar it left memory (mitigated or aged out); null = still active. */
  bornBar: number;
  removedBar: number | null;
  removedBy: "mitigated" | "aged" | null;
};
export type LshSignal = {
  i: number; time: number; side: "bull" | "bear";
  /** Marker price (signalOffset away from the wick, like plotshape). */
  price: number;
  /** Bar of the sweep, how many visibly distinct bands it cleared, their average strength, and the reclaim level. */
  sweepBar: number; bands: number; strength: number; reclaim: number;
};
export type LshResult = {
  levels: LshLevel[];
  signals: LshSignal[];
  /** Three nearest active liquidity levels above / below the close, per bar (na when none). */
  upper: [Series, Series, Series];
  lower: [Series, Series, Series];
};

type Level = {
  price: number; birth: number; strength: number;
  lastDrawn: boolean; lastNorm: number; lastCellH: number; lastDrawBar: number;
  rec: LshLevel;
};
type Pending = { bar: number; reclaim: number; bands: number; strength: number };

const roundToTick = (v: number, tick: number): number => Math.round(v / tick) * tick;

function findInsertIndex(levels: Level[], price: number, descending: boolean): number {
  let lo = 0, hi = levels.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) * 0.5);
    const mp = levels[mid]!.price;
    if (descending ? mp > price : mp < price) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function addLevel(levels: Level[], raw: number, tolerance: number, descending: boolean, bar: number, tick: number, all: LshLevel[], side: "high" | "low", src: LshLevel["src"]): void {
  if (Number.isNaN(raw)) return;
  const price = roundToTick(raw, tick);
  const size = levels.length;
  const ins = findInsertIndex(levels, price, descending);
  let match = -1;
  let best = NaN;
  if (ins < size) {
    const d = Math.abs(levels[ins]!.price - price);
    if (d <= tolerance) { match = ins; best = d; }
  }
  if (ins > 0) {
    const d = Math.abs(levels[ins - 1]!.price - price);
    if (d <= tolerance && (Number.isNaN(best) || d < best)) match = ins - 1;
  }
  if (match < 0) {
    const rec: LshLevel = { side, price, src, bornBar: bar, removedBar: null, removedBy: null };
    all.push(rec);
    levels.splice(ins, 0, { price, birth: bar, strength: 0, lastDrawn: false, lastNorm: NaN, lastCellH: NaN, lastDrawBar: NaN, rec });
  } else {
    levels[match]!.birth = bar;
  }
}

function pruneExpired(levels: Level[], bar: number, maxAge: number): void {
  for (let i = levels.length - 1; i >= 0; i--) {
    if (bar - levels[i]!.birth > maxAge) {
      const r = levels[i]!.rec;
      r.removedBar = bar; r.removedBy = "aged";
      levels.splice(i, 1);
    }
  }
}

/** f_mitigateUppers / f_mitigateLowers: pop from the end while the end level is inside the mitigation price. */
function mitigate(levels: Level[], upper: boolean, price: number, bar: number): number {
  let removed = 0;
  while (levels.length) {
    const l = levels[levels.length - 1]!;
    if (upper ? l.price <= price : l.price >= price) {
      l.rec.removedBar = bar; l.rec.removedBy = "mitigated";
      levels.pop();
      removed += 1;
    } else break;
  }
  return removed;
}

/** f_upperVisibleSweepStats / f_lowerVisibleSweepStats. */
function visibleSweepStats(levels: Level[], upper: boolean, wick: number, bar: number, maxAge: number): { bands: number; reclaim: number; avg: number } {
  let bandCount = 0, reclaim = NaN, strengthSum = 0;
  let bandOpen = false, bandEdge = NaN, bandStrength = 0;
  for (let i = levels.length - 1; i >= 0; i--) {
    const l = levels[i]!;
    if (upper ? l.price <= wick : l.price >= wick) {
      const recentlyDrawn = !Number.isNaN(l.lastDrawBar) && bar - l.lastDrawBar <= maxAge;
      const visible = recentlyDrawn && l.lastDrawn && !Number.isNaN(l.lastNorm) && !Number.isNaN(l.lastCellH) && l.lastCellH > 0;
      if (visible) {
        const bottom = l.price - l.lastCellH * 0.5, top = l.price + l.lastCellH * 0.5;
        reclaim = Number.isNaN(reclaim) ? l.price : upper ? Math.min(reclaim, l.price) : Math.max(reclaim, l.price);
        if (!bandOpen) {
          bandOpen = true; bandEdge = upper ? top : bottom; bandStrength = l.lastNorm;
        } else if (upper ? bottom <= bandEdge : top >= bandEdge) {
          bandEdge = upper ? Math.max(bandEdge, top) : Math.min(bandEdge, bottom);
          bandStrength = Math.max(bandStrength, l.lastNorm);
        } else {
          bandCount += 1; strengthSum += bandStrength;
          bandEdge = upper ? top : bottom; bandStrength = l.lastNorm;
        }
      }
    } else break;
  }
  if (bandOpen) { bandCount += 1; strengthSum += bandStrength; }
  return { bands: bandCount, reclaim, avg: bandCount > 0 ? strengthSum / bandCount : 0 };
}

/** f_resolveUpperSweeps / f_resolveLowerSweeps. Returns the newest resolved sweep, if any. */
function resolveSweeps(pending: Pending[], upper: boolean, close: number, bar: number): Pending | null {
  let hit: Pending | null = null;
  for (let i = pending.length - 1; i >= 0; i--) {
    const p = pending[i]!;
    const age = bar - p.bar;
    if (age > SIGNAL_RECLAIM_BARS) pending.splice(i, 1);
    else if (upper ? close < p.reclaim : close > p.reclaim) {
      if (!hit) hit = p;
      pending.splice(i, 1);
    }
  }
  return hit;
}

export function lsh(bars: TvBar[], opt: Partial<LshOptions> = {}): LshResult {
  const o = { ...LSH_DEFAULTS, ...opt };
  const n = bars.length;
  const high = bars.map((b) => b.high), low = bars.map((b) => b.low);
  const h = [highest(high, o.shortBars), highest(high, o.mediumBars), highest(high, o.longBars)];
  const l = [lowest(low, o.shortBars), lowest(low, o.mediumBars), lowest(low, o.longBars)];
  const srcName: LshLevel["src"][] = ["fast", "mid", "slow"];
  const hv = [NaN, NaN, NaN];
  const lv = [NaN, NaN, NaN];
  const vol = bars.map((b) => b.volume ?? 0);
  const volAvg = sma(vol, VOLUME_AVERAGE_BARS);
  const atrS = atr(bars, SIGNAL_ATR_LENGTH);
  const heatHigh = highest(high, o.heatmapLookback);
  const heatLow = lowest(low, o.heatmapLookback);

  const uppers: Level[] = []; // descending by price
  const lowers: Level[] = []; // ascending by price
  const pendingU: Pending[] = [];
  const pendingL: Pending[] = [];
  const all: LshLevel[] = [];
  const signals: LshSignal[] = [];
  const upper: [Series, Series, Series] = [new Array(n).fill(NaN), new Array(n).fill(NaN), new Array(n).fill(NaN)];
  const lower: [Series, Series, Series] = [new Array(n).fill(NaN), new Array(n).fill(NaN), new Array(n).fill(NaN)];
  const removeOnWick = o.removeLevelWhen === "Wick";
  const tolerance = o.mintick * LEVEL_MERGE_TICKS;

  for (let i = 0; i < n; i++) {
    const c = bars[i]!.close;
    // Level source: shift detection (compares to 3 bars ago and 1 bar ago), then the stored level takes the new value.
    const hShift: boolean[] = [], lShift: boolean[] = [];
    for (let k = 0; k < 3; k++) {
      const hh = h[k]![i]!, ll = l[k]![i]!;
      const hh3 = i >= SHIFT_COMPARISON_BARS ? h[k]![i - SHIFT_COMPARISON_BARS]! : NaN;
      const ll3 = i >= SHIFT_COMPARISON_BARS ? l[k]![i - SHIFT_COMPARISON_BARS]! : NaN;
      const hh1 = i ? h[k]![i - 1]! : NaN, ll1 = i ? l[k]![i - 1]! : NaN;
      hShift[k] = !Number.isNaN(hh) && (Number.isNaN(hv[k]!) || (!Number.isNaN(hh3) && hh > hh3 && hh !== hh3 && hh === hh1));
      lShift[k] = !Number.isNaN(ll) && (Number.isNaN(lv[k]!) || (!Number.isNaN(ll3) && ll < ll3 && ll !== ll3 && ll === ll1));
    }
    for (let k = 0; k < 3; k++) {
      if (hShift[k]) hv[k] = h[k]![i]!;
      if (lShift[k]) lv[k] = l[k]![i]!;
    }

    // Level memory update (history bars are all confirmed).
    const upMit = removeOnWick ? bars[i]!.high : c;
    const loMit = removeOnWick ? bars[i]!.low : c;
    const us = visibleSweepStats(uppers, true, bars[i]!.high, i, o.heatmapCellBars);
    const ls = visibleSweepStats(lowers, false, bars[i]!.low, i, o.heatmapCellBars);
    mitigate(uppers, true, upMit, i);
    mitigate(lowers, false, loMit, i);
    const minStrength = o.minimumSweepStrength / 100.0;
    const uQual = !o.filterSweepsByStrength || us.avg >= minStrength;
    const lQual = !o.filterSweepsByStrength || ls.avg >= minStrength;
    if (removeOnWick && us.bands >= MIN_LEVELS_FOR_SIGNAL && uQual && !Number.isNaN(us.reclaim)) {
      pendingU.push({ bar: i, reclaim: us.reclaim, bands: us.bands, strength: us.avg });
    }
    if (removeOnWick && ls.bands >= MIN_LEVELS_FOR_SIGNAL && lQual && !Number.isNaN(ls.reclaim)) {
      pendingL.push({ bar: i, reclaim: ls.reclaim, bands: ls.bands, strength: ls.avg });
    }
    const bearHit = resolveSweeps(pendingU, true, c, i);
    const bullHit = resolveSweeps(pendingL, false, c, i);
    if (i % CLEANUP_BARS === 0) {
      pruneExpired(uppers, i, o.keepLevelsForBars);
      pruneExpired(lowers, i, o.keepLevelsForBars);
    }
    for (let k = 0; k < 3; k++) {
      if (hShift[k]) addLevel(uppers, hv[k]!, tolerance, true, i, o.mintick, all, "high", srcName[k]!);
      if (lShift[k]) addLevel(lowers, lv[k]!, tolerance, false, i, o.mintick, all, "low", srcName[k]!);
    }

    // Nearest active levels (three above the close, three below).
    const activeU: Level[] = [];
    for (let j = uppers.length - 1; j >= 0 && activeU.length < 3; j--) {
      const lv_ = uppers[j]!;
      if (lv_.price > c && i - lv_.birth <= o.keepLevelsForBars) activeU.push(lv_);
    }
    const activeL: Level[] = [];
    for (let j = lowers.length - 1; j >= 0 && activeL.length < 3; j--) {
      const lv_ = lowers[j]!;
      if (lv_.price < c && i - lv_.birth <= o.keepLevelsForBars) activeL.push(lv_);
    }

    // Directional volume strength.
    const bv = vol[i]!;
    const va = volAvg[i]!;
    const safeAvg = Number.isNaN(va) || va <= 0 ? bv : va;
    const rawNorm = safeAvg > 0 ? bv / safeAvg : 0;
    const normVol = Math.min(rawNorm, MAX_VOLUME_SCORE_PER_BAR);
    const dir = c > bars[i]!.open ? 1 : c < bars[i]!.open ? -1 : 0;
    const signed = normVol * dir;
    if (signed < 0) {
      activeU.forEach((lv_, k) => { lv_.strength = Math.min(lv_.strength + Math.abs(signed) * LEVEL_WEIGHTS[k]!, FULL_HEATMAP_STRENGTH); });
    } else if (signed > 0) {
      activeL.forEach((lv_, k) => { lv_.strength = Math.min(lv_.strength + signed * LEVEL_WEIGHTS[k]!, FULL_HEATMAP_STRENGTH); });
    }
    const maxStrength = Math.max(0, ...activeU.map((x) => x.strength), ...activeL.map((x) => x.strength));

    // Heatmap cell state (what the script reads back to decide visibility).
    const hH = Number.isNaN(heatHigh[i]!) ? bars[i]!.high : heatHigh[i]!;
    const hL = Number.isNaN(heatLow[i]!) ? bars[i]!.low : heatLow[i]!;
    const cellH = Math.max(hH - hL, o.mintick * o.heatmapResolution) / o.heatmapResolution;
    if ((i + 1) % o.heatmapCellBars === 0) {
      for (const lv_ of [...activeU, ...activeL]) {
        lv_.lastDrawn = true;
        lv_.lastNorm = maxStrength > 0 ? Math.max(0, Math.min(1, lv_.strength / maxStrength)) : 0;
        lv_.lastCellH = cellH;
        lv_.lastDrawBar = i;
      }
    }
    activeU.forEach((lv_, k) => { upper[k]![i] = lv_.price; });
    activeL.forEach((lv_, k) => { lower[k]![i] = lv_.price; });

    // Signals.
    const off = (Number.isNaN(atrS[i]!) ? bars[i]!.high - bars[i]!.low : atrS[i]!) * SIGNAL_OFFSET_MULTIPLIER;
    if (bullHit) signals.push({ i, time: bars[i]!.time, side: "bull", price: bars[i]!.low - off, sweepBar: bullHit.bar, bands: bullHit.bands, strength: bullHit.strength, reclaim: bullHit.reclaim });
    if (bearHit) signals.push({ i, time: bars[i]!.time, side: "bear", price: bars[i]!.high + off, sweepBar: bearHit.bar, bands: bearHit.bands, strength: bearHit.strength, reclaim: bearHit.reclaim });
  }
  return { levels: all, signals, upper, lower };
}

const lf = (x: number): string => (Math.abs(x) >= 100 ? x.toFixed(2) : x.toFixed(3));

export const def: IndicatorDef<LshOptions> = {
  id: "lsh",
  label: "Liquidity Sweep",
  version: 1,
  source: { url: "https://www.tradingview.com/scripts/search/liquidity+sweep+hunter+algoalpha/", author: "AlgoAlpha", license: "MPL-2.0", pinePath: "research/sources/tradingview/liquidity-sweep-hunter-algoalpha.pine" },
  defaults: LSH_DEFAULTS,
  timeframes: ["5m", "15m", "1h"],
  pane: "price",
  title: "Nearest 3 liquidity highs (red) / lows (teal); arrows = sweep of 2+ levels then reclaim.",
  marker: (e) => ({ text: "Sweep", color: e.side === "buy" ? "#00ffbb" : "#ff1100" }),
  compute(bars, opts) {
    const r = lsh(bars, opts);
    const series: Record<string, number[]> = {};
    r.upper.forEach((v, k) => { series[`u${k + 1}`] = v; });
    r.lower.forEach((v, k) => { series[`l${k + 1}`] = v; });
    return {
      series,
      events: r.signals.map((s) => ({
        time: s.time, side: s.side === "bull" ? "buy" : "sell", kind: "Sweep", price: bars[s.i]!.close,
        note: [`${s.side === "bull" ? "Bullish" : "Bearish"} sweep reversal: ${s.bands} levels cleared (avg strength ${(s.strength * 100).toFixed(0)}%), reclaimed ${lf(s.reclaim)}`],
      })),
      view: {
        lines: [
          ...r.upper.map((_, k) => ({ key: `u${k + 1}`, color: "rgba(239,68,68,0.8)", dashed: true })),
          ...r.lower.map((_, k) => ({ key: `l${k + 1}`, color: "rgba(0,255,187,0.8)", dashed: true })),
        ],
      },
    };
  },
};
