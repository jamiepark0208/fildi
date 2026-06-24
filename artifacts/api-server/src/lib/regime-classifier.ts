import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadMacroCache, loadChartsCache, type MacroData, type MacroCharts } from "./macro-data.js";
import { FED_MEMBERS, ECONOMIC_EVENTS, BANK_RESEARCH_DEFAULT } from "./macro-static.js";
import type { BankResearch } from "./macro-data.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = join(__dirname, "..", "..");

const COT_CACHE_FILE        = join(ROOT, "cot-cache.json");
const BANK_RESEARCH_FILE    = join(ROOT, "macro-bank-research.json");

// ── Types ─────────────────────────────────────────────────────────────────────

export type Regime =
  | "expansion"
  | "late_cycle"
  | "contraction"
  | "recession"
  | "recovery"
  | "stagflation"
  | "insufficient_data";

export interface RegimeResult {
  regime: Regime;
  confidence: number;
  signalScores: Record<string, number>;
  confirmingSignals: string[];
  conflictingSignals: string[];
  indicatorSnapshot: Record<string, unknown>;
  computedAt: Date;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function lastN<T>(arr: T[], n: number): T[] {
  return arr.length >= n ? arr.slice(-n) : arr;
}

function lastVal(arr: { date: string; value: number }[]): number | null {
  return arr.length > 0 ? arr[arr.length - 1].value : null;
}

function nthFromEnd(arr: { date: string; value: number }[], n: number): number | null {
  return arr.length > n ? arr[arr.length - 1 - n].value : null;
}

type Direction3 = "rising" | "falling" | "flat";
function direction(arr: { date: string; value: number }[], lookback: number, threshold = 0.01): Direction3 {
  const current = lastVal(arr);
  const past    = nthFromEnd(arr, lookback);
  if (current === null || past === null || past === 0) return "flat";
  const pct = (current - past) / Math.abs(past);
  if (pct > threshold)  return "rising";
  if (pct < -threshold) return "falling";
  return "flat";
}

// ── Cache readers ─────────────────────────────────────────────────────────────

interface CotCache {
  fetchedAt: number;
  records: Record<string, Array<{ levMoneyNet: number; assetMgrNet: number; date: string }>>;
}

function loadCOTCache(): CotCache | null {
  try {
    if (!existsSync(COT_CACHE_FILE)) return null;
    return JSON.parse(readFileSync(COT_CACHE_FILE, "utf-8")) as CotCache;
  } catch { return null; }
}

function loadBankResearch(): BankResearch[] {
  try {
    if (!existsSync(BANK_RESEARCH_FILE)) return BANK_RESEARCH_DEFAULT;
    return JSON.parse(readFileSync(BANK_RESEARCH_FILE, "utf-8")) as BankResearch[];
  } catch { return BANK_RESEARCH_DEFAULT; }
}

// ── Derived inputs ────────────────────────────────────────────────────────────

type FedLean    = "hawkish" | "neutral" | "dovish";
type BankLean   = "risk_on" | "neutral" | "risk_off";
type HyDir      = "tightening" | "widening" | "flat";
type FedDir     = "hiking" | "cutting" | "hold";

function deriveFedLean(): FedLean {
  const voting = FED_MEMBERS.filter((m) => m.voting);
  let hawkish = 0, dovish = 0;
  for (const m of voting) {
    if (m.stance === "hawkish") hawkish++;
    else if (m.stance === "dovish") dovish++;
  }
  if (hawkish > dovish + 1) return "hawkish";
  if (dovish > hawkish + 1) return "dovish";
  return "neutral";
}

function deriveBankLean(): BankLean {
  const research = loadBankResearch();
  let bullish = 0, bearish = 0;
  for (const r of research) {
    if (r.stance === "bullish") bullish++;
    else if (r.stance === "bearish") bearish++;
  }
  if (bullish > bearish + 1) return "risk_on";
  if (bearish > bullish + 1) return "risk_off";
  return "neutral";
}

function deriveHighVolEventSoon(): boolean {
  const today     = new Date();
  const cutoff    = new Date(today.getTime() + 10 * 24 * 60 * 60 * 1000);
  const todayStr  = today.toISOString().slice(0, 10);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return ECONOMIC_EVENTS.some(
    (e) => e.importance === "high" && e.date >= todayStr && e.date <= cutoffStr,
  );
}

function deriveHyDir(hyHistory: MacroCharts["hySpreadHistory"]): HyDir {
  // ~4 weeks of daily data ≈ 20 points
  const dir = direction(hyHistory, 20, 0.02);
  if (dir === "rising")  return "widening";
  if (dir === "falling") return "tightening";
  return "flat";
}

function deriveFedDir(fedFunds: MacroData["series"]["fedFundsRate"]): FedDir {
  const v = fedFunds.value ?? 0;
  const p = fedFunds.prev  ?? 0;
  if (v > p + 0.1) return "hiking";
  if (v < p - 0.1) return "cutting";
  return "hold";
}

function deriveVixDir(vixHistory: MacroCharts["vixHistory"]): Direction3 {
  return direction(vixHistory, 20, 0.03);
}

// ── Scoring ───────────────────────────────────────────────────────────────────

type SignalMap = Record<string, number>;

function scoreExpansion(inputs: Inputs, scores: SignalMap) {
  const { vix, vixDir, ismPmi, yieldCurve, hyDir, gdp, fearGreed, cotNet, fedLean, bankLean } = inputs;
  if (vix !== null) scores["vix_low"]          = vix < 18 ? 2 : 0;
  if (vixDir !== null) scores["vix_falling"]   = vixDir === "falling" ? 1 : 0;
  if (ismPmi !== null) scores["pmi_high"]       = ismPmi > 52 ? 2 : 0;
  if (yieldCurve !== null) scores["curve_pos"]  = yieldCurve > 0.5 ? 2 : 0;
  if (hyDir !== null) scores["hy_tightening"]   = hyDir === "tightening" ? 2 : 0;
  if (gdp !== null) scores["gdp_strong"]        = gdp > 2 ? 2 : 0;
  if (fearGreed !== null) scores["fg_high"]     = fearGreed > 60 ? 1 : 0;
  if (cotNet !== null) scores["cot_positive"]   = cotNet > 0 ? 1 : 0;
  if (fedLean !== null) scores["fed_easy"]      = fedLean === "neutral" || fedLean === "dovish" ? 1 : 0;
  if (bankLean !== null) scores["bank_on"]      = bankLean === "risk_on" ? 1 : 0;
}

function scoreLateCycle(inputs: Inputs, scores: SignalMap) {
  const { vix, ismPmi, yieldCurve, cpiYoy, fedLean, fedDir, hyDir, gdp, fearGreed } = inputs;
  if (vix !== null) scores["vix_mid"]           = vix >= 16 && vix <= 22 ? 1 : 0;
  if (ismPmi !== null) scores["pmi_border"]     = ismPmi >= 50 && ismPmi <= 53 ? 1 : 0;
  if (yieldCurve !== null) scores["curve_flat"] = yieldCurve >= -0.2 && yieldCurve <= 0.5 ? 2 : 0;
  if (cpiYoy !== null) scores["cpi_hot"]        = cpiYoy > 3 ? 2 : 0;
  if (fedLean !== null) scores["fed_hawk"]      = fedLean === "hawkish" ? 2 : 0;
  if (fedDir !== null) scores["fed_hiking"]     = fedDir === "hiking" ? 2 : 0;
  if (hyDir !== null) scores["hy_flat"]         = hyDir === "flat" ? 1 : 0;
  if (gdp !== null) scores["gdp_slowing"]       = gdp >= 0 && gdp <= 2 ? 1 : 0;
  if (fearGreed !== null) scores["fg_mid"]      = fearGreed >= 45 && fearGreed <= 65 ? 1 : 0;
}

function scoreContraction(inputs: Inputs, scores: SignalMap) {
  const { vix, vixDir, ismPmi, yieldCurve, hyDir, gdp, fearGreed, cotNet, bankLean } = inputs;
  if (vix !== null) scores["vix_stress"]       = vix >= 20 && vix <= 30 ? 2 : 0;
  if (vixDir !== null) scores["vix_rising"]    = vixDir === "rising" ? 1 : 0;
  if (ismPmi !== null) scores["pmi_below50"]   = ismPmi < 50 ? 2 : 0;
  if (yieldCurve !== null) scores["curve_inv"] = yieldCurve < 0 ? 1 : 0;
  if (hyDir !== null) scores["hy_widening"]    = hyDir === "widening" ? 2 : 0;
  if (gdp !== null) scores["gdp_weak"]         = gdp < 1 ? 1 : 0;
  if (fearGreed !== null) scores["fg_fear"]    = fearGreed < 45 ? 1 : 0;
  if (cotNet !== null) scores["cot_negative"]  = cotNet < 0 ? 1 : 0;
  if (bankLean !== null) scores["bank_off"]    = bankLean === "risk_off" ? 1 : 0;
}

function scoreRecession(inputs: Inputs, scores: SignalMap) {
  const { vix, ismPmi, hyOas, gdp, unemploymentRate, unemploymentPrev, yieldCurve, yieldCurveDir, fedLean, fearGreed } = inputs;
  if (vix !== null) scores["vix_spike"]        = vix > 28 ? 2 : 0;
  if (ismPmi !== null) scores["pmi_deep"]      = ismPmi < 48 ? 2 : 0;
  if (hyOas !== null) scores["hy_blown"]       = hyOas > 500 ? 2 : 0;
  if (gdp !== null) scores["gdp_neg"]          = gdp < 0 ? 2 : 0;
  if (unemploymentRate !== null && unemploymentPrev !== null)
    scores["ur_rising"]                        = unemploymentRate > unemploymentPrev + 0.1 ? 1 : 0;
  // deeply inverted OR steepening from inversion
  if (yieldCurve !== null && yieldCurveDir !== null)
    scores["curve_crisis"]                     = (yieldCurve < -0.5) || (yieldCurve < 0 && yieldCurveDir === "rising") ? 2 : 0;
  if (fedLean !== null) scores["fed_dove"]     = fedLean === "dovish" ? 1 : 0;
  if (fearGreed !== null) scores["fg_extreme_fear"] = fearGreed < 30 ? 1 : 0;
}

function scoreRecovery(inputs: Inputs, scores: SignalMap) {
  const { vix, vixDir, vvix, vvixDir, ismPmi, ismPmiPrev, yieldCurve, yieldCurveDir, fedDir, fearGreed, fearGreedDir, hyDir, hyOas, hyOasPrev4w, gdp } = inputs;
  // vvix falling + vix > 20 but falling
  if (vvix !== null && vvixDir !== null && vix !== null && vixDir !== null)
    scores["vol_subsiding"]                    = (vvixDir === "falling" && vix > 20 && vixDir === "falling") ? 2 : 0;
  if (ismPmi !== null && ismPmiPrev !== null)
    scores["pmi_recovering"]                   = ismPmi >= 49 && ismPmi <= 52 && ismPmi > ismPmiPrev ? 2 : 0;
  if (yieldCurve !== null && yieldCurveDir !== null)
    scores["curve_steepening"]                 = yieldCurveDir === "rising" ? 2 : 0;
  if (fedDir !== null) scores["fed_easy2"]     = fedDir === "cutting" || fedDir === "hold" ? 2 : 0;
  if (fearGreed !== null && fearGreedDir !== null)
    scores["fg_improving"]                     = fearGreedDir === "rising" ? 1 : 0;
  if (hyDir !== null && hyOas !== null && hyOasPrev4w !== null)
    scores["hy_tightening_from_wide"]          = hyDir === "tightening" && hyOasPrev4w > 400 ? 1 : 0;
  if (gdp !== null) scores["gdp_near_zero_pos"] = gdp >= 0 && gdp < 1.5 ? 1 : 0;
}

function scoreStagflation(inputs: Inputs, scores: SignalMap) {
  const { cpiYoy, ismPmi, gdp, fedDir, fedFundsRate, unemploymentRate, hyDir, bankLean } = inputs;
  if (cpiYoy !== null) scores["cpi_stagflation"]   = cpiYoy > 3.5 ? 2 : 0;
  if (ismPmi !== null) scores["pmi_stag"]           = ismPmi < 51 ? 2 : 0;
  if (gdp !== null) scores["gdp_stag"]              = gdp < 1.5 ? 2 : 0;
  // high rate + hold
  if (fedFundsRate !== null && fedDir !== null)
    scores["fed_high_hold"]                         = fedFundsRate > 4 && fedDir === "hold" ? 2 : 0;
  if (unemploymentRate !== null) scores["ur_elev"]  = unemploymentRate > 4.5 ? 1 : 0;
  if (hyDir !== null) scores["hy_wide_stag"]        = hyDir === "widening" ? 1 : 0;
  if (bankLean !== null) scores["bank_off2"]        = bankLean === "risk_off" ? 1 : 0;
}

// ── Inputs collector ──────────────────────────────────────────────────────────

interface Inputs {
  vix:              number | null;
  vixDir:           Direction3 | null;
  vvix:             number | null;
  vvixDir:          Direction3 | null;
  hyOas:            number | null;
  hyOasPrev4w:      number | null;
  hyDir:            HyDir | null;
  ismPmi:           number | null;
  ismPmiPrev:       number | null;
  yieldCurve:       number | null;
  yieldCurveDir:    Direction3 | null;
  cpiYoy:           number | null;
  unemploymentRate: number | null;
  unemploymentPrev: number | null;
  fedFundsRate:     number | null;
  fedDir:           FedDir | null;
  gdp:              number | null;
  fearGreed:        number | null;
  fearGreedDir:     Direction3 | null;
  cotNet:           number | null;
  fedLean:          FedLean | null;
  bankLean:         BankLean | null;
  highVolEventSoon: boolean;
}

function collectInputs(): Inputs {
  const macro   = loadMacroCache();
  const charts  = loadChartsCache();
  const cotRaw  = loadCOTCache();

  // VIX
  const vix     = macro?.vix.value ?? null;
  const vixDir  = charts ? deriveVixDir(charts.vixHistory) : null;

  // VVIX (putCallHistory = VVIX)
  const vvixArr = charts?.putCallHistory ?? [];
  const vvix    = lastVal(vvixArr);
  const vvixDir = vvixArr.length > 5 ? direction(vvixArr, 10, 0.02) : null;

  // HY OAS
  const hyArr   = charts?.hySpreadHistory ?? [];
  const hyOas   = lastVal(hyArr);
  const hyOasPrev4w = nthFromEnd(hyArr, 20);
  const hyDir   = hyArr.length >= 5 ? deriveHyDir(charts!.hySpreadHistory) : null;

  // ISM PMI
  const ismSeries = macro?.series.ismManufacturing;
  const ismPmi    = ismSeries?.value ?? null;
  const ismPmiPrev = ismSeries?.prev ?? null;

  // Yield curve (10Y–2Y spread)
  const yieldCurve = macro?.yieldSpread ?? null;
  // Approximate yield curve direction from tenYearHistory vs short rate history
  // Use last 30 data points of vixHistory as a proxy for how often data is updated —
  // actual curve direction: compare current yieldSpread against 4-week prior from yield data
  // We approximate using the charts fedFundsHistory vs tenYearHistory
  let yieldCurveDir: Direction3 | null = null;
  if (charts && charts.tenYearHistory.length > 0 && macro) {
    const t10 = direction(charts.tenYearHistory, 20, 0.01);
    yieldCurveDir = t10; // rising 10Y with stable 2Y → steepening
  }

  // CPI YoY
  const cpiYoy = macro?.series.cpi.yoy ?? null;

  // Unemployment
  const urSeries          = macro?.series.unemployment;
  const unemploymentRate  = urSeries?.value ?? null;
  const unemploymentPrev  = urSeries?.prev  ?? null;

  // Fed Funds
  const ffSeries   = macro?.series.fedFundsRate;
  const fedFundsRate = ffSeries?.value ?? null;
  const fedDir     = ffSeries ? deriveFedDir(ffSeries) : null;

  // GDP QoQ
  const gdp = macro?.series.gdp.value ?? null;

  // Fear & Greed
  const fgArr      = charts?.fearGreedHistory ?? [];
  const fearGreed  = lastVal(fgArr);
  const fearGreedDir = fgArr.length > 5 ? direction(fgArr, 10, 0.03) : null;

  // COT net — SP500 leveraged money net
  let cotNet: number | null = null;
  if (cotRaw?.records?.["sp500"]?.length) {
    const rec = cotRaw.records["sp500"];
    cotNet = rec[rec.length - 1].levMoneyNet;
  }

  // Derived
  const fedLean = deriveFedLean();
  const bankLean = deriveBankLean();
  const highVolEventSoon = deriveHighVolEventSoon();

  return {
    vix, vixDir,
    vvix, vvixDir,
    hyOas, hyOasPrev4w, hyDir,
    ismPmi, ismPmiPrev,
    yieldCurve, yieldCurveDir,
    cpiYoy,
    unemploymentRate, unemploymentPrev,
    fedFundsRate, fedDir,
    gdp,
    fearGreed, fearGreedDir,
    cotNet,
    fedLean, bankLean,
    highVolEventSoon,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const REGIME_KEYS = ["expansion", "late_cycle", "contraction", "recession", "recovery", "stagflation"] as const;

export function computeRegime(): RegimeResult {
  const inputs = collectInputs();

  const allScores: Record<string, SignalMap> = {
    expansion:   {},
    late_cycle:  {},
    contraction: {},
    recession:   {},
    recovery:    {},
    stagflation: {},
  };

  scoreExpansion(inputs,   allScores.expansion);
  scoreLateCycle(inputs,   allScores.late_cycle);
  scoreContraction(inputs, allScores.contraction);
  scoreRecession(inputs,   allScores.recession);
  scoreRecovery(inputs,    allScores.recovery);
  scoreStagflation(inputs, allScores.stagflation);

  // Tally totals
  const totals = Object.fromEntries(
    REGIME_KEYS.map((k) => [k, Object.values(allScores[k]).reduce((a, b) => a + b, 0)])
  );

  // Sort by score
  const sorted = [...REGIME_KEYS].sort((a, b) => totals[b] - totals[a]);
  const winner = sorted[0];
  const second = sorted[1];
  const winnerScore = totals[winner];
  const secondScore = totals[second];

  // Flatten all signal scores for output
  const signalScores: Record<string, number> = {};
  for (const regime of REGIME_KEYS) {
    for (const [k, v] of Object.entries(allScores[regime])) {
      signalScores[`${regime}:${k}`] = v;
    }
  }

  // Confirming = top-3 non-zero signals in winner's map
  const confirmingSignals = Object.entries(allScores[winner])
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([k]) => k);

  // Conflicting = signals in winner's map that scored 0
  const conflictingSignals = Object.entries(allScores[winner])
    .filter(([, v]) => v === 0)
    .map(([k]) => k);

  // Confidence: winner margin vs 2nd place, 0-100
  let confidence =
    winnerScore > 0
      ? Math.round(((winnerScore - secondScore) / winnerScore) * 100)
      : 0;

  // Determine regime label
  let regime: Regime = winner as Regime;
  if (winnerScore < 6) {
    regime = "insufficient_data";
    confidence = 0;
  }

  // ── Sanity checks ──────────────────────────────────────────────────────────
  const vix = inputs.vix;

  // 1. VIX > 30 and expansion/late_cycle → override
  if (vix !== null && vix > 30 && (regime === "expansion" || regime === "late_cycle")) {
    regime = "contraction";
    conflictingSignals.push("vix_override_gt30");
  }

  // 2. CPI > 4 and fed dovish and expansion → confidence penalty
  if (
    inputs.cpiYoy !== null &&
    inputs.cpiYoy > 4 &&
    inputs.fedLean === "dovish" &&
    regime === "expansion"
  ) {
    confidence = Math.max(0, confidence - 20);
    conflictingSignals.push("cpi_dovish_mismatch");
  }

  // 3. High vol event pending
  if (inputs.highVolEventSoon) {
    conflictingSignals.push("high_vol_event_pending");
  }

  const indicatorSnapshot: Record<string, unknown> = {
    vix:              inputs.vix,
    vixDirection:     inputs.vixDir,
    vvix:             inputs.vvix,
    vvixDirection:    inputs.vvixDir,
    hyOas:            inputs.hyOas,
    hyDirection:      inputs.hyDir,
    ismPmi:           inputs.ismPmi,
    yieldCurve:       inputs.yieldCurve,
    cpiYoy:           inputs.cpiYoy,
    unemploymentRate: inputs.unemploymentRate,
    fedFundsRate:     inputs.fedFundsRate,
    fedDirection:     inputs.fedDir,
    gdpQoq:           inputs.gdp,
    fearGreed:        inputs.fearGreed,
    cotNetPositioning: inputs.cotNet,
    fedLean:          inputs.fedLean,
    bankLean:         inputs.bankLean,
    highVolEventSoon: inputs.highVolEventSoon,
    regimeScores:     totals,
  };

  return {
    regime,
    confidence,
    signalScores,
    confirmingSignals,
    conflictingSignals,
    indicatorSnapshot,
    computedAt: new Date(),
  };
}
