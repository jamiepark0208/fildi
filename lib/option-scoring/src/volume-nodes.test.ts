import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeVolumeNodes, scoreNodeGap, type DailyBar } from "./volume-nodes.ts";
import { computeTechnicalRankingsV2, type TechnicalRow } from "./technical-rankings.ts";

describe("volume nodes (S045)", () => {
  // 40 quiet bars around 100, 20 heavy bars around 90 → strongest node near 90.
  const bars: DailyBar[] = [
    ...Array.from({ length: 40 }, () => ({ high: 101, low: 99, volume: 1_000 })),
    ...Array.from({ length: 20 }, () => ({ high: 91, low: 89, volume: 50_000 })),
  ];

  it("finds the heavy-volume price as the top node", () => {
    const nodes = computeVolumeNodes(bars);
    assert.ok(nodes.length > 0);
    assert.ok(Math.abs(nodes[0]! - 90) < 1, `top node ${nodes[0]}`);
  });

  it("needs ≥ 30 bars", () => {
    assert.deepEqual(computeVolumeNodes(bars.slice(0, 20)), []);
  });

  it("scores 0 when a node sits between strike and spot, 1 when clear, null when unknown", () => {
    assert.equal(scoreNodeGap(85, 100, [90]), 0);
    assert.equal(scoreNodeGap(95, 100, [90]), 1);
    assert.equal(scoreNodeGap(95, 100, []), null);
    assert.equal(scoreNodeGap(95, 100, null), null);
  });
});

describe("negative tech weight = lower is better (A167)", () => {
  it("inverts the component instead of dropping it", () => {
    const rows = [{ ticker: "AAA", volumeRatioPct: 0.8 }, { ticker: "BBB", volumeRatioPct: 0.3 }] as unknown as TechnicalRow[];
    const only = (k: string, w: number) => ({
      oversoldDepth: 0, reversalSignal: 0, volatilityState: 0, trendContext: 0,
      optionsFlow: 0, relativePressure: 0, analystUpside: 0, volumeConfirm: 0, [k]: w,
    });
    const pos = computeTechnicalRankingsV2(rows, {}, only("volumeConfirm", 1), "put");
    const neg = computeTechnicalRankingsV2(rows, {}, only("volumeConfirm", -1), "put");
    const total = (list: typeof pos, t: string) => list.find((s) => s.ticker === t)!.totalScore;
    assert.ok(Math.abs(total(pos, "AAA") - 80) < 1e-6);
    assert.ok(Math.abs(total(neg, "AAA") - 20) < 1e-6);
    assert.ok(total(neg, "BBB") > total(neg, "AAA"));
  });
});
