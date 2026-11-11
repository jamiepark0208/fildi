import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarize, type CongressRow } from "./congress.js";

const row = (type: CongressRow["type"], disclosedDate: string, lo: number, hi: number, member = "A"): CongressRow => ({
  chamber: "house", symbol: "X", member, district: null, owner: null, txnDate: null, disclosedDate, lagDays: 30, type,
  rawType: null, amountLo: lo, amountHi: hi, amountText: null, assetType: null, link: null,
});

describe("congress summarize", () => {
  const today = new Date("2026-11-10T00:00:00Z");
  it("uses range midpoints, windows by disclosure date, nets buys minus sells", () => {
    const w = summarize([
      row("buy", "2026-11-01", 1001, 15000), row("sell", "2026-10-20", 15001, 50000, "B"), row("buy", "2026-03-01", 1001, 15000),
    ], 90, today);
    assert.equal(w.buys, 1); assert.equal(w.sells, 1); assert.equal(w.buyUsd, 8000.5); assert.equal(w.sellUsd, 32500.5);
    assert.equal(w.netUsd, 8000.5 - 32500.5); assert.equal(w.members, 2);
  });
  it("ignores exchange rows", () => {
    assert.equal(summarize([row("exchange", "2026-11-01", 1, 2)], 90, today).members, 0);
  });
});
