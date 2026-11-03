/**
 * Fixtures for owned gold metrics + unit normalization (Phase 0).
 * Run: pnpm exec tsx --test src/lib/derived-metrics.fixture.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeTrailingPeg,
  computeForwardPeg,
  computeNetMargin,
  computeOperatingMargin,
  computeReturnOnEquity,
  computeDebtToEquity,
  computePeFromPriceEps,
  resolvePegGrowth,
  canDerivePriceRatiosFromUsdClose,
  shouldForceDerivedPriceRatio,
  isEvEbitdaGoldCandidate,
  isGicsFinancialsSector,
  computePriceToSales,
} from "../lib/derived-metrics.js";

describe("owned PEG (ZTS-shaped)", () => {
  it("derives trailing PEG from PE and growth", () => {
    const pe = 12.03752;
    const g = 0.10130385805089652;
    const peg = computeTrailingPeg(pe, g);
    assert.ok(peg != null);
    assert.ok(Math.abs(peg - pe / (g * 100)) < 1e-9);
  });

  it("fills PEG for tiny and negative growth (coverage > null)", () => {
    assert.ok(computeTrailingPeg(20, 0.005) != null);
    assert.ok(computeTrailingPeg(20, -0.1) != null);
    assert.equal(computeTrailingPeg(20, 0), null); // divide-by-zero only
  });

  it("fills negative PE for losses", () => {
    assert.ok(computePeFromPriceEps(100, -2) != null);
    assert.equal(computePeFromPriceEps(100, 0), null);
  });

  it("falls back to forward growth when trailing growth unusable", () => {
    const g = resolvePegGrowth({
      epsGrowth: 0,
      trailingEps: 2,
      forwardEps: 2.4,
    });
    assert.ok(g != null);
    assert.ok(Math.abs(g! - 0.2) < 1e-9);
  });

  it("derives forward PEG from forward PE", () => {
    const fwd = computeForwardPeg(15, 0.12);
    assert.ok(fwd != null);
    assert.ok(Math.abs(fwd! - 15 / 12) < 1e-9);
  });
});

describe("Finnhub dividendYield scale heuristic", () => {
  function normalizeFinnhubDy(v: number): number {
    return v > 0.2 ? v / 100 : v;
  }

  it("leaves XEL-like decimals alone", () => {
    assert.equal(normalizeFinnhubDy(0.028769), 0.028769);
  });

  it("scales AAPL-like percent-points down", () => {
    const n = normalizeFinnhubDy(0.349933577422804);
    assert.ok(Math.abs(n - 0.00349933577422804) < 1e-12);
  });
});

describe("price-ratio derive gate (USD close)", () => {
  it("blocks non-USD financial currency", () => {
    assert.equal(
      canDerivePriceRatiosFromUsdClose({
        financialCurrency: "CNY",
        price: 100,
        revenue: 1e9,
        shares: 1e9,
        vendorPriceToSales: 2.5,
      }),
      false,
    );
  });

  it("allows USD filers", () => {
    assert.equal(
      canDerivePriceRatiosFromUsdClose({
        financialCurrency: "USD",
        price: 100,
        revenue: 1e9,
        shares: 1e9,
        vendorPriceToSales: 0.5,
      }),
      true,
    );
  });

  it("blocks when implied P/S disagrees with vendor (currency mix)", () => {
    assert.equal(
      canDerivePriceRatiosFromUsdClose({
        financialCurrency: null,
        price: 170,
        revenue: 941_168_000_000,
        shares: 2_320_000_000,
        vendorPriceToSales: 2.8,
      }),
      false,
    );
  });

  it("per-ratio gate: unknown currency requires vendor agreement (TCOM-shaped P/E leak)", () => {
    assert.equal(
      shouldForceDerivedPriceRatio({
        financialCurrency: null,
        derived: 1.19,
        vendorGold: 20,
      }),
      false,
    );
    assert.equal(
      shouldForceDerivedPriceRatio({
        financialCurrency: null,
        derived: 19,
        vendorGold: 20,
      }),
      true,
    );
  });

  it("EV/EBITDA gold band rejects Yahoo garbage", () => {
    assert.equal(isEvEbitdaGoldCandidate(2059), false);
    assert.equal(isEvEbitdaGoldCandidate(35.7), true);
    assert.equal(isGicsFinancialsSector("Financial Services"), true);
  });
});

describe("ratio fill-ins", () => {
  it("net and operating margin from legs", () => {
    assert.equal(computeNetMargin(10, 100), 0.1);
    assert.equal(computeOperatingMargin(25, 100), 0.25);
  });

  it("ROE and D/E from legs", () => {
    assert.equal(computeReturnOnEquity(20, 100), 0.2);
    assert.equal(computeDebtToEquity(50, 100), 0.5);
  });
});
