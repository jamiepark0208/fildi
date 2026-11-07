import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  putCallParityError,
  priceStructure,
  payoffAtSpot,
  type ChainContext,
  type Leg,
  OPTION_MULT,
  priceLegs,
  DEFAULT_RISK_FREE,
} from "./legs.js";
import { buildTemplate } from "./templates.js";
import type { OptionsChainResult } from "../options.js";

function synthChain(spot: number, expiry: string, dte: number): OptionsChainResult {
  const strikes = [spot - 10, spot - 5, spot, spot + 5, spot + 10];
  const row = (K: number, delta: number, iv: number) => ({
    strike: K,
    bid: 1,
    ask: 1.2,
    lastPrice: 1.1,
    iv,
    volume: 10,
    openInterest: 100,
    incomePct: 0,
    meetsGate: true,
    bidIsLive: true,
    quoteStale: false,
    delta,
    spreadPct: 0.1,
  });
  return {
    ticker: "TEST",
    expiry,
    isWeekly: false,
    daysToExpiry: dte,
    exactDte: dte,
    settlementDte: dte,
    spot,
    tier: 1,
    puts: strikes.map((K, i) => row(K, -0.5 + i * 0.1, 0.3)),
    calls: strikes.map((K, i) => row(K, 0.5 - i * 0.1, 0.3)),
    fetchedAt: Date.now(),
  };
}

describe("legs — put-call parity", () => {
  it("|C−P−(S−K·e^{-rT})| < 0.01", () => {
    const err = putCallParityError(100, 100, 0.5, 0.05, 0.25);
    assert.ok(Math.abs(err) < 0.01, `parity err=${err}`);
  });
});

describe("legs — CSP", () => {
  it("payoff matches short put", () => {
    const chain = synthChain(100, "2026-12-19", 40);
    const legs: Leg[] = [{ kind: "put", side: "short", qty: 1, strike: 95, expiry: chain.expiry }];
    const ctx: ChainContext = { spot: 100, chains: [chain] };
    const { netFill } = priceLegs(legs, ctx);
    assert.ok(netFill > 0, "credit");
    const at90 = payoffAtSpot(legs, ctx, 90, netFill, true);
    const at100 = payoffAtSpot(legs, ctx, 100, netFill, true);
    assert.ok(at90 < at100, "deeper ITM hurts short put");
    assert.ok(Math.abs(at100 - netFill) < 1, "OTM ≈ keep credit");
  });
});

describe("legs — iron condor max loss", () => {
  it("max loss ≈ width − credit", () => {
    const spot = 100;
    const chain = synthChain(spot, "2026-12-19", 30);
    const width = 5;
    const legs: Leg[] = [
      { kind: "put", side: "short", qty: 1, strike: 95, expiry: chain.expiry },
      { kind: "put", side: "long", qty: 1, strike: 90, expiry: chain.expiry },
      { kind: "call", side: "short", qty: 1, strike: 105, expiry: chain.expiry },
      { kind: "call", side: "long", qty: 1, strike: 110, expiry: chain.expiry },
    ];
    const ctx: ChainContext = { spot, chains: [chain] };
    const priced = priceStructure(legs, ctx);
    const credit = priced.netFill;
    const expectedMax = width * OPTION_MULT - credit;
    assert.ok(Math.abs(priced.maxLoss - expectedMax) < width * OPTION_MULT * 0.15 + 50,
      `maxLoss=${priced.maxLoss} vs ${expectedMax}`);
  });
});

describe("legs — calendar at front expiry", () => {
  it("value vs hand calc", () => {
    const spot = 100;
    const front = synthChain(spot, "2026-01-16", 7);
    const back = synthChain(spot, "2026-02-20", 35);
    const K = 100;
    const legs: Leg[] = [
      { kind: "call", side: "short", qty: 1, strike: K, expiry: front.expiry },
      { kind: "call", side: "long", qty: 1, strike: K, expiry: back.expiry },
    ];
    const ctx: ChainContext = { spot, chains: [front, back], riskFree: DEFAULT_RISK_FREE };
    const { netFill } = priceLegs(legs, ctx);
    const spread = 0.2;
    const bid = 1;
    const ask = 1.2;
    const shortFill = bid + 0.23 * spread;
    const longFill = ask - 0.23 * spread;
    const handCredit = (shortFill - longFill) * OPTION_MULT;
    assert.ok(Math.abs(netFill - handCredit) < 1e-6, `fill=${netFill} hand≈${handCredit}`);
  });
});

describe("legs — AAPL stored chain samples", () => {
  it("prices 3 sample trades", async () => {
    if (!process.env.DATABASE_URL) {
      const chain = synthChain(225, "2026-12-19", 30);
      const ctx: ChainContext = { spot: chain.spot, chains: [chain] };
      const legs = buildTemplate("cash_secured_put", { chains: [chain], horizonDays: 30 });
      assert.ok(legs);
      const p = priceStructure(legs!, ctx, 30);
      console.log(`SANITY (no DB): synthetic CSP maxLoss=${p.maxLoss.toFixed(2)} POP=${(p.pop * 100).toFixed(1)}%`);
      return;
    }
    const { readChainSnapshot } = await import("../options-chain-store.js");
    const snap = await readChainSnapshot("AAPL").catch(() => null);
    if (!snap?.chains?.length) {
      console.log("SANITY: AAPL chain missing — skip live sample");
      return;
    }
    const ctx: ChainContext = { spot: snap.chains[0].spot, chains: snap.chains };
    const samples: { name: string; legs: Leg[] | null }[] = [
      { name: "CSP", legs: buildTemplate("cash_secured_put", { chains: snap.chains, horizonDays: 30 }) },
      { name: "Iron condor", legs: buildTemplate("iron_condor", { chains: snap.chains, horizonDays: 37 }) },
      { name: "Covered call", legs: buildTemplate("covered_call", { chains: snap.chains, horizonDays: 30 }) },
    ];
    for (const s of samples) {
      if (!s.legs) {
        console.log(`SANITY: ${s.name} — no legs`);
        continue;
      }
      const p = priceStructure(s.legs, ctx, 30);
      console.log(
        `AAPL ${s.name}: netFill=${p.netFill.toFixed(2)} maxLoss=${p.maxLoss.toFixed(2)} POP=${(p.pop * 100).toFixed(1)}% BE=${p.breakevens.map((x) => x.toFixed(2)).join(",")} legs=${JSON.stringify(s.legs)}`,
      );
    }
    assert.ok(samples.some((s) => s.legs), "at least one template built");
  });
});
