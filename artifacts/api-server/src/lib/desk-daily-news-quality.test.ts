import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assessDailyNewsQuality,
  sanitizeDailyNewsContent,
} from "./desk-daily-news-quality.ts";

describe("desk-daily-news-quality", () => {
  it("rejects TipRanks count-teaser commentary", () => {
    const bad = `## Sector & tickers
**SPCX, GOOGL, CRWV each drew 1 new analyst rating today.** Monitor TipRanks for PT/rating direction.

## Put-seller takeaway
Stay the course.`;
    const q = assessDailyNewsQuality(bad);
    assert.equal(q.ok, false);
    assert.ok(q.reasons.some((r) => /TipRanks|substantive/i.test(r)));
  });

  it("accepts firm/grade + macro levels", () => {
    const good = `## Overnight / Macro
- **S&P futures +0.30%; 10Y yield >5.3%.** Risk-on into cash open.
- **WTI −1.9% to $87.76.** Energy vol moderates.

## Sector & tickers
- **GOOGL — Wells Fargo maintain Overweight (2026-10-06).** Book watch.

## Put-seller takeaway
- Mild risk-on favors short premium; rates drag reinvestment.`;
    assert.equal(assessDailyNewsQuality(good).ok, true);
  });

  it("rejects empty Overnight section", () => {
    const bad = `## Overnight / Macro

## Put-seller takeaway
- Stay light.`;
    const q = assessDailyNewsQuality(bad);
    assert.equal(q.ok, false);
    assert.ok(q.reasons.some((r) => /empty|substantive|short/i.test(r)));
  });

  it("sanitize strips shallow bullets", () => {
    const raw = `## Overnight / Macro
**WTI down 1.9% to $87.76.**

## Sector & tickers
**SPCX drew 1 new analyst rating today.** Monitor TipRanks.

## Put-seller takeaway
Vol compressed.`;
    const out = sanitizeDailyNewsContent(raw);
    assert.match(out, /WTI/);
    assert.doesNotMatch(out, /1 new analyst rating/);
    assert.doesNotMatch(out, /Monitor TipRanks/);
  });

  it("allows ## Muse levels alongside Desk adds (A301)", () => {
    const good = `## Muse levels
- S&P futures ~6770 (+0.2%)

## Desk adds
- **GS raises NVDA PT to $200 (2026-10-28).** Book watch.

## Sector & tickers
- **NVDA — Goldman raise.**

## Put-seller takeaway
- **NVDA: no model contract** (see strip).`;
    assert.equal(assessDailyNewsQuality(good).ok, true);
  });

  it("still rejects pasted Morning market brief title", () => {
    const bad = `# Morning market brief
## Desk adds
- **S&P +0.2%.** Foo.

## Put-seller takeaway
- Stay light.`;
    const q = assessDailyNewsQuality(bad);
    assert.equal(q.ok, false);
    assert.ok(q.reasons.some((r) => /Muse|banner|title|paraphrase/i.test(r)));
  });
});

