import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSections } from "./daily-news-parse.ts";

describe("parseSections", () => {
  it("parses bare **Catalyst** lines (no leading dash) — was empty-box bug", () => {
    const md = `## Overnight / Macro

**Oil weakness extends; WTI down 1.9% to $87.76** — Gulf flow recovery.

**Treasury futures volatility ahead** — Yield regime under pressure.

## Sector & tickers

**GOOGL — Wells Fargo maintain Overweight (2026-10-06).** Book watch.

## Put-seller takeaway

S&P 500 +0.58%, Nasdaq ATH; equity bias elevated into week.`;
    const secs = parseSections(md);
    assert.equal(secs.length, 3);
    assert.equal(secs[0]!.title, "Overnight / Macro");
    assert.equal(secs[0]!.bullets.length, 2);
    assert.match(secs[0]!.bullets[0]!, /WTI/);
    assert.ok(secs.find((s) => s.title === "Put-seller takeaway")?.bullets.length);
  });

  it("parses markdown dash bullets", () => {
    const md = `## Overnight / Macro
- **ES +0.30%** — risk-on into open.
- **10Y ~5.27%** — rates still elevated.`;
    const secs = parseSections(md);
    assert.equal(secs[0]!.bullets.length, 2);
  });

  it("drops empty headings", () => {
    const md = `## Overnight / Macro

## Sector & tickers
- **NFLX earnings 2026-10-20** — IV watch.`;
    const secs = parseSections(md);
    assert.equal(secs.length, 1);
    assert.equal(secs[0]!.title, "Sector & tickers");
  });
});
