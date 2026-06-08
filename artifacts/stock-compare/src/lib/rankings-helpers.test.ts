import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { safeDiv, winsorize, normalize, MIN_Z_N } from "./rankings-helpers.ts";

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
