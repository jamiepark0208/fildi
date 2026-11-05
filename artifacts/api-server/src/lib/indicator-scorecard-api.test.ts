import test from "node:test";
import assert from "node:assert/strict";
import { shapeScorecard, type IndMeta } from "./indicator-scorecard-api.js";

const meta: IndMeta[] = [
  { id: "ut", label: "UT", version: 1, title: "t", source: { url: "u", author: "a" }, timeframes: ["5m"] },
  { id: "zz", label: "ZZ", version: 1, title: "t", source: { url: "u", author: "a" }, timeframes: ["5m"] },
];
const row = (o: Record<string, unknown>) => ({ indicatorId: "ut", version: 1, kind: "ALL", tf: "ALL", n: 10, days: 3, verdict: "too early", needMore: 5, pWin: "55.2", pWinLo: "40", pWinHi: "70", randomWinPct: "50", bestStructure: null, structures: null, hitPct: null, placeboHitPct: "1.5", gradedThrough: null, ...o }) as any;

test("shape: numerics, ordering, ungraded indicator, version filter", () => {
  const out = shapeScorecard([row({ kind: "Buy", tf: "5m" }), row({}), row({ version: 2 })], meta);
  assert.equal(out[0]!.cells.length, 2);
  assert.equal(out[0]!.cells[0]!.kind, "ALL");
  assert.equal(out[0]!.cells[0]!.pWin, 55.2);
  assert.equal(out[0]!.cells[0]!.oldHitPct, null);
  assert.equal(out[0]!.cells[0]!.oldPlaceboHitPct, 1.5);
  assert.equal(out[1]!.graded, false);
});
