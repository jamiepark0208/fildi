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
});
