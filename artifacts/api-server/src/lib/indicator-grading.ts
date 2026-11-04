// Pure grading + scorecard maths for the indicator track record (tv-indicators spec phase 2 B). No I/O here.
//
// An event is graded from the close of its signal bar, same session only:
//   hit  = price reaches +0.5 ATR in the signal's direction before -0.5 ATR (same bar both = miss; neither = miss)
//   fwd  = % move in the signal's direction to +30m / +60m / the session close (exact bar ends; null if not on a bar edge)
//   MFE/MAE = best / worst excursion to the session close, in ATR
// Placebo = the same test from a random other bar of the same ticker, tf, time of day and direction (seeded, so
// re-grading is stable). Lift = hit% - placebo hit%; t is day-clustered; verdict is the fixed rule below, no judgment.
import { etClock, type ResampledBar } from "@workspace/indicators";

export const HIT_ATR = 0.5;
export const MIN_USEFUL_LIFT = 3;
export const NOISE_LIFT = 1.5;
// Data floor (added to the spec rule so 8 lucky signals on 4 days cannot read "useful"): below it the answer is always "too early".
export const MIN_N = 20;
export const MIN_DAYS = 5;
export const POWER_Z = 2.8; // 80% power at 5% two-sided

export type Verdict = "likely useful" | "likely noise" | "too early";

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

// ── Scorecard ────────────────────────────────────────────────────────────────────────────────────────────────────

export type ScoreInput = { indicatorId: string; version: number; kind: string; tf: string; day: string; time: number; hit: boolean; placeboHit: boolean };
export type ScoreRow = {
  indicatorId: string; version: number; kind: string; tf: string; n: number; days: number;
  hitPct: number; placeboHitPct: number; liftPts: number; tStat: number; signBothHalves: boolean; mdePts: number;
  verdict: Verdict; needMore: number | null; gradedThrough: number;
};

/** The fixed rule (spec): useful = lift >= 3, |t| >= 2, same sign both halves; noise = |lift| < 1.5 with MDE <= 3; else too early. */
export function verdictFor(liftPts: number, t: number, signBoth: boolean, mdePts: number, n = Infinity, days = Infinity): Verdict {
  if (n < MIN_N || days < MIN_DAYS) return "too early";
  if (liftPts >= MIN_USEFUL_LIFT && Math.abs(t) >= 2 && signBoth) return "likely useful";
  if (Math.abs(liftPts) < NOISE_LIFT && mdePts <= MIN_USEFUL_LIFT) return "likely noise";
  return "too early";
}

export function statsFor(rows: ScoreInput[]): Omit<ScoreRow, "indicatorId" | "version" | "kind" | "tf"> | null {
  const n = rows.length;
  if (!n) return null;
  const x = rows.map((r) => (r.hit ? 1 : 0) - (r.placeboHit ? 1 : 0));
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
  const liftPts = mean * 100;
  const mdePts = Number.isFinite(se) ? POWER_Z * se * 100 : Infinity;
  const verdict = verdictFor(liftPts, t, signBoth, mdePts, n, D);
  let needMore: number | null = null;
  if (verdict === "too early") {
    const target = mdePts > MIN_USEFUL_LIFT ? MIN_USEFUL_LIFT : NOISE_LIFT;
    needMore = Number.isFinite(mdePts) ? Math.max(0, Math.ceil(n * ((mdePts / target) ** 2 - 1)), MIN_N - n) : Math.max(0, MIN_N - n);
  }
  return {
    n, days: D,
    hitPct: (rows.filter((r) => r.hit).length / n) * 100,
    placeboHitPct: (rows.filter((r) => r.placeboHit).length / n) * 100,
    liftPts, tStat: t, signBothHalves: signBoth, mdePts, verdict, needMore,
    gradedThrough: Math.max(...rows.map((r) => r.time)),
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
