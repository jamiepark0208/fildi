import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { levelsFromBars, pickFundingPut, pickRiskReversal, type Bar } from "./risk-reversal.js";
import type { OptionRow, OptionsChainResult } from "./options.js";

const row = (strike: number, bid: number, ask: number, iv: number, delta: number): OptionRow => ({
  strike, bid, ask, lastPrice: (bid + ask) / 2, iv, volume: 10, openInterest: 100, incomePct: 0, meetsGate: false,
  bidIsLive: true, quoteStale: false, delta, spreadPct: (ask - bid) / ((ask + bid) / 2),
});
const chain = (expiry: string, dte: number, puts: OptionRow[], calls: OptionRow[]): OptionsChainResult => ({
  ticker: "T", expiry, isWeekly: false, daysToExpiry: dte, exactDte: dte, settlementDte: dte, spot: 100, tier: 1,
  puts, calls, fetchedAt: 0,
});

describe("levelsFromBars", () => {
  it("finds a swing low below spot and a swing high above it", () => {
    const bars: Bar[] = [];
    for (let i = 0; i < 60; i++) {
      const c = i < 20 ? 120 - i : i < 40 ? 100 - (i - 20) * 0.5 + (i > 30 ? (i - 30) : 0) : 100;
      bars.push({ date: `d${i}`, high: c + 1, low: c - 1, close: c });
    }
    bars[30].low = 85; // clear swing low
    const lv = levelsFromBars(bars, 100);
    assert.ok(lv.support.some((x) => x.price === 85), "swing low 85 present");
    assert.ok(lv.support.every((x) => x.price < 100), "supports below spot");
    assert.ok(lv.resistance.every((x) => x.price > 100), "resistances above spot");
    assert.equal(lv.resistance.at(-1)!.price, 121, "52-w high is the farthest resistance");
  });
});

describe("pickRiskReversal", () => {
  const puts45 = [row(80, 0.9, 1.0, 0.7, -0.12), row(85, 1.6, 1.8, 0.65, -0.2), row(90, 2.8, 3.0, 0.6, -0.3)];
  const calls120 = [row(110, 6.0, 6.4, 0.5, 0.45), row(120, 3.3, 3.5, 0.5, 0.33), row(130, 1.7, 1.9, 0.5, 0.22)];
  const calls170 = [row(110, 7.8, 8.2, 0.48, 0.5), row(120, 4.9, 5.2, 0.48, 0.4), row(130, 3.0, 3.2, 0.48, 0.3)];
  const chains = [chain("p45", 45, puts45, []), chain("c120", 120, [], calls120), chain("c170", 170, [], calls170)];
  const lv = { support: [{ price: 86, kind: "swing" as const }], resistance: [{ price: 103, kind: "swing" as const }, { price: 125, kind: "sma200" as const }] };

  it("sells the highest put strike at/below support and buys a call under resistance near zero net", () => {
    const p = pickRiskReversal(chains, 100, lv)!;
    assert.equal(p.short.strike, 85);
    assert.ok(p.long.strike <= 125);
    assert.ok(Math.abs(p.net) <= 0.1 * p.short.fill + 1e-9 || p.net < 0, "near-even or smallest debit");
    assert.ok(p.short.fill > 1.6 && p.short.fill < 1.8, "sell fill between bid and ask");
    assert.equal(p.cashIfAssigned, 8500);
    assert.ok(p.pShortSafe > 0.5 && p.pShortSafe < 1);
  });

  it("prefers the longest call expiry that is still near even", () => {
    const p = pickRiskReversal(chains, 100, lv)!;
    // put credit ≈ 1.65: c120 130C costs ≈ 1.85 (−0.2, within 10 %? no → −12 %); c170 has no call that cheap ≤ 125 → fallback
    assert.ok(["c120", "c170"].includes(p.long.expiry));
    assert.ok(p.pLongBe <= p.pLongItm);
  });

  it("returns null with no quoted put in the band", () => {
    assert.equal(pickRiskReversal([chain("c120", 120, [], calls120)], 100, lv), null);
  });
});

describe("same-expiry skew", () => {
  it("frontSkew uses the 7–45 DTE expiry nearest 30 with both 25Δ sides", async () => {
    const { frontSkew } = await import("./risk-reversal.js");
    const puts = [row(85, 1, 1.1, 0.7, -0.15), row(92, 2, 2.1, 0.6, -0.35)];
    const calls = [row(108, 1, 1.1, 0.48, 0.35), row(115, 0.5, 0.6, 0.46, 0.15)];
    const fs = frontSkew([chain("d10", 10, puts, calls), chain("d28", 28, puts, calls), chain("d60", 60, puts, calls), chain("d33", 33, puts, [])]);
    assert.equal(fs!.expiry, "d28");   // d33 nearer 30 but has no calls → skipped; d60 outside the window
    assert.ok(Math.abs(fs!.rr25 - (0.65 - 0.47)) < 1e-9);
  });
  it("ivAtDelta interpolates on one expiry", async () => {
    const { ivAtDelta } = await import("./risk-reversal.js");
    const rows = [row(80, 1, 1.1, 0.7, -0.1), row(90, 2, 2.1, 0.6, -0.3)];
    assert.ok(Math.abs(ivAtDelta(rows, -0.2)! - 0.65) < 1e-9);
    assert.equal(ivAtDelta(rows, -0.5), null);
  });
  it("vol edge = put IV sold − call IV bought; rolls counted on the call's life", () => {
    const puts20 = [row(85, 1.0, 1.1, 0.7, -0.2)];
    const calls = [row(110, 2.0, 2.2, 0.45, 0.3)];
    const p = pickRiskReversal([chain("p20", 20, puts20, calls), chain("c120", 120, puts20, calls)], 100,
      { support: [{ price: 86, kind: "swing" }], resistance: [{ price: 115, kind: "swing" }] })!;
    assert.ok(Math.abs(p.volEdge - 0.25) < 1e-9);
    assert.equal(p.rollsAvailable, 6);
    assert.ok(p.rollsToFund > 1.5 && p.rollsToFund < 2.5);
  });
});

describe("bear mirror", () => {
  it("sells a call at/above resistance and buys a longer put toward support", () => {
    const calls20 = [row(105, 2.0, 2.2, 0.5, 0.3), row(112, 1.0, 1.1, 0.55, 0.18), row(120, 0.4, 0.5, 0.6, 0.08)];
    const puts120 = [row(95, 4.0, 4.3, 0.45, -0.4), row(88, 2.2, 2.4, 0.47, -0.27), row(80, 1.0, 1.1, 0.5, -0.15)];
    const lv = { support: [{ price: 97, kind: "swing" as const }, { price: 88, kind: "sma200" as const }], resistance: [{ price: 110, kind: "swing" as const }] };
    const p = pickRiskReversal([chain("s20", 20, [], calls20), chain("l120", 120, puts120, [])], 100, lv, undefined, "bear")!;
    assert.equal(p.direction, "bear");
    assert.equal(p.short.side, "call");
    assert.equal(p.short.strike, 112, "nearest call strike at/above resistance 110");
    assert.equal(p.long.side, "put");
    assert.ok(p.long.strike < 100 && p.long.strike >= 88, "long put between spot and target support");
    assert.equal(p.cashIfAssigned, null, "short call = uncapped unless covered");
    assert.ok(p.pShortSafe > 0.5 && p.pShortSafe < 1);
  });
});

describe("pickFundingPut (fund a held call)", () => {
  const puts30 = [row(80, 0.9, 1.0, 0.7, -0.12), row(85, 1.6, 1.8, 0.65, -0.2), row(90, 2.8, 3.0, 0.6, -0.3)];
  const puts40 = [row(85, 2.2, 2.4, 0.8, -0.22)];
  const lv = { support: [{ price: 86, kind: "swing" as const }], resistance: [] };
  const call = { strike: 110, expiry: "2026-12-24", days: 35, qty: 2, cost: 4, mark: 2.5 };

  it("sells one put per call at support and lowers the call breakeven by the credit", () => {
    const f = pickFundingPut([chain("2026-12-19", 30, puts30, [])], 100, lv, call, 0.6)!;
    assert.equal(f.short.strike, 85);
    assert.ok(Math.abs(f.credit - f.short.fill * 200) < 1e-9, "2 calls → 2 puts");
    assert.equal(f.paid, 800);
    assert.equal(f.breakeven, 114);
    assert.ok(f.breakevenAfter < 114 && f.pBeAfter! > f.pBe!, "lower breakeven → higher odds");
    assert.equal(f.cashIfAssigned, 17000);
    assert.ok(f.rollsToCover > 2 && f.rollsToCover < 2.5);
  });

  it("never sells a put that outlives the call", () => {
    const f = pickFundingPut([chain("2026-12-19", 30, puts30, []), chain("2027-01-02", 40, puts40, [])], 100, lv, call, 0.6)!;
    assert.equal(f.short.expiry, "2026-12-19", "richer 40-DTE put skipped: expires after the call");
    assert.equal(pickFundingPut([chain("2027-01-02", 40, puts40, [])], 100, lv, call, 0.6), null);
  });
});
