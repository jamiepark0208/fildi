import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bsPrice, legPnl, netCost, ticketCurve, ticketSummary, expiryMs, dollarDeltaPer1Pct, popMonteCarlo, pricedLegs,
  orderTickets, orderText, alignSpots, type TicketLeg,
} from "./trade-ticket.ts";
import { normCdf } from "./prob-cone.ts";

const EXP = "2026-12-18";
const AT = expiryMs(EXP);
const NOW = AT - 30 * 86_400_000;
const leg = (p: Partial<TicketLeg>): TicketLeg => ({
  id: Math.random().toString(36), ticker: "AAA", kind: "call", side: "long", qty: 1, strike: 100,
  expiry: EXP, price: 2, iv: 0.4, spot: 100, addedAt: 0, ...p,
});

describe("trade-ticket payoff", () => {
  it("long call: −premium below strike, intrinsic − premium above", () => {
    const l = leg({});
    assert.equal(legPnl(l, 90, AT), -200);
    assert.equal(legPnl(l, 110, AT), 800);
  });

  it("short put credit counts negative cost; BE = strike − credit", () => {
    const l = leg({ kind: "put", side: "short", price: 3 });
    assert.equal(netCost([l]), -300);
    const s = ticketSummary([l], {}, NOW);
    assert.equal(s.breakevens.length, 1);
    assert.ok(Math.abs(s.breakevens[0] - -0.03) < 0.002, String(s.breakevens[0]));
    assert.ok(Math.abs((s.maxGain ?? 0) - 300) < 1e-6);
    assert.ok(Math.abs((s.maxLoss ?? 0) - -9700) < 5); // floored at $0.01 spot
  });

  it("long call max gain unbounded, short call max loss unbounded", () => {
    assert.equal(ticketSummary([leg({})], {}, NOW).maxGain, null);
    assert.equal(ticketSummary([leg({ side: "short" })], {}, NOW).maxLoss, null);
  });

  it("bull call spread is bounded both ways", () => {
    const s = ticketSummary([leg({ strike: 100, price: 4 }), leg({ strike: 110, side: "short", price: 1 })], {}, NOW);
    assert.ok(Math.abs((s.maxGain ?? 0) - 700) < 1e-6);
    assert.ok(Math.abs((s.maxLoss ?? 0) - -300) < 1e-6);
  });

  it("two tickers: beta scales each name's move; byTicker sums to total", () => {
    const a = leg({ ticker: "AAA", kind: "stock", price: 100, spot: 100, strike: undefined, expiry: undefined });
    const b = leg({ ticker: "BBB", kind: "stock", price: 50, spot: 50, strike: undefined, expiry: undefined, side: "short" });
    const [p] = ticketCurve([a, b], [0.1], AT, { AAA: 2, BBB: 1 });
    assert.ok(Math.abs(p.byTicker.AAA - 20) < 1e-9);   // 100 × 2 × 10 %
    assert.ok(Math.abs(p.byTicker.BBB - -5) < 1e-9);   // short 50 × 10 %
    assert.ok(Math.abs(p.total - 15) < 1e-9);
  });

  it("before expiry a later-dated leg keeps time value (calendar)", () => {
    const near = leg({ side: "short", price: 2 });
    const far = leg({ expiry: "2027-01-15", price: 4 });
    const [p] = ticketCurve([near, far], [0], AT);
    assert.ok(p.byTicker.AAA > -200 && p.byTicker.AAA < 300, String(p.byTicker.AAA));
  });

  it("BS put-call parity at r = 0", () => {
    const c = bsPrice("call", 100, 95, 0.3, 0.25), p = bsPrice("put", 100, 95, 0.3, 0.25);
    assert.ok(Math.abs(c - p - 5) < 1e-4);
  });

  it("dollar delta of 100 shares ≈ $ per 1 %", () => {
    const s = leg({ kind: "stock", price: 100, strike: undefined, expiry: undefined });
    assert.ok(Math.abs(dollarDeltaPer1Pct([s], {}, NOW) - 1) < 1e-9);
    assert.ok(Math.abs(dollarDeltaPer1Pct([s], { AAA: 2 }, NOW) - 2) < 1e-9);
  });
});

describe("trade-ticket POP + orders", () => {
  it("short put POP ≈ lognormal P(S_T > K − credit)", () => {
    const l = leg({ kind: "put", side: "short", price: 3, iv: 0.4 });
    const r = popMonteCarlo([l], {}, 0.2, NOW, 20_000)!;
    const T = 30 / 365, sd = 0.4 * Math.sqrt(T), be = 97;
    const want = normCdf((Math.log(100 / be) - 0.5 * sd * sd) / sd);
    assert.ok(Math.abs(r.pop - want) < 0.015, `${r.pop} vs ${want}`);
    assert.ok(Math.abs(r.horizonDays - 30) < 1e-6);
  });

  it("long stock + short same stock = no P&L → POP 0, EV 0", () => {
    const a = leg({ kind: "put", side: "long", price: 2 }), b = leg({ kind: "put", side: "short", price: 2 });
    const r = popMonteCarlo([a, b], {}, 0.2, NOW)!;
    assert.equal(r.pop, 0);
    assert.ok(Math.abs(r.ev) < 1e-9);
  });

  it("perfectly hedged pair across names (β 1, no idio) nets ~0 spread of outcomes", () => {
    // Stock-only names get σ = |β|·σm → all systematic; long A / short B same $ → P&L ≈ 0 every path.
    const a = leg({ ticker: "A", kind: "call", side: "long", strike: 100, price: 2, iv: 0.2 });
    const b = leg({ ticker: "B", kind: "call", side: "short", strike: 100, price: 2, iv: 0.2 });
    const r = popMonteCarlo([a, b], { A: 1, B: 1 }, 0.2, NOW)!;
    assert.ok(Math.abs(r.ev) < 1, String(r.ev));
  });

  it("unquoted legs are left out; expired / stock-only → null", () => {
    const u = leg({ unquoted: "no market" });
    assert.equal(popMonteCarlo([u], {}, 0.2, NOW), null);
    assert.equal(popMonteCarlo([leg({ expiry: "2020-01-17" })], {}, 0.2, NOW), null);
    assert.equal(pricedLegs([u, leg({})]).length, 1);
  });

  it("orders: one per name, shares separate, ratio by gcd, ≤ 4 legs each", () => {
    const o = orderTickets([
      leg({ side: "short", qty: 2, strike: 95, kind: "put", price: 1.5 }),
      leg({ side: "long", qty: 2, strike: 90, kind: "put", price: 0.5 }),
      leg({ kind: "stock", qty: 100, price: 100, strike: undefined, expiry: undefined }),
      leg({ ticker: "B", qty: 1, price: 1 }), leg({ ticker: "B", qty: 1, strike: 105, price: 1 }),
      leg({ ticker: "B", qty: 1, strike: 110, price: 1 }), leg({ ticker: "B", qty: 1, strike: 115, price: 1 }),
      leg({ ticker: "B", qty: 1, strike: 120, price: 1 }),
    ]);
    assert.deepEqual(o.map((x) => `${x.ticker}:${x.kind}:${x.quantity}:${x.lines.length}`),
      ["AAA:stock:100:1", "AAA:options:2:2", "B:options:1:4", "B:options:1:1"]);
    assert.ok(Math.abs(o[1].limit - -1) < 1e-9); // 1.5 credit − 0.5 debit per spread
    assert.match(orderText(o[1]), /credit/);
  });
});

describe("alignSpots", () => {
  it("every leg of a name takes the latest-quoted spot; other names untouched", () => {
    const out = alignSpots([
      leg({ spot: 11.87, quotedAt: 1 }), leg({ kind: "stock", spot: 12.27, price: 12.27, quotedAt: 2 }),
      leg({ ticker: "B", spot: 50, quotedAt: 9 }),
    ]);
    assert.deepEqual(out.map((l) => l.spot), [12.27, 12.27, 50]);
    assert.equal(out[0].price, 2); // fill untouched
  });
});

describe("trade-ticket multi-stock bounds", () => {
  it("max loss reaches the low-beta name's zero, not just the high-beta one", () => {
    const hi = leg({ ticker: "HI", kind: "put", side: "short", strike: 100, price: 1 });
    const lo = leg({ ticker: "LO", kind: "put", side: "short", strike: 100, price: 1 });
    const s = ticketSummary([hi, lo], { HI: 3, LO: 0.5 }, NOW);
    assert.ok((s.maxLoss ?? 0) < -19_000, String(s.maxLoss)); // both puts ~fully ITM
  });
});
