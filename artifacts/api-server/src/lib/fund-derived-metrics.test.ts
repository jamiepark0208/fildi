import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  netDebtToEbitda,
  grossProfitability,
  accrualsRatio,
  avgEpsSurprise,
  ibesRevBreadth,
  avgIbesSue,
  streetEventRisk,
  piotroskiFScore,
  ownHistoryNorm,
  blendPeerHist,
} from "./fund-derived-metrics.js";

describe("netDebtToEbitda", () => {
  it("computes (debt-cash)/ebitda", () => {
    assert.equal(netDebtToEbitda(100, 20, 40), 2);
  });
  it("null when ebitda <= 0", () => {
    assert.equal(netDebtToEbitda(100, 0, 0), null);
    assert.equal(netDebtToEbitda(100, 0, -5), null);
  });
});

describe("grossProfitability", () => {
  it("gp/assets", () => {
    assert.equal(grossProfitability(50, 200), 0.25);
  });
  it("null on bad assets", () => {
    assert.equal(grossProfitability(50, 0), null);
  });
});

describe("accrualsRatio", () => {
  it("positive when NI > OCF", () => {
    assert.equal(accrualsRatio(100, 60, 200), 0.2);
  });
});

describe("avgEpsSurprise", () => {
  it("averages last N clipped", () => {
    assert.equal(avgEpsSurprise([10, 20, 100, -100], 4, 50), (10 + 20 + 50 + -50) / 4);
  });
  it("null when empty", () => {
    assert.equal(avgEpsSurprise([null, undefined]), null);
  });
});

describe("ibesRevBreadth", () => {
  it("computes (up-down)/est", () => {
    assert.equal(ibesRevBreadth(7, 1, 20), 0.3);
  });
  it("null when no estimates", () => {
    assert.equal(ibesRevBreadth(1, 0, 0), null);
  });
});

describe("avgIbesSue", () => {
  it("clips and averages", () => {
    assert.equal(avgIbesSue([1, 2, 10, -10], 4, 5), (1 + 2 + 5 + -5) / 4);
  });
});

describe("streetEventRisk", () => {
  it("true when breadth extreme", () => {
    assert.equal(streetEventRisk(0.2, 0), true);
  });
  it("false when quiet", () => {
    assert.equal(streetEventRisk(0.05, 0.2), false);
  });
});

describe("piotroskiFScore", () => {
  it("scores full profitable quality name", () => {
    const r = piotroskiFScore({
      netIncome: 10,
      annualOcf: 12,
      accruals: -0.01,
      roa: 0.1,
      roaPrior: 0.08,
      grossMargin: 0.4,
      grossMarginPrior: 0.35,
      currentRatio: 1.5,
      currentRatioPrior: 1.2,
      debtToEquity: 0.5,
      debtToEquityPrior: 0.6,
      sharesOutstanding: 100,
      sharesOutstandingPrior: 100,
      assetTurnover: 0.8,
      assetTurnoverPrior: 0.7,
    });
    assert.equal(r.answered, 9);
    assert.equal(r.rawPoints, 9);
    assert.equal(r.score, 9);
  });
  it("partial coverage scales", () => {
    const r = piotroskiFScore({
      netIncome: 10,
      annualOcf: 12,
      accruals: null,
      roa: null,
      roaPrior: null,
      grossMargin: null,
      grossMarginPrior: null,
      currentRatio: null,
      currentRatioPrior: null,
      debtToEquity: null,
      debtToEquityPrior: null,
      sharesOutstanding: null,
      sharesOutstandingPrior: null,
      assetTurnover: null,
      assetTurnoverPrior: null,
    });
    assert.equal(r.answered, 2);
    assert.equal(r.rawPoints, 2);
    assert.equal(r.score, 9);
  });
});

describe("ownHistoryNorm", () => {
  it("n>=3 percentile", () => {
    const s = ownHistoryNorm(10, [1, 5, 10, 20], true);
    assert.ok(s != null && s >= 0.5);
  });
  it("n=2 trend", () => {
    assert.equal(ownHistoryNorm(110, [100], true), null); // n=1 in hist
    assert.equal(ownHistoryNorm(110, [100, 100], true), 0.75);
    assert.equal(ownHistoryNorm(90, [100, 100], true), 0.25);
  });
  it("n<=1 null", () => {
    assert.equal(ownHistoryNorm(10, [], true), null);
    assert.equal(ownHistoryNorm(10, [10], true), null);
  });
});

describe("blendPeerHist", () => {
  it("70/30 blend", () => {
    assert.equal(blendPeerHist(1, 0), 0.7);
  });
  it("peer only when no hist", () => {
    assert.equal(blendPeerHist(0.8, null), 0.8);
  });
});
