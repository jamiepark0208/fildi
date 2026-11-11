import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyNonUsdAbsoluteGoldPolicyDetailed } from "./statement-gold-policy.js";

type PB = { field: string; result: { source: string; value: number | null; isOverride: boolean; divergent: boolean } };
const pb = (field: string, source: string, value: number): PB => ({ field, result: { source, value, isOverride: false, divergent: false } });

describe("non-USD gold: convert, don't blank (11-11 TSM)", () => {
  it("converts a yahoo TWD revenue at the FX rate and cross-checks factset", () => {
    const update: Record<string, number> = { totalRevenue: 4.94e12 };
    const batch = [pb("totalRevenue", "yahoo", 4.94e12)];
    const bronze = new Map([["totalRevenue", new Map([["factset", 1.69e11]])]]);
    const r = applyNonUsdAbsoluteGoldPolicyDetailed(update, batch, "TWD", { usdPerUnit: 0.0304, bronze });
    assert.ok(Math.abs(update.totalRevenue! - 1.50176e11) < 1e6);
    assert.equal(batch[0]!.result.source, "yahoo+fx");
    assert.equal(batch[0]!.result.divergent, false);   // 150B vs 169B = 11 % gap < 35 %
    assert.deepEqual(r.cleared, []);
  });
  it("flags divergent when the converted value is far from factset", () => {
    const update: Record<string, number> = { totalRevenue: 4.94e12 };
    const batch = [pb("totalRevenue", "yahoo", 4.94e12)];
    const bronze = new Map([["totalRevenue", new Map([["factset", 4.0e11]])]]);
    applyNonUsdAbsoluteGoldPolicyDetailed(update, batch, "TWD", { usdPerUnit: 0.0304, bronze });
    assert.equal(batch[0]!.result.divergent, true);
  });
  it("falls back to factset USD when there is no FX rate", () => {
    const update: Record<string, number> = {};
    const batch: PB[] = [];
    const bronze = new Map([["cashAndEquivalents", new Map([["factset", 9e10]])]]);
    const r = applyNonUsdAbsoluteGoldPolicyDetailed(update, batch, "TWD", { usdPerUnit: null, bronze });
    assert.equal(update.cashAndEquivalents, 9e10);
    assert.equal(r.outcomes.find((o) => o.field === "cashAndEquivalents")?.action, "factset");
  });
  it("converts sec_local IFRS total assets (ASML EUR 20-F)", () => {
    const update: Record<string, number> = { totalAssets: 50.6e9 };
    const batch = [pb("totalAssets", "sec_local", 50.6e9)];
    applyNonUsdAbsoluteGoldPolicyDetailed(update, batch, "EUR", { usdPerUnit: 1.1 });
    assert.ok(Math.abs(update.totalAssets! - 55.66e9) < 1e6);
    assert.equal(batch[0]!.result.source, "sec_local+fx");
  });
  it("still clears (and reports) when nothing is convertible", () => {
    const update: Record<string, number> = { totalDebt: 1e12 };
    const batch = [pb("totalDebt", "sec", 1e12)];
    const r = applyNonUsdAbsoluteGoldPolicyDetailed(update, batch, "JPY", { usdPerUnit: 0.0066 });
    assert.equal(update.totalDebt, undefined);
    assert.equal(r.outcomes[0]!.action, "cleared");
  });
});
