import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dispersionNote, earningsHistoryNote, earningsPremium, expiryAfter, nearestIvExpiry } from "./lseg-earnings.ts";

describe("expiryAfter", () => {
  it("first Friday strictly after the report", () => {
    assert.equal(expiryAfter("2026-10-27"), "2026-10-30"); // Tue → Fri
    assert.equal(expiryAfter("2026-10-30"), "2026-11-06"); // Fri → next Fri
  });
});

describe("nearestIvExpiry", () => {
  it("first Friday ≥2 days out", () => {
    assert.equal(nearestIvExpiry("2026-10-04"), "2026-10-09"); // Sun → Fri
    assert.equal(nearestIvExpiry("2026-10-08"), "2026-10-16"); // Thu → next Fri (1 day is < 2 DTE)
  });
});

describe("earningsPremium", () => {
  const today = "2026-10-04"; // nearest IV expiry = 2026-10-09
  it("rich when IV prices far more than history", () => {
    const r = earningsPremium({ pastMovesPct: [2, -1.5, 2.5, -2], ivPct: 70, rvPct: 25, reportDate: "2026-10-07", today });
    assert.equal(r?.verdict, "rich");
    assert.equal(r?.tone, "good");
  });
  it("cheap when history moves more than IV prices (ONDS-like ±12% reports)", () => {
    const r = earningsPremium({ pastMovesPct: [3.7, 26.5, -11.6, 19.1, 25.1, -2.2, -3.7, -2, -14.9], ivPct: 58, rvPct: 35, reportDate: "2026-10-07", today });
    assert.equal(r?.verdict, "cheap");
    assert.match(r!.text, /CHEAP/);
  });
  it("no verdict when today's IV expiry is before the report (the AMD/META 'cheap' artifact)", () => {
    assert.equal(earningsPremium({ pastMovesPct: [8, 8, 8, 8], ivPct: 50, rvPct: 40, reportDate: "2026-10-20", today }), null);
  });
  it("needs ≥4 reports and a date", () => {
    assert.equal(earningsPremium({ pastMovesPct: [5, 5, 5], ivPct: 50, rvPct: 40, reportDate: "2026-10-07", today }), null);
    assert.equal(earningsPremium({ pastMovesPct: [5, 5, 5, 5], ivPct: 50, rvPct: 40, reportDate: null, today }), null);
  });
});

describe("dispersionNote", () => {
  it("flags wide analyst disagreement only", () => {
    assert.ok(dispersionNote(-3.77, 2.34, 7)); // GOSS-like
    assert.equal(dispersionNote(2.48, 0.065, 42), null); // NVDA-like tight
    assert.equal(dispersionNote(0.01, 0.05, 5), null); // near-zero mean → meaningless ratio
  });
});

describe("earningsHistoryNote", () => {
  it("summarises typical and worst move", () => {
    const n = earningsHistoryNote([3.7, 26.5, -11.6, 19.1]);
    assert.match(n!.text, /±15\.2%.*worst ±26\.5%/);
    assert.equal(earningsHistoryNote([1, 2, 3]), null);
  });
});
