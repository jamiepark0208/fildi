import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeRefreshDaysLeft } from "./schwab-auth.js";

describe("computeRefreshDaysLeft", () => {
  it("anchors 7d clock on obtainedAt (access refresh must not reset)", () => {
    const now = Date.parse("2026-10-04T12:00:00Z");
    const obtainedAt = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5d ago
    const days = computeRefreshDaysLeft(obtainedAt, now);
    assert.ok(days != null);
    assert.ok(days! > 1.9 && days! < 2.1, `expected ~2d left, got ${days}`);
  });

  it("returns 0 when past 7d", () => {
    const now = Date.parse("2026-10-04T12:00:00Z");
    const obtainedAt = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();
    assert.equal(computeRefreshDaysLeft(obtainedAt, now), 0);
  });

  it("returns null for garbage obtainedAt", () => {
    assert.equal(computeRefreshDaysLeft("not-a-date"), null);
  });

  it("≤2d is the A73 warn threshold (banner)", () => {
    const now = Date.parse("2026-10-14T12:00:00Z");
    const obtainedAt = new Date(now - 5.5 * 24 * 60 * 60 * 1000).toISOString(); // 5.5d ago → ~1.5d left
    const days = computeRefreshDaysLeft(obtainedAt, now);
    assert.ok(days != null && days! <= 2 && days! > 1, `expected 1–2d left, got ${days}`);
  });
});
