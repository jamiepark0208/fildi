import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  scoreIncomeAdequacy,
  scoreDeltaBand,
  scoreSdBuffer,
  scoreBuffer,
  scoreIvRelative,
  scoreIvAbsolute,
  scoreStockQuality,
  scoreStrikeSupport,
  scoreDtePreference,
  liquidityGate,
  computeOptionScore,
  buildCandidate,
  type OptionCandidate,
  type StockContext,
} from "./option-scorer.ts";

import {
  computeRelativeMove,
  computeStockScore,
  tagBonus,
} from "./stock-scorer.ts";

import {
  INCOME_FLOOR, INCOME_TARGET, INCOME_DECAY_FLOOR,
  MIN_OI, MAX_SPREAD_PCT, MIN_VOL,
} from "./option-scorer-constants.ts";

function close(a: number | null, b: number, tol = 0.001, msg?: string) {
  assert.ok(a !== null, `expected ~${b}, got null — ${msg ?? ""}`);
  assert.ok(Math.abs((a as number) - b) < tol, `${msg ?? ""}: expected ${b} ± ${tol}, got ${a}`);
}

// ── scoreIncomeAdequacy ───────────────────────────────────────────────────────

describe("scoreIncomeAdequacy", () => {
  it("returns 0 below floor", () => assert.equal(scoreIncomeAdequacy(0), 0));
  it("returns 0 at floor", () => assert.equal(scoreIncomeAdequacy(INCOME_FLOOR), 0));
  it("returns 1 at target", () => close(scoreIncomeAdequacy(INCOME_TARGET), 1.0));
  it("linear at midpoint", () => close(scoreIncomeAdequacy((INCOME_FLOOR + INCOME_TARGET) / 2), 0.5));
  it("decays above target but stays >= INCOME_DECAY_FLOOR", () => {
    const s = scoreIncomeAdequacy(INCOME_TARGET * 3);
    assert.ok(s >= INCOME_DECAY_FLOOR, `score ${s} < INCOME_DECAY_FLOOR ${INCOME_DECAY_FLOOR}`);
    assert.ok(s < 1.0, "score above target should be < 1");
  });
  it("2x target scores less than target (encodes: prefer ~1%/wk over 2%/wk)", () => {
    const atTarget  = scoreIncomeAdequacy(INCOME_TARGET);
    const at2Target = scoreIncomeAdequacy(INCOME_TARGET * 2);
    assert.ok(at2Target < atTarget, `${at2Target} should be < ${atTarget}`);
  });
  it("curve is continuous at target (left ≈ right limit)", () => {
    const eps = 0.0001;
    const left  = scoreIncomeAdequacy(INCOME_TARGET - eps);
    const right = scoreIncomeAdequacy(INCOME_TARGET + eps);
    close(left, right, 0.01, "curve discontinuity at target");
  });
  it("returns 0 for NaN", () => assert.equal(scoreIncomeAdequacy(NaN), 0));
});

// ── scoreDeltaBand ────────────────────────────────────────────────────────────

describe("scoreDeltaBand", () => {
  it("peaks inside BASELINE sweet spot [0.10, 0.15]", () => {
    assert.equal(scoreDeltaBand(0.12, "BASELINE"), 1.0);
  });
  it("returns 0 at DELTA_MAX", () => assert.equal(scoreDeltaBand(0.35, "BASELINE"), 0));
  it("returns 0 above DELTA_MAX", () => assert.equal(scoreDeltaBand(0.50, "BASELINE"), 0));
  it("decays below sweet spot (0 < delta < lo)", () => {
    const s = scoreDeltaBand(0.03, "BASELINE");
    assert.ok(s > 0 && s < 1, `expected (0,1), got ${s}`);
  });
  it("decays above sweet spot (hi < delta < max)", () => {
    const s = scoreDeltaBand(0.25, "BASELINE");
    assert.ok(s > 0 && s < 1, `expected (0,1), got ${s}`);
  });
  it("EXTREME regime has higher sweet-spot floor than BASELINE", () => {
    // EXTREME sweet spot: [0.15, 0.25]
    assert.equal(scoreDeltaBand(0.20, "EXTREME"), 1.0);
    assert.equal(scoreDeltaBand(0.12, "BASELINE"), 1.0);
    // 0.12 is below EXTREME sweet spot floor (0.15)
    const extremeAt012 = scoreDeltaBand(0.12, "EXTREME");
    assert.ok(extremeAt012 < 1.0, `expected <1.0 at 0.12 in EXTREME, got ${extremeAt012}`);
  });
});

// ── scoreSdBuffer ─────────────────────────────────────────────────────────────

describe("scoreSdBuffer", () => {
  it("returns 0 for zero IV", () => assert.equal(scoreSdBuffer(0.10, 0, 7), 0));
  it("returns 0 for zero DTE", () => assert.equal(scoreSdBuffer(0.10, 0.40, 0), 0));
  it("1.25 SDs OTM → score 1.0", () => {
    // EM = 0.40 * sqrt(7/365) = 0.40 * 0.1384 = 0.05535; otmPct = 1.25 * EM
    const iv = 0.40; const dte = 7;
    const em = iv * Math.sqrt(dte / 365);
    close(scoreSdBuffer(1.25 * em, iv, dte), 1.0, 0.01);
  });
  it("score increases with OTM distance", () => {
    const iv = 0.40; const dte = 7;
    const s1 = scoreSdBuffer(0.05, iv, dte);
    const s2 = scoreSdBuffer(0.10, iv, dte);
    assert.ok(s2 > s1, `${s2} should > ${s1}`);
  });
});

// ── scoreBuffer (blended) ─────────────────────────────────────────────────────

describe("scoreBuffer", () => {
  it("returns null when both delta and IV are null", () => {
    assert.equal(scoreBuffer(null, null, 7, 0.10, "BASELINE"), null);
  });
  it("falls back to SD-only when delta is null", () => {
    const r = scoreBuffer(null, 0.40, 7, 0.10, "BASELINE");
    assert.ok(r !== null && r > 0);
  });
  it("falls back to delta-only when IV is null", () => {
    const r = scoreBuffer(-0.12, null, 7, 0.10, "BASELINE");
    assert.ok(r !== null && r > 0);
  });
  it("blends both when available (result between the two)", () => {
    const deltaBand = scoreDeltaBand(0.12, "BASELINE");
    const sd = scoreSdBuffer(0.10, 0.40, 7);
    const blended = scoreBuffer(-0.12, 0.40, 7, 0.10, "BASELINE");
    assert.ok(blended !== null);
    const min = Math.min(deltaBand, sd) - 0.01;
    const max = Math.max(deltaBand, sd) + 0.01;
    assert.ok((blended as number) >= min && (blended as number) <= max, `blended ${blended} not in [${min},${max}]`);
  });
});

// ── scoreIvRelative ───────────────────────────────────────────────────────────

describe("scoreIvRelative", () => {
  it("returns null when all inputs null", () =>
    assert.equal(scoreIvRelative(null, null, null, null), null));
  it("high IV rank → high score", () =>
    assert.ok((scoreIvRelative(0.90, 85, null, null) as number) > 0.8));
  it("low IV rank → low score", () =>
    assert.ok((scoreIvRelative(0.10, 15, null, null) as number) < 0.2));
  it("works with only ivRank (ivPercentile null)", () =>
    assert.ok(scoreIvRelative(0.80, null, null, null) !== null));
  it("works with only ivPercentile (ivRank null)", () =>
    assert.ok(scoreIvRelative(null, 80, null, null) !== null));
  it("ivVsRealizedVol > 1 nudges score up", () => {
    const base  = scoreIvRelative(0.50, 50, null, null) as number;
    const bonus = scoreIvRelative(0.50, 50, 1.5, null) as number;
    assert.ok(bonus > base, `bonus ${bonus} should > base ${base}`);
  });
  it("positive basicSkew nudges score up", () => {
    const base  = scoreIvRelative(0.50, 50, null, null) as number;
    const bonus = scoreIvRelative(0.50, 50, null, 0.05) as number;
    assert.ok(bonus > base);
  });
  it("result is capped at 1.0", () =>
    assert.ok((scoreIvRelative(1.0, 100, 2.0, 0.10) as number) <= 1.0));
});

// ── scoreIvAbsolute ───────────────────────────────────────────────────────────

describe("scoreIvAbsolute", () => {
  it("returns null for null IV", () =>
    assert.equal(scoreIvAbsolute(null, [0.3, 0.5, 0.7]), null));
  it("returns null for empty watchlist", () =>
    assert.equal(scoreIvAbsolute(0.5, []), null));
  it("lowest IV → low score", () =>
    assert.ok((scoreIvAbsolute(0.10, [0.10, 0.30, 0.50, 0.70]) as number) < 0.3));
  it("highest IV → capped at IV_ABSOLUTE_CAP", () => {
    const s = scoreIvAbsolute(0.90, [0.10, 0.30, 0.50, 0.70, 0.90]) as number;
    assert.ok(s <= 0.85, `score ${s} > cap 0.85`);
  });
});

// ── scoreStockQuality ─────────────────────────────────────────────────────────

describe("scoreStockQuality", () => {
  it("returns null when both null", () =>
    assert.equal(scoreStockQuality(null, null), null));
  it("uses tech only when fund is null", () =>
    close(scoreStockQuality(80, null) as number, 0.8, 0.01));
  it("uses fund only when tech is null", () =>
    close(scoreStockQuality(null, 60) as number, 0.6, 0.01));
  it("blends 60/40 tech/fund", () => {
    const expected = 0.6 * 0.8 + 0.4 * 0.4;
    close(scoreStockQuality(80, 40) as number, expected, 0.01);
  });
});

// ── scoreStrikeSupport ────────────────────────────────────────────────────────

describe("scoreStrikeSupport", () => {
  it("returns null when no support levels", () =>
    assert.equal(scoreStrikeSupport(90, 100, null, null, null), null));
  it("strike below all support → 1.0", () =>
    assert.equal(scoreStrikeSupport(70, 100, 80, 75, 78), 1.0));
  it("strike very close to spot → 0", () =>
    assert.equal(scoreStrikeSupport(97, 100, 80, 75, null), 0));
  it("strike between spot and support → intermediate", () => {
    const s = scoreStrikeSupport(85, 100, 80, null, null) as number;
    assert.ok(s > 0 && s < 1, `expected (0,1), got ${s}`);
  });
  it("lower strike scores higher (closer to support)", () => {
    const s1 = scoreStrikeSupport(90, 100, 80, null, null) as number;
    const s2 = scoreStrikeSupport(82, 100, 80, null, null) as number;
    assert.ok(s2 > s1, `${s2} should > ${s1}`);
  });
});

// ── scoreDtePreference ────────────────────────────────────────────────────────

describe("scoreDtePreference", () => {
  it("1 DTE → 1.0",  () => assert.equal(scoreDtePreference(1), 1.0));
  it("7 DTE → 1.0",  () => assert.equal(scoreDtePreference(7), 1.0));
  it("8 DTE → 0.8",  () => assert.equal(scoreDtePreference(8), 0.8));
  it("14 DTE → 0.8", () => assert.equal(scoreDtePreference(14), 0.8));
  it("15 DTE → 0.6", () => assert.equal(scoreDtePreference(15), 0.6));
  it("21 DTE → 0.6", () => assert.equal(scoreDtePreference(21), 0.6));
  it("28 DTE → 0.4", () => assert.equal(scoreDtePreference(28), 0.4));
});

// ── liquidityGate ─────────────────────────────────────────────────────────────

describe("liquidityGate", () => {
  it("all null → pass, no warn", () => {
    const r = liquidityGate(null, null, null);
    assert.equal(r.pass, true);
    assert.equal(r.warn, false);
  });
  it("good values → pass", () => {
    const r = liquidityGate(200, 0.05, 50);
    assert.equal(r.pass, true);
    assert.equal(r.warn, false);
  });
  it("low OI → warn (soft gate)", () => {
    const r = liquidityGate(MIN_OI - 1, 0.05, 50);
    assert.equal(r.warn, true);
  });
  it("high spread → warn", () => {
    const r = liquidityGate(200, MAX_SPREAD_PCT + 0.01, 50);
    assert.equal(r.warn, true);
  });
  it("low volume → warn", () => {
    const r = liquidityGate(200, 0.05, MIN_VOL - 1);
    assert.equal(r.warn, true);
  });
});

// ── Renormalization invariance ────────────────────────────────────────────────
// Removing a null component must not change the relative ranking between two options.

describe("renormalization invariance", () => {
  const baseStock: StockContext = {
    ivRank: 0.70, ivPercentile: 65, ivVsRealizedVol: 1.2, basicSkew: 0.03,
    swingLow20d: 90, swingLow50d: 85, pivotS1: 88,
    nearestSupportDistPct: 0.05,
    techTotalScore: 75, fundTotalScore: 60,
  };

  const highIncome: OptionCandidate = {
    strike: 95, spot: 100, dte: 7, weeklyIncome: 1.0,
    delta: -0.12, strikeIV: 0.40, otmPct: 0.05,
    openInterest: 500, spreadPct: 0.05, volume: 100,
  };
  const lowIncome: OptionCandidate = {
    ...highIncome, weeklyIncome: 0.3, // below floor
  };

  it("higher income wins over lower income (control)", () => {
    const r1 = computeOptionScore(highIncome, baseStock, "BASELINE", [0.40]);
    const r2 = computeOptionScore(lowIncome,  baseStock, "BASELINE", [0.40]);
    assert.ok(r1.optionScore > r2.optionScore, `${r1.optionScore} should > ${r2.optionScore}`);
  });

  it("dropping support component does not swap ranking when income difference is large", () => {
    const noSupport: StockContext = { ...baseStock, swingLow20d: null, swingLow50d: null, pivotS1: null };
    const r1 = computeOptionScore(highIncome, noSupport, "BASELINE", [0.40]);
    const r2 = computeOptionScore(lowIncome,  noSupport, "BASELINE", [0.40]);
    assert.ok(r1.optionScore > r2.optionScore, `with no support: ${r1.optionScore} should > ${r2.optionScore}`);
  });

  it("dropping IV rank does not swap ranking", () => {
    const noIV: StockContext = { ...baseStock, ivRank: null, ivPercentile: null };
    const r1 = computeOptionScore(highIncome, noIV, "BASELINE", [0.40]);
    const r2 = computeOptionScore(lowIncome,  noIV, "BASELINE", [0.40]);
    assert.ok(r1.optionScore > r2.optionScore);
  });

  it("dataQuality < 1 when a component is null", () => {
    const noSupport: StockContext = { ...baseStock, swingLow20d: null, swingLow50d: null, pivotS1: null };
    const r = computeOptionScore(highIncome, noSupport, "BASELINE", [0.40]);
    assert.ok(r.dataQuality < 1.0, `expected dataQuality < 1, got ${r.dataQuality}`);
  });
});

// ── DTE <= 0 ineligibility ────────────────────────────────────────────────────

describe("DTE guard", () => {
  it("returns score 0 and 0 components for DTE = 0", () => {
    const stock: StockContext = {
      ivRank: 70, ivPercentile: 65, ivVsRealizedVol: null, basicSkew: null,
      swingLow20d: 90, swingLow50d: null, pivotS1: null,
      nearestSupportDistPct: null, techTotalScore: 75, fundTotalScore: 60,
    };
    const cand: OptionCandidate = {
      strike: 95, spot: 100, dte: 0, weeklyIncome: 1.0,
      delta: -0.12, strikeIV: 0.40, otmPct: 0.05,
      openInterest: 500, spreadPct: 0.05, volume: 100,
    };
    const r = computeOptionScore(cand, stock, "BASELINE", [0.40]);
    assert.equal(r.optionScore, 0);
    assert.equal(r.availableComponents, 0);
  });
});

// ── buildCandidate ────────────────────────────────────────────────────────────

describe("buildCandidate", () => {
  it("computes weeklyIncome = incomePct / (exactDte/7)", () => {
    const put = { strike: 95, bid: 0.50, ask: 0.55, iv: 0.40, volume: 100,
                  openInterest: 500, delta: -0.12, spreadPct: 0.05, incomePct: 0.526 };
    const chain = { spot: 100, exactDte: 3.5 };
    const c = buildCandidate(put, chain);
    close(c.weeklyIncome, 0.526 / (3.5 / 7), 0.01);
  });
  it("computes otmPct correctly", () => {
    const put = { strike: 90, bid: 0.5, ask: 0.55, iv: 0.4, volume: 10,
                  openInterest: 100, delta: -0.10, spreadPct: 0.1, incomePct: 0.5 };
    const c = buildCandidate(put, { spot: 100, exactDte: 7 });
    close(c.otmPct, 0.10, 0.001);
  });
});

// ── computeRelativeMove ───────────────────────────────────────────────────────

describe("computeRelativeMove", () => {
  it("returns ~0.5 with no data", () =>
    close(computeRelativeMove(null, null, null, null, null, null), 0.5, 0.01));
  it("negative z-score → high score (oversold favorable)", () => {
    const s = computeRelativeMove(-2, null, null, null, null, null);
    assert.ok(s > 0.6, `expected > 0.6, got ${s}`);
  });
  it("positive z-score → low score (overbought unfavorable)", () => {
    const s = computeRelativeMove(2, null, null, null, null, null);
    assert.ok(s < 0.4, `expected < 0.4, got ${s}`);
  });
  it("large positive return5d reduces score", () => {
    const base  = computeRelativeMove(0, 0, 0, null, null, null);
    const spike = computeRelativeMove(0, 0, 8, null, null, null);
    assert.ok(spike < base, `spike ${spike} should < base ${base}`);
  });
  it("stock at bottom of 20d range → high score", () => {
    const s = computeRelativeMove(null, null, null, 110, 90, 91);
    assert.ok(s > 0.8, `expected > 0.8, got ${s}`);
  });
  it("stock at top of 20d range → low score", () => {
    const s = computeRelativeMove(null, null, null, 110, 90, 109);
    assert.ok(s < 0.2, `expected < 0.2, got ${s}`);
  });
});

// ── tagBonus ─────────────────────────────────────────────────────────────────

describe("tagBonus", () => {
  it("green → 1.0",   () => assert.equal(tagBonus("green"),  1.0));
  it("blue → 0.8",    () => assert.equal(tagBonus("blue"),   0.8));
  it("yellow → 0.5",  () => assert.equal(tagBonus("yellow"), 0.5));
  it("null → 0.5",    () => assert.equal(tagBonus(null),     0.5));
  it("unknown → 0.5", () => assert.equal(tagBonus("orange"), 0.5));
});

// ── computeStockScore ─────────────────────────────────────────────────────────

describe("computeStockScore", () => {
  it("all null inputs → insufficient quality, some score (from relativeMove+tag)", () => {
    const r = computeStockScore({
      techTotalScore: null, fundTotalScore: null,
      relativeMoveScore: 0.5, bestOptionScore: null, colorTag: null,
    });
    assert.equal(r.dataQuality, "insufficient");
    assert.ok(r.stockScore >= 0 && r.stockScore <= 100);
  });
  it("all inputs present → good quality", () => {
    const r = computeStockScore({
      techTotalScore: 80, fundTotalScore: 70,
      relativeMoveScore: 0.6, bestOptionScore: 75, colorTag: "green",
    });
    assert.equal(r.dataQuality, "good");
    assert.ok(r.stockScore > 50);
  });
  it("higher scores → higher stockScore", () => {
    const high = computeStockScore({
      techTotalScore: 90, fundTotalScore: 85, relativeMoveScore: 0.9,
      bestOptionScore: 88, colorTag: "green",
    });
    const low = computeStockScore({
      techTotalScore: 20, fundTotalScore: 15, relativeMoveScore: 0.1,
      bestOptionScore: 10, colorTag: "yellow",
    });
    assert.ok(high.stockScore > low.stockScore);
  });
});
