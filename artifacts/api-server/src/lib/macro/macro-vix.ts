// VIX term structure. Extracted verbatim from macro-data.ts — no behavior change.
import { yahooFinance } from "../yahoo-client.js";
import type { VixCurvePoint } from "../macro-data.js";
import { safeQuote } from "./macro-utils.js";

const VIX_TENORS = [
  { ticker: "^VXST", label: "9D",  days: 9   },
  { ticker: "^VIX",  label: "30D", days: 30  },
  { ticker: "^VIX3M", label: "93D", days: 93 },
  { ticker: "^VIX6M", label: "6M",  days: 183 },
  { ticker: "^VIX1Y", label: "1Y",  days: 365 },
];

export async function fetchVixCurve(): Promise<VixCurvePoint[]> {
  const now = new Date();
  const period1 = new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000);

  const results = await Promise.allSettled(
    VIX_TENORS.map(async (t) => {
      const [quoteResult, chartResult] = await Promise.allSettled([
        yahooFinance.quote(t.ticker, {}, { validateResult: false }),
        yahooFinance.chart(t.ticker, { period1, interval: "1d" }, { validateResult: false }),
      ]);

      const currentValue =
        quoteResult.status === "fulfilled"
          ? (safeQuote(quoteResult.value).value)
          : null;

      const quotes =
        chartResult.status === "fulfilled"
          ? ((chartResult.value as Record<string, unknown>)?.["quotes"] as Array<{date: unknown; close: number | null}> ?? [])
          : [];

      const findClose = (daysAgo: number): number | null => {
        const target = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
        const targetStr = target.toISOString().slice(0, 10);
        let best: number | null = null;
        for (const q of quotes) {
          if (q.close == null) continue;
          const d = (q.date instanceof Date ? q.date : new Date(q.date as string))
            .toISOString()
            .slice(0, 10);
          if (d <= targetStr) best = q.close;
        }
        return best;
      };

      return {
        tenor: t.label,
        days: t.days,
        value: currentValue,
        weekAgo:       findClose(7),
        monthAgo:      findClose(30),
        threeMonthAgo: findClose(91),
      };
    })
  );

  return results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { tenor: VIX_TENORS[i].label, days: VIX_TENORS[i].days, value: null, weekAgo: null, monthAgo: null, threeMonthAgo: null }
  );
}
