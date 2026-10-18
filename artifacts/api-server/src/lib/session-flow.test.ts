import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSessionFlow,
  computeSessionVwap,
  computeVolumeProfile,
  estimateDelta,
} from "./session-flow.ts";
import type { Bar } from "./intraday-regime.ts";

function bar(i: number, close: number, vol: number, open = close): Bar {
  const t0 = Date.parse("2026-10-16T13:30:00.000Z"); // ~9:30 ET
  return {
    time: t0 + i * 5 * 60_000,
    open,
    high: Math.max(open, close) + 0.1,
    low: Math.min(open, close) - 0.1,
    close,
    volume: vol,
  };
}

describe("computeSessionVwap", () => {
  it("rises when later bars trade higher with volume", () => {
    const bars = [bar(0, 100, 1000), bar(1, 102, 1000), bar(2, 104, 2000)];
    const vwap = computeSessionVwap(bars);
    assert.ok(vwap.length >= 2);
    assert.ok(vwap[vwap.length - 1]!.value > vwap[0]!.value);
  });
});

describe("computeVolumeProfile", () => {
  it("POC near densest price; VAH >= VAL", () => {
    const bars = [
      ...Array.from({ length: 8 }, (_, i) => bar(i, 100, 500)),
      ...Array.from({ length: 4 }, (_, i) => bar(8 + i, 105, 100)),
      ...Array.from({ length: 4 }, (_, i) => bar(12 + i, 95, 100)),
    ];
    const { poc, vah, val, profile } = computeVolumeProfile(bars, 12);
    assert.ok(poc != null && vah != null && val != null);
    assert.ok(vah! >= val!);
    assert.ok(profile.length === 12);
    assert.ok(Math.abs(poc! - 100) < 3, `poc=${poc}`);
  });
});

describe("estimateDelta", () => {
  it("uptick credits buy volume", () => {
    const bars = [bar(0, 100, 100), bar(1, 101, 200), bar(2, 100.5, 50)];
    const d = estimateDelta(bars);
    assert.equal(d[1]!.buy, 200);
    assert.equal(d[1]!.sell, 0);
    assert.equal(d[2]!.sell, 50);
  });
});

describe("buildSessionFlow", () => {
  it("packages session metadata", () => {
    const bars = Array.from({ length: 20 }, (_, i) => bar(i, 100 + (i % 3), 100 + i));
    const r = buildSessionFlow("spy", "2026-10-16", bars);
    assert.equal(r.ticker, "SPY");
    assert.equal(r.source, "yahoo-5m");
    assert.ok(r.vwap.length > 0);
    assert.ok(r.estimatedDelta.length === 20);
  });
});
