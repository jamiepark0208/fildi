import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreIvRelative, scoreVolOfVol, computeOptionScore, type OptionCandidate, type StockContext } from "./option-scorer.ts";

describe("A191 ivRelative / volOfVol", () => {
  it("ivRelative uses universe IV/RV percentile when provided", () => {
    const withEdge = scoreIvRelative(0.2, 20, 0.8, 0, false, 0.9);
    const legacy = scoreIvRelative(0.2, 20, 0.8, 0, false, null);
    assert.equal(withEdge, 0.9);
    assert.ok(legacy != null && legacy < 0.9);
  });

  it("volOfVol passes through percentile", () => {
    assert.equal(scoreVolOfVol(0.75), 0.75);
    assert.equal(scoreVolOfVol(null), null);
  });

  it("computeOptionScore includes volOfVol when weighted", () => {
    const candidate: OptionCandidate = {
      weeklyIncome: 1.0,
      delta: -0.2,
      strikeIV: 0.35,
      dte: 21,
      otmPct: 0.08,
      openInterest: 200,
      spreadPct: 0.05,
      volume: 50,
      strike: 92,
      spot: 100,
      bidIsLive: true,
    };
    const stock: StockContext = {
      ivRank: 0.5,
      ivPercentile: 50,
      ivVsRealizedVol: 1.1,
      basicSkew: 0.02,
      swingLow20d: 90,
      swingLow50d: 88,
      pivotS1: 91,
      swingHigh20d: 110,
      swingHigh50d: 112,
      pivotR1: 108,
      nearestSupportDistPct: 0.05,
      techTotalScore: 60,
      fundTotalScore: 55,
      earningsDaysOut: 40,
      ivRvUniversePct: 0.8,
      volOfVolPct: 0.7,
    };
    const weights = {
      income: 0.28, buffer: 0.28, ivRelative: 0.12, volOfVol: 0.10,
      ivAbsolute: 0, stockQuality: 0.12, support: 0, nodeGap: 0.06, dte: 0.04,
    };
    const r = computeOptionScore(candidate, stock, "BASELINE", [0.2, 0.3, 0.4], weights, false);
    assert.equal(r.componentScores.volOfVol?.score, 0.7);
    assert.equal(r.componentScores.ivRelative?.score, 0.8);
    assert.equal(r.componentScores.ivAbsolute?.weight, 0);
  });
});
