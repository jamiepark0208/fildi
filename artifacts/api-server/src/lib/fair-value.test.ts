import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  blendLogs, computeFairValues, dcfPerShare, impliedGrowth, methodValue, buildPeerStats,
  type FairValueParams, type FvTickerInput, type FvMarket,
} from "./fair-value.ts";
import { FAIR_VALUE_SEED } from "./fair-value.ts";

const P: FairValueParams = FAIR_VALUE_SEED;
const M: FvMarket = { riskFree: 0.045, aaaYield: 0.055 };

function stock(over: Partial<FvTickerInput> & { ticker: string }): FvTickerInput {
  return {
    mode: "standard", peerGroupId: "technology.software", metricExclusions: [],
    price: 100, forwardEps: 5, eps2: 5.5, ltg: 0.10, trailingEps: 4.6, revenueGrowth: 0.08,
    fcf: 5e9, shares: 1e9, totalDebt: 2e9, cash: 1e9, ebitda: 8e9, equity: 20e9, roe: 0.18,
    beta: 1.1, ffo: null, analystTarget: null, starminePriceToIntrinsic: null,
    ...over,
  };
}
/** 8 peers with mild dispersion so peer medians and the warranted regression exist. */
function universe(extra: FvTickerInput[] = []): FvTickerInput[] {
  const peers = Array.from({ length: 8 }, (_, i) => stock({
    ticker: `P${i}`, price: 80 + i * 6, forwardEps: 4 + i * 0.2, eps2: 4.4 + i * 0.25, ltg: 0.06 + i * 0.01,
    peerGroupId: i % 2 ? "technology.software" : "industrials.machinery",
  }));
  // warranted regression needs ≥30 rows: add a broad filler set
  const filler = Array.from({ length: 30 }, (_, i) => stock({
    ticker: `F${i}`, price: 50 + i * 3, forwardEps: 3 + (i % 7) * 0.3, eps2: 3.3 + (i % 7) * 0.35,
    ltg: 0.04 + (i % 9) * 0.01, peerGroupId: ["consumer.retail", "healthcare.pharma", "energy.oil"][i % 3]!,
  }));
  return [...peers, ...filler, ...extra];
}

describe("blendLogs", () => {
  it("trims one high and one low at >=4 votes", () => {
    const r = blendLogs([0, 0.1, 0.2, 5], "trimmed");
    assert.ok(Math.abs(r.value - 0.15) < 1e-9);
    assert.deepEqual(r.kept, [false, true, true, false]);
  });
  it("uses the median below 4 votes", () => {
    assert.equal(blendLogs([0, 0.3, 9], "trimmed").value, 0.3);
    assert.equal(blendLogs([0.1, 0.3], "trimmed").value, 0.2);
  });
  it("a single wild vote barely moves the trimmed blend but drags the mean", () => {
    const clean = [0.0, 0.05, 0.1, 0.12, 0.08];
    const dirty = [...clean.slice(0, 4), Math.log(10)];
    const t = blendLogs(dirty, "trimmed").value - blendLogs(clean, "trimmed").value;
    const g = blendLogs(dirty, "geo").value - blendLogs(clean, "geo").value;
    assert.ok(Math.abs(t) < 0.03 && g > 0.4);
  });
});

describe("DCF and reverse DCF", () => {
  it("value rises with growth and falls with discount rate", () => {
    assert.ok(dcfPerShare(1, 1, 0.10, 0.09, 0.025) > dcfPerShare(1, 1, 0.05, 0.09, 0.025));
    assert.ok(dcfPerShare(1, 1, 0.05, 0.08, 0.025) > dcfPerShare(1, 1, 0.05, 0.11, 0.025));
  });
  it("implied growth reproduces the price", () => {
    const t = stock({ ticker: "X" });
    const g = impliedGrowth(t, M, P)!;
    const k = 0.045 + 1.1 * 0.05;
    assert.ok(Math.abs(dcfPerShare(5e9, 1e9, g, k, 0.025) - 100) < 0.01);
  });
  it("no implied growth for banks, REITs or negative FCF", () => {
    assert.equal(impliedGrowth(stock({ ticker: "B", mode: "financial" }), M, P), null);
    assert.equal(impliedGrowth(stock({ ticker: "N", fcf: -1e9 }), M, P), null);
  });
});

describe("methods", () => {
  it("revised Graham on forward EPS with capped growth", () => {
    const peers = buildPeerStats([], P);
    const v = methodValue("grahamForward", stock({ ticker: "G", ltg: 0.50, eps2: null }), M, P, peers)!;
    // growth capped at 20% → 5 × (8.5 + 40) × 4.4 / 5.5
    assert.ok(Math.abs(v - (5 * 48.5 * 4.4) / 5.5) < 1e-6);
  });
  it("excess returns: ROE above cost of equity is worth more than book", () => {
    const peers = buildPeerStats([], P);
    const bv = 20;
    assert.ok(methodValue("excessReturns", stock({ ticker: "B", mode: "financial", roe: 0.20 }), M, P, peers)! > bv);
    assert.ok(methodValue("excessReturns", stock({ ticker: "B", mode: "financial", roe: 0.05 }), M, P, peers)! < bv);
  });
});

describe("computeFairValues", () => {
  it("routes by mode: speculative gets no model value, banks skip DCF/EV-EBITDA", () => {
    const res = computeFairValues(universe([
      stock({ ticker: "SPEC", mode: "speculative_pre_revenue" }),
      stock({ ticker: "BANK", mode: "financial", peerGroupId: "financials.banks" }),
    ]), M, P);
    const spec = res.find((r) => r.ticker === "SPEC")!;
    assert.equal(spec.fairValue, null);
    assert.equal(spec.nullReason, "mode_speculative_pre_revenue");
    const bank = res.find((r) => r.ticker === "BANK")!;
    const names = bank.votes.map((v) => v.name);
    assert.ok(names.includes("excessReturns"));
    assert.ok(!names.includes("dcfFcfe") && !names.includes("peerEvEbitda"));
  });

  it("never returns a negative or absurd value for loss-makers", () => {
    const res = computeFairValues(universe([
      stock({ ticker: "LOSS", forwardEps: -2, eps2: -1, trailingEps: -3, fcf: -1e9, ebitda: -1e9 }),
    ]), M, P);
    const r = res.find((x) => x.ticker === "LOSS")!;
    assert.equal(r.fairValue, null);
    assert.equal(r.nullReason, "too_few_votes");
  });

  it("respects peer-group metric exclusions", () => {
    const res = computeFairValues(universe([stock({ ticker: "EX", metricExclusions: ["ev_ebitda"] })]), M, P);
    assert.ok(!res.find((r) => r.ticker === "EX")!.votes.some((v) => v.name === "peerEvEbitda"));
  });

  it("external votes are de-biased and counted; range and confidence are set", () => {
    const res = computeFairValues(universe([
      stock({ ticker: "EXT", analystTarget: 130, starminePriceToIntrinsic: 0.9 }),
    ]), M, P);
    const r = res.find((x) => x.ticker === "EXT")!;
    const a = r.votes.find((v) => v.name === "analystTarget")!;
    assert.ok(Math.abs(a.value - 130 * Math.exp(-P.analystBias)) < 0.01);
    assert.ok(Math.abs(r.votes.find((v) => v.name === "starmine")!.value - 111.11) < 0.01);
    assert.ok(r.fairValue! >= r.low! && r.fairValue! <= r.high!);
    assert.ok(["high", "medium", "low"].includes(r.confidence!));
    assert.ok(r.impliedGrowth != null);
  });

  it("range spans all votes when fewer than 4 (no trimming)", () => {
    const res = computeFairValues(universe([
      stock({ ticker: "R3", mode: "reit", peerGroupId: "real_estate.reits", ffo: 3e9, analystTarget: 120, starminePriceToIntrinsic: 0.8 }),
    ]), M, P);
    const r = res.find((x) => x.ticker === "R3")!;
    assert.ok(r.votes.length <= 3 && r.low! < r.high!, JSON.stringify(r));
  });

  it("flags a value trap only when cheap AND in the bottom half of 12-1 momentum", () => {
    const base = universe().map((s, i) => ({ ...s, momentum12_1: (i % 10) / 10 - 0.2 }));
    const cheap = { analystTarget: 300, starminePriceToIntrinsic: 0.3, forwardEps: 12, eps2: 14 };
    const res = computeFairValues([...base,
      stock({ ticker: "TRAP", ...cheap, momentum12_1: -0.4 }),
      stock({ ticker: "RISER", ...cheap, momentum12_1: 0.6 })], M, P);
    const trap = res.find((r) => r.ticker === "TRAP")!, riser = res.find((r) => r.ticker === "RISER")!;
    assert.ok(trap.fairValue! / trap.price! >= 1.25, `trap ratio ${trap.fairValue! / trap.price!}`);
    assert.equal(trap.valueTrap, true);
    assert.equal(riser.valueTrap, false);
  });

  it("cyclicals never show high confidence", () => {
    const res = computeFairValues(universe([stock({ ticker: "SEMI", peerGroupId: "technology.semiconductors" })]), M, P);
    const r = res.find((x) => x.ticker === "SEMI")!;
    assert.equal(r.cyclical, true);
    assert.notEqual(r.confidence, "high");
  });

  it("chinese mode is always low confidence", () => {
    const res = computeFairValues(universe([stock({ ticker: "CN", mode: "chinese" })]), M, P);
    assert.equal(res.find((r) => r.ticker === "CN")!.confidence, "low");
  });

  it("the LYFT case: a 12,000% trailing EPS jump can't explode the value", () => {
    const res = computeFairValues(universe([
      stock({ ticker: "LYFT", price: 15.46, trailingEps: 0.05, forwardEps: 1.2, eps2: 1.5, ltg: null,
        fcf: 8e8, shares: 4e8, ebitda: 4e8, totalDebt: 1e9, cash: 2e9 }),
    ]), M, P);
    const r = res.find((x) => x.ticker === "LYFT")!;
    assert.ok(r.fairValue != null && r.fairValue / 15.46 < 4, `got ${r.fairValue}`);
  });
});
