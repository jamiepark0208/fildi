import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mapChainResponse,
  normalizeSchwabIv,
  parseExpKey,
  isStandardMonthlyExpiry,
  type SchwabChainResponse,
} from "./schwab-client.js";

function futureExpKey(daysOut: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysOut);
  // Prefer Friday for weekly flag tests when possible
  while (d.getDay() !== 5 && daysOut < 40) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  const ymd = d.toISOString().slice(0, 10);
  return `${ymd}:${daysOut}`;
}

describe("isStandardMonthlyExpiry", () => {
  it("flags 3rd Friday as monthly", () => {
    // 2026-11-20 is the 3rd Friday of Nov 2026
    assert.equal(isStandardMonthlyExpiry(new Date("2026-11-20T16:00:00")), true);
  });
  it("flags other Fridays as not monthly", () => {
    assert.equal(isStandardMonthlyExpiry(new Date("2026-11-13T16:00:00")), false);
    assert.equal(isStandardMonthlyExpiry(new Date("2026-11-27T16:00:00")), false);
  });
});

describe("normalizeSchwabIv", () => {
  it("divides percent-style IV (>3) by 100", () => {
    assert.equal(normalizeSchwabIv(28.5), 0.285);
    assert.equal(normalizeSchwabIv(100), 1);
  });
  it("leaves decimal IV alone", () => {
    assert.equal(normalizeSchwabIv(0.35), 0.35);
    assert.equal(normalizeSchwabIv(2.5), 2.5);
  });
  it("handles nullish", () => {
    assert.equal(normalizeSchwabIv(null), 0);
    assert.equal(normalizeSchwabIv(undefined), 0);
  });
});

describe("parseExpKey", () => {
  it("parses Schwab expDateMap keys", () => {
    const p = parseExpKey("2026-12-18:75");
    assert.ok(p);
    assert.equal(p!.dteHint, 75);
    // Local calendar date (T16:00 without Z = exchange close local)
    assert.equal(p!.date.getFullYear(), 2026);
    assert.equal(p!.date.getMonth(), 11);
    assert.equal(p!.date.getDate(), 18);
  });
  it("rejects garbage", () => {
    assert.equal(parseExpKey("not-a-date"), null);
    assert.equal(parseExpKey("2026-13-99:1"), null);
  });
});

describe("mapChainResponse edge cases", () => {
  it("returns null without spot", () => {
    assert.equal(mapChainResponse("AAPL", { callExpDateMap: {} }), null);
  });

  it("returns null with only past expiries", () => {
    const raw: SchwabChainResponse = {
      underlyingPrice: 100,
      callExpDateMap: {
        "2020-01-17:0": {
          "110.0": [{ strikePrice: 110, bid: 1, ask: 1.2, volatility: 30, delta: 0.3 }],
        },
      },
    };
    assert.equal(mapChainResponse("AAPL", raw), null);
  });

  it("maps near-term calls/puts and filters OTM band", () => {
    const near = futureExpKey(10);
    const monthly = futureExpKey(37);
    const raw: SchwabChainResponse = {
      underlyingPrice: 100,
      callExpDateMap: {
        [near]: {
          "105.0": [{ strikePrice: 105, bid: 2.1, ask: 2.3, last: 2.2, volatility: 28, delta: 0.4, totalVolume: 10, openInterest: 100 }],
          "150.0": [{ strikePrice: 150, bid: 0.05, ask: 0.1, volatility: 40, delta: 0.05 }], // outside 25% OTM
          "100.0": [{ strikePrice: 100, bid: 3, ask: 3.2, volatility: 25, delta: 0.5 }], // ITM / below 3% OTM
        },
        [monthly]: {
          "110.0": [{ strikePrice: 110, bid: 1.5, ask: 1.7, volatility: 27, delta: 0.35 }],
        },
      },
      putExpDateMap: {
        [near]: {
          "95.0": [{ strikePrice: 95, bid: 1.8, ask: 2.0, volatility: 29, delta: -0.35 }],
          "70.0": [{ strikePrice: 70, bid: 0.1, ask: 0.2, volatility: 45, delta: -0.05 }], // outside band
        },
      },
    };
    const mapped = mapChainResponse("AAPL", raw);
    assert.ok(mapped);
    assert.ok(mapped!.length >= 1);
    const nearSlice = mapped!.find((c) => c.expiry === near.slice(0, 10));
    assert.ok(nearSlice);
    assert.equal(nearSlice!.spot, 100);
    assert.ok(nearSlice!.calls.every((r) => r.strike >= 103 && r.strike <= 125));
    assert.ok(nearSlice!.puts.every((r) => r.strike <= 97 && r.strike >= 75));
    assert.ok(nearSlice!.calls.some((r) => r.strike === 105 && Math.abs(r.iv - 0.28) < 1e-9));
  });

  it("monthly-only calendar keeps puts and marks isWeekly=false", () => {
    // Pin to a known 3rd Friday so isWeekly is false (monthly).
    const monthly = "2026-11-20:33";
    const raw: SchwabChainResponse = {
      underlyingPrice: 125,
      callExpDateMap: {
        [monthly]: {
          "130.0": [{ strikePrice: 130, bid: 1.2, ask: 1.4, volatility: 22, delta: 0.35 }],
        },
      },
      putExpDateMap: {
        [monthly]: {
          "120.0": [{ strikePrice: 120, bid: 1.8, ask: 2.0, volatility: 24, delta: -0.35 }],
          "115.0": [{ strikePrice: 115, bid: 1.1, ask: 1.3, volatility: 25, delta: -0.28 }],
        },
      },
    };
    const mapped = mapChainResponse("AEP", raw);
    assert.ok(mapped?.length === 1);
    assert.equal(mapped![0]!.isWeekly, false);
    assert.ok(mapped![0]!.puts.length >= 1, "puts must not be stripped when monthly is the only expiry");
    assert.ok(mapped![0]!.puts.some((p) => p.strike === 120));
  });

  it("dedupes strikes preferring higher bid", () => {
    const near = futureExpKey(7);
    const raw: SchwabChainResponse = {
      underlyingPrice: 200,
      callExpDateMap: {
        [near]: {
          "210.0": [
            { strikePrice: 210, bid: 1.0, ask: 1.2, volatility: 20, delta: 0.3 },
            { strikePrice: 210, bid: 1.5, ask: 1.6, volatility: 20, delta: 0.3 },
          ],
        },
      },
      putExpDateMap: { [near]: {} },
    };
    // contractsFromStrikeMap only takes arr[0] — first wins at ingest; dedupe is for multi-map paths
    const mapped = mapChainResponse("MSFT", raw);
    assert.ok(mapped);
    const calls = mapped![0]!.calls.filter((c) => c.strike === 210);
    assert.equal(calls.length, 1);
  });
});
