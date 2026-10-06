// Fed funds curve (CME 30-Day Fed Funds Futures). Extracted verbatim from macro-data.ts — no behavior change.
import { yahooFinance } from "../yahoo-client.js";
import type { FedFundsCurvePoint } from "../macro-data.js";
import { fetchYieldCurve } from "./macro-yields.js";

const MONTH_CODES = ["F", "G", "H", "J", "K", "M", "N", "Q", "U", "V", "X", "Z"];

// Upcoming FOMC meeting dates — update periodically
const FOMC_MEETINGS = [
  { date: "2026-06-18", label: "Jun '26", month: 5,  year: 2026 },
  { date: "2026-07-29", label: "Jul '26", month: 6,  year: 2026 },
  { date: "2026-09-17", label: "Sep '26", month: 8,  year: 2026 },
  { date: "2026-10-29", label: "Oct '26", month: 9,  year: 2026 },
  { date: "2026-12-10", label: "Dec '26", month: 11, year: 2026 },
  { date: "2027-01-28", label: "Jan '27", month: 0,  year: 2027 },
  { date: "2027-03-19", label: "Mar '27", month: 2,  year: 2027 },
  { date: "2027-05-06", label: "May '27", month: 4,  year: 2027 },
  { date: "2027-07-29", label: "Jul '27", month: 6,  year: 2027 },
];

function getZQTicker(month: number, year: number): string {
  const code = MONTH_CODES[month];
  const yy = year % 100;
  return `ZQ${code}${yy < 10 ? "0" + yy : yy}.CBT`;
}

export async function fetchFedFundsCurve(): Promise<FedFundsCurvePoint[]> {
  const now = new Date();
  const upcoming = FOMC_MEETINGS.filter((m) => new Date(m.date) >= now).slice(0, 7);
  if (upcoming.length === 0) return [];

  const period1 = new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000);

  const results = await Promise.allSettled(
    upcoming.map(async (m) => {
      const ticker = getZQTicker(m.month, m.year);
      const [quoteResult, chartResult] = await Promise.allSettled([
        yahooFinance.quote(ticker, {}, { validateResult: false }),
        yahooFinance.chart(ticker, { period1, interval: "1d" }, { validateResult: false }),
      ]);

      const price =
        quoteResult.status === "fulfilled"
          ? (quoteResult.value as Record<string, unknown>)?.["regularMarketPrice"] as number | null
          : null;
      const impliedRate = price != null ? parseFloat((100 - price).toFixed(3)) : null;

      const quotes =
        chartResult.status === "fulfilled"
          ? ((chartResult.value as Record<string, unknown>)?.["quotes"] as Array<{date: unknown; close: number | null}> ?? [])
          : [];

      const findHistRate = (daysAgo: number): number | null => {
        const target = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
        const targetStr = target.toISOString().slice(0, 10);
        let best: number | null = null;
        for (const q of quotes) {
          if (q.close == null) continue;
          const d = (q.date instanceof Date ? q.date : new Date(q.date as string))
            .toISOString()
            .slice(0, 10);
          if (d <= targetStr) best = parseFloat((100 - q.close).toFixed(3));
        }
        return best;
      };

      return {
        label:         m.label,
        meetingDate:   m.date,
        impliedRate,
        weekAgo:       findHistRate(7),
        monthAgo:      findHistRate(30),
        threeMonthAgo: findHistRate(91),
        isTbillProxy:  false,
      };
    })
  );

  const points: FedFundsCurvePoint[] = results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : {
          label: upcoming[i].label,
          meetingDate: upcoming[i].date,
          impliedRate: null,
          weekAgo: null,
          monthAgo: null,
          threeMonthAgo: null,
          isTbillProxy: false,
        }
  );

  // If all futures are null (Yahoo Finance doesn't have ZQ), fall back to Treasury short-end
  const hasData = points.some((p) => p.impliedRate != null);
  if (!hasData) {
    // Use Treasury yield curve short-end as proxy
    try {
      const curve = await fetchYieldCurve();
      const tenorMap: Record<string, string> = {
        "1M": "Jun '26", "3M": "Jul '26", "6M": "Sep '26", "1Y": "Dec '26",
      };
      return curve
        .filter((c) => tenorMap[c.maturity])
        .map((c) => ({
          label:         tenorMap[c.maturity],
          meetingDate:   "",
          impliedRate:   c.current,
          weekAgo:       c.weekAgo,
          monthAgo:      c.monthAgo,
          threeMonthAgo: c.threeMonthAgo,
          isTbillProxy:  true,
        }));
    } catch {
      return points;
    }
  }

  return points;
}
