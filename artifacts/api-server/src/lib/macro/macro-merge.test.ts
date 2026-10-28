import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hasData, mergeWithPrior, keptFromPrior } from "./macro-merge.js";

describe("macro mergeWithPrior (A303)", () => {
  const prior = {
    fetchedAt: "2026-10-28T10:00:00Z",
    yieldSpread: 0.42,
    yieldCurve: [{ tenor: "2Y", current: 3.9 }, { tenor: "10Y", current: 4.3 }],
    vix: { symbol: "^VIX", price: 18.2, level: "mid" },
    series: { cpi: { value: 3.1, date: "2026-09-01", unit: "%" }, sofr: { value: 4.2, date: "2026-10-27", unit: "%" } },
  };

  it("keeps prior values where the fresh refresh came back empty (outage), at any depth", () => {
    const fresh = {
      fetchedAt: "2026-10-28T14:00:00Z",
      yieldSpread: null,
      yieldCurve: [{ tenor: "2Y", current: null }, { tenor: "10Y", current: null }],
      vix: { symbol: "^VIX", price: null, level: "mid" },
      series: { cpi: { value: null, date: null, unit: "%" }, sofr: { value: 4.3, date: "2026-10-28", unit: "%" } },
    };
    const m = mergeWithPrior(fresh, prior);
    assert.equal(m.fetchedAt, fresh.fetchedAt);
    assert.equal(m.yieldSpread, 0.42);
    assert.deepEqual(m.yieldCurve, prior.yieldCurve);           // labels-only array = empty → prior whole
    assert.deepEqual(m.vix, prior.vix);
    assert.deepEqual(m.series.cpi, prior.series.cpi);          // failed series → prior series whole
    assert.deepEqual(m.series.sofr, fresh.series.sofr);        // fresh data wins
    assert.deepEqual(keptFromPrior(fresh, m).sort(), ["series", "vix", "yieldCurve", "yieldSpread"]);
  });

  it("fresh data always wins; no prior = fresh as is; keys only in prior are dropped", () => {
    const fresh = { yieldSpread: 0.5, extra: [1] };
    assert.deepEqual(mergeWithPrior(fresh, { yieldSpread: 0.1, old: 9 }), { yieldSpread: 0.5, extra: [1] });
    assert.equal(mergeWithPrior(fresh, null), fresh);
  });

  it("hasData: numbers and text count, label fields and flags don't", () => {
    assert.equal(hasData({ tenor: "2Y", current: null, flag: true }), false);
    assert.equal(hasData({ value: null, date: null, unit: "%" }), false);
    assert.equal(hasData([{ a: NaN }, { b: 0 }]), true);
    assert.equal(hasData([]), false);
    assert.equal(hasData({ overall: "Liquidity tightening", signals: [] }), true); // text-only summary is fresh data
  });

  it("a fresh text-only summary replaces the prior one", () => {
    const m = mergeWithPrior({ implications: { overall: "new read" } }, { implications: { overall: "old read" } });
    assert.equal(m.implications.overall, "new read");
  });
});
