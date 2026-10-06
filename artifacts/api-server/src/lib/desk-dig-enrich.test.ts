import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recentActionsFromYahooRaw } from "./desk-dig-enrich.ts";

describe("desk-dig-enrich", () => {
  it("filters Yahoo raw history by sinceDate without firm dedupe", () => {
    const raw = [
      { firm: "Wells Fargo", action: "main", fromGrade: "Overweight", toGrade: "Overweight", epochGradeDate: Math.floor(Date.parse("2026-10-06T12:00:00Z") / 1000) },
      { firm: "Old Firm", action: "up", fromGrade: "Hold", toGrade: "Buy", epochGradeDate: Math.floor(Date.parse("2026-09-01T12:00:00Z") / 1000) },
      { firm: "Freedom Capital Markets", action: "main", fromGrade: "Buy", toGrade: "Buy", epochGradeDate: Math.floor(Date.parse("2026-10-05T12:00:00Z") / 1000) },
    ];
    const recent = recentActionsFromYahooRaw(raw, "2026-10-05");
    assert.deepEqual(recent.map((r) => r.firm), ["Wells Fargo", "Freedom Capital Markets"]);
    assert.equal(recent[0]!.date, "2026-10-06");
  });
});
