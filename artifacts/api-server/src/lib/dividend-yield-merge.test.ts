/**
 * A147 — Yahoo dividendYield=0 must lose to a positive Finnhub/FMP yield.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { skipYahooZeroDividend } from "./dividend-yield-merge.js";

describe("skipYahooZeroDividend", () => {
  const priority: [string, string][] = [
    ["yahoo", "dividendYield"],
    ["finnhub", "dividendYield"],
    ["fmp", "dividendYield"],
  ];

  it("skips Yahoo 0 when Finnhub has > 0.5%", () => {
    const byField = new Map([
      ["dividendYield", new Map([["yahoo", 0], ["finnhub", 0.032]])],
    ]);
    assert.equal(skipYahooZeroDividend("dividendYield", "yahoo", 0, byField, priority), true);
  });

  it("keeps Yahoo 0 when no other source has a real yield", () => {
    const byField = new Map([
      ["dividendYield", new Map([["yahoo", 0], ["finnhub", 0]])],
    ]);
    assert.equal(skipYahooZeroDividend("dividendYield", "yahoo", 0, byField, priority), false);
  });

  it("does not skip a positive Yahoo yield", () => {
    const byField = new Map([
      ["dividendYield", new Map([["yahoo", 0.02], ["finnhub", 0.03]])],
    ]);
    assert.equal(skipYahooZeroDividend("dividendYield", "yahoo", 0.02, byField, priority), false);
  });

  it("ignores other fields", () => {
    const byField = new Map([["peRatio", new Map([["yahoo", 0], ["finnhub", 12]])] ]);
    assert.equal(skipYahooZeroDividend("peRatio", "yahoo", 0, byField, [["yahoo", "peRatio"], ["finnhub", "peRatio"]]), false);
  });
});
