import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pollStartMsForSymbol } from "./schwab-1m-window.js";

describe("pollStartMsForSymbol", () => {
  it("rewinds two bars from last stored ts", () => {
    const end = 1_000_000;
    const start = pollStartMsForSymbol("SPY", end, end - 60_000);
    assert.equal(start, end - 60_000 - 2 * 60_000);
  });
  it("fills a gap longer than the live lookback (outage / overnight)", () => {
    const end = 10 * 24 * 60 * 60 * 1000;
    const last = end - 5 * 60 * 60 * 1000; // 5 h ago
    assert.equal(pollStartMsForSymbol("SPY", end, last), last - 2 * 60_000);
  });
});
