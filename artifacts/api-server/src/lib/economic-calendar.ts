/**
 * A49 (narrowed, display only): live macro event calendar.
 * Finnhub /calendar/economic when keyed; else falls back to macro-static ECONOMIC_EVENTS.
 * No score / hold-roll-trim — S026 failed event-week edge.
 */
import { ECONOMIC_EVENTS } from "./macro-static.js";
import type { MacroEvent } from "./macro-shared-types.js";
import { logApiCall } from "./api-logger.js";

export type CalendarEvent = MacroEvent & {
  timeEt?: string | null;
  consensus?: string | null;
  tier?: "T1" | "T2" | "T3";
  source: "finnhub" | "static";
};

const T1 = /cpi|fomc|nonfarm|payroll|nfp|unemployment rate/i;
const T2 = /ppi|retail sales|pce|gdp|jolts|adp/i;

function tierOf(name: string): "T1" | "T2" | "T3" {
  if (T1.test(name)) return "T1";
  if (T2.test(name)) return "T2";
  return "T3";
}

function importanceOf(tier: "T1" | "T2" | "T3"): MacroEvent["importance"] {
  return tier === "T1" ? "high" : tier === "T2" ? "medium" : "low";
}

let cache: { at: number; events: CalendarEvent[] } | null = null;
const TTL_MS = 6 * 3600_000;

export async function getEconomicCalendar(from: string, to: string): Promise<CalendarEvent[]> {
  if (cache && Date.now() - cache.at < TTL_MS) {
    return cache.events.filter((e) => e.date >= from && e.date <= to);
  }
  const key = process.env.FINNHUB_API_KEY || process.env.FINNHUB_TOKEN;
  if (!key) {
    return ECONOMIC_EVENTS.filter((e) => e.date >= from).map((e) => ({
      ...e,
      tier: tierOf(e.event),
      source: "static" as const,
    }));
  }
  const url = `https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${to}&token=${key}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    void logApiCall({
      source: "finnhub",
      fn: "calendar/economic",
      trigger: "a49-display",
      outcome: res.ok ? "success" : "failure",
      error: res.ok ? undefined : `HTTP ${res.status}`,
      requestedFields: "calendar/economic",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      economicCalendar?: Array<{
        date?: string;
        time?: string;
        event?: string;
        country?: string;
        impact?: string;
        estimate?: number | string | null;
      }>;
    };
    const us = (body.economicCalendar ?? []).filter(
      (x) => (x.country === "US" || x.country === "United States") && x.date && x.event,
    );
    const events: CalendarEvent[] = us.map((x) => {
      const tier = tierOf(x.event!);
      const imp = (x.impact || "").toLowerCase();
      const importance: MacroEvent["importance"] =
        imp === "high" || imp === "3" ? "high" : imp === "medium" || imp === "2" ? "medium" : importanceOf(tier);
      return {
        date: x.date!.slice(0, 10),
        event: x.event!,
        importance,
        timeEt: x.time ?? null,
        consensus: x.estimate != null ? String(x.estimate) : null,
        tier,
        source: "finnhub",
      };
    });
    // Merge static FOMC/CPI we trust when Finnhub is thin on Fed dates
    const have = new Set(events.map((e) => `${e.date}|${e.event}`));
    for (const e of ECONOMIC_EVENTS) {
      if (e.date < from || e.date > to) continue;
      const k = `${e.date}|${e.event}`;
      if (!have.has(k) && /fomc|cpi/i.test(e.event)) {
        events.push({ ...e, tier: tierOf(e.event), source: "static" });
      }
    }
    events.sort((a, b) => a.date.localeCompare(b.date) || a.event.localeCompare(b.event));
    cache = { at: Date.now(), events };
    return events;
  } catch {
    return ECONOMIC_EVENTS.filter((e) => e.date >= from).map((e) => ({
      ...e,
      tier: tierOf(e.event),
      source: "static" as const,
    }));
  }
}
