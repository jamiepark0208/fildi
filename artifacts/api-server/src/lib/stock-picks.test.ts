import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  coerceStockPicks,
  normalizeTickerList,
  parseStockPicksPatch,
  MAX_PICKS_PER_STANCE,
} from "./stock-picks.ts";

describe("normalizeTickerList", () => {
  it("uppercases and dedupes", () => {
    assert.deepEqual(normalizeTickerList(["nvda", "NVDA", "aapl"]), ["NVDA", "AAPL"]);
  });

  it("rejects more than max", () => {
    const six = ["A", "B", "C", "D", "E", "F"];
    assert.equal(normalizeTickerList(six), null);
  });

  it("rejects invalid ticker", () => {
    assert.equal(normalizeTickerList(["123"]), null);
  });
});

describe("parseStockPicksPatch", () => {
  const current = { bullish: ["NVDA"], neutral: [], bearish: [] };

  it("merges partial patch", () => {
    const r = parseStockPicksPatch({ bearish: ["TSLA"] }, current);
    assert.ok(!("error" in r));
    if (!("error" in r)) {
      assert.deepEqual(r.picks.bullish, ["NVDA"]);
      assert.deepEqual(r.picks.bearish, ["TSLA"]);
    }
  });

  it("returns error for invalid list", () => {
    const r = parseStockPicksPatch({ neutral: ["!!!"] }, current);
    assert.ok("error" in r);
  });

  it("enforces max per stance", () => {
    const r = parseStockPicksPatch(
      { bullish: ["A", "B", "C", "D", "E", "F"] },
      current,
    );
    assert.ok("error" in r);
    assert.match((r as { error: string }).error, new RegExp(String(MAX_PICKS_PER_STANCE)));
  });
});

describe("coerceStockPicks", () => {
  it("defaults invalid input", () => {
    assert.deepEqual(coerceStockPicks(null), {
      bullish: [],
      neutral: [],
      bearish: [],
    });
  });
});
