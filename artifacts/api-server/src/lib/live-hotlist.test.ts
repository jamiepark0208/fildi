import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveBothHotLists,
  partitionOverlap,
  type HotlistEntry,
} from "./live-hotlist.ts";
import type { IndicatorResult } from "./indicators.ts";

function row(partial: Partial<IndicatorResult> & Pick<IndicatorResult, "ticker" | "rsi">): IndicatorResult {
  return {
    scoredDate: "2026-10-06",
    rsiYesterday: partial.rsi,
    mfi: 50,
    rsiThreshold: 40,
    mfiThreshold: 30,
    rsiOk: partial.rsi < 40,
    mfiOk: false,
    signal: partial.rsi < 40 ? "WATCH" : "NO",
    tier: 2,
    atr: null,
    macdCross: null,
    stoch: partial.stoch ?? 50,
    return5d: partial.return5d ?? 0,
    position52w: null,
    vsSpy20d: null,
    earningsDate: null,
    price: 100,
    ivCurrent: partial.ivCurrent ?? 0,
    ivPercentile: 50,
    ma200: null,
    ...partial,
  };
}

describe("deriveBothHotLists", () => {
  it("returns empty for empty input", () => {
    assert.deepEqual(deriveBothHotLists([]), { dip: [], rally: [] });
  });

  it("MRVL-class mid-RSI high-IV appears on at most one side", () => {
    const all = [
      row({ ticker: "MRVL", rsi: 48, ivCurrent: 95 }),
      row({ ticker: "LOW", rsi: 25, ivCurrent: 20, stoch: 10, return5d: -8 }),
      row({ ticker: "HIGH", rsi: 78, ivCurrent: 22, stoch: 90, return5d: 9 }),
      ...Array.from({ length: 8 }, (_, i) =>
        row({ ticker: `D${i}`, rsi: 30 + i, ivCurrent: 10 + i }),
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        row({ ticker: `R${i}`, rsi: 60 + i, ivCurrent: 15 + i }),
      ),
    ];
    const { dip, rally } = deriveBothHotLists(all);
    const dipSet = new Set(dip.map(e => e.ticker));
    const rallySet = new Set(rally.map(e => e.ticker));
    const both = [...dipSet].filter(t => rallySet.has(t));
    assert.deepEqual(both, []);
    assert.equal(rallySet.has("MRVL"), false);
  });

  it("RSI boundary: 49.9 dip-eligible, 50.1 rally-eligible, 50 neither", () => {
    const all = [
      row({ ticker: "UNDER", rsi: 49.9, ivCurrent: 80, stoch: 20, return5d: -5 }),
      row({ ticker: "EXACT", rsi: 50, ivCurrent: 99, stoch: 50, return5d: 0 }),
      row({ ticker: "OVER", rsi: 50.1, ivCurrent: 80, stoch: 80, return5d: 5 }),
    ];
    const { dip, rally } = deriveBothHotLists(all);
    assert.ok(dip.map(e => e.ticker).includes("UNDER"));
    assert.ok(!dip.map(e => e.ticker).includes("EXACT"));
    assert.ok(!dip.map(e => e.ticker).includes("OVER"));
    assert.ok(rally.map(e => e.ticker).includes("OVER"));
    assert.ok(!rally.map(e => e.ticker).includes("EXACT"));
    assert.ok(!rally.map(e => e.ticker).includes("UNDER"));
  });
});

describe("partitionOverlap", () => {
  it("assigns overlapping ticker to more extreme |RSI-50| side", () => {
    const dip: HotlistEntry[] = [
      { ticker: "X", price: 1, rsi: 40, mfi: 40, ivCurrent: 90, return5d: null, stoch: null, macdCross: null, signal: "NO", tier: 2 },
    ];
    const rally: HotlistEntry[] = [
      { ticker: "X", price: 1, rsi: 65, mfi: 60, ivCurrent: 90, return5d: null, stoch: null, macdCross: null, signal: "NO", tier: 2 },
    ];
    const out = partitionOverlap(dip, rally);
    assert.deepEqual(out.dip.map(e => e.ticker), []);
    assert.deepEqual(out.rally.map(e => e.ticker), ["X"]);
  });

  it("ties prefer dip (sell-put bias)", () => {
    const dip: HotlistEntry[] = [
      { ticker: "Y", price: 1, rsi: 40, mfi: 40, ivCurrent: 90, return5d: null, stoch: null, macdCross: null, signal: "NO", tier: 2 },
    ];
    const rally: HotlistEntry[] = [
      { ticker: "Y", price: 1, rsi: 60, mfi: 60, ivCurrent: 90, return5d: null, stoch: null, macdCross: null, signal: "NO", tier: 2 },
    ];
    const out = partitionOverlap(dip, rally);
    assert.deepEqual(out.dip.map(e => e.ticker), ["Y"]);
    assert.deepEqual(out.rally.map(e => e.ticker), []);
  });
});
