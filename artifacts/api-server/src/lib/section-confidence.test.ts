import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  setupConfidence,
  trimConfidence,
  urgencyConfidence,
  attachSectionConfidence,
  type ConfidenceItem,
  type SectionConfidence,
} from "./section-confidence.js";

describe("setupConfidence", () => {
  it("scores ok status higher than warn", () => {
    const ok = setupConfidence({ ticker: "A", status: "ok" });
    const warn = setupConfidence({ ticker: "B", status: "warn" });
    assert.ok(ok.score > warn.score);
    assert.equal(ok.kind, "setup");
    assert.match(ok.basis, /not call option score/);
  });

  it("blends win rate when present", () => {
    const withWin = setupConfidence({
      ticker: "A",
      status: "ok",
      contract: { win: { rate: 0.9 } },
    });
    const noWin = setupConfidence({ ticker: "B", status: "ok" });
    assert.ok(withWin.score >= noWin.score - 5);
    assert.match(withWin.basis, /hist win/);
  });
});

describe("trimConfidence", () => {
  it("ignores falling-knife context-only lines", () => {
    const a = trimConfidence({
      ticker: "X",
      flags: ["high distress risk (StarMine credit 8/100)", "analysts cutting estimates (ARM 15/100)"],
      why: ["falling-knife chart (context only, not counted: S058)"],
    });
    const b = trimConfidence({
      ticker: "Y",
      flags: ["high distress risk (StarMine credit 8/100)", "analysts cutting estimates (ARM 15/100)"],
    });
    assert.equal(a.score, b.score);
    assert.match(a.basis, /credit distress/);
  });

  it("ranks more flags higher", () => {
    const two = trimConfidence({
      ticker: "A",
      flags: ["flag one", "flag two"],
    });
    const three = trimConfidence({
      ticker: "B",
      flags: ["flag one", "flag two", "flag three"],
    });
    assert.ok(three.score > two.score);
  });
});

describe("urgencyConfidence", () => {
  it("puts ITM above expiry-only", () => {
    const itm = urgencyConfidence({ ticker: "A", why: ["in the money: T $9 vs strike $10"] });
    const exp = urgencyConfidence({ ticker: "B", why: ["expires in 5d (2026-11-01): let expire, roll, or close"] });
    assert.ok(itm.score > exp.score);
    assert.equal(itm.kind, "urgency");
  });
});

describe("attachSectionConfidence", () => {
  it("assigns within-folder ranks by score desc", () => {
    const items: Array<ConfidenceItem & { confidence?: SectionConfidence }> = [
      { ticker: "LOW", status: "warn" },
      { ticker: "HIGH", status: "ok", contract: { win: { rate: 0.85 } } },
    ];
    attachSectionConfidence("sell_calls", items);
    assert.equal(items[1]!.confidence!.rank, 1);
    assert.equal(items[0]!.confidence!.rank, 2);
  });

  it("no-ops on sell_puts", () => {
    const items: Array<ConfidenceItem & { confidence?: SectionConfidence }> = [
      { ticker: "A", status: "ok" },
    ];
    attachSectionConfidence("sell_puts", items);
    assert.equal(items[0]!.confidence, undefined);
  });
});
