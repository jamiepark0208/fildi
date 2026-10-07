import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chainHistoryRows } from "./option-chain-history.ts";
import type { OptionsChainResult, OptionRow } from "./options.ts";

const row = (strike: number, bid: number, live = true): OptionRow => ({
  strike, bid, ask: bid + 0.05, lastPrice: bid, iv: 0.5, volume: 10, openInterest: 100, incomePct: 0, meetsGate: true,
  bidIsLive: live, quoteStale: !live, delta: -0.2, spreadPct: null,
});
const chain = (puts: OptionRow[], calls: OptionRow[]): OptionsChainResult => ({
  ticker: "ABC", expiry: "2026-10-16", isWeekly: true, daysToExpiry: 10, exactDte: 10, settlementDte: 10, spot: 100, tier: 1,
  puts, calls, fetchedAt: 0, source: "schwab",
});

describe("chainHistoryRows", () => {
  it("keeps OTM strikes 1–35% away with a live bid", () => {
    const rows = chainHistoryRows("abc", [chain(
      [row(99.5, 1), row(90, 0.5), row(60, 0.01), row(85, 0), row(95, 0.4, false), row(105, 6)],
      [row(110, 0.3), row(100.5, 1)],
    )], "2026-10-06");
    assert.deepEqual(rows.map((r) => `${r.side}${r.strike}`), ["put90", "call110"]);
    assert.equal(rows[0]!.ticker, "ABC");
    assert.equal(rows[0]!.source, "schwab");
  });
});
