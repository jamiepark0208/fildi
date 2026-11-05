import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseYahooMostRecentQuarter,
  pickSharesByStatementDate,
  yahooMostRecentQuarterFromPayload,
} from "../lib/shares-gold-pick.js";

describe("merge-trusted seg3 shares", () => {
  it("parseYahooMostRecentQuarter handles epoch seconds", () => {
    const d = parseYahooMostRecentQuarter("1704067200");
    assert.ok(d?.startsWith("2024"));
  });

  it("yahooMostRecentQuarterFromPayload prefers defaultKeyStatistics", () => {
    const d = yahooMostRecentQuarterFromPayload({
      defaultKeyStatistics: { mostRecentQuarter: "1704067200" },
      financialData: {},
    });
    assert.ok(d?.startsWith("2024"));
  });

  it("pickSharesByStatementDate prefers newer statement end", () => {
    const pulled = new Map<string, number>([
      ["yahoo", Date.parse("2024-06-01T12:00:00Z")],
      ["edgar", Date.parse("2024-10-01T12:00:00Z")],
    ]);
    const picked = pickSharesByStatementDate(
      [
        { src: "yahoo", val: 1e9 },
        { src: "edgar", val: 9.5e8 },
      ],
      pulled,
      "2024-06-30",
    );
    assert.equal(picked.src, "edgar");
  });
});
