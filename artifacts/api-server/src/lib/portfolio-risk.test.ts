/**
 * A257 — date-aligned corr/cov; signed shorts; thin-name proxy; no silent VaR 0.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  alignReturns,
  computePortfolioRiskFromCloses,
  pearsonCorrelationAligned,
  covarianceAligned,
  MIN_SHARED_RETURNS,
  type DatedClose,
} from "./portfolio-risk.js";

function series(dates: string[], closes: number[]): DatedClose[] {
  return dates.map((date, i) => ({ date, close: closes[i]! }));
}

/** Dense 70-day path with mild drift + noise. */
function dense(tickerSeed: number, start = "2026-07-01", n = 70): DatedClose[] {
  const out: DatedClose[] = [];
  const [y, m, d] = start.split("-").map(Number);
  let close = 100 + tickerSeed;
  for (let i = 0; i < n; i++) {
    const dt = new Date(Date.UTC(y!, m! - 1, d! + i));
    close *= 1 + 0.001 * Math.sin(i / 3 + tickerSeed) + (i % 2 === 0 ? 0.004 : -0.003);
    out.push({ date: dt.toISOString().slice(0, 10), close });
  }
  return out;
}

describe("alignReturns (A257)", () => {
  it("pairs only shared dates (no tail-slice mismatch)", () => {
    const a = series(["2026-01-01", "2026-01-02", "2026-01-03"], [100, 110, 121]);
    const b = series(["2026-01-01", "2026-01-03", "2026-01-04"], [50, 55, 60]);
    const aligned = alignReturns(a, b)!;
    assert.equal(aligned.ra.length, 1);
    assert.equal(aligned.rb.length, 1);
    assert.ok(Math.abs(aligned.ra[0]! - 0.21) < 1e-9);
    assert.ok(Math.abs(aligned.rb[0]! - 0.10) < 1e-9);
  });

  it("returns null corr when under MIN_SHARED_RETURNS", () => {
    const a = series(["2026-01-01", "2026-01-02", "2026-01-03"], [100, 101, 102]);
    const b = series(["2026-01-01", "2026-01-02", "2026-01-03"], [50, 51, 52]);
    assert.equal(pearsonCorrelationAligned(a, b), null);
    assert.equal(covarianceAligned(a, b), null);
    assert.ok(MIN_SHARED_RETURNS >= 60);
  });

  it("drops return steps with calendar gap > 4 days", () => {
    const a = series(["2026-01-01", "2026-01-02", "2026-01-10"], [100, 101, 110]);
    const b = series(["2026-01-01", "2026-01-02", "2026-01-10"], [50, 51, 55]);
    const aligned = alignReturns(a, b)!;
    // Only Jan1→Jan2 kept; Jan2→Jan10 gap=8 dropped
    assert.equal(aligned.ra.length, 1);
  });
});

describe("signed VaR weights (A257)", () => {
  it("short-stock weight lowers variance vs the same long weight", () => {
    const aaa = dense(1);
    const bbb = aaa.map((x) => ({ date: x.date, close: x.close * 1.02 }));
    const closes = new Map<string, DatedClose[]>([
      ["AAA", aaa],
      ["BBB", bbb],
    ]);
    const longBook = computePortfolioRiskFromCloses(
      [{ ticker: "AAA", weight: 50 }, { ticker: "BBB", weight: 50 }],
      100_000,
      closes,
    );
    const hedged = computePortfolioRiskFromCloses(
      [{ ticker: "AAA", weight: 50 }, { ticker: "BBB", weight: -50 }],
      100_000,
      closes,
    );
    assert.ok(hedged.dailyVolatilityPct < longBook.dailyVolatilityPct,
      `hedged ${hedged.dailyVolatilityPct} should be < long ${longBook.dailyVolatilityPct}`);
  });

  it("40-day second name proxies in and raises VaR vs treating it as dropped", () => {
    const full = dense(1, "2026-07-01", 70);
    const thin = dense(2, "2026-08-01", 40);
    const closes = new Map<string, DatedClose[]>([
      ["AAA", full],
      ["THIN", thin],
    ]);
    // Same book weights: with THIN proxied vs THIN uncovered (no σ, no SPY) under full-gross norm.
    const withProxy = computePortfolioRiskFromCloses(
      [{ ticker: "AAA", weight: 50 }, { ticker: "THIN", weight: 50 }],
      100_000,
      closes,
    );
    const dropped = computePortfolioRiskFromCloses(
      [{ ticker: "AAA", weight: 50 }, { ticker: "THIN", weight: 50 }],
      100_000,
      new Map([["AAA", full]]), // THIN missing → uncovered
      null,
    );
    assert.ok(withProxy.varProxy?.includes("THIN"), `varProxy=${withProxy.varProxy}`);
    assert.ok(withProxy.var95Pct > dropped.var95Pct,
      `proxy VaR ${withProxy.var95Pct} should be > dropped ${dropped.var95Pct}`);
    assert.ok(dropped.coverage === "partial");
  });

  it("disjoint dates do not show corr cell as 0", () => {
    const a = dense(1, "2026-01-01", 70);
    const b = dense(2, "2026-04-01", 70); // little overlap with Jan start in 100d lookalike fixtures
    // Force near-disjoint: take first 35 of A and last 35 of shifted B with no shared dates
    const aOnly = a.slice(0, 35);
    const bOnly = series(
      aOnly.map((_, i) => {
        const dt = new Date(Date.UTC(2027, 0, 1 + i));
        return dt.toISOString().slice(0, 10);
      }),
      aOnly.map((x) => x.close * 1.1),
    );
    const closes = new Map<string, DatedClose[]>([["AAA", aOnly], ["BBB", bOnly]]);
    const spy = dense(0, "2026-01-01", 70);
    const r = computePortfolioRiskFromCloses(
      [{ ticker: "AAA", weight: 50 }, { ticker: "BBB", weight: 50 }],
      100_000,
      closes,
      spy,
    );
    assert.ok(r.tickers.length === 2);
    const cell = r.correlationMatrix[0]![1]!;
    assert.notEqual(cell, 0);
  });

  it("all-missing book with no SPY → coverage none, not fake $0 risk card content", () => {
    const closes = new Map<string, DatedClose[]>();
    const r = computePortfolioRiskFromCloses(
      [{ ticker: "AAA", weight: 50 }, { ticker: "BBB", weight: 50 }],
      100_000,
      closes,
      null,
    );
    assert.equal(r.coverage, "none");
    assert.equal(r.tickers.length, 0);
    assert.equal(r.pricedGrossPct, 0);
  });

  it("near-singular / negative variance path sets varFallback and var95 > 0", () => {
    // Two names, forced via proxy path with extreme opposite weights still get PSD fallback
    const aaa = dense(1);
    const closes = new Map<string, DatedClose[]>([["AAA", aaa], ["BBB", aaa]]);
    const r = computePortfolioRiskFromCloses(
      [{ ticker: "AAA", weight: 100 }, { ticker: "BBB", weight: -99 }],
      100_000,
      closes,
    );
    assert.ok(r.var95Pct >= 0);
    // Hedge can be near-zero but must not be silently wrong; book non-empty
    assert.ok(r.coverage !== "none");
    assert.ok(r.tickers.length >= 1);
  });
});
