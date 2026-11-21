import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyQuote } from "./trade-ticket-store.ts";
import type { TicketLeg } from "./trade-ticket.ts";

const leg = (p: Partial<TicketLeg>): TicketLeg => ({
  id: "a", ticker: "AAA", kind: "put", side: "short", qty: 1, strike: 100, expiry: "2026-12-18",
  price: 0, spot: 0, addedAt: 0, unquoted: "pricing…", ...p,
});
const q = (p: Record<string, unknown>) => ({ ticker: "AAA", kind: "put" as const, strike: 100, expiry: "2026-12-18",
  bid: 2, ask: 2.2, iv: 0.5, spot: 101, quoted: true, ...p });

describe("applyQuote", () => {
  it("sell fills at bid, buy at ask; clears unquoted", () => {
    const s = applyQuote(leg({}), q({}), 5);
    assert.deepEqual([s.price, s.spot, s.iv, s.quotedAt, s.unquoted], [2, 101, 0.5, 5, undefined]);
    assert.equal(applyQuote(leg({ side: "long" }), q({}), 5).price, 2.2);
  });
  it("missing side → stays unquoted, never a 0 price", () => {
    const s = applyQuote(leg({}), q({ bid: null }), 5);
    assert.equal(s.unquoted, "no bid");
    assert.equal(s.price, 0);
    assert.equal(applyQuote(leg({ side: "long" }), q({ ask: null }), 5).unquoted, "no ask");
  });
  it("no quote / server reason passes through", () => {
    assert.equal(applyQuote(leg({}), undefined, 5).unquoted, "no quote");
    assert.equal(applyQuote(leg({}), q({ quoted: false, reason: "expiry not listed" }), 5).unquoted, "expiry not listed");
  });
  it("stock leg prices at spot", () => {
    const s = applyQuote(leg({ kind: "stock", strike: undefined, expiry: undefined, side: "long", qty: 100 }),
      q({ kind: "stock", strike: undefined, expiry: undefined, bid: 50, ask: 50, iv: null, spot: 50 }), 5);
    assert.deepEqual([s.price, s.spot, s.unquoted], [50, 50, undefined]);
  });
});
