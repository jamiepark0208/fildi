import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assetToTicker,
  horizonToDays,
  directionHit,
} from "./figure-views-auto-resolve.js";

describe("A85 auto-resolve helpers", () => {
  it("maps assets to tickers", () => {
    assert.equal(assetToTicker("SPX"), "SPY");
    assert.equal(assetToTicker("rates"), "TLT");
    assert.equal(assetToTicker("AAPL"), "AAPL");
    assert.equal(assetToTicker("nope blah"), null);
  });

  it("parses horizons", () => {
    assert.equal(horizonToDays("1w", "2026-01-01"), 7);
    assert.equal(horizonToDays("3m", "2026-01-01"), 90);
    assert.equal(horizonToDays("year-end", "2026-06-01"), horizonToDays("ye", "2026-06-01"));
    assert.ok((horizonToDays("year-end", "2026-06-01") ?? 0) > 100);
    assert.equal(horizonToDays(null, "2026-01-01"), null);
  });

  it("scores direction vs price move", () => {
    assert.equal(directionHit("bullish", 100, 110, "SPY"), true);
    assert.equal(directionHit("bearish", 100, 110, "SPY"), false);
    assert.equal(directionHit("hawkish", 100, 90, "TLT"), true);
    assert.equal(directionHit("dovish", 100, 110, "TLT"), true);
  });
});
