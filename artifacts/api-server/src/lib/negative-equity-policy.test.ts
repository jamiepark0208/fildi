import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rawMetricValue } from "./fund-score-raw.js";
import { applyNegativeEquityGoldPolicy, applyNegativeTbvGoldPolicy, hasNegativeEquity } from "./negative-equity-policy.js";

describe("negative-equity-policy", () => {
  it("detects negative book equity", () => {
    assert.equal(hasNegativeEquity(-1), true);
    assert.equal(hasNegativeEquity(0), false);
    assert.equal(hasNegativeEquity(100), false);
  });

  it("clears D/E and ROE gold and sets flag", () => {
    const update: Record<string, unknown> = {
      totalStockholdersEquity: -500,
      debtToEquity: -3.2,
      returnOnEquity: -0.4,
    };
    const prov: { field: string; result: { source: string; value: number | null; isOverride: boolean; divergent: boolean } }[] =
      [];
    const cleared = applyNegativeEquityGoldPolicy(update, prov);
    assert.equal(update.negativeEquity, true);
    assert.equal(update.debtToEquity, null);
    assert.equal(update.returnOnEquity, null);
    assert.deepEqual(cleared.sort(), ["debtToEquity", "returnOnEquity"]);
  });

  it("fund score skips D/E and ROE when equity negative (not worst bucket)", () => {
    const row = {
      totalStockholdersEquity: -200,
      debtToEquity: -5,
      returnOnEquity: 0.2,
    } as Parameters<typeof rawMetricValue>[1];
    assert.equal(rawMetricValue("de", row, { negativeEquityLeverage: "sanitized" }), null);
    assert.equal(rawMetricValue("roe", row, { negativeEquityLeverage: "sanitized" }), null);
    assert.equal(rawMetricValue("de", row, { negativeEquityLeverage: "legacy" }), -5);
  });

  it("clears priceToTbv when tangible book per share is non-positive", () => {
    const update: Record<string, unknown> = {
      tangibleBookValuePerShare: -2.5,
      priceToTbv: 4.2,
    };
    const prov: { field: string; result: { source: string; value: number | null; isOverride: boolean; divergent: boolean } }[] =
      [{ field: "priceToTbv", result: { source: "finnhub", value: 4.2, isOverride: false, divergent: false } }];
    const cleared = applyNegativeTbvGoldPolicy(update, prov);
    assert.equal(update.priceToTbv, null);
    assert.deepEqual(cleared, ["priceToTbv"]);
    assert.equal(prov.length, 0);
  });
});
