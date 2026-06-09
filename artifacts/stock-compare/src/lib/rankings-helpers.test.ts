import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  safeDiv, winsorize, normalize, MIN_Z_N,
  cashRunway, dilutionRate, interestCoverage, approxWACC, roicWaccSpread,
  MAX_CASH_RUNWAY_QUARTERS, MAX_INTEREST_COVERAGE,
  percentileRank, zScoreVsHistory, macdTurnDirection,
  regimeFromPrice, fallingKnifeDetect, realizedVolatility,
  swingHighLow, vwap,
} from "./rankings-helpers.ts";
import { computeTechnicalRankingsV2, type TechnicalRow } from "./technical-rankings.ts";

// node:assert/strict doesn't have toBeCloseTo — simple helper
function assertClose(actual: number | null, expected: number, tol = 1e-9, msg?: string) {
  assert.ok(actual !== null, msg ?? `expected ~${expected}, got null`);
  assert.ok(
    Math.abs((actual as number) - expected) < tol,
    msg ?? `expected ${expected} ± ${tol}, got ${actual}`,
  );
}

// ─── safeDiv ────────────────────────────────────────────────────────────────

describe("safeDiv", () => {
  it("returns null for null numerator", () => assert.equal(safeDiv(null, 10), null));
  it("returns null for undefined numerator", () => assert.equal(safeDiv(undefined, 10), null));
  it("returns null for null denominator", () => assert.equal(safeDiv(10, null), null));
  it("returns null for zero denominator", () => assert.equal(safeDiv(5, 0), null));
  it("returns null for Infinity numerator", () => assert.equal(safeDiv(Infinity, 1), null));
  it("returns null for NaN numerator", () => assert.equal(safeDiv(NaN, 1), null));
  it("returns null for Infinity denominator", () => assert.equal(safeDiv(1, Infinity), null));
  it("computes positive result correctly", () => assertClose(safeDiv(10, 4), 2.5, 1e-9));
  it("handles negative numerator", () => assertClose(safeDiv(-100, 200), -0.5, 1e-9));
  it("handles both negatives", () => assertClose(safeDiv(-6, -3), 2, 1e-9));
  it("handles fractional result < 1", () => assertClose(safeDiv(1, 1000), 0.001, 1e-9));
});

// ─── winsorize ───────────────────────────────────────────────────────────────

describe("winsorize", () => {
  it("returns input as-is when fewer than 3 non-null values (1 value)", () => {
    assert.deepEqual(winsorize([42]), [42]);
  });
  it("returns input as-is when fewer than 3 non-null values (2 values)", () => {
    assert.deepEqual(winsorize([1, 2]), [1, 2]);
  });
  it("returns input as-is when fewer than 3 non-null values (1 value + nulls)", () => {
    assert.deepEqual(winsorize([null, 5, null]), [null, 5, null]);
  });
  it("preserves nulls in-place", () => {
    const result = winsorize([null, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(result[0], null);
  });
  it("clips high outlier at p95 (n=21 needed: ceil(0.95×20)=19 lands below the max)", () => {
    // [0..19, 10000] — hi_index=19 → finite[19]=19; 10000 clipped to 19
    const vals = [...Array.from({ length: 20 }, (_, i) => i), 10000];
    const result = winsorize(vals);
    assert.ok((result[20] as number) < 10000, `outlier not clipped: ${result[20]}`);
    assert.ok((result[20] as number) >= 19, `clipped too far: ${result[20]}`);
  });
  it("clips low outlier at p5 (n=21 needed: floor(0.05×20)=1 lands above the min)", () => {
    // [-10000, 1..20] — lo_index=1 → finite[1]=1; -10000 clipped to 1
    const vals = [-10000, ...Array.from({ length: 20 }, (_, i) => i + 1)];
    const result = winsorize(vals);
    assert.ok((result[0] as number) > -10000, `outlier not clipped: ${result[0]}`);
    assert.ok((result[0] as number) <= 2, `clipped too far: ${result[0]}`);
  });
  it("handles all-null", () => {
    assert.deepEqual(winsorize([null, null, null]), [null, null, null]);
  });
  it("handles all-equal values (no clipping needed)", () => {
    assert.deepEqual(winsorize([5, 5, 5, 5, 5]), [5, 5, 5, 5, 5]);
  });
  it("does not alter values within normal range", () => {
    const result = winsorize([1, 2, 3, 4, 5]);
    assertClose(result[1], 2, 1e-6);
    assertClose(result[2], 3, 1e-6);
    assertClose(result[3], 4, 1e-6);
  });
});

// ─── normalize ───────────────────────────────────────────────────────────────

describe("normalize", () => {
  // ── all-null / empty ──
  it("returns all-null when all inputs are null", () => {
    assert.deepEqual(normalize([null, null, null], { higherIsBetter: true }), [null, null, null]);
  });
  it("returns empty array for empty input", () => {
    assert.deepEqual(normalize([], { higherIsBetter: true }), []);
  });

  // ── single non-null (ordinal path) ──
  it("single non-null value → 1.0", () => {
    const result = normalize([null, 42, null], { higherIsBetter: true });
    assert.equal(result[0], null);
    assert.equal(result[1], 1);
    assert.equal(result[2], null);
  });

  // ── ordinal path (n < MIN_Z_N = 8) ──
  it("ordinal (n=3): best=1 worst=0 middle=0.5 — higherIsBetter=true", () => {
    const result = normalize([10, 50, 90], { higherIsBetter: true });
    assertClose(result[2], 1, 1e-9);    // 90 best
    assertClose(result[0], 0, 1e-9);    // 10 worst
    assertClose(result[1], 0.5, 1e-9);  // 50 middle
  });
  it("ordinal (n=3): flips correctly for higherIsBetter=false", () => {
    const result = normalize([10, 50, 90], { higherIsBetter: false });
    assertClose(result[0], 1, 1e-9);    // 10 best (lowest)
    assertClose(result[2], 0, 1e-9);    // 90 worst
    assertClose(result[1], 0.5, 1e-9);
  });
  it("ordinal: null inputs stay null, non-nulls get valid [0,1] scores", () => {
    const result = normalize([null, 10, null, 90], { higherIsBetter: true });
    assert.equal(result[0], null);
    assert.equal(result[2], null);
    assertClose(result[3], 1, 1e-9);   // 90 best of 2
    assertClose(result[1], 0, 1e-9);   // 10 worst of 2
  });
  it("ordinal: 5-ticker compare view (n=5 < 8) uses rank not z-score", () => {
    const vals = [20, 40, 60, 80, 100];
    const result = normalize(vals, { higherIsBetter: true });
    assertClose(result[4], 1, 1e-9);    // 100 best
    assertClose(result[0], 0, 1e-9);    // 20 worst
    assertClose(result[2], 0.5, 1e-9);  // 60 middle
    assertClose(result[1], 0.25, 1e-9);
    assertClose(result[3], 0.75, 1e-9);
  });
  it("ordinal with negatives: works correctly", () => {
    const result = normalize([-5, 0, 5], { higherIsBetter: true });
    assertClose(result[2], 1, 1e-9);
    assertClose(result[0], 0, 1e-9);
    assertClose(result[1], 0.5, 1e-9);
  });

  // ── z-score path (n >= MIN_Z_N = 8) ──
  it("z-score (n=8): all output scores are in [0, 1]", () => {
    const vals = Array.from({ length: MIN_Z_N }, (_, i) => i * 10);
    const result = normalize(vals, { higherIsBetter: true });
    result.forEach((v, i) => {
      assert.ok(v !== null, `index ${i} should not be null`);
      assert.ok((v as number) >= 0 && (v as number) <= 1, `index ${i}: ${v} not in [0,1]`);
    });
  });
  it("z-score (n=8): higher value gets higher score when higherIsBetter=true", () => {
    const vals = Array.from({ length: MIN_Z_N }, (_, i) => i * 10);
    const result = normalize(vals, { higherIsBetter: true });
    const last = result[vals.length - 1] as number;
    const first = result[0] as number;
    assert.ok(last > first, `last (${last}) should be > first (${first})`);
  });
  it("z-score: all-equal values → all 0.5 (std=0 case)", () => {
    const vals = Array.from({ length: MIN_Z_N }, () => 5);
    const result = normalize(vals, { higherIsBetter: true });
    result.forEach((v, i) => assertClose(v, 0.5, 1e-9, `index ${i} should be 0.5`));
  });
  it("z-score (n=21): extreme outlier is winsorized — spread among normal values preserved", () => {
    // 21 values: [1..20] + extreme; n >= 21 means p95 clips the outlier (see winsorize tests)
    const vals = [...Array.from({ length: 20 }, (_, i) => i + 1), 100_000];
    const result = normalize(vals, { higherIsBetter: true });
    result.forEach((v, i) => {
      if (v !== null) {
        assert.ok(
          (v as number) >= 0 && (v as number) <= 1,
          `index ${i}: ${v} not in [0,1]`,
        );
      }
    });
    // After winsorization of 100_000, the 20 normal values retain meaningful spread
    const normalScores = result.slice(0, 20).filter((v): v is number => v !== null);
    const spread = Math.max(...normalScores) - Math.min(...normalScores);
    assert.ok(spread > 0.05, `spread too small after winsorization: ${spread}`);
  });
  it("z-score: null inputs stay null; non-nulls get valid [0,1] scores", () => {
    const vals: (number | null)[] = [null, 10, 20, 30, 40, 50, 60, 70, 80]; // 8 non-null → z-score
    const result = normalize(vals, { higherIsBetter: true });
    assert.equal(result[0], null);
    result.slice(1).filter((v): v is number => v !== null).forEach(v => {
      assert.ok(v >= 0 && v <= 1, `score ${v} not in [0,1]`);
    });
  });
  it("z-score: higherIsBetter=false flips scores (lower value → higher score)", () => {
    const vals = Array.from({ length: MIN_Z_N }, (_, i) => i + 1); // [1..8]
    const asc = normalize(vals, { higherIsBetter: true });
    const desc = normalize(vals, { higherIsBetter: false });
    assert.ok(
      (desc[0] as number) > (asc[0] as number),
      `desc[0]=${desc[0]} should be > asc[0]=${asc[0]}`,
    );
    const last = vals.length - 1;
    assert.ok(
      (desc[last] as number) < (asc[last] as number),
      `desc[last]=${desc[last]} should be < asc[last]=${asc[last]}`,
    );
  });
});

// ─── cashRunway ───────────────────────────────────────────────────────────────

describe("cashRunway", () => {
  it("returns null for null cash", () => assert.equal(cashRunway(null, -10), null));
  it("returns null for undefined cash", () => assert.equal(cashRunway(undefined, -10), null));
  it("returns null for null quarterlyOCF", () => assert.equal(cashRunway(100, null), null));
  it("returns null for undefined quarterlyOCF", () => assert.equal(cashRunway(100, undefined), null));
  it("returns null for Infinity cash", () => assert.equal(cashRunway(Infinity, -10), null));
  it("returns null for NaN quarterlyOCF", () => assert.equal(cashRunway(100, NaN), null));

  it("returns Infinity when OCF = 0 (no burn)", () => assert.equal(cashRunway(100, 0), Infinity));
  it("returns Infinity when OCF > 0 (cash generating)", () => assert.equal(cashRunway(100, 50), Infinity));
  it("returns Infinity when OCF positive and cash is 0", () => assert.equal(cashRunway(0, 10), Infinity));

  it("basic burn rate: 100 / |(-5)| = 20 quarters", () =>
    assertClose(cashRunway(100, -5), 20, 1e-9));
  it("caps at MAX_CASH_RUNWAY_QUARTERS when cash/burn > 20", () =>
    assertClose(cashRunway(500, -5), MAX_CASH_RUNWAY_QUARTERS, 1e-9)); // 500/5=100, capped
  it("returns fractional quarters when cash < burn×20", () =>
    assertClose(cashRunway(30, -5), 6, 1e-9)); // 30/5=6
  it("returns 0 when cash = 0 and burning", () =>
    assertClose(cashRunway(0, -10), 0, 1e-9));
  it("caps exactly at 20 for cash/burn = 20", () =>
    assertClose(cashRunway(100, -5), 20, 1e-9)); // 100/5=20, on boundary
});

// ─── dilutionRate ─────────────────────────────────────────────────────────────

describe("dilutionRate", () => {
  it("returns null for null current", () => assert.equal(dilutionRate(null, 100), null));
  it("returns null for null prior", () => assert.equal(dilutionRate(110, null), null));
  it("returns null for undefined inputs", () => assert.equal(dilutionRate(undefined, undefined), null));
  it("returns null when prior = 0", () => assert.equal(dilutionRate(110, 0), null));
  it("returns null for Infinity current", () => assert.equal(dilutionRate(Infinity, 100), null));

  it("10% dilution: (110-100)/100 = 0.10", () =>
    assertClose(dilutionRate(110e6, 100e6), 0.10, 1e-9));
  it("10% buyback: (90-100)/100 = -0.10", () =>
    assertClose(dilutionRate(90e6, 100e6), -0.10, 1e-9));
  it("no change: (100-100)/100 = 0", () =>
    assertClose(dilutionRate(100e6, 100e6), 0, 1e-9));

  it("clamps at 1.0 upper bound (200% dilution → 1.0)", () =>
    assertClose(dilutionRate(300e6, 100e6), 1.0, 1e-9));
  it("clamps at -0.5 lower bound (70% buyback → -0.5)", () =>
    assertClose(dilutionRate(20e6, 100e6), -0.5, 1e-9)); // -0.8 → clamped to -0.5
  it("exactly at upper clamp boundary: 100% dilution → 1.0", () =>
    assertClose(dilutionRate(200e6, 100e6), 1.0, 1e-9));
  it("just below upper clamp: 99% dilution → 0.99", () =>
    assertClose(dilutionRate(199e6, 100e6), 0.99, 1e-9));
});

// ─── interestCoverage ─────────────────────────────────────────────────────────

describe("interestCoverage", () => {
  it("returns null for null ebit", () => assert.equal(interestCoverage(null, 10), null));
  it("returns null for null interestExpense", () => assert.equal(interestCoverage(100, null), null));
  it("returns null for undefined inputs", () => assert.equal(interestCoverage(undefined, undefined), null));
  it("returns null for Infinity ebit", () => assert.equal(interestCoverage(Infinity, 10), null));
  it("returns null for NaN interestExpense", () => assert.equal(interestCoverage(100, NaN), null));

  it("returns MAX (50) when interestExpense = 0 (debt-free)", () =>
    assertClose(interestCoverage(100, 0), MAX_INTEREST_COVERAGE, 1e-9));
  it("returns MAX even when ebit is negative and interestExpense = 0", () =>
    assertClose(interestCoverage(-50, 0), MAX_INTEREST_COVERAGE, 1e-9));

  it("basic: 100 ebit / 10 expense = 10x", () =>
    assertClose(interestCoverage(100, 10), 10, 1e-9));
  it("caps at 50 when ratio exceeds MAX_INTEREST_COVERAGE", () =>
    assertClose(interestCoverage(600, 10), MAX_INTEREST_COVERAGE, 1e-9)); // 60 → 50
  it("exactly at cap: 500 / 10 = 50 (on boundary)", () =>
    assertClose(interestCoverage(500, 10), MAX_INTEREST_COVERAGE, 1e-9));
  it("negative ebit (distressed): -50 / 10 = -5 (no cap on negatives)", () =>
    assertClose(interestCoverage(-50, 10), -5, 1e-9));
  it("fractional result: 15 / 4 = 3.75", () =>
    assertClose(interestCoverage(15, 4), 3.75, 1e-9));
});

// ─── approxWACC ──────────────────────────────────────────────────────────────

describe("approxWACC", () => {
  const base = {
    beta: 1.2,
    totalDebt: 200e6,
    totalStockholdersEquity: 1000e6,
    effectiveTaxRate: 0.21,
    interestExpense: 10e6,
    riskFreeRate: 0.045,
    equityRiskPremium: 0.055,
  };

  it("returns null for null beta", () =>
    assert.equal(approxWACC({ ...base, beta: null }), null));
  it("returns null for undefined beta", () =>
    assert.equal(approxWACC({ ...base, beta: undefined }), null));
  it("returns null for null equity", () =>
    assert.equal(approxWACC({ ...base, totalStockholdersEquity: null }), null));
  it("returns null for Infinity beta", () =>
    assert.equal(approxWACC({ ...base, beta: Infinity }), null));
  it("returns null when totalCapital <= 0 (debt + negative equity)", () =>
    assert.equal(approxWACC({ ...base, totalStockholdersEquity: -300e6, totalDebt: 200e6 }), null));

  it("debt-free company: WACC = costOfEquity only", () => {
    const result = approxWACC({ ...base, totalDebt: 0, interestExpense: 0 });
    // costOfEquity = 0.045 + 1.2*0.055 = 0.111
    assertClose(result, 0.111, 1e-6);
  });

  it("null debt treated as 0 (debt-free path)", () => {
    const result = approxWACC({ ...base, totalDebt: null, interestExpense: null });
    assertClose(result, 0.111, 1e-6);
  });

  it("returns a number in plausible WACC range [0.03, 0.30] for normal inputs", () => {
    const result = approxWACC(base);
    assert.ok(result !== null, "should not be null");
    assert.ok((result as number) >= 0.03 && (result as number) <= 0.30,
      `WACC ${result} outside [0.03, 0.30]`);
  });

  it("uses 0.21 default tax rate when effectiveTaxRate is null", () => {
    const withNull = approxWACC({ ...base, effectiveTaxRate: null });
    const withExplicit = approxWACC({ ...base, effectiveTaxRate: 0.21 });
    assertClose(withNull, withExplicit as number, 1e-9);
  });

  it("costOfDebt uses rfr as floor (interestExpense/debt < rfr → rfr)", () => {
    // interestExpense=1M on 200M debt → 0.5% < rfr 4.5%, so costOfDebt = rfr
    const lowDebtCost = approxWACC({ ...base, interestExpense: 1e6 });
    const rfrDebtCost = approxWACC({ ...base, interestExpense: 0 }); // triggers rfr fallback
    assertClose(lowDebtCost, rfrDebtCost as number, 1e-9);
  });

  it("uses default rfr=0.045 and erp=0.055 when not provided", () => {
    const { riskFreeRate: _rfr, equityRiskPremium: _erp, ...noDefaults } = base;
    const result = approxWACC(noDefaults);
    const resultExplicit = approxWACC(base);
    assertClose(result, resultExplicit as number, 1e-9);
  });

  it("higher beta → higher WACC", () => {
    const low = approxWACC({ ...base, beta: 0.5 }) as number;
    const high = approxWACC({ ...base, beta: 2.0 }) as number;
    assert.ok(high > low, `high beta WACC ${high} should exceed low beta WACC ${low}`);
  });
});

// ─── roicWaccSpread ───────────────────────────────────────────────────────────

describe("roicWaccSpread", () => {
  it("returns null for null roic", () => assert.equal(roicWaccSpread(null, 0.10), null));
  it("returns null for null wacc", () => assert.equal(roicWaccSpread(0.15, null), null));
  it("returns null for undefined inputs", () => assert.equal(roicWaccSpread(undefined, undefined), null));
  it("returns null for Infinity roic", () => assert.equal(roicWaccSpread(Infinity, 0.10), null));
  it("returns null for NaN wacc", () => assert.equal(roicWaccSpread(0.15, NaN), null));

  it("positive spread (value creation): 0.15 - 0.10 = 0.05", () =>
    assertClose(roicWaccSpread(0.15, 0.10), 0.05, 1e-9));
  it("negative spread (value destruction): 0.05 - 0.10 = -0.05", () =>
    assertClose(roicWaccSpread(0.05, 0.10), -0.05, 1e-9));
  it("zero spread: 0.10 - 0.10 = 0", () =>
    assertClose(roicWaccSpread(0.10, 0.10), 0, 1e-9));
  it("both zero: 0 - 0 = 0", () =>
    assertClose(roicWaccSpread(0, 0), 0, 1e-9));
  it("large positive spread: 0.30 - 0.08 = 0.22", () =>
    assertClose(roicWaccSpread(0.30, 0.08), 0.22, 1e-9));
  it("deeply negative spread: -0.10 - 0.12 = -0.22", () =>
    assertClose(roicWaccSpread(-0.10, 0.12), -0.22, 1e-9));
});

// ─── Phase 2 Technical V2 helpers ────────────────────────────────────────────

// helpers
const range = (n: number, start = 1) => Array.from({ length: n }, (_, i) => start + i);

// ─── percentileRank ──────────────────────────────────────────────────────────

describe("percentileRank", () => {
  it("returns null when series has fewer than minN finite values", () =>
    assert.strictEqual(percentileRank(5, [1, 2, 3], 10), null));
  it("returns null when series is empty", () =>
    assert.strictEqual(percentileRank(5, [], 1), null));
  it("all values equal: current equals each — 0 below → 0.0", () =>
    assertClose(percentileRank(5, [5, 5, 5, 5, 5, 5, 5, 5, 5, 5], 5), 0.0, 1e-9));
  it("current below all values → 0.0", () =>
    assertClose(percentileRank(0, range(60), 60), 0.0, 1e-9));
  it("current above all values → 1.0 (all 60 below it)", () =>
    assertClose(percentileRank(61, range(60), 60), 1.0, 1e-9));
  it("current is the median of 1..61 (31) → 50/61 ≈ 0.82", () =>
    assertClose(percentileRank(31, range(61), 60), 30 / 61, 1e-9));
  it("ignores NaN in series", () => {
    const series = [...range(60), NaN, NaN];
    assertClose(percentileRank(30, series, 60), 29 / 60, 1e-9);
  });
  it("current = NaN returns null", () =>
    assert.strictEqual(percentileRank(NaN, range(60), 60), null));
  it("single-value series with minN=1: current equals it → 0.0 (strict less-than)", () =>
    assertClose(percentileRank(5, [5], 1), 0.0, 1e-9));
});

// ─── zScoreVsHistory ─────────────────────────────────────────────────────────

describe("zScoreVsHistory", () => {
  it("returns null when fewer than minN values", () =>
    assert.strictEqual(zScoreVsHistory(5, [1, 2, 3], 10), null));
  it("all-equal series → 0.5 (neutral)", () =>
    assertClose(zScoreVsHistory(5, [5, 5, 5, 5, 5, 5, 5, 5, 5, 5], 5), 0.5, 1e-9));
  it("zero std → 0.5", () =>
    assertClose(zScoreVsHistory(0, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 5), 0.5, 1e-9));
  it("current = mean → 0.5", () => {
    const s = range(100); // mean = 50.5
    assertClose(zScoreVsHistory(50.5, s, 60), 0.5, 1e-6);
  });
  it("extreme high (>>3 std above mean) → clips to 1.0", () =>
    assertClose(zScoreVsHistory(1e9, range(100), 60), 1.0, 1e-9));
  it("extreme low (<< -3 std below mean) → clips to 0.0", () =>
    assertClose(zScoreVsHistory(-1e9, range(100), 60), 0.0, 1e-9));
  it("current = NaN → null", () =>
    assert.strictEqual(zScoreVsHistory(NaN, range(100), 60), null));
  it("ignores NaN in series (enough finite values remain)", () => {
    const s = [...range(60), NaN, NaN];
    const r = zScoreVsHistory(30.5, s, 60);
    assert.ok(r !== null && r >= 0 && r <= 1);
  });
});

// ─── macdTurnDirection ───────────────────────────────────────────────────────

describe("macdTurnDirection", () => {
  it("returns null when series shorter than lookback", () =>
    assert.strictEqual(macdTurnDirection([1, 2], 3), null));
  it("returns null for empty series", () =>
    assert.strictEqual(macdTurnDirection([]), null));
  it("clearly improving histogram → UP", () =>
    assert.strictEqual(macdTurnDirection([-3, -2, -1], 3), "UP"));
  it("clearly deteriorating → DOWN", () =>
    assert.strictEqual(macdTurnDirection([1, 0.5, -0.5], 3), "DOWN"));
  it("tiny change within noise (5% of first bar) → FLAT", () =>
    assert.strictEqual(macdTurnDirection([10, 10, 10.0001], 3), "FLAT"));
  it("uses only last `lookback` bars", () => {
    // first 3 bars go DOWN, last 3 bars go UP — should report UP
    assert.strictEqual(macdTurnDirection([5, 4, 3, -3, -2, -1], 3), "UP");
  });
  it("single large jump: -1 to +1 = UP", () =>
    assert.strictEqual(macdTurnDirection([-1, 0, 1], 3), "UP"));
  it("default lookback=3 works without second arg", () =>
    assert.strictEqual(macdTurnDirection([0, 0.5, 1.0, 1.5]), "UP"));
  it("histogram crossing zero upward → UP", () =>
    assert.strictEqual(macdTurnDirection([-0.5, -0.1, 0.4], 3), "UP"));
});

// ─── regimeFromPrice ─────────────────────────────────────────────────────────

describe("regimeFromPrice", () => {
  it("BULLISH: price > ma50 > ma200, slope > 0", () =>
    assert.strictEqual(regimeFromPrice(120, 100, 80, 0.001), "BULLISH"));
  it("BEARISH: price < ma50 < ma200, slope < 0", () =>
    assert.strictEqual(regimeFromPrice(60, 80, 100, -0.001), "BEARISH"));
  it("NEUTRAL: price > ma50 > ma200 but slope = 0", () =>
    assert.strictEqual(regimeFromPrice(120, 100, 80, 0), "NEUTRAL"));
  it("NEUTRAL: price between ma50 and ma200", () =>
    assert.strictEqual(regimeFromPrice(90, 100, 80, 0.001), "NEUTRAL"));
  it("NEUTRAL: ma50 null", () =>
    assert.strictEqual(regimeFromPrice(100, null, 80, 0.001), "NEUTRAL"));
  it("NEUTRAL: ma200 null", () =>
    assert.strictEqual(regimeFromPrice(100, 90, null, 0.001), "NEUTRAL"));
  it("NEUTRAL: slope null", () =>
    assert.strictEqual(regimeFromPrice(120, 100, 80, null), "NEUTRAL"));
  it("BEARISH requires both MAs stacked (ma50 < ma200)", () =>
    assert.strictEqual(regimeFromPrice(60, 90, 80, -0.001), "NEUTRAL"));
});

// ─── fallingKnifeDetect ──────────────────────────────────────────────────────

describe("fallingKnifeDetect", () => {
  it("all three conditions met → true", () =>
    assert.strictEqual(fallingKnifeDetect(-3, -2.5, "DOWN"), true));
  it("macdDirection not DOWN → false", () =>
    assert.strictEqual(fallingKnifeDetect(-3, -2.5, "FLAT"), false));
  it("macdDirection UP → false", () =>
    assert.strictEqual(fallingKnifeDetect(-3, -2.5, "UP"), false));
  it("priceVsMa50Atr null → false", () =>
    assert.strictEqual(fallingKnifeDetect(null, -2.5, "DOWN"), false));
  it("priceVsMa50Atr = -1.9 (above threshold) → false", () =>
    assert.strictEqual(fallingKnifeDetect(-1.9, -3, "DOWN"), false));
  it("priceVsMa200Atr = -1.9 (above threshold) → false when MA200 available", () =>
    assert.strictEqual(fallingKnifeDetect(-3, -1.9, "DOWN"), false));
  it("priceVsMa200Atr = null: uses MA50 alone → true when MA50 < -2.0 and DOWN", () =>
    assert.strictEqual(fallingKnifeDetect(-3, null, "DOWN"), true));
  it("macdDirection null → false", () =>
    assert.strictEqual(fallingKnifeDetect(-3, -3, null), false));
  it("exact threshold -2.0: not strictly below → false", () =>
    assert.strictEqual(fallingKnifeDetect(-2.0, -3, "DOWN"), false));
});

// ─── realizedVolatility ──────────────────────────────────────────────────────

describe("realizedVolatility", () => {
  it("returns null when fewer than window+1 closes", () =>
    assert.strictEqual(realizedVolatility([100, 101, 102], 5), null));
  it("returns null for empty array", () =>
    assert.strictEqual(realizedVolatility([]), null));
  it("flat prices → vol near 0", () => {
    const flat = Array(25).fill(100);
    assertClose(realizedVolatility(flat, 20), 0, 1e-6);
  });
  it("vol is annualized (≈ daily std × √252)", () => {
    // daily returns of ±1% alternating → daily std ≈ 0.01
    const closes = [100];
    for (let i = 0; i < 25; i++) closes.push(closes[closes.length - 1] * (i % 2 === 0 ? 1.01 : 0.99));
    const rv = realizedVolatility(closes, 20);
    assert.ok(rv !== null && rv > 0 && rv < 300, `unreasonable vol: ${rv}`);
  });
  it("result is a percentage (e.g. ~35 not ~0.35)", () => {
    // alternating ±2% returns → non-zero variance → result should be >> 1
    const closes = [100];
    for (let i = 0; i < 25; i++) closes.push(closes[closes.length - 1] * (i % 2 === 0 ? 1.02 : 0.98));
    const rv = realizedVolatility(closes, 20);
    assert.ok(rv !== null && rv > 1, `expected percentage scale, got ${rv}`);
  });
  it("uses exactly the last window+1 closes", () => {
    // prepend junk values that shouldn't affect result
    const signal = Array(25).fill(100);
    const withJunk = [...Array(100).fill(50), ...signal];
    const direct = realizedVolatility(signal, 20);
    const withPre = realizedVolatility(withJunk, 20);
    assertClose(direct, withPre!, 1e-6);
  });
});

// ─── swingHighLow ────────────────────────────────────────────────────────────

describe("swingHighLow", () => {
  it("returns {null, null} when series too short", () => {
    const r = swingHighLow([1, 2, 3], 20);
    assert.strictEqual(r.high, null);
    assert.strictEqual(r.low, null);
  });
  it("flat series → no swing high/low (all equal, no local extrema)", () => {
    const flat = Array(30).fill(100);
    const r = swingHighLow(flat, 20);
    assert.strictEqual(r.high, null);
    assert.strictEqual(r.low, null);
  });
  it("single spike up → detected as swing high", () => {
    // ..100, 100, 200, 100, 100...
    const closes = [...Array(10).fill(100), 200, ...Array(10).fill(100)];
    const r = swingHighLow(closes, 15);
    assert.strictEqual(r.high, 200);
  });
  it("single dip down → detected as swing low", () => {
    const closes = [...Array(10).fill(100), 50, ...Array(10).fill(100)];
    const r = swingHighLow(closes, 15);
    assert.strictEqual(r.low, 50);
  });
  it("returns highest swing high (not first one found)", () => {
    // two spikes — array must be >= lookback+4; use lookback=10, 17 elements ≥ 14
    const closes = [...Array(5).fill(100), 150, ...Array(5).fill(100), 200, ...Array(5).fill(100)];
    const r = swingHighLow(closes, 10);
    assert.strictEqual(r.high, 200);
  });
  it("returns lowest swing low", () => {
    const closes = [...Array(5).fill(100), 60, ...Array(5).fill(100), 40, ...Array(5).fill(100)];
    const r = swingHighLow(closes, 10);
    assert.strictEqual(r.low, 40);
  });
  it("skips NaN values without crashing", () => {
    const closes = [...Array(10).fill(100), NaN, 200, NaN, ...Array(10).fill(100)];
    const r = swingHighLow(closes, 15);
    // NaN skipped — 200 may or may not qualify depending on neighbors
    assert.ok(r.high === null || typeof r.high === "number");
  });
});

// ─── vwap ────────────────────────────────────────────────────────────────────

describe("vwap", () => {
  it("returns null when fewer than window closes", () =>
    assert.strictEqual(vwap([100, 101], [1000, 1000], 5), null));
  it("returns null when fewer than window volumes", () =>
    assert.strictEqual(vwap(range(20, 100), [1000], 20), null));
  it("returns null when total volume is 0", () =>
    assert.strictEqual(vwap(Array(20).fill(100), Array(20).fill(0), 20), null));
  it("equal volumes → simple average of closes", () => {
    const closes = [100, 102, 104, 106, 108];
    const vols = [1000, 1000, 1000, 1000, 1000];
    assertClose(vwap(closes, vols, 5)!, 104, 1e-9);
  });
  it("higher volume on lower price pulls VWAP down", () => {
    const closes = [90, 110];
    const vols =   [900, 100]; // 90% weight on 90, 10% on 110
    const result = vwap(closes, vols, 2);
    assert.ok(result !== null && result < 100, `expected < 100, got ${result}`);
  });
  it("uses only last window bars", () => {
    const closes = [...Array(10).fill(50), ...Array(5).fill(100)];
    const vols   = [...Array(10).fill(1000), ...Array(5).fill(1000)];
    const result = vwap(closes, vols, 5);
    assertClose(result!, 100, 1e-9);
  });
  it("single bar → returns that close", () =>
    assertClose(vwap([123.45], [5000], 1)!, 123.45, 1e-9));
  it("zero-volume bars excluded from numerator and denominator", () => {
    // bar with price=200, vol=0 should not affect result
    const closes = [100, 200, 100];
    const vols   = [1000, 0, 1000];
    const result = vwap(closes, vols, 3);
    assertClose(result!, 100, 1e-9);
  });
});

// ─── computeTechnicalRankingsV2 ───────────────────────────────────────────────

// Factory: build a TechnicalRow with all fields set to known defaults
function makeRow(overrides: Partial<TechnicalRow> = {}): TechnicalRow {
  return {
    ticker: "TEST",
    technicalsCoverage: "1.0",
    rsi14: "40",    rsi14Pct: "0.25",   // oversold for this stock
    mfi14Pct: "0.30",
    stoch: "30",    stochPct: "0.25",
    macdHist: "0.5", macdDirection: "UP",
    rsiVelocity: "2",
    volumeRatioPct: "0.6",
    realizedVol20d: "30",
    ivRank: "0.5",  ivPercentile: "50",
    ivVsRealizedVol: "1.2",
    bbWidthPct: "0.4",
    priceZScore: "-1.0",
    ma50: "100", ma200: "90",
    priceVsMa50Atr: "-1.0", priceVsMa200Atr: "2.0",
    nearestSupportDistPct: "3",
    priceVsVwapPct: "-2",
    regime: "BULLISH",
    fallingKnife: 0,
    atmPutIv: "35",
    putCallVolumeRatio: "1.2",
    basicSkew: "8",
    ivTermStructure: "1.1",
    earningsDaysOut: null,
    ...overrides,
  };
}

describe("computeTechnicalRankingsV2", () => {

  // ── INVARIANCE (most important) ──────────────────────────────────────────────

  it("INVARIANCE: score is identical whether peer set has 1 or 5 tickers", () => {
    const a = makeRow({ ticker: "A", rsi14Pct: "0.15" });
    const b = makeRow({ ticker: "B", rsi14Pct: "0.40" });
    const c = makeRow({ ticker: "C", rsi14Pct: "0.70" });
    const d = makeRow({ ticker: "D", rsi14Pct: "0.55" });
    const e = makeRow({ ticker: "E", rsi14Pct: "0.90" });

    const solo  = computeTechnicalRankingsV2([a]);
    const full  = computeTechnicalRankingsV2([a, b, c, d, e]);
    const scoreAlone = solo.find(r => r.ticker === "A")!.totalScore;
    const scoreInGroup = full.find(r => r.ticker === "A")!.totalScore;

    assertClose(scoreAlone, scoreInGroup, 1e-6,
      `A score changed: solo=${scoreAlone} vs group=${scoreInGroup}`);
  });

  it("INVARIANCE: removing a peer does not change any remaining ticker's score", () => {
    const rows = ["X","Y","Z"].map(t => makeRow({ ticker: t, rsi14Pct: String(Math.random()) }));
    const [rx, ry, rz] = rows;

    const full    = computeTechnicalRankingsV2([rx, ry, rz]);
    const without = computeTechnicalRankingsV2([rx, ry]);

    for (const t of ["X", "Y"]) {
      const f = full.find(r => r.ticker === t)!.totalScore;
      const w = without.find(r => r.ticker === t)!.totalScore;
      assertClose(f, w, 1e-6, `${t} score changed after removing Z: ${f} → ${w}`);
    }
  });

  // ── maxPossible ──────────────────────────────────────────────────────────────

  it("maxPossible is always 100 regardless of null components", () => {
    const nullRow = makeRow({ ivRank: null, putCallVolumeRatio: null, basicSkew: null });
    const [r] = computeTechnicalRankingsV2([nullRow]);
    assert.strictEqual(r.maxPossible, 100);
  });

  it("maxPossible is 100 even when all options fields are null", () => {
    const r = makeRow({ atmPutIv: null, ivVsRealizedVol: null, putCallVolumeRatio: null, basicSkew: null, ivTermStructure: null, ivRank: null });
    const [s] = computeTechnicalRankingsV2([r]);
    assert.strictEqual(s.maxPossible, 100);
  });

  it("totalScore ∈ [0, 100] for any valid input", () => {
    const r = computeTechnicalRankingsV2([makeRow()]);
    assert.ok(r[0].totalScore >= 0 && r[0].totalScore <= 100);
  });

  // ── Gate logic ───────────────────────────────────────────────────────────────

  it("GO: all conditions met", () => {
    const row = makeRow({
      rsi14Pct: "0.20", mfi14Pct: "0.30",
      macdDirection: "UP", fallingKnife: 0, earningsDaysOut: null,
    });
    const [r] = computeTechnicalRankingsV2([row]);
    assert.strictEqual(r.signal, "GO");
  });

  it("GATE: regime=BEARISH does NOT prevent GO", () => {
    const row = makeRow({
      regime: "BEARISH",
      rsi14Pct: "0.20", mfi14Pct: "0.30",
      macdDirection: "UP", fallingKnife: 0, earningsDaysOut: null,
    });
    const [r] = computeTechnicalRankingsV2([row]);
    assert.strictEqual(r.signal, "GO", "regime=BEARISH must not block GO");
  });

  it("GATE: fallingKnife=1 caps at WATCH even if all other GO conditions hold", () => {
    const row = makeRow({
      rsi14Pct: "0.20", mfi14Pct: "0.30",
      macdDirection: "UP", fallingKnife: 1,
    });
    const [r] = computeTechnicalRankingsV2([row]);
    assert.strictEqual(r.signal, "WATCH");
  });

  it("GATE: earningsDaysOut=5 caps at WATCH when other GO conditions hold", () => {
    const row = makeRow({
      rsi14Pct: "0.20", mfi14Pct: "0.30",
      macdDirection: "UP", fallingKnife: 0, earningsDaysOut: 5,
    });
    const [r] = computeTechnicalRankingsV2([row]);
    assert.strictEqual(r.signal, "WATCH");
  });

  it("WATCH: rsi14Pct approaching threshold (0.35) without full GO", () => {
    const row = makeRow({
      rsi14Pct: "0.35",            // between WATCH (0.40) and GO (0.30) threshold
      mfi14Pct: "0.50",            // not at GO momentum threshold
      macdDirection: "DOWN",       // no stabilization
    });
    const [r] = computeTechnicalRankingsV2([row]);
    assert.strictEqual(r.signal, "WATCH");
  });

  it("NO: high RSI percentile, no approaching conditions", () => {
    const row = makeRow({
      rsi14Pct: "0.75",
      mfi14Pct: "0.70",
      stochPct: "0.80",
      macdDirection: "DOWN",
      priceZScore: "0.5",
      earningsDaysOut: null,
    });
    const [r] = computeTechnicalRankingsV2([row]);
    assert.strictEqual(r.signal, "NO");
  });

  it("NO: technicalsCoverage < 0.5 → NO regardless of signals", () => {
    const row = makeRow({ technicalsCoverage: "0.4", rsi14Pct: "0.10" });
    const [r] = computeTechnicalRankingsV2([row]);
    assert.strictEqual(r.signal, "NO");
  });

  // ── BEARISH regime reduces trendContext score but does not zero it ───────────

  it("trendContext BEARISH > 0: regime=BEARISH gives score > 0 (0.3 not 0.0)", () => {
    const bullish = makeRow({ regime: "BULLISH", priceVsMa50Atr: "0", priceVsVwapPct: "0" });
    const bearish = makeRow({ regime: "BEARISH", priceVsMa50Atr: "0", priceVsVwapPct: "0" });
    const [sb] = computeTechnicalRankingsV2([bullish]);
    const [sr] = computeTechnicalRankingsV2([bearish]);
    // BEARISH score < BULLISH score, but bearish component > 0
    assert.ok(sr.totalScore < sb.totalScore, "BEARISH should score lower than BULLISH");
    assert.ok(sr.componentScores!["trendContext"]!.score! > 0, "BEARISH must not zero trendContext");
  });

  // ── Null handling ─────────────────────────────────────────────────────────────

  it("null component excluded from denominator: totalScore not artificially deflated", () => {
    // Remove volumeConfirm → 5 components. Score should not be 5% lower than expected.
    const withVol    = makeRow({ volumeRatioPct: "0.8" });
    const withoutVol = makeRow({ volumeRatioPct: null });
    const [sv] = computeTechnicalRankingsV2([withVol]);
    const [sn] = computeTechnicalRankingsV2([withoutVol]);
    // If we incorrectly treated null as 0, withoutVol would score lower. Both should be close.
    // (They differ by at most the volumeConfirm contribution)
    const diff = Math.abs(sv.totalScore - sn.totalScore);
    assert.ok(diff < 5, `null volumeRatioPct caused score gap of ${diff.toFixed(2)} (expected < 5)`);
  });

  // ── Output contract ──────────────────────────────────────────────────────────

  it("output has all required TechnicalScore fields", () => {
    const [r] = computeTechnicalRankingsV2([makeRow()]);
    assert.ok("ticker" in r);
    assert.ok("totalScore" in r);
    assert.ok("maxPossible" in r);
    assert.ok("rank" in r);
    assert.ok("signal" in r);
    assert.ok("tier" in r);
    assert.ok("metricScores" in r);
    assert.ok("reason" in r);
  });

  it("output has V2 optional fields", () => {
    const [r] = computeTechnicalRankingsV2([makeRow()]);
    assert.ok("gateStatus" in r);
    assert.ok("regime" in r);
    assert.ok("componentScores" in r);
    assert.ok("dataQuality" in r);
  });

  it("reason string contains signal and regime", () => {
    const [r] = computeTechnicalRankingsV2([makeRow({ regime: "BULLISH" })]);
    assert.ok(r.reason.includes("BULLISH"), `reason missing BULLISH: ${r.reason}`);
    assert.ok(r.reason.includes(r.signal),  `reason missing signal ${r.signal}: ${r.reason}`);
  });

  it("reason includes ⚠ falling knife when fallingKnife=1", () => {
    const row = makeRow({ fallingKnife: 1 });
    const [r] = computeTechnicalRankingsV2([row]);
    assert.ok(r.reason.includes("⚠"), `expected knife warning in reason: ${r.reason}`);
  });

  it("reason includes earnings notice when earningsDaysOut <= 14", () => {
    const row = makeRow({ earningsDaysOut: 10 });
    const [r] = computeTechnicalRankingsV2([row]);
    assert.ok(r.reason.includes("earnings"), `expected earnings notice: ${r.reason}`);
  });

  it("empty input returns empty array", () =>
    assert.deepStrictEqual(computeTechnicalRankingsV2([]), []));

  it("tierMap default: unknown tickers get tier 1", () => {
    const [r] = computeTechnicalRankingsV2([makeRow({ ticker: "UNKNOWN" })]);
    assert.strictEqual(r.tier, 1);
  });

  it("tierMap: explicit tier is applied", () => {
    const [r] = computeTechnicalRankingsV2([makeRow({ ticker: "AAA" })], { AAA: 3 });
    assert.strictEqual(r.tier, 3);
  });
});
