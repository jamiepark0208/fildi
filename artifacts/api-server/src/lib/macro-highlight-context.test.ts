import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  dedupeHeadlines,
  normalizeHeadlineTitle,
  parseMacroHighlightsPayload,
  fallbackHighlightsPayload,
  type NewsHeadline,
} from "./macro-highlight-utils.ts";
import {
  getEventsForDate,
  getEventsThisWeek,
  getUnifiedMacroEvents,
} from "./macro-data.ts";

describe("normalizeHeadlineTitle", () => {
  it("lowercases and strips punctuation", () => {
    assert.equal(
      normalizeHeadlineTitle("S&P 500 Rises on FOMC News!"),
      "s p 500 rises on fomc news",
    );
  });
});

describe("dedupeHeadlines", () => {
  it("removes near-duplicate titles", () => {
    const input: NewsHeadline[] = [
      {
        title: "Stock market rises on Fed decision",
        url: "https://a.com",
        source: "A",
        publishedAt: "",
      },
      {
        title: "Stock Market Rises on Fed Decision",
        url: "https://b.com",
        source: "B",
        publishedAt: "",
      },
      {
        title: "Oil prices slip as demand worries grow",
        url: "https://c.com",
        source: "C",
        publishedAt: "",
      },
    ];
    const out = dedupeHeadlines(input);
    assert.equal(out.length, 2);
    assert.equal(out[0].title, input[0].title);
    assert.equal(out[1].title, input[2].title);
  });

  it("drops very short titles", () => {
    const out = dedupeHeadlines([
      { title: "Short", url: "x", source: "X", publishedAt: "" },
    ]);
    assert.equal(out.length, 0);
  });
});

describe("parseMacroHighlightsPayload", () => {
  it("accepts valid payload", () => {
    const payload = {
      generatedAt: new Date().toISOString(),
      marketDate: "2026-06-16",
      headline: "Stocks flat ahead of FOMC",
      eventsToday: [
        { date: "2026-06-16", event: "FOMC Meeting Day 1", importance: "high" as const },
      ],
      bullets: [
        {
          id: "1",
          category: "event" as const,
          title: "FOMC",
          body: "Day one of June meeting.",
        },
      ],
      watchlistMovers: [{ ticker: "HOOD", changePct: 5.2, blurb: "Crypto headline" }],
    };
    assert.ok(parseMacroHighlightsPayload(payload));
  });

  it("rejects invalid category", () => {
    const bad = {
      generatedAt: new Date().toISOString(),
      marketDate: "2026-06-16",
      headline: "x",
      eventsToday: [],
      bullets: [{ id: "1", category: "invalid", title: "t", body: "b" }],
      watchlistMovers: [],
    };
    assert.equal(parseMacroHighlightsPayload(bad), null);
  });
});

describe("fallbackHighlightsPayload", () => {
  it("returns error bullet", () => {
    const fb = fallbackHighlightsPayload("2026-06-16", "test error");
    assert.equal(fb.marketDate, "2026-06-16");
    assert.equal(fb.bullets[0].category, "tape");
    assert.match(fb.bullets[0].body, /test error/);
  });
});

describe("unified macro calendar", () => {
  it("includes FOMC from schedule not stale Jun 11-12", () => {
    const all = getUnifiedMacroEvents();
    assert.ok(!all.some((e) => e.date === "2026-06-11" && e.event.includes("FOMC")));
    assert.ok(all.some((e) => e.date === "2026-06-18" && e.event.includes("FOMC")));
  });

  it("getEventsForDate returns today matches only", () => {
    const jun18 = getEventsForDate("2026-06-18");
    assert.ok(jun18.some((e) => e.event.includes("FOMC Rate Decision")));
  });

  it("getEventsThisWeek spans 7 days", () => {
    const week = getEventsThisWeek("2026-06-16");
    assert.ok(week.every((e) => e.date >= "2026-06-16" && e.date <= "2026-06-23"));
    assert.ok(week.length > 0);
  });
});
