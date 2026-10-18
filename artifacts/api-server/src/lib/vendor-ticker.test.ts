import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { schwabSymbol, yahooSymbol } from "./vendor-ticker.ts";

describe("vendor-ticker (A87)", () => {
  it("maps dotted Berkshire / Brown-Forman for Yahoo and Schwab", () => {
    assert.equal(yahooSymbol("BRK.B"), "BRK-B");
    assert.equal(yahooSymbol("bf.b"), "BF-B");
    assert.equal(schwabSymbol("BRK.B"), "BRK/B");
    assert.equal(schwabSymbol("BF.B"), "BF/B");
  });
  it("leaves plain tickers unchanged (aside from case)", () => {
    assert.equal(yahooSymbol("AAPL"), "AAPL");
    assert.equal(schwabSymbol("AAPL"), "AAPL");
  });
});
