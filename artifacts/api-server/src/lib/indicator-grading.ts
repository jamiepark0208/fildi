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

export type RoundTrip = {
  rtPct: number; rtBars: number; rtExit: "flip" | "close"; rtRandomPct: number | null; rtRandomWin: number | null;
  // Structure outcomes over the same hold (signal vs the same random draws), Jamie 11-04: one up/down probability, many trades.
  // Structure facts use the fixed STRUCT_MIN horizon (see below), not the round trip's own hold.
  absPct: number; randomAbsPct: number | null;        // |move| %  -> long (bigger) / short (smaller) straddle-strangle
  noBreach: boolean; randomNoBreach: number | null;   // never > 1 ATR against -> credit spread / short premium on the far side
  target: boolean; randomTarget: number | null;       // reached +1 ATR in favour (context: rises with any vol, not direction)
  bracket: boolean; randomBracket: number | null;     // +1 ATR before -1 ATR (same bar = loss) -> option / debit spread with stop
  volMatched: boolean;                                 // random draws matched on the pre-entry move (else unmatched fallback)
};
/** Pre-entry move = |close - close 3 bars back| / ATR. Signals fire after moves and vol clusters, so random entries
 *  must come from bars with a similar pre-entry move or every excursion test reads "bigger" (found 11-04). */
export const PRE_BARS = 3, PRE_TOL = 0.25;
export function preMove(bars: ResampledBar[], atrS: number[]): number[] {
  return bars.map((b, i) => (i >= PRE_BARS && Number.isFinite(atrS[i]!) && atrS[i]! > 0 ? Math.abs(b.close - bars[i - PRE_BARS]!.close) / atrS[i]! : NaN));
}
export const STRUCT_ATR = 1;
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

/** Path facts over bars a+1..a+L for direction d: [return %, |return| %, no breach, target, bracket win]. */
function pathFacts(bars: ResampledBar[], a: number, L: number, d: 1 | -1, atrV: number): [number, number, boolean, boolean, boolean] {
  const entry = bars[a]!.close, thr = STRUCT_ATR * atrV;
  let adv = 0, fav = 0, br: boolean | null = null;
  for (let k = a + 1; k <= a + L; k++) {
    const b = bars[k]!;
    const f = d > 0 ? b.high - entry : entry - b.low, ad = d > 0 ? entry - b.low : b.high - entry;
    if (f > fav) fav = f; if (ad > adv) adv = ad;
    if (br === null) { if (ad >= thr) br = false; else if (f >= thr) br = true; }
  }
  const r = (bars[a + L]!.close / entry - 1) * 100;
  return [d * r, Math.abs(r), adv < thr, fav >= thr, br === true];
}

/** Structure horizon: options have a fixed expiry, so the structure families use a fixed 60 min (capped at the session
 *  close), set at entry. The round trip's own hold ends at the next flip = a stopping time that depends on the future
 *  path; judging excursions over it vs random same-length holds inflated bracket/target (UT bracket +9 pts, t 17, 11-04). */
export const STRUCT_MIN = 60;

export function roundTrip(bars: ResampledBar[], i: number, side: "buy" | "sell", exit: { j: number; exit: "flip" | "close" }, rix: RandomIndex, seedKey: string, atrS: number[], pre: number[] = [], tfMin = 5): RoundTrip | null {
  const L = exit.j - i;
  const atrI = atrS[i]!;
  if (L <= 0 || !Number.isFinite(atrI) || atrI <= 0) return null;
  const d = side === "buy" ? 1 : -1;
  const Ls = Math.min(Math.max(1, Math.round(STRUCT_MIN / tfMin)), rix.rem[i]!);
  const [rtPct] = pathFacts(bars, i, L, d, atrI);
  const [, absPct, noBreach, target, bracket] = pathFacts(bars, i, Ls, d, atrI);
  const base = { rtPct, rtBars: L, rtExit: exit.exit, absPct, noBreach, target, bracket, volMatched: false };
  const none = { ...base, rtRandomPct: null, rtRandomWin: null, randomAbsPct: null, randomNoBreach: null, randomTarget: null, randomBracket: null };
  const prefix = (len: number) => { // count of starts with rem >= len
    let lo = 0, hi = rix.order.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (rix.rem[rix.order[m]!]! >= len) lo = m + 1; else hi = m; }
    return lo;
  };
  const rnd = mulberry32(hashStr(seedKey));
  const p0 = pre[i];
  const draw = (matched: boolean, L: number, lo: number) => {
    let sum = 0, wins = 0, abs = 0, nb = 0, tg = 0, bk = 0, k = 0;
    for (let tries = 0; tries < RANDOM_DRAWS * (matched ? 40 : 2) && k < RANDOM_DRAWS; tries++) {
      const a = rix.order[Math.floor(rnd() * lo)]!;
      const atrA = atrS[a]!;
      if (a === i || !Number.isFinite(atrA) || atrA <= 0) continue;
      if (matched && !(Math.abs(pre[a]! - p0!) <= PRE_TOL)) continue;
      const [r, ab, n0, t0, b0] = pathFacts(bars, a, L, d, atrA);
      sum += r; abs += ab; k++;
      if (r > 0) wins++; if (n0) nb++; if (t0) tg++; if (b0) bk++;
    }
    return { k, sum, wins, abs, nb, tg, bk };
  };
  const run = (len: number) => {
    const lo = prefix(len);
    if (lo < 2) return null;
    let r = p0 != null && Number.isFinite(p0) ? draw(true, len, lo) : null;
    const matched = !!r && r.k >= RANDOM_DRAWS / 2;
    if (!matched) r = draw(false, len, lo);
    return r && r.k ? { ...r, matched } : null;
  };
  const a = run(L), b = run(Ls);
  if (!a) return none;
  return {
    ...base, volMatched: a.matched && !!b?.matched, rtRandomPct: a.sum / a.k, rtRandomWin: a.wins / a.k,
    randomAbsPct: b ? b.abs / b.k : null, randomNoBreach: b ? b.nb / b.k : null, randomTarget: b ? b.tg / b.k : null, randomBracket: b ? b.bk / b.k : null,
  };
}

// ── Scorecard ────────────────────────────────────────────────────────────────────────────────────────────────────

export type ScoreInput = {
  indicatorId: string; version: number; kind: string; tf: string; day: string; time: number; side?: "buy" | "sell";
  rtPct: number; rtRandomPct: number; rtRandomWin: number | null; hit: boolean | null; placeboHit: boolean | null;
  absPct?: number | null; randomAbsPct?: number | null; noBreach?: boolean | null; randomNoBreach?: number | null; target?: boolean | null; randomTarget?: number | null; bracket?: boolean | null; randomBracket?: number | null;
};

/** One paired test (signal - random, same rows): lift, day-clustered t, both halves, MDE, verdict on fixed thresholds. */
export type PairStat = { n: number; days: number; sig: number; rnd: number; lift: number; t: number; both: boolean; mde: number; verdict: Verdict; needMore: number | null };
export type Family = "direction" | "bracket" | "vol" | "premium" | "target";
/** Thresholds per family: direction/vol in % per trade, premium/target in probability points. */
export const FAMILY_RULE: Record<Family, { useful: number; noise: number }> = {
  direction: { useful: MIN_USEFUL_LIFT_PCT, noise: NOISE_LIFT_PCT },
  vol: { useful: MIN_USEFUL_LIFT_PCT, noise: NOISE_LIFT_PCT },
  bracket: { useful: 3, noise: 1.5 },
  premium: { useful: 3, noise: 1.5 },
  target: { useful: 3, noise: 1.5 },
};
/** What each family's verdict means as a trade (signal direction d: buy = up). Fixed text, no judgment. */
export const STRUCTURE_FOR: Record<Family, { useful: string; worse: string }> = {
  direction: { useful: "trade the side: stock, long call/put, debit spread", worse: "fade it: the opposite side" },
  vol: { useful: "long straddle / strangle (bigger move, either way)", worse: "short straddle / iron condor (smaller move)" },
  premium: { useful: "sell premium on the far side: put credit spread on buys, call credit spread on sells", worse: "avoid short premium on the far side" },
  bracket: { useful: "long option / debit spread, +1 ATR target with -1 ATR stop", worse: "fade with a bracket: the opposite side, +1/-1 ATR" },
  target: { useful: "context only (reaching +1 ATR rises with any vol)", worse: "context only" },
};

export function pairStat(rows: { day: string; time: number }[], sig: number[], rnd: number[], rule: { useful: number; noise: number }): PairStat | null {
  const n = rows.length;
  if (!n) return null;
  const x = sig.map((v, k) => v - rnd[k]!);
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
  const both = (m1 > 0 && m2 > 0) || (m1 < 0 && m2 < 0);
  const mde = Number.isFinite(se) ? POWER_Z * se : Infinity;
  const verdict = verdictFor(mean, t, both, mde, n, D, rule);
  let needMore: number | null = null;
  if (verdict === "too early") {
    const target = mde > rule.useful ? rule.useful : rule.noise;
    needMore = Number.isFinite(mde) ? Math.max(0, Math.ceil(n * ((mde / target) ** 2 - 1)), MIN_N - n) : Math.max(0, MIN_N - n);
  }
  const avg = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  return { n, days: D, sig: avg(sig), rnd: avg(rnd), lift: mean, t, both, mde, verdict, needMore };
}

/** Calibrated confidence: P(the trip makes money in the signal's direction), shrunk toward the random win rate with a
 *  K-signal prior (small cells read near random), and a 90% band (normal approx on the shrunk rate). */
export const SHRINK_K = 30;
export function confidence(wins: number, n: number, prior: number): { p: number; lo: number; hi: number } {
  const p = (wins + SHRINK_K * prior) / (n + SHRINK_K);
  const se = Math.sqrt((p * (1 - p)) / (n + SHRINK_K));
  return { p, lo: Math.max(0, p - 1.645 * se), hi: Math.min(1, p + 1.645 * se) };
}

export type ScoreRow = {
  indicatorId: string; version: number; kind: string; tf: string; n: number; days: number;
  winPct: number; randomWinPct: number | null; avgRtPct: number; randomRtPct: number; liftPct: number; mdePct: number;
  tStat: number; signBothHalves: boolean; verdict: Verdict; needMore: number | null; gradedThrough: number;
  pWin: number; pWinLo: number; pWinHi: number;
  structures: Partial<Record<Family, PairStat>>; bestStructure: string | null;
  hitPct: number | null; placeboHitPct: number | null; liftPts: number | null; // old +-0.5 ATR hit test, context only
};

/** The fixed rule. Default thresholds = direction (round-trip lift, % per trade): useful = lift >= 0.10, t >= 2, same sign
 *  both halves; worse than random (fade candidate) = the mirror; noise = |lift| < 0.05 with MDE <= 0.10; else too early. */
export function verdictFor(lift: number, t: number, signBoth: boolean, mde: number, n = Infinity, days = Infinity, rule = FAMILY_RULE.direction): Verdict {
  if (n < MIN_N || days < MIN_DAYS) return "too early";
  if (lift >= rule.useful && t >= 2 && signBoth) return "likely useful";
  if (lift <= -rule.useful && t <= -2 && signBoth) return "likely worse than random";
  if (Math.abs(lift) < rule.noise && mde <= rule.useful) return "likely noise";
  return "too early";
}

/** Best structure = the family whose verdict is decided (useful / worse) with the largest |t|; null when none is. */
export function bestStructure(st: Partial<Record<Family, PairStat>>): string | null {
  let best: { f: Family; t: number; v: Verdict } | null = null;
  for (const [f, s] of Object.entries(st) as [Family, PairStat][]) {
    if (s.verdict !== "likely useful" && s.verdict !== "likely worse than random") continue;
    if (f === "target") continue; // one-sided excursion = vol, not direction; bracket is the directional test
    if (f === "premium" && s.verdict === "likely worse than random") continue; // "avoid X" is not a trade
    if (!best || Math.abs(s.t) > Math.abs(best.t)) best = { f, t: s.t, v: s.verdict };
  }
  return best ? STRUCTURE_FOR[best.f][best.v === "likely useful" ? "useful" : "worse"] : null;
}

export function statsFor(rows: ScoreInput[]): Omit<ScoreRow, "indicatorId" | "version" | "kind" | "tf"> | null {
  const dir = pairStat(rows, rows.map((r) => r.rtPct), rows.map((r) => r.rtRandomPct), FAMILY_RULE.direction);
  if (!dir) return null;
  const structures: Partial<Record<Family, PairStat>> = { direction: dir };
  const fam = (f: Family, ok: (r: ScoreInput) => boolean, sig: (r: ScoreInput) => number, rnd: (r: ScoreInput) => number) => {
    const rs = rows.filter(ok);
    const s = pairStat(rs, rs.map(sig), rs.map(rnd), FAMILY_RULE[f]);
    if (s) structures[f] = s;
  };
  fam("vol", (r) => r.absPct != null && r.randomAbsPct != null, (r) => r.absPct!, (r) => r.randomAbsPct!);
  fam("premium", (r) => r.noBreach != null && r.randomNoBreach != null, (r) => (r.noBreach ? 100 : 0), (r) => r.randomNoBreach! * 100);
  fam("target", (r) => r.target != null && r.randomTarget != null, (r) => (r.target ? 100 : 0), (r) => r.randomTarget! * 100);
  fam("bracket", (r) => r.bracket != null && r.randomBracket != null, (r) => (r.bracket ? 100 : 0), (r) => r.randomBracket! * 100);
  const n = rows.length;
  const wins = rows.filter((r) => r.rtPct > 0).length;
  const rw = rows.filter((r) => r.rtRandomWin != null).map((r) => r.rtRandomWin!);
  const prior = rw.length ? rw.reduce((a, b) => a + b, 0) / rw.length : 0.5;
  const c = confidence(wins, n, prior);
  const hr = rows.filter((r) => r.hit != null && r.placeboHit != null);
  const hitPct = hr.length ? (hr.filter((r) => r.hit).length / hr.length) * 100 : null;
  const placeboHitPct = hr.length ? (hr.filter((r) => r.placeboHit).length / hr.length) * 100 : null;
  return {
    n, days: dir.days,
    winPct: (wins / n) * 100, randomWinPct: rw.length ? prior * 100 : null,
    avgRtPct: dir.sig, randomRtPct: dir.rnd, liftPct: dir.lift, mdePct: dir.mde,
    tStat: dir.t, signBothHalves: dir.both, verdict: dir.verdict, needMore: dir.needMore,
    gradedThrough: Math.max(...rows.map((r) => r.time)),
    pWin: c.p * 100, pWinLo: c.lo * 100, pWinHi: c.hi * 100,
    structures, bestStructure: bestStructure(structures),
    hitPct, placeboHitPct, liftPts: hitPct != null && placeboHitPct != null ? hitPct - placeboHitPct : null,
  };
}

/** Rows per (indicator, version) x (kind | ALL | kind · up/down | ALL · up/down) x (tf | ALL). */
export function buildScorecard(all: ScoreInput[]): ScoreRow[] {
  const groups = new Map<string, ScoreInput[]>();
  const push = (key: string, r: ScoreInput) => { const g = groups.get(key); if (g) g.push(r); else groups.set(key, [r]); };
  for (const r of all) {
    const sk = r.side ? [`${r.kind} · ${r.side === "buy" ? "up" : "down"}`, `ALL · ${r.side === "buy" ? "up" : "down"}`] : [];
    for (const kind of [...new Set([r.kind, "ALL", ...sk])]) for (const tf of [r.tf, "ALL"]) push(`${r.indicatorId}\u0001${r.version}\u0001${kind}\u0001${tf}`, r);
  }
  const out: ScoreRow[] = [];
  for (const [key, rows] of groups) {
    const [indicatorId, version, kind, tf] = key.split("\u0001") as [string, string, string, string];
    const s = statsFor(rows);
    if (s) out.push({ indicatorId, version: Number(version), kind, tf, ...s });
  }
  return out;
}
