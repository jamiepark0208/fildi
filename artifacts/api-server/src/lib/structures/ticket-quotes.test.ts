import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cleanQuoteReqs, quoteFromChains } from "./ticket-quotes.js";
import type { OptionsChainResult } from "../options.js";

const row = (strike: number, bid: number, ask: number, iv = 0.5) =>
  ({ strike, bid, ask, iv, lastPrice: 0, volume: 0, openInterest: 0, incomePct: 0, meetsGate: true, bidIsLive: true, delta: null, spreadPct: null });
const chain = { ticker: "AAA", expiry: "2026-12-18", spot: 101, puts: [row(100, 2, 2.2), row(95, 0, 0.05)], calls: [row(105, 1, 1.1)] } as unknown as OptionsChainResult;

describe("ticket quotes", () => {
  it("cleans + caps requests", () => {
    const r = cleanQuoteReqs([
      { ticker: "aaa", kind: "put", strike: 100, expiry: "2026-12-18" },
      { ticker: "BAD!", kind: "put", strike: 1, expiry: "2026-12-18" },
      { ticker: "AAA", kind: "put", strike: -1, expiry: "2026-12-18" },
      { ticker: "AAA", kind: "call", strike: 100, expiry: "12/18" },
      { ticker: "AAA", kind: "stock" },
      { ticker: "AAA", kind: "future" },
    ]);
    assert.deepEqual(r.map((x) => `${x.ticker}:${x.kind}`), ["AAA:put", "AAA:stock"]);
    assert.equal(cleanQuoteReqs(Array(50).fill({ ticker: "A", kind: "stock" }), 40).length, 40);
    assert.deepEqual(cleanQuoteReqs("x"), []);
  });

  it("finds the row; one-sided market keeps the side it has", () => {
    const q = quoteFromChains([chain], { ticker: "AAA", kind: "put", strike: 100, expiry: "2026-12-18" }, null);
    assert.deepEqual([q.bid, q.ask, q.iv, q.spot, q.quoted], [2, 2.2, 0.5, 101, true]);
    const thin = quoteFromChains([chain], { ticker: "AAA", kind: "put", strike: 95, expiry: "2026-12-18" }, null);
    assert.deepEqual([thin.bid, thin.ask, thin.quoted], [null, 0.05, true]);
  });

  it("missing expiry / strike → unquoted with a reason", () => {
    assert.equal(quoteFromChains([chain], { ticker: "AAA", kind: "put", strike: 100, expiry: "2027-01-15" }, null).reason, "expiry not listed");
    assert.equal(quoteFromChains([chain], { ticker: "AAA", kind: "call", strike: 100, expiry: "2026-12-18" }, null).reason, "strike not listed");
  });

  it("stock leg = spot both sides", () => {
    const q = quoteFromChains([chain], { ticker: "AAA", kind: "stock" }, 99.5);
    assert.deepEqual([q.bid, q.ask, q.quoted], [99.5, 99.5, true]);
  });
});
