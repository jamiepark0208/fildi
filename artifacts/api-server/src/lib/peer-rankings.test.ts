import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TickerFundamentalsRow } from "@workspace/db";
import { rankCompetitors } from "./peer-rankings.ts";

function fund(ticker: string, grossMargin: string, fundTotalScore: string | null): TickerFundamentalsRow {
  return { ticker, grossMargin, fundTotalScore } as TickerFundamentalsRow;
}

describe("rankCompetitors cohort", () => {
  const sub = fund("SUB", "0.50", null);
  const peer = fund("PEER", "0.10", "80");
  const fill = fund("FILL", "0.90", null);

  it("ranks only the taxonomy group and ignores extra fund rows", () => {
    const group = rankCompetitors("SUB", ["PEER"], [], [sub, peer]);
    const withFillRow = rankCompetitors("SUB", ["PEER"], [], [sub, peer, fill]);
    const mixed = rankCompetitors("SUB", ["PEER", "FILL"], [], [sub, peer, fill]);

    assert.deepEqual(group.map((r) => r.ticker).sort(), ["PEER", "SUB"]);
    assert.deepEqual(withFillRow.map((r) => r.ticker).sort(), ["PEER", "SUB"]);
    assert.deepEqual(group.map((r) => r.rank), [1, 2].slice(0, group.length));
    assert.ok(group.every((r, i) => r.rank === i + 1));

    const subGroup = group.find((r) => r.ticker === "SUB")!;
    const subExtra = withFillRow.find((r) => r.ticker === "SUB")!;
    const subMixed = mixed.find((r) => r.ticker === "SUB")!;
    assert.equal(subGroup.fundScore, subExtra.fundScore);
    assert.notEqual(subGroup.fundScore, subMixed.fundScore);
    assert.equal(mixed.some((r) => r.ticker === "FILL"), true);
  });
});
