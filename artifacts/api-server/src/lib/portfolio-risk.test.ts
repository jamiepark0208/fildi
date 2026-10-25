/**
 * A257 — date-aligned corr/cov; signed short weights reduce variance vs same long weight.
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
function dense(tickerSeed: number, start = "2026-07-01"): DatedClose[] {
  const out: DatedClose[] = [];
  const [y, m, d] = start.split("-").map(Number);
  let close = 100 + tickerSeed;
  for (let i = 0; i < 70; i++) {
    const dt = new Date(Date.UTC(y!, m! - 1, d! + i));
    // Skip weekends roughly by advancing calendar days; fine for alignment tests.
    close *= 1 + 0.001 * Math.sin(i / 3 + tickerSeed) + (i % 2 === 0 ? 0.004 : -0.003);
    out.push({ date: dt.toISOString().slice(0, 10), close });
  }
  return out;
}

describe("alignReturns (A257)", () => {
  it("pairs only shared dates (no tail-slice mismatch)", () => {
    // A: dates 1,2,3  B: dates 1,3,4 → shared 1,3 → one return step
    const a = series(["2026-01-01", "2026-01-02", "2026-01-03"], [100, 110, 121]);
    const b = series(["2026-01-01", "2026-01-03", "2026-01-04"], [50, 55, 60]);
    const aligned = alignReturns(a, b)!;
    assert.equal(aligned.ra.length, 1);
    assert.equal(aligned.rb.length, 1);
    // 121/100 - 1 = 0.21; 55/50 - 1 = 0.10
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
});

describe("signed VaR weights (A257)", () => {
  it("short-stock weight lowers variance vs the same long weight", () => {
    const aaa = dense(1);
    // Near-perfect positive corr so a short of BBB hedges AAA.
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

  it("skips a 9-close name and still returns a card", () => {
    const short = series(
      Array.from({ length: 9 }, (_, i) => `2026-01-${String(i + 1).padStart(2, "0")}`),
      Array.from({ length: 9 }, (_, i) => 100 + i),
    );
    const closes = new Map<string, DatedClose[]>([
      ["THIN", short],
      ["AAA", dense(1)],
      ["BBB", dense(2)],
    ]);
    const r = computePortfolioRiskFromCloses(
      [
        { ticker: "THIN", weight: 40 },
        { ticker: "AAA", weight: 30 },
        { ticker: "BBB", weight: 30 },
      ],
      50_000,
      closes,
    );
    assert.ok(r.skippedTickers.includes("THIN"));
    assert.ok(!r.tickers.includes("THIN"));
    assert.equal(r.varBasis, "underlying");
    assert.ok(r.tickers.length >= 2);
  });
});
