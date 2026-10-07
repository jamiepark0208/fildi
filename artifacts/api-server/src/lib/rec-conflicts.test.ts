import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectRecConflicts, conflictsForTicker } from "./rec-conflicts.ts";

describe("detectRecConflicts", () => {
  it("flags live_both_sides", () => {
    const c = detectRecConflicts({
      modelIdeas: [],
      liveDip: ["MRVL"],
      liveRally: ["mrvl"],
      liveTopPuts: [],
      liveTopCalls: [],
    });
    assert.equal(c.length, 1);
    assert.equal(c[0]!.code, "live_both_sides");
  });

  it("flags model put vs Live Top Calls with prefer model", () => {
    const c = detectRecConflicts({
      modelIdeas: [{ ticker: "AAPL", side: "put" }],
      liveDip: [],
      liveRally: [],
      liveTopPuts: [],
      liveTopCalls: ["AAPL"],
    });
    assert.equal(c[0]!.code, "model_vs_live_side");
    assert.equal(c[0]!.prefer, "model");
    assert.equal(c[0]!.severity, "warn");
  });

  it("flags model put on Live rally as info", () => {
    const c = detectRecConflicts({
      modelIdeas: [{ ticker: "NVDA", side: "put" }],
      liveDip: [],
      liveRally: ["NVDA"],
      liveTopPuts: [],
      liveTopCalls: [],
    });
    assert.equal(c[0]!.code, "model_vs_hotlist");
    assert.equal(c[0]!.severity, "info");
  });

  it("conflictsForTicker filters", () => {
    const all = detectRecConflicts({
      modelIdeas: [
        { ticker: "A", side: "put" },
        { ticker: "B", side: "call" },
      ],
      liveDip: ["B"],
      liveRally: [],
      liveTopPuts: [],
      liveTopCalls: ["A"],
    });
    assert.equal(conflictsForTicker(all, "a").length, 1);
    assert.equal(conflictsForTicker(all, "B")[0]!.code, "model_vs_hotlist");
  });

  it("Model List avoid beats a Live dip/top-put signal; off-list names ignored", () => {
    const c = detectRecConflicts({
      modelIdeas: [], liveDip: ["opEN"], liveRally: [], liveTopPuts: ["USAR"], liveTopCalls: [],
      modelAvoid: ["OPEN", "USAR", "LCID"],
    });
    assert.deepEqual(c.map(x => [x.ticker, x.code, x.prefer]).sort(), [["OPEN", "model_avoid", "model"], ["USAR", "model_avoid", "model"]]);
  });
});
