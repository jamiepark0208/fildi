// Pure grading + scorecard maths for the indicator track record (tv-indicators spec phase 2 B). No I/O here.
//
// An event is graded from the close of its signal bar, same session only:
//   hit  = price reaches +0.5 ATR in the signal's direction before -0.5 ATR (same bar both = miss; neither = miss)
//   fwd  = % move in the signal's direction to +30m / +60m / the session close (exact bar ends; null if not on a bar edge)
//   MFE/MAE = best / worst excursion to the session close, in ATR
// Placebo = the same test from a random other bar of the same ticker, tf, time of day and direction (seeded, so
// re-grading is stable). Kept as context only.
//
// VERDICT BASIS = ROUND TRIP (Jamie 11-04: "+-0.5 ATR next bars is not the trade"). Buy at the signal-bar close, exit
// at the close of the indicator's next opposite signal (same tf, same session), else at the session close. Comparator
// = 50 seeded random entries anywhere in the series, same side, same hold length, not crossing a session. Lift = avg
// round trip - avg random (% per trade); t is day-clustered; verdict is the fixed rule below, no judgment.
import { etClock, type ResampledBar } from "@workspace/indicators";

export const HIT_ATR = 0.5;
export const MIN_USEFUL_LIFT_PCT = 0.10; // round-trip lift, % per trade (~ a 5m spread + slippage on liquid names)
export const NOISE_LIFT_PCT = 0.05;
// Data floor (added to the spec rule so 8 lucky signals on 4 days cannot read "useful"): below it the answer is always "too early".
export const MIN_N = 20;
export const MIN_DAYS = 5;
export const POWER_Z = 2.8; // 80% power at 5% two-sided

export type Verdict = "likely useful" | "likely worse than random" | "likely noise" | "too early";

export type EventGrade = {
  fwd30mPct: number | null;
  fwd60mPct: number | null;
  fwdClosePct: number | null;
  mfeAtr: number | null;
  maeAtr: number | null;
  hit: boolean | null;
};

const NONE: EventGrade = { fwd30mPct: null, fwd60mPct: null, fwdClosePct: null, mfeAtr: null, maeAtr: null, hit: null };

/** Per-bar ET date, minute of day and session-end index, computed once per series (etClock is slow). */
export type BarCtx = { day: string[]; mod: number[]; sessEnd: number[] };
export function barCtx(bars: ResampledBar[]): BarCtx {
  const day: string[] = [], mod: number[] = [], sessEnd: number[] = new Array(bars.length).fill(0);
  for (const b of bars) { const [d, m] = etClock(b.time); day.push(d); mod.push(m); }
  for (let i = bars.length - 1; i >= 0; i--) sessEnd[i] = i + 1 < bars.length && day[i + 1] === day[i] ? sessEnd[i + 1]! : i;
  return { day, mod, sessEnd };
}

function dirOf(side: "buy" | "sell" | "neutral"): 1 | -1 | 0 {
  return side === "buy" ? 1 : side === "sell" ? -1 : 0;
}

export function gradeAt(bars: ResampledBar[], i: number, side: "buy" | "sell" | "neutral", atrV: number, ctx: BarCtx = barCtx(bars)): EventGrade {
  const sessEnd = ctx.sessEnd[i]!;
  const d = dirOf(side);
  if (d === 0 || !Number.isFinite(atrV) || atrV <= 0 || sessEnd <= i) return NONE;
  const entry = bars[i]!.close;
  const thr = HIT_ATR * atrV;
  let hit: boolean | null = null;
  let mfe = 0, mae = 0;
  const t30 = bars[i]!.end + 1800, t60 = bars[i]!.end + 3600;
  let f30: number | null = null, f60: number | null = null;
  for (let j = i + 1; j <= sessEnd; j++) {
    const b = bars[j]!;
    const fav = d > 0 ? b.high - entry : entry - b.low;
    const adv = d > 0 ? entry - b.low : b.high - entry;
    if (hit === null) {
      if (fav >= thr && adv >= thr) hit = false;
      else if (fav >= thr) hit = true;
      else if (adv >= thr) hit = false;
    }
    if (fav > mfe) mfe = fav;
    if (adv > mae) mae = adv;
    const full = b.lastTime + 300 >= b.end;
    if (full && b.end === t30) f30 = (d * (b.close - entry)) / entry * 100;
    if (full && b.end === t60) f60 = (d * (b.close - entry)) / entry * 100;
  }
  return {
    fwd30mPct: f30, fwd60mPct: f60,
    fwdClosePct: (d * (bars[sessEnd]!.close - entry)) / entry * 100,
    mfeAtr: mfe / atrV, maeAtr: mae / atrV,
    hit: hit ?? false,
  };
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s: string): number {
  let h = 2166136261;
  for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Placebo hit for the event at bar i: random other-day bar at the same time of day, same direction, its own ATR. */
export function placeboHit(bars: ResampledBar[], atrS: number[], i: number, side: "buy" | "sell", seedKey: string, ctx: BarCtx = barCtx(bars)): boolean | null {
  const cands: number[] = [];
  for (let j = 0; j < bars.length - 1; j++) {
    if (j !== i && Number.isFinite(atrS[j]!) && ctx.day[j] !== ctx.day[i] && ctx.mod[j] === ctx.mod[i]) cands.push(j);
  }
  if (!cands.length) return null;
  const j = cands[Math.floor(mulberry32(hashStr(seedKey))() * cands.length)]!;
  return gradeAt(bars, j, side, atrS[j]!, ctx).hit;
}

export type RoundTrip = { rtPct: number; rtBars: number; rtExit: "flip" | "close"; rtRandomPct: number | null; rtRandomWin: number | null };
export const RANDOM_DRAWS = 50;

/** Exit bar for an entry at i: first opposite-side signal bar after i in the same session, else the session close. */
export function exitFor(i: number, side: "buy" | "sell", signals: { i: number; side: "buy" | "sell" }[], ctx: BarCtx): { j: number; exit: "flip" | "close" } {
  const end = ctx.sessEnd[i]!;
  let best = Infinity;
  for (const s of signals) if (s.side !== side && s.i > i && s.i <= end && s.i < best) best = s.i;
  return Number.isFinite(best) ? { j: best, exit: "flip" } : { j: end, exit: "close" };
}

/** Bars sorted by how many bars remain in their session (desc), so "every start with >= L bars left" is a prefix. */
export type RandomIndex = { order: number[]; rem: number[] };
export function randomIndex(bars: ResampledBar[], ctx: BarCtx): RandomIndex {
  const rem = bars.map((_, j) => ctx.sessEnd[j]! - j);
  const order = rem.map((_, j) => j).filter((j) => bars[j]!.lastTime + 300 >= bars[j]!.end).sort((a, b) => rem[b]! - rem[a]!);
  return { order, rem };
}

export function roundTrip(bars: ResampledBar[], i: number, side: "buy" | "sell", exit: { j: number; exit: "flip" | "close" }, rix: RandomIndex, seedKey: string): RoundTrip | null {
  const L = exit.j - i;
  if (L <= 0) return null;
  const d = side === "buy" ? 1 : -1;
  const rtPct = (d * (bars[exit.j]!.close / bars[i]!.close - 1)) * 100;
  let lo = 0, hi = rix.order.length; // count of starts with rem >= L
  while (lo < hi) { const m = (lo + hi) >> 1; if (rix.rem[rix.order[m]!]! >= L) lo = m + 1; else hi = m; }
  if (lo < 2) return { rtPct, rtBars: L, rtExit: exit.exit, rtRandomPct: null, rtRandomWin: null };
  const rnd = mulberry32(hashStr(seedKey));
  let sum = 0, wins = 0;
  for (let k = 0; k < RANDOM_DRAWS; k++) {
    const a = rix.order[Math.floor(rnd() * lo)]!;
    const r = d * (bars[a + L]!.close / bars[a]!.close - 1) * 100;
    sum += r; if (r > 0) wins++;
  }
  return { rtPct, rtBars: L, rtExit: exit.exit, rtRandomPct: sum / RANDOM_DRAWS, rtRandomWin: wins / RANDOM_DRAWS };
}

// ── Scorecard ────────────────────────────────────────────────────────────────────────────────────────────────────

export type ScoreInput = {
  indicatorId: string; version: number; kind: string; tf: string; day: string; time: number;
  rtPct: number; rtRandomPct: number; rtRandomWin: number | null; hit: boolean | null; placeboHit: boolean | null;
};
export type ScoreRow = {
  indicatorId: string; version: number; kind: string; tf: string; n: number; days: number;
  winPct: number; randomWinPct: number | null; avgRtPct: number; randomRtPct: number; liftPct: number; mdePct: number;
  tStat: number; signBothHalves: boolean; verdict: Verdict; needMore: number | null; gradedThrough: number;
  hitPct: number | null; placeboHitPct: number | null; liftPts: number | null; // old +-0.5 ATR hit test, context only
};

/** The fixed rule on round-trip lift (% per trade vs random): useful = lift >= 0.10, |t| >= 2, same sign both halves;
 *  worse than random (fade candidate) = the mirror; noise = |lift| < 0.05 with MDE <= 0.10; else too early. */
export function verdictFor(liftPct: number, t: number, signBoth: boolean, mdePct: number, n = Infinity, days = Infinity): Verdict {
  if (n < MIN_N || days < MIN_DAYS) return "too early";
  if (liftPct >= MIN_USEFUL_LIFT_PCT && t >= 2 && signBoth) return "likely useful";
  if (liftPct <= -MIN_USEFUL_LIFT_PCT && t <= -2 && signBoth) return "likely worse than random";
  if (Math.abs(liftPct) < NOISE_LIFT_PCT && mdePct <= MIN_USEFUL_LIFT_PCT) return "likely noise";
  return "too early";
}

export function statsFor(rows: ScoreInput[]): Omit<ScoreRow, "indicatorId" | "version" | "kind" | "tf"> | null {
  const n = rows.length;
  if (!n) return null;
  const x = rows.map((r) => r.rtPct - r.rtRandomPct);
  const mean = x.reduce((a, b) => a + b, 0) / n;
  const byDay = new Map<string, { s: number; k: number }>();
  rows.forEach((r, k) => { const g = byDay.get(r.day) ?? { s: 0, k: 0 }; g.s += x[k]!; g.k += 1; byDay.set(r.day, g); });
  const D = byDay.size;
  let t = 0, se = NaN;
  if (D >= 3) {
    let ss = 0;
    for (const g of byDay.values()) ss += (g.s - g.k * mean) ** 2;
    se = Math.sqrt((ss * D) / (D - 1)) / n;
    t = se > 0 ? mean / se : 0;
  }
  const order = rows.map((_, k) => k).sort((a, b) => rows[a]!.time - rows[b]!.time);
  const half = Math.floor(n / 2);
  const m = (idx: number[]) => (idx.length ? idx.reduce((a, k) => a + x[k]!, 0) / idx.length : 0);
  const m1 = m(order.slice(0, half)), m2 = m(order.slice(half));
  const signBoth = (m1 > 0 && m2 > 0) || (m1 < 0 && m2 < 0);
  const mdePct = Number.isFinite(se) ? POWER_Z * se : Infinity;
  const verdict = verdictFor(mean, t, signBoth, mdePct, n, D);
  let needMore: number | null = null;
  if (verdict === "too early") {
    const target = mdePct > MIN_USEFUL_LIFT_PCT ? MIN_USEFUL_LIFT_PCT : NOISE_LIFT_PCT;
    needMore = Number.isFinite(mdePct) ? Math.max(0, Math.ceil(n * ((mdePct / target) ** 2 - 1)), MIN_N - n) : Math.max(0, MIN_N - n);
  }
  const avg = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const rw = rows.filter((r) => r.rtRandomWin != null).map((r) => r.rtRandomWin!);
  const hr = rows.filter((r) => r.hit != null && r.placeboHit != null);
  const hitPct = hr.length ? (hr.filter((r) => r.hit).length / hr.length) * 100 : null;
  const placeboHitPct = hr.length ? (hr.filter((r) => r.placeboHit).length / hr.length) * 100 : null;
  return {
    n, days: D,
    winPct: (rows.filter((r) => r.rtPct > 0).length / n) * 100,
    randomWinPct: rw.length ? avg(rw) * 100 : null,
    avgRtPct: avg(rows.map((r) => r.rtPct)), randomRtPct: avg(rows.map((r) => r.rtRandomPct)),
    liftPct: mean, mdePct, tStat: t, signBothHalves: signBoth, verdict, needMore,
    gradedThrough: Math.max(...rows.map((r) => r.time)),
    hitPct, placeboHitPct, liftPts: hitPct != null && placeboHitPct != null ? hitPct - placeboHitPct : null,
  };
}

/** Rows per (indicator, version) x (kind | ALL) x (tf | ALL). */
export function buildScorecard(all: ScoreInput[]): ScoreRow[] {
  const groups = new Map<string, ScoreInput[]>();
  const push = (key: string, r: ScoreInput) => { const g = groups.get(key); if (g) g.push(r); else groups.set(key, [r]); };
  for (const r of all) {
    for (const kind of [r.kind, "ALL"]) for (const tf of [r.tf, "ALL"]) push(`${r.indicatorId}\u0001${r.version}\u0001${kind}\u0001${tf}`, r);
  }
  const out: ScoreRow[] = [];
  for (const [key, rows] of groups) {
    const [indicatorId, version, kind, tf] = key.split("\u0001") as [string, string, string, string];
    const s = statsFor(rows);
    if (s) out.push({ indicatorId, version: Number(version), kind, tf, ...s });
  }
  return out;
}
