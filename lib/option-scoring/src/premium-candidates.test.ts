/**
 * Unit tests for premium-candidate filter + income/OTM viability + quote plausibility.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  selectPremiumCandidates, premiumRichnessScore,
  isViablePremiumIncome, isPlausibleOptionQuote, MIN_OTM_FOR_PREMIUM,
} from "./premium-candidates.ts";
import {
  computeOptionScore, isEarningsRisk, type OptionCandidate, type StockContext,
} from "./option-scorer.ts";

const baseStock: StockContext = {
  ivRank: 0.7, ivPercentile: 70, ivVsRealizedVol: 1.2, basicSkew: 0.05,
  swingLow20d: 90, swingLow50d: 88, pivotS1: 91,
  swingHigh20d: 110, swingHigh50d: 112, pivotR1: 109,
  nearestSupportDistPct: 0.05,
  techTotalScore: 70, fundTotalScore: 65,
  earningsDaysOut: null,
};

function cand(over: Partial<OptionCandidate> = {}): OptionCandidate {
  return {
    weeklyIncome: 0.9,
    delta: -0.12,
    strikeIV: 0.45,
    dte: 7,
    otmPct: 0.10,
    openInterest: 500,
    spreadPct: 0.05,
    volume: 100,
    strike: 90,
    spot: 100,
    bidIsLive: true,
    quoteStale: false,
    ...over,
  };
}

describe("selectPremiumCandidates", () => {
  it("ranks by ATM IV / IV-RV richness and respects limit", () => {
    const rows = [
      { ticker: "LOW", atmPutIv: 11, ivVsRealizedVol: 0.8, technicalsCoverage: 0.8 },
      { ticker: "MID", atmPutIv: 28, ivVsRealizedVol: 1.1, technicalsCoverage: 0.8 },
      { ticker: "HIGH", atmPutIv: 55, ivVsRealizedVol: 1.5, technicalsCoverage: 0.8 },
      { ticker: "THIN", atmPutIv: 40, ivVsRealizedVol: 1.2, technicalsCoverage: 0.05 },
    ];
    assert.ok(premiumRichnessScore(rows[2]!) > premiumRichnessScore(rows[1]!));
    const got = selectPremiumCandidates(rows, 2);
    assert.deepEqual(got, ["HIGH", "MID"]);
    assert.equal(selectPremiumCandidates(rows, 10).includes("THIN"), false);
  });

  it("returns a non-trivial set from a wide IV universe", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      ticker: `T${i}`,
      atmPutIv: 15 + (i % 40),
      ivVsRealizedVol: 1.0,
      technicalsCoverage: 0.5,
    }));
    const got = selectPremiumCandidates(rows, 200);
    assert.ok(got.length >= 40, `expected many candidates, got ${got.length}`);
  });
});

describe("income + OTM viability (fixed floors)", () => {
  it("requires income floor AND fixed min OTM — not a sliding income→OTM curve", () => {
    assert.equal(MIN_OTM_FOR_PREMIUM, 0.03);
    // Adequate income + enough distance
    assert.equal(isViablePremiumIncome(0.5, 0.03), true);
    assert.equal(isViablePremiumIncome(0.9, 0.05), true);
    assert.equal(isViablePremiumIncome(2.5, 0.08), true); // high income OK if distance ok
    // Fail on income alone
    assert.equal(isViablePremiumIncome(0.2, 0.10), false);
    // Fail on distance alone (even with good income)
    assert.equal(isViablePremiumIncome(0.9, 0.02), false);
  });
});

describe("quote plausibility", () => {
  it("rejects LDI-style nonsense premium vs strike", () => {
    assert.equal(isPlausibleOptionQuote(0.37, 0.5, 1.7, 0.70), false);
    assert.equal(isPlausibleOptionQuote(1.20, 90, 100, 0.10), true);
  });
});

describe("earnings risk scoring", () => {
  it("flags earnings ≤7d without zeroing the score", () => {
    assert.equal(isEarningsRisk(3), true);
    const erNear = computeOptionScore(
      cand({ otmPct: 0.03, weeklyIncome: 0.6 }),
      { ...baseStock, earningsDaysOut: 3 },
      "BASELINE", [0.4, 0.45, 0.5],
    );
    const erDeep = computeOptionScore(
      cand({ otmPct: 0.12, weeklyIncome: 0.9 }),
      { ...baseStock, earningsDaysOut: 3 },
      "BASELINE", [0.4, 0.45, 0.5],
    );
    assert.equal(erNear.earningsRisk, true);
    assert.ok(erDeep.optionScore > erNear.optionScore);
  });
});

describe("live bid only", () => {
  it("pickBestStrike skips contracts with bid=0 even when ask>0", async () => {
    const { pickBestStrike } = await import("./option-scorer.ts");
    const chains = [{
      spot: 100,
      exactDte: 7,
      settlementDte: 7,
      options: [{
        strike: 90,
        bid: 0,
        ask: 1.05,
        iv: 0.4,
        volume: 50,
        openInterest: 200,
        delta: -0.15,
        spreadPct: null,
        incomePct: 0,
        meetsGate: false,
        bidIsLive: false,
        lastPrice: 9.99,
      }],
    }];
    const best = pickBestStrike(
      chains as never,
      baseStock,
      "BASELINE",
      [0.35, 0.4, 0.45],
      3,
      undefined,
      false,
    );
    assert.equal(best, null);
  });

  // A254: soft liquidity warning — thin book can still win; reason surfaced, not excluded.
  it("pickBestStrike still returns thin OI/vol with liquidity.warn", async () => {
    const { pickBestStrike } = await import("./option-scorer.ts");
    const chains = [{
      spot: 100,
      exactDte: 7,
      settlementDte: 7,
      options: [{
        strike: 90,
        bid: 1.2,
        ask: 1.4,
        iv: 0.45,
        volume: 1,
        openInterest: 10,
        delta: -0.12,
        spreadPct: 0.5,
        incomePct: 1.2 * 100 / 100, // ~1.2% of spot → weekly via settlement
        meetsGate: true,
        bidIsLive: true,
      }],
    }];
    // incomePct in buildCandidate = option.incomePct / (settlementDte/7)
    // Use a generous incomePct so viability passes.
    chains[0]!.options[0]!.incomePct = 1.5;
    const best = pickBestStrike(
      chains as never,
      baseStock,
      "BASELINE",
      [0.35, 0.4, 0.45],
      3,
      undefined,
      false,
    );
    assert.ok(best, "thin liquidity must still be pickable");
    assert.equal(best!.result.liquidity.warn, true);
    assert.equal(best!.result.liquidity.pass, true);
    assert.ok(best!.result.liquidity.reason);
  });
});
