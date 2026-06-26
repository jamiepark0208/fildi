import { eq } from "drizzle-orm";
import {
  db,
  tickerFundamentals,
  dataSources,
  sourceTickerMap,
  tickerFundamentalsHistory,
  type TickerFundamentalsRow,
  type TickerFundamentalsHistory,
} from "@workspace/db";
import { fetchFMPFundamentals, type FMPFundamentalsData } from "./fmp-client.js";
import { fetchAVOverview } from "./alpha-vantage-client.js";
import { fetchPolygonFundamentals } from "./polygon-client.js";
import { logger } from "./logger.js";

const STALE_DAYS = 7;
const FMP_API_KEY = process.env.FMP_API_KEY ?? "";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FundamentalsResult {
  data: TickerFundamentalsRow;
  source: string;
  fromCache: boolean;
}

export interface HistoryCSVRow {
  ticker: string;
  year: number;
  pe_ratio?: number;
  price_to_book?: number;
  roic?: number;
  gross_margin?: number;
  operating_margin?: number;
  net_margin?: number;
  revenue?: number;
  ebitda?: number;
  eps?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function num(v: number | undefined): string | null {
  return v !== undefined && isFinite(v) ? String(v) : null;
}

function isFresh(row: TickerFundamentalsRow): boolean {
  if (!row.fundamentalsLastFetched) return false;
  const ageMs = Date.now() - new Date(row.fundamentalsLastFetched).getTime();
  return ageMs < STALE_DAYS * 24 * 60 * 60 * 1000;
}

function computeQualityScore(data: FMPFundamentalsData): number {
  const fields: (number | undefined)[] = [
    data.peRatio, data.pegRatio, data.priceToBook, data.priceToSales,
    data.debtToEquity, data.totalRevenue, data.revenueGrowthYoY, data.netIncome,
    data.ebitda, data.earningsPerShare, data.epsGrowth, data.freeCashFlow,
    data.dividendYield, data.returnOnEquity, data.returnOnAssets, data.currentRatio,
    data.grossMargin, data.operatingMargin, data.netMargin, data.beta,
    data.analystTargetPrice, data.wacc, data.roic, data.interestExpense,
    data.totalDebt, data.totalStockholdersEquity, data.cashAndEquivalents,
    data.quarterlyOperatingCashFlow, data.sharesOutstanding, data.sharesOutstandingPrior,
  ];
  const nonNull = fields.filter(v => v !== undefined && isFinite(v as number)).length;
  return parseFloat((nonNull / fields.length).toFixed(4));
}

async function upsertFundamentals(
  ticker: string,
  data: FMPFundamentalsData,
  source: string,
): Promise<TickerFundamentalsRow> {
  const qualityScore = computeQualityScore(data);
  const values = {
    ticker:                     ticker.toUpperCase(),
    fundamentalsLastFetched:    new Date(),
    discrepancyFlags:           null as string | null,
    fmpCoveragePercent:         num(qualityScore * 100) ?? "0",
    peRatio:                    num(data.peRatio),
    pegRatio:                   num(data.pegRatio),
    forwardPe:                  num(data.forwardPe),
    evEbitda:                   num(data.evEbitda),
    evRevenue:                  num(data.evRevenue),
    priceToBook:                num(data.priceToBook),
    priceToSales:               num(data.priceToSales),
    debtToEquity:               num(data.debtToEquity),
    totalRevenue:               num(data.totalRevenue),
    revenueGrowthYoY:           num(data.revenueGrowthYoY),
    revenueGrowthYoyPrior:      num(data.revenueGrowthYoyPrior),
    netIncome:                  num(data.netIncome),
    ebitda:                     num(data.ebitda),
    earningsPerShare:           num(data.earningsPerShare),
    epsGrowth:                  num(data.epsGrowth),
    freeCashFlow:               num(data.freeCashFlow),
    dividendYield:              num(data.dividendYield),
    returnOnEquity:             num(data.returnOnEquity),
    returnOnAssets:             num(data.returnOnAssets),
    currentRatio:               num(data.currentRatio),
    grossMargin:                num(data.grossMargin),
    operatingMargin:            num(data.operatingMargin),
    netMargin:                  num(data.netMargin),
    beta:                       num(data.beta),
    analystTargetPrice:         num(data.analystTargetPrice),
    wacc:                       num(data.wacc),
    roic:                       num(data.roic),
    interestExpense:            num(data.interestExpense),
    totalDebt:                  num(data.totalDebt),
    totalStockholdersEquity:    num(data.totalStockholdersEquity),
    ebit:                       num(data.ebit),
    effectiveTaxRate:           num(data.effectiveTaxRate),
    cashAndEquivalents:         num(data.cashAndEquivalents),
    quarterlyOperatingCashFlow: num(data.quarterlyOperatingCashFlow),
    sharesOutstanding:          num(data.sharesOutstanding),
    sharesOutstandingPrior:     num(data.sharesOutstandingPrior),
    lastSource:                 source,
    dataQualityScore:           String(qualityScore),
  };

  const rows = await db
    .insert(tickerFundamentals)
    .values(values)
    .onConflictDoUpdate({ target: tickerFundamentals.ticker, set: values })
    .returning();
  return rows[0];
}

// Merge partial data from a secondary source into an existing DB row.
// Existing values are preserved for any field the new source left undefined.
async function patchFundamentals(
  ticker: string,
  partial: Partial<FMPFundamentalsData>,
  source: string,
): Promise<TickerFundamentalsRow> {
  const t = ticker.toUpperCase();
  const existing = await db
    .select()
    .from(tickerFundamentals)
    .where(eq(tickerFundamentals.ticker, t))
    .limit(1);

  const base: FMPFundamentalsData = {};
  if (existing.length > 0) {
    const r = existing[0] as Record<string, unknown>;
    const fields: (keyof FMPFundamentalsData)[] = [
      "peRatio","pegRatio","forwardPe","evEbitda","evRevenue","priceToBook","priceToSales",
      "debtToEquity","dividendYield","analystTargetPrice","revenueGrowthYoY","revenueGrowthYoyPrior",
      "epsGrowth","earningsPerShare","grossMargin","operatingMargin","netMargin","returnOnEquity",
      "returnOnAssets","effectiveTaxRate","totalRevenue","netIncome","ebitda","freeCashFlow",
      "ebit","interestExpense","currentRatio","wacc","roic","totalDebt","totalStockholdersEquity",
      "cashAndEquivalents","quarterlyOperatingCashFlow","sharesOutstanding","sharesOutstandingPrior","beta",
    ];
    for (const f of fields) {
      const v = r[f];
      if (v !== null && v !== undefined) {
        const n = Number(v);
        if (isFinite(n)) (base as Record<string, number>)[f] = n;
      }
    }
  }

  return upsertFundamentals(t, { ...base, ...partial }, source);
}

// Record whether a source worked for a ticker in source_ticker_map.
async function upsertSourceMap(ticker: string, source: string, worked: boolean, notes?: string): Promise<void> {
  const t = ticker.toUpperCase();
  await db
    .insert(sourceTickerMap)
    .values({ ticker: t, source, sourceTicker: t, active: worked, notes: notes ?? null })
    .onConflictDoUpdate({
      target: [sourceTickerMap.ticker, sourceTickerMap.source],
      set: { active: worked, notes: notes ?? null },
    })
    .catch(err => logger.warn({ ticker: t, source, err: String(err) }, "sdm: sourceTickerMap upsert failed"));
}

// ── Source-specific fetch stubs ───────────────────────────────────────────────

// FactSet Overview Report Builder API v1
// Docs: https://developer.factset.com/api-catalog/overview-report-builder-api
// Endpoint: GET /report/overview/v1/financial-highlights?id=TICKER-US
// Response format: STACH 2.0 — rows[0].cells[0]=label, cells[2]=most-recent actual
async function fetchFactSet(ticker: string): Promise<FMPFundamentalsData | null> {
  const proxyUrl    = process.env.FACTSET_PROXY_URL;
  const proxySecret = process.env.FACTSET_PROXY_SECRET;
  if (!proxyUrl || !proxySecret) return null;

  const id = `${ticker}-US`;
  const url = `${proxyUrl}/factset/report/overview/v1/financial-highlights?id=${encodeURIComponent(id)}`;

  const res = await fetch(url, {
    headers: { "X-Proxy-Secret": proxySecret, "Accept": "application/json" },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    logger.warn({ ticker, status: res.status }, "sdm: factset overview fetch failed");
    return null;
  }

  const json = await res.json() as any;
  const rows: any[] = json?.data?.tables?.main?.data?.rows ?? [];

  // Build label → { cells, scale, isPct } map from STACH rows.
  // cells[0]=label, cells[1]=forward estimate, cells[2]=most-recent actual, cells[3]=prior actual.
  // FactSet omits `scale` on some FIN rows — default to 6 (millions) for absolute FIN metrics.
  // Percentage metrics (PERCENTAGE / MARGIN / MARGIN_RATIO) are in percent — divide by 100.
  type RowEntry = { cells: (string | null)[]; scale: number; isPct: boolean };
  const byLabel = new Map<string, RowEntry>();
  for (const row of rows) {
    if (!row.cells || row.rowType === "Header") continue;
    const label = (row.cells[0] ?? "").trim();
    if (!label) continue;
    const vt = row.rowMetadata?.valueType?.value ?? "";
    const rt = row.rowMetadata?.rowType?.value ?? "";
    const metricType = row.rowMetadata?.metric?.value ?? "";
    const isPct = vt === "PERCENTAGE" || rt === "MARGIN" || rt === "MARGIN_RATIO";
    const explicitScale = row.rowMetadata?.scale?.value;
    // FIN absolute-value rows default to millions when FactSet omits the scale field
    const scale = explicitScale != null
      ? Number(explicitScale)
      : (metricType === "FIN" && !isPct ? 6 : 0);
    byLabel.set(label, { cells: row.cells, scale, isPct });
  }

  // colIdx 2 = most-recent actual; fall back to colIdx 1 (estimate) if actual is null
  function val(label: string, colIdx = 2): number | undefined {
    const entry = byLabel.get(label);
    if (!entry) return undefined;
    const raw = entry.cells[colIdx] ?? (colIdx === 2 ? entry.cells[1] : null);
    if (raw == null || raw === "") return undefined;
    const n = Number(raw);
    if (!isFinite(n)) return undefined;
    const scaled = entry.scale === 6 ? n * 1_000_000 : n;
    return entry.isPct ? scaled / 100 : scaled;
  }

  const revenue    = val("Revenue");
  const netIncome  = val("Net Income");
  const revPrior   = val("Revenue", 3);
  const epsPrior   = val("EPS (Diluted)", 3);
  const revenueGrowthYoY = (revenue !== undefined && revPrior && revPrior !== 0)
    ? (revenue - revPrior) / Math.abs(revPrior)
    : undefined;
  const epsGrowth = (val("EPS (Diluted)") !== undefined && epsPrior && epsPrior !== 0)
    ? ((val("EPS (Diluted)")! - epsPrior) / Math.abs(epsPrior))
    : undefined;

  return {
    totalRevenue:               revenue,
    netIncome,
    ebitda:                     val("EBITDA"),
    ebit:                       val("EBIT"),
    earningsPerShare:           val("EPS (Diluted)"),
    grossMargin:                val("Gross Margin (%)") ?? val("Gross Margin (%) "),
    operatingMargin:            val("Operating Margin (%) ") ?? val("EBIT Margin (%)"),
    netMargin:                  val("Net Margin (%)") ?? val("Net Margin (%) "),
    returnOnEquity:             val("Return on Equity (%)"),
    returnOnAssets:             val("Return on Asset (%)"),
    totalStockholdersEquity:    val("Total Shareholder Equity"),
    freeCashFlow:               val("Free Cash Flow"),
    quarterlyOperatingCashFlow: val("Net Operating Cash Flow"),
    cashAndEquivalents:         val("Cash & ST Inv"),
    currentRatio:               val("Current Ratio"),
    // D/E reported as percentage (e.g. 7.26 = 7.26%) — store as raw ratio
    debtToEquity:               (() => { const v = byLabel.get("Total Debt / Total Eq (%)"); if (!v) return undefined; const n = Number(v.cells[2]); return isFinite(n) ? n / 100 : undefined; })(),
    revenueGrowthYoY,
    epsGrowth,
  };
}

// TODO: implement when SIMFIN_API_KEY is confirmed
// API: https://app.simfin.com/api/v3/companies/statements
async function fetchSimFin(_ticker: string): Promise<FMPFundamentalsData | null> {
  // TODO: GET /companies/statements?ticker=&statement=pl&period=annual&fyear=
  throw new Error("SimFin not implemented — stub only");
}

// SEC EDGAR XBRL — always available, free, no key required
// https://data.sec.gov/api/xbrl/companyfacts/{CIK}.json
async function fetchEdgar(ticker: string): Promise<FMPFundamentalsData | null> {
  try {
    // Step 1: resolve CIK from ticker via EDGAR company search
      const cikRes = await fetch(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(ticker)}&type=&dateb=&owner=include&count=1&search_text=&output=atom`, {
      headers: { "User-Agent": "TradeDash/1.0 jamiepark0208@gmail.com" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!cikRes.ok) return null;

    const xml = await cikRes.text();
    const cikMatch = xml.match(/CIK=(\d+)/);
    if (!cikMatch) return null;
    const cik = cikMatch[1].padStart(10, "0");

    // Step 2: fetch company facts
    const factsRes = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, {
      headers: { "User-Agent": "TradeDash/1.0 jamiepark0208@gmail.com" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!factsRes.ok) return null;

    const facts = await factsRes.json() as {
      facts?: {
        "us-gaap"?: Record<string, { units?: { USD?: Array<{ val: number; end: string; form: string }> } }>
      }
    };

    const gaap = facts.facts?.["us-gaap"];
    if (!gaap) return null;

    function latestAnnual(concept: string): number | undefined {
      const entries = gaap![concept]?.units?.USD;
      if (!entries) return undefined;
      const annual = entries
        .filter(e => e.form === "10-K")
        .sort((a, b) => b.end.localeCompare(a.end));
      return annual[0]?.val;
    }

    const revenue    = latestAnnual("Revenues") ?? latestAnnual("RevenueFromContractWithCustomerExcludingAssessedTax");
    const netIncome  = latestAnnual("NetIncomeLoss");
    const ebitda     = latestAnnual("OperatingIncomeLoss"); // EBITDA proxy via EBIT
    const totalDebt  = latestAnnual("LongTermDebt");
    const cashAndEq  = latestAnnual("CashAndCashEquivalentsAtCarryingValue");
    const equity     = latestAnnual("StockholdersEquity");
    const intExp     = latestAnnual("InterestExpense");
    const sharesOut  = latestAnnual("CommonStockSharesOutstanding");

    const grossMargin  = revenue && netIncome !== undefined
      ? undefined  // gross profit not directly available in all filers without CostOfRevenue
      : undefined;
    const netMargin = revenue && netIncome !== undefined
      ? netIncome / revenue
      : undefined;

    return {
      totalRevenue:            revenue,
      netIncome,
      ebitda:                  ebitda,
      ebit:                    ebitda,
      totalDebt,
      cashAndEquivalents:      cashAndEq,
      totalStockholdersEquity: equity,
      interestExpense:         intExp !== undefined ? Math.abs(intExp) : undefined,
      sharesOutstanding:       sharesOut,
      netMargin,
    };
  } catch (err) {
    logger.warn({ ticker, err }, "sdm: edgar fetch failed");
    return null;
  }
}

async function fetchFinnhub(ticker: string): Promise<FMPFundamentalsData | null> {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all&token=${apiKey}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;
    const json = await res.json() as { metric?: Record<string, number | null> };
    const m = json.metric ?? {};

    return {
      peRatio:          m["peBasicExclExtraTTM"] ?? undefined,
      priceToBook:      m["pbAnnual"] ?? undefined,
      priceToSales:     m["psAnnual"] ?? undefined,
      revenueGrowthYoY: m["revenueGrowthTTMYoy"] !== undefined ? (m["revenueGrowthTTMYoy"] as number) / 100 : undefined,
      grossMargin:      m["grossMarginTTM"] !== undefined ? (m["grossMarginTTM"] as number) / 100 : undefined,
      netMargin:        m["netProfitMarginTTM"] !== undefined ? (m["netProfitMarginTTM"] as number) / 100 : undefined,
      returnOnEquity:   m["roeTTM"] !== undefined ? (m["roeTTM"] as number) / 100 : undefined,
      returnOnAssets:   m["roaTTM"] !== undefined ? (m["roaTTM"] as number) / 100 : undefined,
      currentRatio:     m["currentRatioAnnual"] ?? undefined,
      debtToEquity:     m["totalDebt/totalEquityAnnual"] !== undefined
        ? (m["totalDebt/totalEquityAnnual"] as number) / 100
        : undefined,
      beta:             m["beta"] ?? undefined,
      earningsPerShare: m["epsBasicExclExtraItemsTTM"] ?? undefined,
    };
  } catch (err) {
    logger.warn({ ticker, err }, "sdm: finnhub fetch failed");
    return null;
  }
}

// ── StockDataManager ──────────────────────────────────────────────────────────

export class StockDataManager {

  async getFundamentals(ticker: string): Promise<FundamentalsResult> {
    const t = ticker.toUpperCase();

    await this.resetDailyCountersIfNeeded();

    // Check DB cache first
    const existing = await db
      .select()
      .from(tickerFundamentals)
      .where(eq(tickerFundamentals.ticker, t))
      .limit(1);

    if (existing.length > 0 && isFresh(existing[0])) {
      return { data: existing[0], source: existing[0].lastSource ?? "cache", fromCache: true };
    }

    const budgets = await this.getSourceBudgets();

    // Priority 1: FactSet (via static-IP proxy on Oracle Cloud)
    if (process.env.FACTSET_PROXY_URL && process.env.FACTSET_PROXY_SECRET && (budgets["factset"] ?? 0) > 0) {
      try {
        const data = await fetchFactSet(t);
        if (data) {
          await this.incrementCalls("factset");
          const row = await upsertFundamentals(t, data, "factset");
          return { data: row, source: "factset", fromCache: false };
        }
      } catch {
        logger.debug({ ticker: t }, "sdm: factset unavailable, falling through");
      }
    }

    // Priority 2: SimFin
    if (process.env.SIMFIN_API_KEY && (budgets["simfin"] ?? 0) > 0) {
      try {
        const data = await fetchSimFin(t);
        if (data) {
          await this.incrementCalls("simfin");
          const row = await upsertFundamentals(t, data, "simfin");
          return { data: row, source: "simfin", fromCache: false };
        }
      } catch {
        logger.debug({ ticker: t }, "sdm: simfin unavailable, falling through");
      }
    }

    // Priority 3: SEC EDGAR (always available)
    if ((budgets["edgar"] ?? 1) > 0) {
      try {
        const data = await fetchEdgar(t);
        if (data) {
          await this.incrementCalls("edgar");
          const row = await upsertFundamentals(t, data, "edgar");
          return { data: row, source: "edgar", fromCache: false };
        }
      } catch {
        logger.debug({ ticker: t }, "sdm: edgar unavailable, falling through");
      }
    }

    // Priority 4: Finnhub
    if (process.env.FINNHUB_API_KEY && (budgets["finnhub"] ?? 0) > 0) {
      try {
        const data = await fetchFinnhub(t);
        if (data) {
          await this.incrementCalls("finnhub");
          const row = await upsertFundamentals(t, data, "finnhub");
          return { data: row, source: "finnhub", fromCache: false };
        }
      } catch {
        logger.debug({ ticker: t }, "sdm: finnhub unavailable, falling through");
      }
    }

    // Priority 5: FMP
    if ((budgets["fmp"] ?? 0) > 0) {
      const data = await fetchFMPFundamentals(t, FMP_API_KEY);
      await this.incrementCalls("fmp");
      const row = await upsertFundamentals(t, data, "fmp");
      return { data: row, source: "fmp", fromCache: false };
    }

    // Priority 6: Polygon — no daily cap, 5/min rate limit
    if (process.env.POLYGON_API_KEY) {
      try {
        const partial = await fetchPolygonFundamentals(t, process.env.POLYGON_API_KEY);
        const filled = Object.values(partial).filter(v => v !== undefined).length;
        await upsertSourceMap(t, "polygon", filled > 0);
        if (filled > 0) {
          const row = await patchFundamentals(t, partial, "polygon");
          return { data: row, source: "polygon", fromCache: false };
        }
      } catch (err) {
        await upsertSourceMap(t, "polygon", false, String(err));
        logger.debug({ ticker: t, err: String(err) }, "sdm: polygon unavailable, falling through");
      }
    }

    // Priority 7: Alpha Vantage — 25 calls/day; only when budget remains
    if (process.env.ALPHA_VANTAGE_API_KEY && (budgets["alpha_vantage"] ?? 0) > 0) {
      try {
        const partial = await fetchAVOverview(t, process.env.ALPHA_VANTAGE_API_KEY);
        const filled = Object.values(partial).filter(v => v !== undefined).length;
        await this.incrementCalls("alpha_vantage");
        await upsertSourceMap(t, "alpha_vantage", filled > 0);
        if (filled > 0) {
          const row = await patchFundamentals(t, partial, "alpha_vantage");
          return { data: row, source: "alpha_vantage", fromCache: false };
        }
      } catch (err) {
        await upsertSourceMap(t, "alpha_vantage", false, String(err));
        logger.debug({ ticker: t, err: String(err) }, "sdm: alpha_vantage unavailable, falling through");
      }
    }

    // All budgets exhausted — return stale cache if available, else throw
    if (existing.length > 0) {
      logger.warn({ ticker: t }, "sdm: all budgets exhausted, returning stale cache");
      return { data: existing[0], source: "stale-cache", fromCache: true };
    }

    throw new Error(`sdm: all data sources exhausted for ${t}`);
  }

  async getSourceBudgets(): Promise<Record<string, number>> {
    const rows = await db.select().from(dataSources);
    const budgets: Record<string, number> = {};
    for (const row of rows) {
      budgets[row.name] = row.isActive ? Math.max(0, row.dailyLimit - row.callsToday) : 0;
    }
    // Ensure edgar always has budget (it's rate-limit-free)
    if (!("edgar" in budgets)) budgets["edgar"] = 9999;
    return budgets;
  }

  async resetDailyCountersIfNeeded(): Promise<void> {
    const today = todayStr();
    const rows = await db.select().from(dataSources);
    for (const row of rows) {
      if (row.lastResetDate !== today) {
        await db
          .update(dataSources)
          .set({ callsToday: 0, lastResetDate: today })
          .where(eq(dataSources.id, row.id));
      }
    }
  }

  async importHistoryRow(row: HistoryCSVRow): Promise<void> {
    const values = {
      ticker:          row.ticker.toUpperCase(),
      year:            row.year,
      peRatio:         row.pe_ratio !== undefined ? String(row.pe_ratio) : null,
      priceToBook:     row.price_to_book !== undefined ? String(row.price_to_book) : null,
      roic:            row.roic !== undefined ? String(row.roic) : null,
      grossMargin:     row.gross_margin !== undefined ? String(row.gross_margin) : null,
      operatingMargin: row.operating_margin !== undefined ? String(row.operating_margin) : null,
      netMargin:       row.net_margin !== undefined ? String(row.net_margin) : null,
      revenue:         row.revenue !== undefined ? String(row.revenue) : null,
      ebitda:          row.ebitda !== undefined ? String(row.ebitda) : null,
      eps:             row.eps !== undefined ? String(row.eps) : null,
      source:          "lseg_csv",
    };

    await db
      .insert(tickerFundamentalsHistory)
      .values(values)
      .onConflictDoUpdate({
        target: [tickerFundamentalsHistory.ticker, tickerFundamentalsHistory.year],
        set: values,
      });
  }

  async getMetricHistory(
    ticker: string,
    metric: keyof TickerFundamentalsHistory,
  ): Promise<number[]> {
    const rows = await db
      .select()
      .from(tickerFundamentalsHistory)
      .where(eq(tickerFundamentalsHistory.ticker, ticker.toUpperCase()))
      .orderBy(tickerFundamentalsHistory.year);

    return rows
      .map(r => {
        const v = r[metric];
        if (v === null || v === undefined) return null;
        const n = parseFloat(String(v));
        return isFinite(n) ? n : null;
      })
      .filter((v): v is number => v !== null);
  }

  computeHistoricalPercentile(currentValue: number, history: number[]): number {
    if (history.length === 0) return 0.5;
    const below = history.filter(v => v <= currentValue).length;
    return below / history.length;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async incrementCalls(sourceName: string): Promise<void> {
    const rows = await db
      .select()
      .from(dataSources)
      .where(eq(dataSources.name, sourceName))
      .limit(1);

    if (rows.length > 0) {
      await db
        .update(dataSources)
        .set({ callsToday: rows[0].callsToday + 1 })
        .where(eq(dataSources.id, rows[0].id));
    }
  }
}

export const stockDataManager = new StockDataManager();
