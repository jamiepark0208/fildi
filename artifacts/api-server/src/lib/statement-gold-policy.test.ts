import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyGaapEbitdaGoldPolicy,
  applyNonUsdAbsoluteGoldPolicy,
} from "./statement-gold-policy.js";
import { vendorEbitdaIsAdjustedOutlier } from "./derived-metrics.js";

describe("statement-gold-policy A329 r6", () => {
  it("vendorEbitdaIsAdjustedOutlier flags INCY-style adjusted EBITDA", () => {
    assert.equal(vendorEbitdaIsAdjustedOutlier(1.94e9, 0.72e9), true);
    assert.equal(vendorEbitdaIsAdjustedOutlier(0.75e9, 0.72e9), false);
  });

  it("applyGaapEbitdaGoldPolicy replaces outlier vendor EBITDA", () => {
    const update: Record<string, number> = { ebit: 500, depreciationAmortization: 220, ebitda: 950 };
    const batch: { field: string; result: { source: string; value: number; isOverride: boolean; divergent: boolean } }[] =
      [{ field: "ebitda", result: { source: "yahoo", value: 950, isOverride: false, divergent: false } }];
    assert.equal(applyGaapEbitdaGoldPolicy(update, batch), true);
    assert.equal(update.ebitda, 720);
    assert.equal(batch[0].result.source, "derived");
  });

  it("applyNonUsdAbsoluteGoldPolicy clears CNY-scale revenue/equity", () => {
    const update: Record<string, number> = { totalRevenue: 1e12, totalStockholdersEquity: 1e12 };
    const batch: { field: string; result: { source: string; value: number; isOverride: boolean; divergent: boolean } }[] =
      [
        { field: "totalRevenue", result: { source: "yahoo", value: 1e12, isOverride: false, divergent: false } },
      ];
    const cleared = applyNonUsdAbsoluteGoldPolicy(update, batch, "CNY");
    assert.deepEqual(cleared, ["totalRevenue", "totalStockholdersEquity"]);
    assert.equal(update.totalRevenue, undefined);
  });

  it("applyNonUsdAbsoluteGoldPolicy keeps yahoo EPS (USD per ADS) for non-USD filers", () => {
    const update: Record<string, number> = { earningsPerShare: 22.76 };
    const batch = [{ field: "earningsPerShare", result: { source: "yahoo", value: 22.76, isOverride: false, divergent: false } }];
    const cleared = applyNonUsdAbsoluteGoldPolicy(update, batch, "JPY");
    assert.deepEqual(cleared, []);
    assert.equal(update.earningsPerShare, 22.76);
  });

  it("applyNonUsdAbsoluteGoldPolicy clears fallback-vendor EPS in reporting currency", () => {
    const update: Record<string, number> = { earningsPerShare: 355.2 };
    const batch = [{ field: "earningsPerShare", result: { source: "fmp", value: 355.2, isOverride: false, divergent: false } }];
    const cleared = applyNonUsdAbsoluteGoldPolicy(update, batch, "JPY");
    assert.deepEqual(cleared, ["earningsPerShare"]);
    assert.equal(update.earningsPerShare, undefined);
  });

  it("applyNegativeEquityGoldPolicy clears negative priceToBook alongside D/E and ROE (MCD bug)", async () => {
    const { applyNegativeEquityGoldPolicy } = await import("./negative-equity-policy.js");
    const update: Record<string, unknown> = {
      totalStockholdersEquity: -1.79e9,
      debtToEquity: -30.5,
      returnOnEquity: -5.0,
      priceToBook: -559.6,
    };
    const batch = [
      { field: "priceToBook", result: { source: "sec", value: -559.6, isOverride: false, divergent: false } },
    ];
    const cleared = applyNegativeEquityGoldPolicy(update, batch);
    assert.ok(cleared.includes("priceToBook"));
    assert.equal(update.priceToBook, null);
    assert.equal(batch.length, 0);
  });
});
