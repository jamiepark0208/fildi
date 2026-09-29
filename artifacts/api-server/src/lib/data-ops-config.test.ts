import { describe, it, expect } from "vitest";
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
    expect(CALLS_PER_TICKER.fmp).toBe(9);
  });

  it("lists yahoo before fmp", () => {
    expect(SOURCE_ORDER[0]).toBe("yahoo");
    expect(SOURCE_ORDER[SOURCE_ORDER.length - 1]).toBe("fmp");
  });

  it("maps tickers into stable cohort buckets", () => {
    expect(tickerCohort("AAPL")).toBe(tickerCohort("AAPL"));
    expect(tickerCohort("AAPL")).toBeGreaterThanOrEqual(0);
    expect(tickerCohort("AAPL")).toBeLessThan(COHORT_MODULUS);
  });

  it("todayCohort is in range", () => {
    const c = todayCohort(new Date("2026-09-28T12:00:00Z"));
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThan(COHORT_MODULUS);
  });

  it("isCohortDueToday matches tickerCohort === todayCohort", () => {
    const now = new Date("2026-09-28T12:00:00Z");
    const due = isCohortDueToday("AAPL", now);
    expect(due).toBe(tickerCohort("AAPL") === todayCohort(now));
  });
});
