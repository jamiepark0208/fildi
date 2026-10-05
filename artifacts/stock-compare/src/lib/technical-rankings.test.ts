import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeTechnicalRankingsV2,
  getTechnicalScorecardMetrics,
  getComponentExplainers,
  TECHNICAL_SCORECARD_METRICS_V2,
  TECHNICAL_SCORECARD_METRICS_V2_CALL,
  type TechnicalRow,
} from "./technical-rankings.ts";

// Minimal fixture builder — all fields null unless overridden.
function row(overrides: Partial<TechnicalRow> = {}): TechnicalRow {
  return {
    ticker: "TEST",
    technicalsCoverage: "1.0",
    rsi14: null, rsi14Pct: null,
    mfi14Pct: null,
    stoch: null, stochPct: null,
    macdHist: null, macdDirection: null,
    rsiVelocity: null,
    volumeRatioPct: null,
    realizedVol20d: null,
    ivRank: null, ivPercentile: null,
    ivVsRealizedVol: null,
    bbWidthPct: null,
    priceZScore: null,
    ma50: null, ma200: null,
    priceVsMa50Atr: null, priceVsMa200Atr: null,
    nearestSupportDistPct: null,
    nearestResistDistPct: null,
    priceVsVwapPct: null,
    regime: null,
    fallingKnife: null,
    atmPutIv: null,
    putCallVolumeRatio: null,
    basicSkew: null,
    ivTermStructure: null,
    earningsDaysOut: null,
    swingLow20d: null, swingHigh20d: null,
    swingLow50d: null, swingHigh50d: null,
    pivotS1: null,
    pivotR1: null,
    atr14: null,
    impliedMoveWeekly: null,
    ...overrides,
  };
}

// Overbought / extended fixture — the ideal call-selling setup.
const OVERBOUGHT = row({
  ticker: "HOT",
  rsi14: "78", rsi14Pct: "0.92", mfi14Pct: "0.85", stochPct: "0.88",
  macdDirection: "DOWN", rsiVelocity: "-2.5",
  priceVsMa50Atr: "2.0", priceVsVwapPct: "4.0",
  nearestResistDistPct: "1.5", nearestSupportDistPct: "12.0",
  putCallVolumeRatio: "0.55", basicSkew: "-4.0",
  priceZScore: "1.6",
});

// Oversold fixture — the ideal put-selling setup.
const OVERSOLD = row({
  ticker: "COLD",
  rsi14: "24", rsi14Pct: "0.08", mfi14Pct: "0.15", stochPct: "0.12",
  macdDirection: "UP", rsiVelocity: "2.5",
  priceVsMa50Atr: "-2.0", priceVsVwapPct: "-4.0",
  nearestSupportDistPct: "1.5", nearestResistDistPct: "12.0",
  putCallVolumeRatio: "1.8", basicSkew: "6.0",
  priceZScore: "-1.6",
});

describe("computeTechnicalRankingsV2: put-side invariance", () => {
  it("default side equals explicit 'put' (byte-identical outputs)", () => {
    const a = computeTechnicalRankingsV2([OVERBOUGHT, OVERSOLD]);
    const b = computeTechnicalRankingsV2([OVERBOUGHT, OVERSOLD], {}, undefined, "put");
    assert.deepEqual(a, b);
  });
});

describe("computeTechnicalRankingsV2: call side mirrors direction", () => {
  it("overbought stock ranks above oversold in call mode; reversed in put mode", () => {
    const put  = computeTechnicalRankingsV2([OVERBOUGHT, OVERSOLD], {}, undefined, "put");
    const call = computeTechnicalRankingsV2([OVERBOUGHT, OVERSOLD], {}, undefined, "call");
    assert.equal(put[0].ticker, "COLD",  "put mode: oversold should rank #1");
    assert.equal(call[0].ticker, "HOT",  "call mode: overbought should rank #1");
  });
  it("component keys are identical across sides (stable UI/weights contract)", () => {
    const put  = computeTechnicalRankingsV2([OVERBOUGHT], {}, undefined, "put")[0];
    const call = computeTechnicalRankingsV2([OVERBOUGHT], {}, undefined, "call")[0];
    assert.deepEqual(
      Object.keys(put.componentScores ?? {}).sort(),
      Object.keys(call.componentScores ?? {}).sort(),
    );
  });
  it("volatilityState and volumeConfirm are side-neutral (same score both sides)", () => {
    const r = row({ atmPutIv: "40", ivVsRealizedVol: "1.2", bbWidthPct: "0.3", volumeRatioPct: "0.6" });
    const put  = computeTechnicalRankingsV2([r], {}, undefined, "put")[0];
    const call = computeTechnicalRankingsV2([r], {}, undefined, "call")[0];
    assert.equal(put.componentScores?.volatilityState.score, call.componentScores?.volatilityState.score);
    assert.equal(put.componentScores?.volumeConfirm.score,   call.componentScores?.volumeConfirm.score);
  });
});

describe("call gate (GO/WATCH/NO)", () => {
  it("overbought + fading momentum + no earnings → GO", () => {
    const [s] = computeTechnicalRankingsV2([OVERBOUGHT], {}, undefined, "call");
    assert.equal(s.gateStatus, "GO");
  });
  it("would-be GO with earnings ≤7d → WATCH", () => {
    const r = row({ ...OVERBOUGHT, earningsDaysOut: 3 });
    const [s] = computeTechnicalRankingsV2([r], {}, undefined, "call");
    assert.equal(s.gateStatus, "WATCH");
  });
  it("would-be GO but still accelerating (rocket: z>2, velocity>0) → WATCH", () => {
    const r = row({ ...OVERBOUGHT, priceZScore: "2.5", rsiVelocity: "3.0", macdDirection: "DOWN" });
    const [s] = computeTechnicalRankingsV2([r], {}, undefined, "call");
    assert.equal(s.gateStatus, "WATCH");
  });
  it("oversold stock → NO in call mode", () => {
    const r = row({ ...OVERSOLD, macdDirection: "UP", priceZScore: "-1.6" });
    const [s] = computeTechnicalRankingsV2([r], {}, undefined, "call");
    assert.equal(s.gateStatus, "NO");
  });
  it("coverage < 0.5 → NO regardless of setup", () => {
    const r = row({ ...OVERBOUGHT, technicalsCoverage: "0.3" });
    const [s] = computeTechnicalRankingsV2([r], {}, undefined, "call");
    assert.equal(s.gateStatus, "NO");
  });
});

describe("side-aware metadata + explainers", () => {
  it("metrics keys match across sides; labels differ for directional components", () => {
    assert.deepEqual(
      TECHNICAL_SCORECARD_METRICS_V2.map(m => m.key),
      TECHNICAL_SCORECARD_METRICS_V2_CALL.map(m => m.key),
    );
    assert.equal(getTechnicalScorecardMetrics("call")[0].label, "Overbought Depth");
    assert.equal(getTechnicalScorecardMetrics("put")[0].label,  "Oversold Depth");
  });
  it("explainer sub-scores mirror the component scorers", () => {
    const call = computeTechnicalRankingsV2([OVERBOUGHT], {}, undefined, "call")[0];
    for (const [key, fn] of Object.entries(getComponentExplainers("call"))) {
      const parts = fn(OVERBOUGHT);
      if (parts.length === 0) continue;
      const avg = parts.reduce((s, p) => s + p.score, 0) / parts.length;
      const comp = call.componentScores?.[key]?.score;
      assert.ok(comp != null && Math.abs(avg - comp) < 1e-9, `${key}: explainer avg ${avg} ≠ component ${comp}`);
    }
  });
});
