// Charts data assembly. Extracted verbatim from macro-data.ts — no behavior change.
import YahooFinanceClass from "yahoo-finance2";
const yahooFinance = new YahooFinanceClass();
import * as XLSX from "xlsx";
import { logApiCall } from "../api-logger.js";
import type { MacroCharts, ChartPoint, VixCurvePoint, FedFundsCurvePoint } from "../macro-data.js";
import { allSettledLimited } from "./macro-utils.js";
import { fetchVixCurve } from "./macro-vix.js";
import { fetchFedFundsCurve } from "./macro-fed-funds.js";
import { computeLiquidityImplications } from "./macro-liquidity.js";
import { computeVolatilityImplications } from "./macro-volatility.js";

export async function fetchMacroCharts(): Promise<MacroCharts> {
  const period1 = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000);

  const chartToPoints = (result: PromiseSettledResult<unknown>): ChartPoint[] => {
    if (result.status !== "fulfilled") return [];
    const quotes = (result.value as { quotes?: { date: unknown; close: number | null }[] })?.quotes ?? [];
    return quotes
      .filter((q) => q.close != null)
      .map((q) => ({
        date:  (q.date instanceof Date ? q.date : new Date(q.date as string)).toISOString().slice(0, 10),
        value: q.close as number,
      }));
  };

  const fetchFredCSV = async (seriesId: string): Promise<ChartPoint[]> => {
    const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const text = await res.text();
    if (text.trimStart().startsWith("<")) return []; // guard against HTML error pages
    const lines = text.trim().split("\n");
    // skip header row (could be "DATE,..." or "observation_date,...")
    return lines.slice(1).flatMap(line => {
      const [date, val] = line.trim().split(",");
      const v = parseFloat(val);
      return date && /^\d{4}-\d{2}-\d{2}$/.test(date) && !isNaN(v) ? [{ date, value: v }] : [];
    });
  };

  // CNN's fear & greed endpoint bundles its sub-indicators in one response, including
  // a CBOE-sourced put/call ratio series (put_call_options) — reuse the single fetch
  // for both rather than hitting a second (dead) source for put/call.
  const fetchCnnFearGreedAndPutCall = async (): Promise<{ fearGreed: ChartPoint[]; putCall: ChartPoint[] }> => {
    try {
      const res = await fetch("https://production.dataviz.cnn.io/index/fearandgreed/graphdata", {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Referer": "https://www.cnn.com/",
          "Accept": "application/json",
        },
      });
      const json = await res.json() as {
        fear_and_greed_historical?: { data?: { x: number; y: number }[] };
        put_call_options?: { data?: { x: number; y: number }[] };
      };
      const toPoints = (raw: { x: number; y: number }[], decimals: number) => raw.map(p => ({
        date:  new Date(p.x).toISOString().slice(0, 10),
        value: parseFloat(p.y.toFixed(decimals)),
      }));
      const fearGreed = toPoints(json.fear_and_greed_historical?.data ?? [], 1);
      const putCall = toPoints(json.put_call_options?.data ?? [], 3);
      logApiCall({ source: "cnn", fn: "fetchCnnFearGreedAndPutCall", trigger: "macro chart refresh", outcome: "success", fieldsReturned: fearGreed.length + putCall.length });
      return { fearGreed, putCall };
    } catch (err: any) {
      logApiCall({ source: "cnn", fn: "fetchCnnFearGreedAndPutCall", trigger: "macro chart refresh", outcome: "failure", error: String(err?.message ?? err), requestedFields: "fear_and_greed/graphdata" });
      return { fearGreed: [], putCall: [] };
    }
  };

  // NY Fed GSCPI — downloaded directly from NY Fed as xlsx (FRED blocks server IPs)
  const fetchGSCPI = async (): Promise<ChartPoint[]> => {
    try {
      const res = await fetch("https://www.newyorkfed.org/medialibrary/research/interactives/gscpi/downloads/gscpi_data.xlsx", {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; TradeDash/1.0)" },
      });
      if (!res.ok) {
        logApiCall({ source: "nyfed", fn: "fetchGSCPI", trigger: "macro chart refresh", outcome: "failure", error: `HTTP ${res.status}`, requestedFields: "gscpi_data.xlsx" });
        return [];
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const wb = XLSX.read(buf, { type: "buffer" });
      const ws = wb.Sheets["GSCPI Monthly Data"];
      if (!ws) {
        logApiCall({ source: "nyfed", fn: "fetchGSCPI", trigger: "macro chart refresh", outcome: "failure", error: "sheet 'GSCPI Monthly Data' not found in xlsx", requestedFields: "gscpi_data.xlsx" });
        return [];
      }
      const rows = XLSX.utils.sheet_to_json<[string, number]>(ws, { header: 1 }) as [string, number][];
      const MONTHS: Record<string, string> = {
        Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
        Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
      };
      const result = rows.slice(5).flatMap(([dateStr, val]) => {
        if (!dateStr || val == null || isNaN(val as number)) return [];
        // "31-Jan-1998" → "1998-01-31"
        const m = String(dateStr).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
        if (!m || !MONTHS[m[2]]) return [];
        const date = `${m[3]}-${MONTHS[m[2]]}-${m[1].padStart(2, "0")}`;
        return [{ date, value: parseFloat((val as number).toFixed(4)) }];
      });
      logApiCall({ source: "nyfed", fn: "fetchGSCPI", trigger: "macro chart refresh", outcome: "success", fieldsReturned: result.length });
      return result;
    } catch (err: any) {
      logApiCall({ source: "nyfed", fn: "fetchGSCPI", trigger: "macro chart refresh", outcome: "failure", error: String(err?.message ?? err), requestedFields: "gscpi_data.xlsx" });
      return [];
    }
  };

  // Net Liquidity = WALCL - TGA - RRP, all normalized to $B.
  // WALCL/WTREGEN are weekly (Wed); RRPONTSYD is daily — resample RRP to the
  // same-week last observation on/before each WALCL date before subtracting.
  const deriveNetLiquidity = (
    walcl: ChartPoint[], tga: ChartPoint[], rrp: ChartPoint[],
  ): ChartPoint[] => {
    const tgaMap = new Map(tga.map(p => [p.date, p.value]));
    const rrpSorted = [...rrp].sort((a, b) => a.date.localeCompare(b.date));
    return walcl.flatMap(w => {
      const tgaVal = tgaMap.get(w.date);
      if (tgaVal === undefined) return [];
      // last RRP obs on/before this WALCL date (same-week alignment)
      let rrpVal: number | undefined;
      for (const p of rrpSorted) {
        if (p.date > w.date) break;
        rrpVal = p.value;
      }
      if (rrpVal === undefined) return [];
      const netLiqB = (w.value / 1000) - (tgaVal / 1000) - rrpVal; // $M -> $B for WALCL/TGA
      return [{ date: w.date, value: parseFloat(netLiqB.toFixed(2)) }];
    });
  };

  // SOFR - IORB spread (bps) — the reserve-scarcity / repo-stress signal the Fed's
  // own repo-market working papers key off (SOFR printing meaningfully above IORB
  // means reserves are getting scarce and repo funding is tightening).
  const deriveSofrIorbSpread = (sofr: ChartPoint[], iorb: ChartPoint[]): ChartPoint[] => {
    const iorbMap = new Map(iorb.map(p => [p.date, p.value]));
    const iorbSorted = [...iorb].sort((a, b) => a.date.localeCompare(b.date));
    return sofr.flatMap(s => {
      let iorbVal = iorbMap.get(s.date);
      if (iorbVal === undefined) {
        for (const p of iorbSorted) {
          if (p.date > s.date) break;
          iorbVal = p.value;
        }
      }
      if (iorbVal === undefined) return [];
      return [{ date: s.date, value: parseFloat(((s.value - iorbVal) * 100).toFixed(1)) }];
    });
  };

  const fetchCopperGold = async (): Promise<ChartPoint[]> => {
    const [cuResult, gcResult] = await Promise.allSettled([
      yahooFinance.chart("HG=F", { period1, interval: "1d" }, { validateResult: false }),
      yahooFinance.chart("GC=F", { period1, interval: "1d" }, { validateResult: false }),
    ]);
    if (cuResult.status !== "fulfilled" || gcResult.status !== "fulfilled") return [];
    const cuPoints = chartToPoints(cuResult);
    const gcMap = new Map(chartToPoints(gcResult).map(p => [p.date, p.value]));
    return cuPoints
      .filter(p => gcMap.has(p.date) && gcMap.get(p.date)! > 0)
      .map(p => ({ date: p.date, value: parseFloat((p.value / gcMap.get(p.date)!).toFixed(6)) }));
  };

  const [vixResult, irxResult, tnxResult, vixCurveResult, ffCurveResult,
         hyResult, igResult, vvixResult, cnnResult,
         gscpiResult, moneyMarketResult,
         nfciResult, copperGoldResult, dxyResult,
         walclResult, tgaResult, rrpResult, reservesResult,
         sofrResult, iorbResult, moveResult] = await allSettledLimited([
    () => yahooFinance.chart("^VIX",    { period1, interval: "1d" }, { validateResult: false }),
    () => yahooFinance.chart("^IRX",    { period1, interval: "1d" }, { validateResult: false }),
    () => yahooFinance.chart("^TNX",    { period1, interval: "1d" }, { validateResult: false }),
    () => fetchVixCurve(),
    () => fetchFedFundsCurve(),
    () => fetchFredCSV("BAMLH0A0HYM2"), // ICE BofA HY OAS spread
    () => fetchFredCSV("BAMLC0A0CM"),   // ICE BofA IG OAS spread
    () => yahooFinance.chart("^VVIX",   { period1, interval: "1d" }, { validateResult: false }),
    () => fetchCnnFearGreedAndPutCall(),
    () => fetchGSCPI(),
    () => fetchFredCSV("WRMFNS"), // All Money Market Funds total assets (weekly, $B)
    () => fetchFredCSV("NFCI"),
    () => fetchCopperGold(),
    () => yahooFinance.chart("DX-Y.NYB", { period1, interval: "1d" }, { validateResult: false }),
    () => fetchFredCSV("WALCL"),      // Fed total assets (weekly, $M)
    () => fetchFredCSV("WTREGEN"),    // Treasury General Account (weekly, $M)
    () => fetchFredCSV("RRPONTSYD"),  // Overnight reverse repo (daily, $B)
    () => fetchFredCSV("WRESBAL"),    // Bank reserve balances (weekly, $M)
    () => fetchFredCSV("SOFR"),       // Secured Overnight Financing Rate (daily, %)
    () => fetchFredCSV("IORB"),       // Interest on Reserve Balances (daily, %)
    () => yahooFinance.chart("^MOVE", { period1, interval: "1d" }, { validateResult: false }), // ICE BofA MOVE — bond market vol
  ], 5);

  const fedAssetsHistory = walclResult.status === "fulfilled" ? (walclResult.value as ChartPoint[]) : [];
  const tgaHistory       = tgaResult.status   === "fulfilled" ? (tgaResult.value   as ChartPoint[]) : [];
  const rrpHistory       = rrpResult.status   === "fulfilled" ? (rrpResult.value   as ChartPoint[]) : [];
  const reservesHistory  = reservesResult.status === "fulfilled" ? (reservesResult.value as ChartPoint[]) : [];
  const netLiquidityHistory = deriveNetLiquidity(fedAssetsHistory, tgaHistory, rrpHistory);
  const sofrHistory = sofrResult.status === "fulfilled" ? (sofrResult.value as ChartPoint[]) : [];
  const iorbHistory = iorbResult.status === "fulfilled" ? (iorbResult.value as ChartPoint[]) : [];
  const sofrIorbSpreadHistory = deriveSofrIorbSpread(sofrHistory, iorbHistory);
  const hySpreadHistoryForImplications = hyResult.status === "fulfilled" ? (hyResult.value as ChartPoint[]) : [];
  const nfciHistoryForImplications = nfciResult.status === "fulfilled" ? (nfciResult.value as ChartPoint[]) : [];
  const liquidityImplications = computeLiquidityImplications(
    netLiquidityHistory, rrpHistory, nfciHistoryForImplications, hySpreadHistoryForImplications, sofrIorbSpreadHistory,
  );

  const cnnData = cnnResult.status === "fulfilled" ? (cnnResult.value as { fearGreed: ChartPoint[]; putCall: ChartPoint[] }) : { fearGreed: [], putCall: [] };

  const vixHistoryForImplications = chartToPoints(vixResult);
  const vixCurveForImplications = vixCurveResult.status === "fulfilled" ? (vixCurveResult.value as VixCurvePoint[]) : [];
  const vvixHistoryForImplications = chartToPoints(vvixResult);
  const putCallRatioHistoryForImplications = cnnData.putCall;
  const moveHistory = chartToPoints(moveResult);
  const volatilityImplications = computeVolatilityImplications(
    vixHistoryForImplications, vixCurveForImplications, vvixHistoryForImplications,
    putCallRatioHistoryForImplications, hySpreadHistoryForImplications, moveHistory,
  );

  return {
    fetchedAt:             new Date().toISOString(),
    vixHistory:            chartToPoints(vixResult),
    fedFundsHistory:       chartToPoints(irxResult),
    tenYearHistory:        chartToPoints(tnxResult),
    vixCurve:              vixCurveResult.status === "fulfilled" ? (vixCurveResult.value as VixCurvePoint[]) : [],
    fedFundsCurve:         ffCurveResult.status  === "fulfilled" ? (ffCurveResult.value  as FedFundsCurvePoint[]) : [],
    hySpreadHistory:       hyResult.status        === "fulfilled" ? (hyResult.value       as ChartPoint[]) : [],
    igSpreadHistory:       igResult.status        === "fulfilled" ? (igResult.value       as ChartPoint[]) : [],
    putCallHistory:        chartToPoints(vvixResult),
    fearGreedHistory:      cnnData.fearGreed,
    putCallRatioHistory:   cnnData.putCall,
    gscpiHistory:          gscpiResult.status     === "fulfilled" ? (gscpiResult.value    as ChartPoint[]) : [],
    moneyMarketHistory:    moneyMarketResult.status === "fulfilled" ? (moneyMarketResult.value as ChartPoint[]) : [],
    nfciHistory:           nfciResult.status       === "fulfilled" ? (nfciResult.value    as ChartPoint[]) : [],
    copperGoldHistory:     copperGoldResult.status === "fulfilled" ? (copperGoldResult.value as ChartPoint[]) : [],
    dxyHistory:            chartToPoints(dxyResult),
    fedAssetsHistory,
    tgaHistory,
    rrpHistory,
    reservesHistory,
    netLiquidityHistory,
    sofrIorbSpreadHistory,
    liquidityImplications,
    moveHistory,
    volatilityImplications,
  };
}
