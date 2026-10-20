import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  afterSkewSurveyWindow,
  ptMinutesOfDay,
  schwab1mUniverse,
} from "./schwab-1m-poll.js";

describe("schwab1mUniverse", () => {
  it("starts with SPY and caps at 20", () => {
    const u = schwab1mUniverse();
    assert.equal(u[0], "SPY");
    assert.ok(u.length <= 20);
    assert.equal(new Set(u).size, u.length);
  });
});

describe("afterSkewSurveyWindow", () => {
  it("false before 07:05 PT, true after", () => {
    // 2026-10-20 is PDT (UTC-7): 14:00 UTC = 07:00 PT, 14:05 UTC = 07:05 PT
    assert.equal(afterSkewSurveyWindow(new Date("2026-10-20T14:00:00Z")), false);
    assert.equal(afterSkewSurveyWindow(new Date("2026-10-20T14:05:00Z")), true);
    assert.equal(ptMinutesOfDay(new Date("2026-10-20T14:05:00Z")), 7 * 60 + 5);
  });
});
