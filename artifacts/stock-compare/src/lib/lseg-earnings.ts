/**
 * "Is the earnings premium rich or cheap?" — compares the move options imply through the first weekly
 * expiry after the next report with what this stock has actually done (normal-day volatility + its own
 * past earnings jumps). Pure + unit-tested.
 *
 * IMPORTANT: Fildi's ticker_technicals.atm_put_iv comes from the NEAREST expiry (2–21 DTE, technicals-db.ts),
 * so it only contains earnings premium when that expiry is on/after the report. We therefore only issue a
 * rich/cheap verdict when the report falls before the nearest expiry (≈ earnings week). Otherwise callers
 * get history only (earningsHistoryNote). Comparing a pre-earnings IV to earnings-inclusive history made
 * nearly every name read "cheap" (AMD 0.40, META 0.43) — that was the artifact this guard removes.
 */
import type { Tone } from "./lseg-interpret.ts";

export type EarningsPremium = {
  verdict: "rich" | "fair" | "cheap";
  tone: Tone; // from a premium SELLER's point of view
  ratio: number; // implied ÷ fair
  impliedMovePct: number; // expected absolute move to expiry, from IV
  fairMovePct: number; // expected absolute move to expiry, from history
  avgEarningsMovePct: number;
  maxEarningsMovePct: number;
  reports: number;
  expiry: string; // first Friday after the report
  text: string;
};

export const MIN_REPORTS = 4;
export const MAX_DAYS_OUT = 45;
export const RICH = 1.2;
export const CHEAP = 0.85;
/** E|X| = σ·√(2/π) ≈ 0.8σ for a normal move. */
const ABS_TO_SIGMA = Math.sqrt(Math.PI / 2);

function isoAddDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Expiry Fildi's ATM IV is read from: first Friday at least 2 days out (technicals-db.ts: dte >= 2). */
export function nearestIvExpiry(today: string): string {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  let add = (5 - dow + 7) % 7;
  if (add < 2) add += 7;
  return isoAddDays(today, add);
}

/** First Friday strictly after the report date (weekly expiry that captures the reaction). */
export function expiryAfter(reportDate: string): string {
  const dow = new Date(`${reportDate}T00:00:00Z`).getUTCDay(); // 0 Sun … 5 Fri
  const add = ((5 - dow + 7) % 7) || 7;
  return isoAddDays(reportDate, add);
}

export function earningsPremium(args: {
  pastMovesPct: number[];
  ivPct: number | null;
  rvPct: number | null;
  reportDate: string | null;
  today?: string;
}): EarningsPremium | null {
  const { pastMovesPct, ivPct, rvPct, reportDate } = args;
  if (!reportDate || ivPct == null || ivPct <= 0 || pastMovesPct.length < MIN_REPORTS) return null;
  const today = args.today ?? new Date().toISOString().slice(0, 10);
  // Only valid when the IV we have was read from an expiry that already spans the report.
  if (reportDate >= nearestIvExpiry(today)) return null;
  const expiry = expiryAfter(reportDate);
  const days = Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (days <= 0 || days > MAX_DAYS_OUT) return null;

  const abs = pastMovesPct.map((m) => Math.abs(m));
  const avgEarn = abs.reduce((a, b) => a + b, 0) / abs.length;
  const maxEarn = Math.max(...abs);
  const sigmaEarn = avgEarn * ABS_TO_SIGMA;
  // RV > 2× IV is usually bad price data (reverse split, GOSS RV 1518%) → fall back to IV for normal days.
  const rv = rvPct != null && rvPct > 0 && rvPct <= 2 * ivPct ? rvPct : ivPct;
  const fairSigma = Math.sqrt((rv * rv * Math.max(days - 1, 0)) / 365 + sigmaEarn * sigmaEarn);
  const impliedSigma = ivPct * Math.sqrt(days / 365);
  const ratio = impliedSigma / fairSigma;
  const impliedMovePct = impliedSigma / ABS_TO_SIGMA;
  const fairMovePct = fairSigma / ABS_TO_SIGMA;

  const verdict: EarningsPremium["verdict"] = ratio >= RICH ? "rich" : ratio <= CHEAP ? "cheap" : "fair";
  const base = `Options price about ±${impliedMovePct.toFixed(1)}% through the ${expiry} expiry. Its history says about ±${fairMovePct.toFixed(1)}% (last ${abs.length} reports averaged ±${avgEarn.toFixed(1)}%, worst ${maxEarn.toFixed(1)}%).`;
  const text =
    verdict === "rich"
      ? `${base} Premium looks RICH: sellers get paid more than this stock usually moves.`
      : verdict === "cheap"
        ? `${base} Premium looks CHEAP: you're not being paid for how much it usually moves on earnings. Avoid selling through the report.`
        : `${base} Premium looks roughly fair.`;
  return {
    verdict,
    tone: verdict === "rich" ? "good" : verdict === "cheap" ? "bad" : "neutral",
    ratio,
    impliedMovePct,
    fairMovePct,
    avgEarningsMovePct: avgEarn,
    maxEarningsMovePct: maxEarn,
    reports: abs.length,
    expiry,
    text,
  };
}

/** Analysts far apart on next quarter → bigger surprise risk than the average suggests. */
export function dispersionNote(mean: number | null | undefined, std: number | null | undefined, n: number | null | undefined) {
  if (mean == null || std == null || n == null || n < 3 || Math.abs(mean) < 0.05) return null;
  const cv = std / Math.abs(mean);
  if (cv < 0.3) return null;
  return {
    tone: "warn" as Tone,
    text: `Analysts are far apart on next quarter (spread ±${(cv * 100).toFixed(0)}% of the average estimate across ${n}). Surprise risk is higher than the consensus suggests.`,
  };
}

/** History-only context for reports beyond the IV's expiry: how big this stock's earnings moves usually are. */
export function earningsHistoryNote(pastMovesPct: number[]): { avg: number; max: number; n: number; text: string } | null {
  if (pastMovesPct.length < MIN_REPORTS) return null;
  const abs = pastMovesPct.map((m) => Math.abs(m));
  const avg = abs.reduce((a, b) => a + b, 0) / abs.length;
  const max = Math.max(...abs);
  return {
    avg,
    max,
    n: abs.length,
    text: `Usually moves ±${avg.toFixed(1)}% on earnings (worst ±${max.toFixed(1)}%, last ${abs.length} reports).`,
  };
}
