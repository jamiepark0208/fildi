import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { occSymbol, mapOptionQuote } from "./schwab-option-quotes.ts";

describe("schwab option quotes", () => {
  it("builds OCC symbols", () => {
    assert.equal(occSymbol({ ticker: "nflx", expiry: "2026-10-16", strike: 65, type: "put" }), "NFLX  261016P00065000");
    assert.equal(occSymbol({ ticker: "ONDS", expiry: "2026-10-09", strike: 7.5, type: "call" }), "ONDS  261009C00007500");
  });
  it("maps a quote and converts IV percent to decimal", () => {
    const q = mapOptionQuote({ quote: { bidPrice: 0.5, askPrice: 0.55, mark: 0.525, volatility: 45, delta: -0.2, quoteTime: 0 } });
    assert.equal(q?.bid, 0.5);
    assert.equal(q?.iv, 0.45);
    assert.equal(mapOptionQuote(undefined), null);
  });
});
