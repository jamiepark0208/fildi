/**
 * A255 — put-edge TS loader: freshness, ETF exclusion, universe rank, shadow-only contract.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computePutEdgeFactorsFromBars,
  PUT_EDGE_MAX_IV_AGE_DAYS,
  type PutEdgeBar,
} from "./put-edge-factors.js";

const AS_OF = "2026-10-24";

function ymdOffset(base: string, daysBack: number): string {
  const [y, m, d] = base.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() - daysBack);
  return dt.toISOString().slice(0, 10);
}

/** 70 sessions ending `lastAge` days before as-of; noisy returns → RV20 ~ mid-teens %. */
function makeBars(lastAge: number, ivScale = 30): PutEdgeBar[] {
  const out: PutEdgeBar[] = [];
  let close = 100;
  // Alternating ± moves so pstdev(lr) is meaningful (constant +1%/d → tiny RV).
  const rets = [0.02, -0.015, 0.018, -0.012, 0.025, -0.02, 0.01, -0.008];
  for (let i = 69; i >= 0; i--) {
    const age = lastAge + i;
    close *= 1 + rets[i % rets.length]!;
    const iv = ivScale + (i % 7) * 0.3;
    out.push({ date: ymdOffset(AS_OF, age), close, iv });
  }
  return out;
}

function universe(n = 35, lastAge = 0): Map<string, PutEdgeBar[]> {
  const m = new Map<string, PutEdgeBar[]>();
  for (let i = 0; i < n; i++) {
    const t = `T${String(i).padStart(2, "0")}`;
    // Spread IV scales so ranks differ
    m.set(t, makeBars(lastAge, 20 + i));
  }
  return m;
}

describe("computePutEdgeFactorsFromBars (A255)", () => {
  it("drops names whose latest IV bar is older than 7 days", () => {
    const fresh = universe(35, 0);
    const stale = universe(35, PUT_EDGE_MAX_IV_AGE_DAYS + 1);
    assert.ok(computePutEdgeFactorsFromBars(fresh, AS_OF).size >= 30);
    assert.equal(computePutEdgeFactorsFromBars(stale, AS_OF).size, 0);
  });

  it("excludes ETFs from ranking (does not shift stock percentiles)", () => {
    const m = universe(35, 0);
    // High-IV ETF would top the ivRv rank if included
    m.set("SPY", makeBars(0, 200));
    const withEtfFiltered = computePutEdgeFactorsFromBars(m, AS_OF);
    assert.equal(withEtfFiltered.has("SPY"), false);
    const noEtf = universe(35, 0);
    const base = computePutEdgeFactorsFromBars(noEtf, AS_OF);
    // Same stock percentile whether or not an excluded ETF was in the map
    assert.equal(withEtfFiltered.get("T00")?.ivRvPct, base.get("T00")?.ivRvPct);
  });

  it("one-ticker request matches universe percentile for that name", () => {
    const m = universe(35, 0);
    const all = computePutEdgeFactorsFromBars(m, AS_OF);
    const one = computePutEdgeFactorsFromBars(m, AS_OF, ["T10"]);
    assert.equal(one.size, 1);
    assert.equal(one.get("T10")?.ivRvPct, all.get("T10")?.ivRvPct);
    assert.equal(one.get("T10")?.volOfVolPct, all.get("T10")?.volOfVolPct);
  });

  it("keeps a name whose IV bar is exactly 7 days old", () => {
    const m = universe(35, PUT_EDGE_MAX_IV_AGE_DAYS);
    assert.ok(computePutEdgeFactorsFromBars(m, AS_OF).size >= 30);
  });
});
