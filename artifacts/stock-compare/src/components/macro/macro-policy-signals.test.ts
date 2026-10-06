import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { derivePolicySignals } from "./macro-policy-signals.ts";
import type { FedFundsCurvePoint, MacroEvent, SepData, VolatilityImplications } from "./macro-page-types";

const pt = (meetingDate: string, impliedRate: number | null, weekAgo: number | null = null): FedFundsCurvePoint => ({
  label: meetingDate.slice(0, 7), meetingDate, impliedRate, weekAgo, monthAgo: null, threeMonthAgo: null,
});
const sep = (year: number, fedRate: number): SepData => ({
  asOf: "2026-09-17",
  projections: [{ year, fedRate, gdp: null, unemployment: null, corePce: null }],
});
const vol = (level: VolatilityImplications["overall"]["level"]): VolatilityImplications => ({
  asOf: "", signals: [], overall: { level, summary: `vol ${level}` },
});
const dayOffset = (d: number) => {
  const t = new Date();
  t.setHours(12, 0, 0, 0);
  t.setDate(t.getDate() + d);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
};
const ev = (d: number, event = "CPI", importance: MacroEvent["importance"] = "high"): MacroEvent => ({
  date: dayOffset(d), event, importance,
});

/** Dots signal only: market far-point rate vs the SEP dot for that year. */
const dotsLevel = (market: number, dot: number) =>
  derivePolicySignals([pt("2027-12-15", market)], sep(2027, dot), [], undefined).signals[0]!.level;
/** WoW fallback signal only (no SEP). */
const wowLevel = (now: number, weekAgo: number) =>
  derivePolicySignals([pt("2026-10-28", now, weekAgo)], undefined, [], undefined).signals[0]!.level;
const eventLevel = (events: MacroEvent[]) =>
  derivePolicySignals([], undefined, events, undefined).signals[1]!;

describe("derivePolicySignals thresholds", () => {
  it("dots vs market |gap| 0.125 / 0.375 / 0.75", () => {
    assert.equal(dotsLevel(3.1, 3.0), "calm");
    assert.equal(dotsLevel(3.125, 3.0), "normal");
    assert.equal(dotsLevel(2.7, 3.0), "normal");
    assert.equal(dotsLevel(3.375, 3.0), "elevated");
    assert.equal(dotsLevel(2.3, 3.0), "elevated");
    assert.equal(dotsLevel(3.75, 3.0), "stress");
  });

  it("dots falls back to the last projection when the far year is missing", () => {
    const r = derivePolicySignals([pt("2030-12-15", 3.0)], sep(2028, 3.0), [], undefined);
    assert.equal(r.signals[0]!.label, "Fed Dots vs. Market");
    assert.equal(r.signals[0]!.level, "calm");
  });

  it("WoW rate-path fallback |change| 0.03 / 0.08 / 0.15", () => {
    assert.equal(wowLevel(4.02, 4.0), "calm");
    assert.equal(wowLevel(4.03, 4.0), "normal");
    assert.equal(wowLevel(3.93, 4.0), "normal");
    assert.equal(wowLevel(4.08, 4.0), "elevated");
    assert.equal(wowLevel(4.15, 4.0), "stress");
  });

  it("no curve → unknown rate path", () => {
    assert.equal(derivePolicySignals([], undefined, [], undefined).signals[0]!.level, "unknown");
  });

  it("next catalyst days 0 / 2 / 7", () => {
    assert.equal(eventLevel([ev(0)]).level, "stress");
    assert.equal(eventLevel([ev(1)]).level, "elevated");
    assert.equal(eventLevel([ev(2)]).level, "elevated");
    assert.equal(eventLevel([ev(3)]).level, "normal");
    assert.equal(eventLevel([ev(7)]).level, "normal");
    assert.equal(eventLevel([ev(8)]).level, "calm");
  });

  it("catalyst picks the nearest future high-importance or FOMC/CPI/NFP event", () => {
    const s = eventLevel([ev(-1), ev(1, "Retail sales", "medium"), ev(5, "FOMC decision", "medium"), ev(3, "GDP", "high")]);
    assert.ok(s.readout.startsWith("GDP"));
    assert.equal(eventLevel([ev(1, "Retail sales", "medium")]).level, "unknown");
  });

  it("vol signal reuses the volatility card's overall level", () => {
    assert.equal(derivePolicySignals([], undefined, [], vol("stress")).signals[2]!.level, "stress");
    assert.equal(derivePolicySignals([], undefined, [], undefined).signals[2]!.level, "unknown");
  });

  it("overall averages known signals (compound case)", () => {
    // dots stress (-2) + catalyst tomorrow elevated (-1) + vol calm (+1) → -0.67 → elevated
    const r = derivePolicySignals([pt("2027-12-15", 4.0)], sep(2027, 3.0), [ev(1)], vol("calm"));
    assert.equal(r.overall.level, "elevated");
    assert.equal(r.nextEvent?.event, "CPI");
    assert.equal(derivePolicySignals([pt("2027-12-15", 3.0)], sep(2027, 3.0), [ev(10)], vol("calm")).overall.level, "calm");
    assert.equal(derivePolicySignals([pt("2027-12-15", 4.0)], sep(2027, 3.0), [ev(0)], vol("stress")).overall.level, "stress");
    assert.equal(derivePolicySignals([], undefined, [], undefined).overall.level, "normal");
  });
});
