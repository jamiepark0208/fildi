import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatMediaSourceFact,
  mediaSentimentInterpretation,
  sourceFactsBlock,
} from "./explain-source-facts.js";

describe("explain-source-facts formatters", () => {
  it("thin sample → thin sample, ignore", () => {
    assert.equal(mediaSentimentInterpretation(50, true, 3), "thin sample, ignore");
    const line = formatMediaSourceFact("StockTwits", "2026-11-05", 0.33, { thin: true, pct: 12 }, 3);
    assert.match(line, /thin sample/);
    assert.match(line, /thin sample, ignore/);
  });

  it("p12 → cautious vs peers", () => {
    const line = formatMediaSourceFact("StockTwits", "2026-11-05", 0.3, { thin: false, pct: 12 }, 19);
    assert.match(line, /p12/);
    assert.match(line, /cautious vs peers, n 19/);
  });

  it("empty facts → block omitted", () => {
    assert.equal(sourceFactsBlock(undefined), "");
    assert.equal(sourceFactsBlock([]), "");
  });

  it("non-empty facts → bullet block", () => {
    const b = sourceFactsBlock(["Street 11-05: neutral — tone neutral; context, not a signal"]);
    assert.match(b, /Desk data sources/);
    assert.match(b, /^- Street/m);
  });
});
