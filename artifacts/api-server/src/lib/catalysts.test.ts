import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  yahooEpochToMs,
  yahooEpochToDateStr,
  parseEarningsDate,
  buildCatalysts,
  buildCatalystItems,
  classifyAnalystLean,
  gradeLean,
  mergeCaseBullets,
} from "./catalysts.ts";

describe("yahooEpochToMs", () => {
  it("returns 0 for null/undefined", () => {
    assert.equal(yahooEpochToMs(null), 0);
    assert.equal(yahooEpochToMs(undefined), 0);
  });
  it("passes through ms epoch (> 1e12)", () => {
    assert.equal(yahooEpochToMs(1_700_000_000_000), 1_700_000_000_000);
  });
  it("converts seconds epoch to ms", () => {
    assert.equal(yahooEpochToMs(1_700_000_000), 1_700_000_000_000);
  });
  it("parses ISO string", () => {
    assert.equal(yahooEpochToMs("2024-01-15"), Date.parse("2024-01-15"));
  });
  it("accepts Date object", () => {
    const d = new Date("2024-06-01");
    assert.equal(yahooEpochToMs(d), d.getTime());
  });
});

describe("yahooEpochToDateStr", () => {
  it("returns null for falsy epoch", () => {
    assert.equal(yahooEpochToDateStr(null), null);
    assert.equal(yahooEpochToDateStr(0), null);
  });
  it("returns YYYY-MM-DD for valid seconds epoch", () => {
    const result = yahooEpochToDateStr(1_700_000_000);
    assert.match(result!, /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("parseEarningsDate", () => {
  it("prefers dbDate over Yahoo summary", () => {
    const summary = { calendarEvents: { earnings: { earningsDate: ["2024-12-01"] } } };
    assert.equal(parseEarningsDate(summary, "2025-03-15"), "2025-03-15");
  });
  it("falls back to Yahoo calendarEvents array", () => {
    const summary = { calendarEvents: { earnings: { earningsDate: ["2024-12-01T00:00:00Z"] } } };
    assert.equal(parseEarningsDate(summary, null), "2024-12-01");
  });
  it("returns null when no data", () => {
    assert.equal(parseEarningsDate(null, null), null);
    assert.equal(parseEarningsDate({}, null), null);
  });
  it("handles Date object in earningsDate array", () => {
    const d = new Date("2025-02-10");
    const summary = { calendarEvents: { earnings: { earningsDate: [d] } } };
    assert.equal(parseEarningsDate(summary, null), "2025-02-10");
  });
});

describe("classifyAnalystLean", () => {
  it("treats Buy→Neutral cut as bear", () => {
    assert.equal(classifyAnalystLean("down", "Neutral"), "bear");
    assert.equal(classifyAnalystLean("downgrade", "Neutral"), "bear");
  });
  it("treats upgrade as bull regardless of destination", () => {
    assert.equal(classifyAnalystLean("up", "Neutral"), "bull");
    assert.equal(classifyAnalystLean("upgrade", "Hold"), "bull");
  });
  it("classifies initiate by destination grade", () => {
    assert.equal(classifyAnalystLean("init", "Overweight"), "bull");
    assert.equal(classifyAnalystLean("initiate", "Underweight"), "bear");
    assert.equal(classifyAnalystLean("init", "Neutral"), "neutral");
  });
  it("gradeLean covers common Wall St labels", () => {
    assert.equal(gradeLean("Buy"), "bull");
    assert.equal(gradeLean("Overweight"), "bull");
    assert.equal(gradeLean("Sell"), "bear");
    assert.equal(gradeLean("Underweight"), "bear");
    assert.equal(gradeLean("Hold"), "neutral");
    assert.equal(gradeLean("Equal-Weight"), "neutral");
  });
});

describe("buildCatalysts / buildCatalystItems", () => {
  it("returns empty array when no inputs", () => {
    assert.deepEqual(buildCatalysts({ earningsDate: null, analystActions: [], news: [] }), []);
  });

  it("includes earnings within 14 days as urgent label", () => {
    const soon = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    const out = buildCatalysts({ earningsDate: soon, analystActions: [], news: [] });
    assert.ok(out[0]!.includes("Earnings in"), `expected urgent label, got: ${out[0]}`);
  });

  it("includes earnings 15-30 days out as date label", () => {
    const mid = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    const out = buildCatalysts({ earningsDate: mid, analystActions: [], news: [] });
    assert.ok(out[0]!.startsWith("Earnings on"), `expected date label, got: ${out[0]}`);
  });

  it("includes earnings > 30 days as 'Next earnings'", () => {
    const far = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
    const out = buildCatalysts({ earningsDate: far, analystActions: [], news: [] });
    assert.ok(out[0]!.startsWith("Next earnings"), `got: ${out[0]}`);
  });

  it("omits past earnings dates", () => {
    const past = "2020-01-01";
    const out = buildCatalysts({ earningsDate: past, analystActions: [], news: [] });
    assert.equal(out.length, 0);
  });

  it("marks GS Buy→Neutral cut as bear item", () => {
    const recent = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    const items = buildCatalystItems({
      earningsDate: null,
      analystActions: [{
        firm: "Goldman Sachs",
        toGrade: "Neutral",
        fromGrade: "Buy",
        action: "down",
        date: recent,
      }],
      news: [],
    });
    assert.equal(items.length, 1);
    assert.equal(items[0]!.lean, "bear");
    assert.match(items[0]!.text, /Goldman Sachs cut from Buy to Neutral/);
  });

  it("includes upgrade analyst action within 90 days as bull", () => {
    const recent = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    const items = buildCatalystItems({
      earningsDate: null,
      analystActions: [{ firm: "GS", toGrade: "Buy", fromGrade: "Neutral", action: "up", date: recent }],
      news: [],
    });
    assert.equal(items[0]!.lean, "bull");
    assert.ok(items[0]!.text.includes("upgraded"), `got: ${items[0]!.text}`);
  });

  it("omits downgrade older than 90 days", () => {
    const old = new Date(Date.now() - 100 * 86400000).toISOString().slice(0, 10);
    const out = buildCatalysts({
      earningsDate: null,
      analystActions: [{ firm: "MS", toGrade: "Sell", fromGrade: "Hold", action: "down", date: old }],
      news: [],
    });
    assert.equal(out.length, 0);
  });

  it("filters news to event keywords; bankruptcy leans bear", () => {
    const items = buildCatalystItems({
      earningsDate: null,
      analystActions: [],
      news: [
        { title: "FDA approves new drug trial", publishedAt: null },
        { title: "CEO attends conference", publishedAt: null },
        { title: "Company files for bankruptcy protection", publishedAt: null },
      ],
    });
    assert.equal(items.length, 2);
    assert.equal(items.find(i => /FDA/.test(i.text))!.lean, "neutral");
    assert.equal(items.find(i => /bankruptcy/.test(i.text))!.lean, "bear");
  });

  it("caps total output at 6", () => {
    const soon = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    const recent = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    const out = buildCatalysts({
      earningsDate: soon,
      analystActions: [
        { firm: "A", toGrade: "Buy", fromGrade: "", action: "up", date: recent },
        { firm: "B", toGrade: "Buy", fromGrade: "", action: "init", date: recent },
        { firm: "C", toGrade: "Hold", fromGrade: "Buy", action: "down", date: recent },
      ],
      news: [
        { title: "Earnings beat guidance expectations", publishedAt: null },
        { title: "FDA approval for merger settlement", publishedAt: null },
        { title: "Dividend split announcement bankruptcy risk", publishedAt: null },
      ],
    });
    assert.ok(out.length <= 6, `expected ≤6, got ${out.length}`);
  });

  it("mergeCaseBullets prefers catalyst line and skips same-firm event bullet", () => {
    const merged = mergeCaseBullets(
      ["Goldman Sachs cut from Buy to Neutral (2026-10-01)"],
      ["Goldman Sachs downgraded AEP from Buy to Neutral"],
    );
    assert.equal(merged.length, 1);
    assert.match(merged[0]!, /cut from Buy/);
  });
});
