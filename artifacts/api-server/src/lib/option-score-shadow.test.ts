import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreShadowOnChosenStrike } from "./option-score-shadow.js";
import type { StockContext } from "@workspace/option-scoring";

const stock: StockContext = {
  ivRank: 50,
  ivPercentile: 50,
  ivVsRealizedVol: 1.2,
  basicSkew: 0,
  swingLow20d: 90,
  swingLow50d: 85,
  pivotS1: 92,
  swingHigh20d: 110,
  swingHigh50d: 115,
  pivotR1: 108,
  nearestSupportDistPct: 0.05,
  techTotalScore: 60,
  fundTotalScore: 55,
  earningsDaysOut: 40,
  volumeNodes: [95, 100],
};

describe("scoreShadowOnChosenStrike", () => {
  it("scores a live-bid put without changing the strike", () => {
    const score = scoreShadowOnChosenStrike({
      opt: {
        strike: 95,
        bid: 1.2,
        ask: 1.4,
        iv: 0.35,
        volume: 100,
        openInterest: 500,
        delta: -0.25,
        spreadPct: 0.08,
        incomePct: 1.26,
        bidIsLive: true,
      },
      chain: { spot: 100, exactDte: 21, settlementDte: 21 },
      stockCtx: stock,
      regime: "BASELINE",
      allWatchlistIVs: [0.2, 0.3, 0.4, 0.35],
      strikeWeights: undefined,
    });
    assert.equal(typeof score, "number");
    assert.ok(score! >= 0 && score! <= 100);
  });

  it("returns null when bid is not live", () => {
    const score = scoreShadowOnChosenStrike({
      opt: {
        strike: 95,
        bid: 0,
        ask: 1.4,
        iv: 0.35,
        volume: null,
        openInterest: null,
        delta: -0.25,
        spreadPct: null,
        incomePct: 0,
        bidIsLive: false,
      },
      chain: { spot: 100, exactDte: 21 },
      stockCtx: stock,
      regime: "BASELINE",
      allWatchlistIVs: [],
    });
    assert.equal(score, null);
  });
});
