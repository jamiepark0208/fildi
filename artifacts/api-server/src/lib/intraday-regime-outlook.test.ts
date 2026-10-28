import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolvedPrefix, outlookCacheKey } from "./intraday-regime-outlook.js";
import type { RegimeCheckpoint } from "./intraday-regime.js";

function cp(partial: Partial<RegimeCheckpoint> & Pick<RegimeCheckpoint, "minAfterOpen" | "status">): RegimeCheckpoint {
  return {
    timestamp: 0,
    direction: null,
    confidence: null,
    spy: null,
    qqq: null,
    breadth: null,
    label: "",
    computedLate: false,
    factors: [],
    ...partial,
  };
}

describe("regime outlook helpers", () => {
  it("builds prefix from resolved non-null directions only", () => {
    const checkpoints = [
      cp({ minAfterOpen: 15, status: "resolved", direction: null }),
      cp({ minAfterOpen: 30, status: "resolved", direction: "bullish" }),
      cp({ minAfterOpen: 45, status: "resolved", direction: "mixed" }),
      cp({ minAfterOpen: 60, status: "pending", direction: null }),
    ];
    assert.deepEqual(resolvedPrefix(checkpoints), [
      { min: 30, dir: "bullish" },
      { min: 45, dir: "mixed" },
    ]);
  });

  it("cache key includes prefix path", () => {
    const checkpoints = [
      cp({ minAfterOpen: 30, status: "resolved", direction: "bearish" }),
      cp({ minAfterOpen: 45, status: "pending" }),
    ];
    assert.match(outlookCacheKey(checkpoints), /v2:.*:30:bearish$/);
  });

  it("empty prefix cache key ends with :empty", () => {
    assert.match(outlookCacheKey([cp({ minAfterOpen: 30, status: "pending" })]), /v2:.*:empty$/);
  });
});
