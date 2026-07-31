// Core FRED fetch helpers. Extracted verbatim from macro-data.ts — no behavior change.
import { logApiCall } from "../api-logger.js";
import type { FredSeries, ChartPoint } from "../macro-data.js";

export function nullSeries(unit = ""): FredSeries {
  return { value: null, prev: null, change: null, changePct: null, yoy: null, date: null, unit };
}

async function fetchFredSeriesData(
  seriesId: string,
  observationStart?: string
): Promise<{ date: string; val: number }[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const params = new URLSearchParams({ id: seriesId });
    if (observationStart) params.set("cosd", observationStart);
    const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?${params.toString()}`;
    const res = await fetch(url, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      logApiCall({ source: "fred", fn: "fetchFredSeriesData", trigger: "macro data refresh", outcome: "failure", error: `HTTP ${res.status}`, requestedFields: seriesId });
      return [];
    }
    const text = await res.text();
    const lines = text.trim().split("\n").slice(1);
    const valid: { date: string; val: number }[] = [];
    for (const line of lines) {
      const [date, rawVal] = line.split(",");
      if (!rawVal || rawVal.trim() === "." || rawVal.trim() === "") continue;
      const val = parseFloat(rawVal.trim());
      if (isNaN(val)) continue;
      valid.push({ date: date.trim(), val });
    }
    logApiCall({ source: "fred", fn: "fetchFredSeriesData", trigger: "macro data refresh", outcome: "success", fieldsReturned: valid.length });
    return valid;
  } catch (err: any) {
    logApiCall({ source: "fred", fn: "fetchFredSeriesData", trigger: "macro data refresh", outcome: "failure", error: String(err?.message ?? err), requestedFields: seriesId });
    return [];
  }
}

export async function fetchFredLatest(
  seriesId: string,
  unit = "",
  periodsForYoY = 0
): Promise<FredSeries> {
  const valid = await fetchFredSeriesData(seriesId);
  if (valid.length === 0) return nullSeries(unit);

  const current = valid[valid.length - 1];
  const prev = valid.length >= 2 ? valid[valid.length - 2] : null;
  const yearAgoIdx = valid.length - 1 - periodsForYoY;
  const yearAgo = periodsForYoY > 0 && yearAgoIdx >= 0 ? valid[yearAgoIdx] : null;

  const value = current.val;
  const prevVal = prev?.val ?? null;
  const change = prevVal !== null ? value - prevVal : null;
  const changePct =
    prevVal !== null && prevVal !== 0
      ? ((value - prevVal) / Math.abs(prevVal)) * 100
      : null;
  const yoy =
    yearAgo !== null && yearAgo.val !== 0
      ? ((value - yearAgo.val) / Math.abs(yearAgo.val)) * 100
      : null;

  return { value, prev: prevVal, change, changePct, yoy, date: current.date, unit };
}

export async function fetchFredHistory(
  seriesId: string,
  days = 365
): Promise<ChartPoint[]> {
  const valid = await fetchFredSeriesData(seriesId);
  if (valid.length === 0) return [];
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return valid
    .filter((p) => new Date(p.date) >= cutoff)
    .map((p) => ({ date: p.date, value: p.val }));
}

/** Fetch FRED indicator history for chart, computing YoY if requested */
export async function fetchIndicatorHistory(
  seriesId: string,
  periodsForYoY = 0,
  days = 3650
): Promise<ChartPoint[]> {
  const extraDays = periodsForYoY > 0 ? 400 : 0;
  const valid = await fetchFredSeriesData(
    seriesId,
    new Date(Date.now() - (days + extraDays) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  );
  if (valid.length === 0) return [];

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  if (periodsForYoY === 0) {
    return valid
      .filter((p) => new Date(p.date) >= cutoff)
      .map((p) => ({ date: p.date, value: p.val }));
  }

  // Compute YoY for price-index series
  return valid
    .filter((p, idx) => {
      const yearAgoIdx = idx - periodsForYoY;
      return new Date(p.date) >= cutoff && yearAgoIdx >= 0;
    })
    .map((p, _idx, arr) => {
      const origIdx = valid.indexOf(p);
      const yearAgoIdx = origIdx - periodsForYoY;
      const yearAgo = yearAgoIdx >= 0 ? valid[yearAgoIdx] : null;
      const yoy = yearAgo && yearAgo.val !== 0
        ? ((p.val - yearAgo.val) / Math.abs(yearAgo.val)) * 100
        : null;
      return { date: p.date, value: yoy ?? p.val };
    });
}
