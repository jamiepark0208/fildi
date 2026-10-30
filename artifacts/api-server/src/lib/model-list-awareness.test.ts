import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bookGroupPromptLine, newsPromptLine } from "./model-list-awareness.ts";

describe("model-list-awareness", () => {
  it("formats book_group for explain", () => {
    const line = bookGroupPromptLine("MRVL", {
      list: ["MRVL", "AMAT", "KLAC", "TXN", "VRT"],
      held: ["POET"],
      corr: 0.63,
      same_expiry: 5,
      of_list: 10,
    });
    assert.ok(line?.includes("Moves with AMAT KLAC TXN VRT"));
    assert.ok(line?.includes("corr 0.63"));
    assert.ok(line?.includes("held POET"));
  });

  it("formats news gap for explain", () => {
    const line = newsPromptLine({
      gap: { move_pct: -13, sigma: 3.3, vs_close: "2026-10-28" },
      filings_8k: [],
      note: "check the news before selling (awareness, not a gate)",
    });
    assert.match(line ?? "", /News: -13 % vs 2026-10-28 close \(3.3σ\)/);
    assert.ok(line?.includes("check the news"));
  });
});
