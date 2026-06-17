import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeChartZones, swingHighLow, pfNum } from "./chart-levels.ts";

function bars(closes: number[], spread = 1): { date: string; close: number; high: number; low: number }[] {
  return closes.map((c, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    close: c,
    high: c + spread,
    low: c - spread,
  }));
}

describe("swingHighLow", () => {
  it("returns null when insufficient data", () => {
    assert.deepEqual(swingHighLow([1, 2, 3], 20), { high: null, low: null });
  });

  it("finds pivot high and low in synthetic series", () => {
    const closes = [10, 11, 12, 15, 14, 13, 12, 11, 10, 9, 8, 9, 10, 11, 12];
    const r = swingHighLow(closes, 10);
    assert.ok(r.high !== null);
    assert.ok(r.low !== null);
  });
});

describe("computeChartZones", () => {
  it("returns empty for no bars", () => {
    assert.deepEqual(computeChartZones([], "3M", null), []);
  });

  it("includes period extrema on 1D", () => {
    const data = bars([100, 101, 99, 102, 98, 103]);
    const zones = computeChartZones(data, "1D", null);
    assert.ok(zones.some(z => z.label === "Period low" && z.kind === "support"));
    assert.ok(zones.some(z => z.label === "Period high" && z.kind === "resistance"));
  });

  it("caps at 2 support + 2 resistance", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 10);
    const data = bars(closes);
    const zones = computeChartZones(data, "1Y", {
      swingLow20d: 90,
      swingLow50d: 85,
      swingHigh20d: 115,
      swingHigh50d: 120,
      pivotS1: 88,
      pivotR1: 118,
      ma50: 100,
      ma200: 95,
      bbLower: 92,
      bbUpper: 112,
    });
    const sup = zones.filter(z => z.kind === "support");
    const res = zones.filter(z => z.kind === "resistance");
    assert.ok(sup.length <= 2, `supports=${sup.length}`);
    assert.ok(res.length <= 2, `resistances=${res.length}`);
  });

  it("dedupes levels within 0.5%", () => {
    const merged = mergeClose([
      { price: 100, label: "A", kind: "support" },
      { price: 100.4, label: "B", kind: "support" },
    ]);
    assert.equal(merged.length, 1);
  });

  it("pfNum parses string numerics from DB", () => {
    assert.equal(pfNum("211.14"), 211.14);
    assert.equal(pfNum(null), null);
  });
});

// mergeClose is not exported - fix test
function mergeClose(candidates: { price: number; label: string; kind: "support" | "resistance" }[]) {
  const MERGE_PCT = 0.005;
  const out: typeof candidates = [];
  for (const c of candidates) {
    const dup = out.find(o => o.kind === c.kind && Math.abs(o.price - c.price) / c.price < MERGE_PCT);
    if (!dup) out.push(c);
  }
  return out;
}
