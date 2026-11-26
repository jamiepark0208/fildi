import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitReportSessions } from "./earnings-reaction.js";

describe("earnings reaction sessions", () => {
  it("uses Friday's close when the report date is a Saturday", () => {
    const { pre, post } = splitReportSessions("2026-11-21", [
      { date: "2026-11-20", c: 100 },
      { date: "2026-11-23", c: 110 },
      { date: "2026-11-24", c: 108 },
    ]);
    assert.equal(pre?.date, "2026-11-20");
    assert.equal(post[0]?.c, 110);
    assert.equal(post.length, 2);
  });

  it("treats a weekday report as after the close", () => {
    const { pre, post } = splitReportSessions("2026-11-20", [
      { date: "2026-11-19", c: 90 },
      { date: "2026-11-20", c: 100 },
      { date: "2026-11-21", c: 104 },
    ]);
    assert.equal(pre?.c, 100);
    assert.equal(post[0]?.c, 104);
  });

  it("stays pending until the next session exists", () => {
    const { pre, post } = splitReportSessions("2026-11-20", [
      { date: "2026-11-20", c: 100 },
    ]);
    assert.equal(pre?.c, 100);
    assert.equal(post.length, 0);
  });

  /** Calendar has no BMO flag — after-close assumed (see hover on /today). */
  it("AMC: day 1 is the first close after the report date", () => {
    const { pre, post } = splitReportSessions("2026-11-20", [
      { date: "2026-11-19", c: 90 },
      { date: "2026-11-20", c: 100 },
      { date: "2026-11-21", c: 105 },
    ]);
    assert.equal(pre?.date, "2026-11-20");
    assert.equal(post[0]?.date, "2026-11-21");
    assert.ok(Math.abs(post[0].c / pre.c - 1.05) < 1e-9);
  });

  it("BMO (after-close assumed): uses same-day close as pre, not prior session", () => {
    const { pre, post } = splitReportSessions("2026-11-24", [
      { date: "2026-11-21", c: 90 },
      { date: "2026-11-24", c: 100 },
      { date: "2026-11-25", c: 98 },
    ]);
    assert.equal(pre?.date, "2026-11-24");
    assert.equal(post[0]?.date, "2026-11-25");
  });
});
