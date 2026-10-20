import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeTickerPnlRollup } from "./ticker-pnl.ts";

describe("computeTickerPnlRollup", () => {
  it("drops near-zero rows so Top Tickers empties after stats reset", () => {
    const rows = computeTickerPnlRollup(
      [],
      [
        { ticker: "AAA", status: "CLOSED", realizedPnl: 0, unrealizedPnl: null },
        { ticker: "BBB", status: "OPEN", realizedPnl: null, unrealizedPnl: 0 },
        { ticker: "CCC", status: "CLOSED", realizedPnl: 12, unrealizedPnl: null },
      ],
    );
    assert.deepEqual(rows.map((r) => r.ticker), ["CCC"]);
  });

  it("sums posts + holdings", () => {
    const rows = computeTickerPnlRollup(
      [{ ticker: "spy", status: "CLOSED", resolvedPnl: 10 }],
      [{ ticker: "SPY", status: "OPEN", realizedPnl: null, unrealizedPnl: 5 }],
    );
    assert.deepEqual(rows, [{ ticker: "SPY", realizedPnl: 10, unrealizedPnl: 5, totalPnl: 15 }]);
  });
});
