// Yield curve via US Treasury CSV. Extracted verbatim from macro-data.ts — no behavior change.
import type { YieldCurvePoint } from "../macro-data.js";

const TREASURY_MATURITIES: { col: string; label: string; months: number }[] = [
  { col: "1 Mo",  label: "1M",  months: 1   },
  { col: "3 Mo",  label: "3M",  months: 3   },
  { col: "6 Mo",  label: "6M",  months: 6   },
  { col: "1 Yr",  label: "1Y",  months: 12  },
  { col: "2 Yr",  label: "2Y",  months: 24  },
  { col: "3 Yr",  label: "3Y",  months: 36  },
  { col: "5 Yr",  label: "5Y",  months: 60  },
  { col: "7 Yr",  label: "7Y",  months: 84  },
  { col: "10 Yr", label: "10Y", months: 120 },
  { col: "20 Yr", label: "20Y", months: 240 },
  { col: "30 Yr", label: "30Y", months: 360 },
];

async function fetchTreasuryCSV(yyyymm: string): Promise<{ headers: string[]; rows: string[][] }> {
  const year = yyyymm.slice(0, 4);
  const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${yyyymm}&t=1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "TradeDash/1.0" },
    });
    clearTimeout(timer);
    if (!res.ok) return { headers: [], rows: [] };
    const text = await res.text();
    const lines = text.trim().split("\n");
    if (lines.length < 2) return { headers: [], rows: [] };
    const headers = lines[0].split(",").map((h) => h.replace(/"/g, "").trim());
    const rows = lines.slice(1).map((l) => l.split(",").map((c) => c.replace(/"/g, "").trim()));
    return { headers, rows };
  } catch {
    clearTimeout(timer);
    return { headers: [], rows: [] };
  }
}

export async function fetchYieldCurve(): Promise<YieldCurvePoint[]> {
  const now = new Date();
  const curYYYYMM = now.toISOString().slice(0, 7).replace("-", "");

  const prevDate = new Date(now);
  prevDate.setDate(1);
  prevDate.setMonth(prevDate.getMonth() - 1);
  const prevYYYYMM = prevDate.toISOString().slice(0, 7).replace("-", "");

  const threeMonthDate = new Date(now);
  threeMonthDate.setDate(1);
  threeMonthDate.setMonth(threeMonthDate.getMonth() - 3);
  const threeMonthYYYYMM = threeMonthDate.toISOString().slice(0, 7).replace("-", "");

  const [cur, prev, threeMonth] = await Promise.allSettled([
    fetchTreasuryCSV(curYYYYMM),
    fetchTreasuryCSV(prevYYYYMM),
    fetchTreasuryCSV(threeMonthYYYYMM),
  ]);

  const curData      = cur.status      === "fulfilled" ? cur.value      : { headers: [], rows: [] };
  const prevData     = prev.status     === "fulfilled" ? prev.value     : { headers: [], rows: [] };
  const threeMonthData = threeMonth.status === "fulfilled" ? threeMonth.value : { headers: [], rows: [] };

  if (curData.rows.length === 0) return [];

  const latestRow    = curData.rows[curData.rows.length - 1];
  // ~1 week ago = ~5 trading days back in current month; if not enough rows, use earliest
  const weekAgoIdx   = Math.max(0, curData.rows.length - 6);
  const weekAgoRow   = curData.rows.length >= 2 ? curData.rows[weekAgoIdx] : null;
  const monthAgoRow  = prevData.rows.length > 0 ? prevData.rows[prevData.rows.length - 1] : null;
  const threeMonthAgoRow = threeMonthData.rows.length > 0 ? threeMonthData.rows[threeMonthData.rows.length - 1] : null;

  return TREASURY_MATURITIES.map((m) => {
    const idx = curData.headers.indexOf(m.col);
    const cur  = idx >= 0 ? parseFloat(latestRow[idx])           : NaN;
    const wk   = weekAgoRow && idx >= 0 ? parseFloat(weekAgoRow[idx])   : NaN;
    const mo   = monthAgoRow && idx >= 0 ? parseFloat(monthAgoRow[idx]) : NaN;
    const threeM = threeMonthAgoRow && idx >= 0 ? parseFloat(threeMonthAgoRow[idx]) : NaN;
    return {
      maturity:      m.label,
      months:        m.months,
      current:       isNaN(cur)    ? null : cur,
      weekAgo:       isNaN(wk)     ? null : wk,
      monthAgo:      isNaN(mo)     ? null : mo,
      threeMonthAgo: isNaN(threeM) ? null : threeM,
    };
  });
}
