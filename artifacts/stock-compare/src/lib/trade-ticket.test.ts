import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bsPrice, legPnl, netCost, ticketCurve, ticketSummary, expiryMs, dollarDeltaPer1Pct, type TicketLeg,
} from "./trade-ticket.ts";

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

describe("trade-ticket multi-stock bounds", () => {
  it("max loss reaches the low-beta name's zero, not just the high-beta one", () => {
    const hi = leg({ ticker: "HI", kind: "put", side: "short", strike: 100, price: 1 });
    const lo = leg({ ticker: "LO", kind: "put", side: "short", strike: 100, price: 1 });
    const s = ticketSummary([hi, lo], { HI: 3, LO: 0.5 }, NOW);
    assert.ok((s.maxLoss ?? 0) < -19_000, String(s.maxLoss)); // both puts ~fully ITM
  });
});
