import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  scoreUniverse,
  defaultOptionalMetrics,
  missingDefaultOptionals,
  type FundRowInput,
} from "./fund-score-engine.js";

function row(i: number): FundRowInput {
  const v = (base: number, step: number) => base + step * i;
  return {
    ticker: `T${i}`,
    peRatio: v(12, 1.5), pegRatio: v(0.8, 0.1), forwardPe: v(11, 1.2), evEbitda: v(8, 0.7), evRevenue: v(1.5, 0.3),
    priceToBook: v(1.2, 0.2), priceToSales: v(1.1, 0.25), dividendYield: 0.01,
    netIncome: v(400, 40), freeCashFlow: v(350, 30), totalRevenue: v(4000, 300), ebitda: v(800, 60), ebit: v(600, 50),
    interestExpense: 40, grossMargin: v(0.35, 0.01), operatingMargin: v(0.15, 0.005), netMargin: v(0.1, 0.004),
    returnOnEquity: v(0.12, 0.01), returnOnAssets: v(0.06, 0.004), roic: v(0.11, 0.006), wacc: 0.08,
    revenueGrowthYoY: v(0.04, 0.01), revenueGrowthYoyPrior: v(0.03, 0.01), epsGrowth: v(0.05, 0.012),
    analystTargetPrice: v(110, 2), currentPrice: 100, marketCap: v(20_000, 1_000), currentRatio: v(1.2, 0.08),
    debtToEquity: v(0.9, -0.04), totalDebt: 1500, cashAndEquivalents: v(500, 40), quarterlyOperatingCashFlow: v(120, 10),
    sharesOutstanding: 200, sharesOutstandingPrior: 201, beta: 1.1, grossProfit: v(1400, 100), totalAssets: 8000,
    annualOperatingCashFlow: v(480, 40), tangibleBookValuePerShare: v(20, 1), ffoProxy: null,
    peerGroupId: "test.group", scoringMode: null,
  };
}

const rows = Array.from({ length: 12 }, (_, i) => row(i));
// IBES covers only half the group; the rest have no IBES row at all.
const ibes = Object.fromEntries(
  rows.slice(0, 6).map((r, i) => [r.ticker, { revBreadth: 0.1 * i - 0.2, sue: 0.5, fwdGrowth: 0.08 + 0.01 * i }]),
);
const coverageOf = (optionalMetrics?: ("ibesRevBreadth" | "ibesFwdGrowth")[]) =>
  new Map(scoreUniverse(rows, {}, {}, ibes, optionalMetrics ? { optionalMetrics } : undefined).map((s) => [s.ticker, s]));

describe("optionalMetrics (versioned fund param)", () => {
  it("code defaults mark both IBES expectation metrics optional", () => {
    const d = defaultOptionalMetrics();
    assert.ok(d.includes("ibesRevBreadth"));
    assert.ok(d.includes("ibesFwdGrowth"));
  });

  it("absent list = code defaults (fund-1.1.1 lists the same set)", () => {
    const absent = coverageOf();
    const full = coverageOf(["ibesRevBreadth", "ibesFwdGrowth"]);
    for (const [t, s] of absent) {
      assert.deepEqual(s.coverage, full.get(t)!.coverage, t);
      assert.equal(s.totalScore, full.get(t)!.totalScore, t);
    }
  });

  it("a present list replaces the defaults, so fund-1.1.0 reproduces (ibesRevBreadth required)", () => {
    const v110 = coverageOf(["ibesFwdGrowth"]);
    const v111 = coverageOf(["ibesRevBreadth", "ibesFwdGrowth"]);
    const uncovered = rows.slice(6).map((r) => r.ticker);
    for (const t of uncovered) assert.ok(v110.get(t)!.coverage.total < v111.get(t)!.coverage.total, `${t} coverage should shrink under 1.1.0`);
    const covered = rows.slice(0, 6).map((r) => r.ticker);
    for (const t of covered) assert.deepEqual(v110.get(t)!.coverage, v111.get(t)!.coverage, t);
  });

  it("missingDefaultOptionals flags a partial champion list", () => {
    assert.deepEqual(missingDefaultOptionals(undefined), []);
    assert.deepEqual(missingDefaultOptionals(["ibesRevBreadth", "ibesFwdGrowth"]), []);
    assert.deepEqual(missingDefaultOptionals(["ibesFwdGrowth"]), ["ibesRevBreadth"]);
  });
});
