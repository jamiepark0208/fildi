import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  tickerCohort,
  todayCohort,
  isCohortDueToday,
  COHORT_MODULUS,
  CALLS_PER_TICKER,
  SOURCE_ORDER,
} from "../lib/data-ops-config.js";

describe("data-ops-config", () => {
  it("keeps FMP call cost at 9 endpoints", () => {
    assert.equal(CALLS_PER_TICKER.fmp, 9);
  });

  it("lists yahoo before fmp", () => {
    assert.equal(SOURCE_ORDER[0], "yahoo");
    assert.equal(SOURCE_ORDER[SOURCE_ORDER.length - 1], "fmp");
  });

  it("maps tickers into stable cohort buckets", () => {
    assert.equal(tickerCohort("AAPL"), tickerCohort("AAPL"));
    assert.ok(tickerCohort("AAPL") >= 0);
    assert.ok(tickerCohort("AAPL") < COHORT_MODULUS);
  });

  it("todayCohort is in range", () => {
    const c = todayCohort(new Date("2026-09-28T12:00:00Z"));
    assert.ok(c >= 0);
    assert.ok(c < COHORT_MODULUS);
  });

  it("isCohortDueToday matches tickerCohort === todayCohort", () => {
    const now = new Date("2026-09-28T12:00:00Z");
    const due = isCohortDueToday("AAPL", now);
    assert.equal(due, tickerCohort("AAPL") === todayCohort(now));
  });
});
