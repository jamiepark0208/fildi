import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapDay, rankUnusual } from "./options-flow.js";

const raw = (ticker: string, x: number | null, call: number, put: number, base = 10) =>
  ({ day: "2026-11-09", ticker, prints: 5, call_premium: call, put_premium: put, blocks: 0, bursts: 0, max_print: 1, premium_x_norm: x, baseline_days: base, top: [] });

describe("options flow", () => {
  it("mapDay totals premium and put share", () => {
    const d = mapDay(raw("A", 2, 300_000, 100_000));
    assert.equal(d.totalPremium, 400_000); assert.equal(d.putShare, 0.25);
  });
  it("rankUnusual needs ≥ 3× own median, ≥ 5 baseline days, ≥ $500k; sorts by multiple", () => {
    const rows = [raw("LOW", 2.9, 1e6, 0), raw("SMALL", 9, 100_000, 0), raw("THIN", 9, 1e6, 0, 3), raw("B", 4, 1e6, 0), raw("A", 8, 400_000, 200_000), raw("NONE", null, 1e6, 0)].map(mapDay);
    assert.deepEqual(rankUnusual(rows).map((r) => r.ticker), ["A", "B"]);
  });
});
