/**
 * FactSet referee — last-resort fill for gold nulls and cross-source divergences.
 * Writes source_fundamentals (source='factset') then caller re-runs merge-trusted.
 * Never upserts ticker_fundamentals directly.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  dataSources,
  fieldProvenance,
  pricesHistorical,
  sourceFundamentals,
  tickerFundamentals,
  tickerRegistry,
} from "@workspace/db";
import {
  deriveFactSetValuations,
  fetchFactSetFundamentals,
  type FactSetFundamentalsPartial,
} from "./factset-client.js";
import { isCohortDueToday } from "./data-ops-config.js";
import { logger } from "./logger.js";
import { recordApiUsage } from "./api-usage.js";

/** Map FactSet partial keys → source_fundamentals field names (FIELD_DEFS sfField). */
const FACTSET_FIELD_MAP: Array<{
  key: keyof FactSetFundamentalsPartial;
  sfField: string;
}> = [
  { key: "totalRevenue", sfField: "totalRevenue" },
  { key: "netIncome", sfField: "netIncome" },
  { key: "ebitda", sfField: "ebitda" },
  { key: "ebit", sfField: "ebit" },
  { key: "earningsPerShare", sfField: "earningsPerShare" },
  { key: "bookValuePerShare", sfField: "bookValuePerShare" },
  { key: "grossMargin", sfField: "grossMargin" },
  { key: "operatingMargin", sfField: "operatingMargin" },
  { key: "netMargin", sfField: "netMargin" },
  { key: "returnOnEquity", sfField: "returnOnEquity" },
  { key: "returnOnAssets", sfField: "returnOnAssets" },
  { key: "totalStockholdersEquity", sfField: "totalStockholdersEquity" },
  { key: "freeCashFlow", sfField: "freeCashFlow" },
  { key: "quarterlyOperatingCashFlow", sfField: "quarterlyOperatingCashFlow" },
  { key: "cashAndEquivalents", sfField: "totalCash" }, // FIELD_DEFS yahoo alias
  { key: "currentRatio", sfField: "currentRatio" },
  { key: "debtToEquity", sfField: "debtToEquity" },
  { key: "revenueGrowthYoY", sfField: "revenueGrowthYoY" },
  { key: "epsGrowth", sfField: "epsGrowth" },
  // Derived valuations (price + FactSet fundamentals / consensus forward EPS)
  { key: "peRatio", sfField: "peRatio" },
  { key: "priceToBook", sfField: "priceToBook" },
  { key: "pegRatio", sfField: "pegRatio" },
  { key: "forwardPe", sfField: "forwardPe" },
];

const GOLD_NULL_COLS = [
  "totalRevenue", "netIncome", "ebitda", "ebit", "earningsPerShare",
  "grossMargin", "operatingMargin", "netMargin", "returnOnEquity", "returnOnAssets",
  "totalStockholdersEquity", "freeCashFlow", "quarterlyOperatingCashFlow",
  "cashAndEquivalents", "currentRatio", "debtToEquity", "revenueGrowthYoY", "epsGrowth",
  "peRatio", "priceToBook", "pegRatio", "forwardPe",
] as const;

async function latestClosePrice(ticker: string): Promise<number | null> {
  const rows = await db
    .select({ close: pricesHistorical.close })
    .from(pricesHistorical)
    .where(eq(pricesHistorical.ticker, ticker))
    .orderBy(desc(pricesHistorical.date))
    .limit(1);
  const n = rows[0]?.close != null ? Number(rows[0].close) : NaN;
  return isFinite(n) && n > 0 ? n : null;
}

/** Prefer Yahoo forward EPS; any free source with forwardEps works. */
async function consensusForwardEps(ticker: string): Promise<number | null> {
  const rows = await db
    .select({ source: sourceFundamentals.source, value: sourceFundamentals.value })
    .from(sourceFundamentals)
    .where(and(eq(sourceFundamentals.ticker, ticker), eq(sourceFundamentals.field, "forwardEps")));
  const bySrc = new Map(rows.map((r) => [r.source, Number(r.value)]));
  for (const src of ["yahoo", "fmp", "finnhub", "alpha_vantage"]) {
    const v = bySrc.get(src);
    if (v != null && isFinite(v) && v > 0) return v;
  }
  return null;
}

const DEFAULT_DAILY_CAP = 40; // stay well under FactSet plan; prefer cohort rotation

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function factsetBudgetRemaining(): Promise<number> {
  const rows = await db.select().from(dataSources).where(eq(dataSources.name, "factset")).limit(1);
  if (rows.length === 0) return 0;
  const row = rows[0];
  if (!row.isActive) return 0;
  return Math.max(0, row.dailyLimit - row.callsToday);
}

async function incrementFactsetCalls(n = 1): Promise<void> {
  await db.execute(sql`
    UPDATE data_sources
    SET calls_today = calls_today + ${n}
    WHERE name = 'factset'
  `);
  // API Monitor reads api_usage — keep both counters in sync.
  await recordApiUsage("factset", n).catch(() => {});
}

export async function selectFactsetRefereeCandidates(limit: number): Promise<string[]> {
  const flagged = await db
    .select({ ticker: tickerRegistry.ticker })
    .from(tickerRegistry)
    .where(eq(tickerRegistry.fetchFundamentals, true));
  const tickers = flagged.map((r) => r.ticker);
  if (tickers.length === 0) return [];

  const [fundRows, divRows] = await Promise.all([
    db.select().from(tickerFundamentals).where(inArray(tickerFundamentals.ticker, tickers)),
    db
      .select({ ticker: fieldProvenance.ticker })
      .from(fieldProvenance)
      .where(and(eq(fieldProvenance.divergent, true), inArray(fieldProvenance.ticker, tickers))),
  ]);

  const divergent = new Set(divRows.map((r) => r.ticker));
  const needsNull: string[] = [];
  for (const row of fundRows) {
    const rec = row as Record<string, unknown>;
    const hasNull = GOLD_NULL_COLS.some((c) => rec[c] == null);
    if (hasNull) needsNull.push(row.ticker);
  }
  // Never-fetched registry tickers
  const haveFund = new Set(fundRows.map((r) => r.ticker));
  for (const t of tickers) {
    if (!haveFund.has(t)) needsNull.push(t);
  }

  const candidates = [...new Set([...needsNull, ...divergent])];
  // Prefer today's cohort, then the rest
  const due = candidates.filter((t) => isCohortDueToday(t));
  const rest = candidates.filter((t) => !isCohortDueToday(t));
  return [...due, ...rest].slice(0, limit);
}

async function writeFactsetSourceRows(
  ticker: string,
  data: FactSetFundamentalsPartial,
): Promise<number> {
  const now = new Date();
  const rows: Array<{ ticker: string; source: string; field: string; value: string; fetchedAt: Date }> = [];
  for (const { key, sfField } of FACTSET_FIELD_MAP) {
    const v = data[key];
    if (v === undefined || !isFinite(v)) continue;
    rows.push({
      ticker,
      source: "factset",
      field: sfField,
      value: String(v),
      fetchedAt: now,
    });
  }
  if (rows.length === 0) return 0;

  await db
    .insert(sourceFundamentals)
    .values(rows)
    .onConflictDoUpdate({
      target: [sourceFundamentals.ticker, sourceFundamentals.source, sourceFundamentals.field],
      set: {
        value: sql`excluded.value`,
        fetchedAt: sql`excluded.fetched_at`,
      },
    });
  return rows.length;
}

export type FactsetRefereeResult = {
  candidates: number;
  fetched: number;
  fieldsWritten: number;
  skippedBudget: number;
  failed: number;
};

/**
 * Fetch FactSet for null/divergent tickers within budget. Returns stats.
 * Caller should runMergeTrusted() afterward if fieldsWritten > 0.
 *
 * Pass `tickers` to force a small test subset (e.g. one Needs Review name).
 */
export async function runFactsetReferee(opts: {
  dryRun?: boolean;
  maxTickers?: number;
  /** When set, only these tickers are considered (still budget-capped). */
  tickers?: string[];
} = {}): Promise<FactsetRefereeResult> {
  if (!process.env.FACTSET_PROXY_URL || !process.env.FACTSET_PROXY_SECRET) {
    logger.info("factset-referee: proxy not configured — skip");
    return { candidates: 0, fetched: 0, fieldsWritten: 0, skippedBudget: 0, failed: 0 };
  }

  const remaining = await factsetBudgetRemaining();
  const cap = Math.min(opts.maxTickers ?? DEFAULT_DAILY_CAP, remaining);
  if (cap <= 0) {
    logger.info({ remaining }, "factset-referee: no budget");
    return { candidates: 0, fetched: 0, fieldsWritten: 0, skippedBudget: 0, failed: 0 };
  }

  const forced = opts.tickers?.map((t) => t.toUpperCase()).filter(Boolean);
  const candidates = forced?.length
    ? forced
    : await selectFactsetRefereeCandidates(cap * 2);
  const toFetch = candidates.slice(0, cap);
  const skippedBudget = Math.max(0, candidates.length - toFetch.length);

  logger.info(
    { candidates: candidates.length, toFetch: toFetch.length, remaining },
    "factset-referee: starting",
  );

  if (opts.dryRun) {
    return {
      candidates: candidates.length,
      fetched: toFetch.length,
      fieldsWritten: 0,
      skippedBudget,
      failed: 0,
    };
  }

  let fetched = 0;
  let fieldsWritten = 0;
  let failed = 0;

  for (const ticker of toFetch) {
    try {
      const raw = await fetchFactSetFundamentals(ticker);
      await incrementFactsetCalls(1);
      if (!raw) {
        failed++;
        continue;
      }
      const [price, fwdEps] = await Promise.all([
        latestClosePrice(ticker),
        consensusForwardEps(ticker),
      ]);
      const data = deriveFactSetValuations(raw, price, fwdEps);
      const n = await writeFactsetSourceRows(ticker, data);
      if (n > 0) {
        fetched++;
        fieldsWritten += n;
        logger.info(
          {
            ticker,
            price,
            peRatio: data.peRatio,
            priceToBook: data.priceToBook,
            pegRatio: data.pegRatio,
            forwardPe: data.forwardPe,
            eps: data.earningsPerShare,
            bvps: data.bookValuePerShare,
          },
          "factset-referee: derived valuations",
        );
      } else {
        failed++;
      }
    } catch (err) {
      failed++;
      logger.warn({ ticker, err }, "factset-referee: fetch failed");
    }
    await sleep(250);
  }

  logger.info({ fetched, fieldsWritten, failed, skippedBudget }, "factset-referee: done");
  return {
    candidates: candidates.length,
    fetched,
    fieldsWritten,
    skippedBudget,
    failed,
  };
}
