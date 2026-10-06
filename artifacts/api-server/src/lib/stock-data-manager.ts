/**
 * StockDataManager — gold READ + history CSV + source budget status.
 *
 * Gold fundamentals are written ONLY by enrich → populate → merge-trusted
 * (nightly-enrichment or enrichAndMergeTickers). This module must never
 * upsert ticker_fundamentals from a single-provider waterfall.
 */
import { eq, sql } from "drizzle-orm";
import {
  db,
  tickerFundamentals,
  dataSources,
  tickerFundamentalsHistory,
  type TickerFundamentalsRow,
  type TickerFundamentalsHistory,
} from "@workspace/db";
import { STALE_DAYS } from "./data-ops-config.js";
import { enrichAndMergeTickers, loadGoldFundamentals } from "./enrich-and-merge.js";
import { normalizeUsageSource } from "./api-usage.js";
import { usageCalendarDate } from "./usage-date.js";
import { logger } from "./logger.js";

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

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function isFresh(row: TickerFundamentalsRow): boolean {
  if (!row.fundamentalsLastFetched) return false;
  const ageMs = Date.now() - new Date(row.fundamentalsLastFetched).getTime();
  return ageMs < STALE_DAYS * 24 * 60 * 60 * 1000;
}

export class StockDataManager {
  /**
   * Return gold fundamentals. Fresh rows are served from DB.
   * Stale/missing rows go through enrichAndMergeTickers (Yahoo-first FIELD_DEFS path).
   */
  async getFundamentals(ticker: string): Promise<FundamentalsResult> {
    const t = ticker.toUpperCase();

    await this.resetDailyCountersIfNeeded();

    const existing = await db
      .select()
      .from(tickerFundamentals)
      .where(eq(tickerFundamentals.ticker, t))
      .limit(1);

    if (existing.length > 0 && isFresh(existing[0])) {
      return {
        data: existing[0],
        source: existing[0].lastSource ?? "merge-trusted",
        fromCache: true,
      };
    }

    const result = await enrichAndMergeTickers([t]);
    if (result.skipped && result.reason === "enrichment already running") {
      if (existing.length > 0) {
        logger.warn({ ticker: t }, "sdm: enrich busy — returning stale gold");
        return { data: existing[0], source: "stale-cache", fromCache: true };
      }
      throw new Error(`sdm: enrichment busy and no gold row for ${t}`);
    }

    const rows = await loadGoldFundamentals([t]);
    if (rows.length > 0) {
      return {
        data: rows[0],
        source: rows[0].lastSource ?? "merge-trusted",
        fromCache: false,
      };
    }

    if (existing.length > 0) {
      logger.warn({ ticker: t, reason: result.reason }, "sdm: enrich left no new gold — stale");
      return { data: existing[0], source: "stale-cache", fromCache: true };
    }

    throw new Error(
      `sdm: no gold fundamentals for ${t} after enrich (${result.reason ?? "unknown"})`,
    );
  }

  async getSourceBudgets(): Promise<Record<string, number>> {
    // Remaining budget from api_usage (API Monitor SoT), not stale data_sources.calls_today.
    const today = usageCalendarDate();
    const usage = await db.execute<{ source: string; calls_made: number }>(
      sql`SELECT source, calls_made FROM api_usage WHERE date = ${today}::date`,
    );
    const used = new Map(usage.rows.map((r) => [r.source, Number(r.calls_made)]));
    const rows = await db.select().from(dataSources);
    const budgets: Record<string, number> = {};
    for (const row of rows) {
      const key = normalizeUsageSource(row.name);
      const calls = used.get(key) ?? used.get(row.name) ?? 0;
      budgets[row.name] = row.isActive ? Math.max(0, row.dailyLimit - calls) : 0;
    }
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
      ticker: row.ticker.toUpperCase(),
      year: row.year,
      peRatio: row.pe_ratio !== undefined ? String(row.pe_ratio) : null,
      priceToBook: row.price_to_book !== undefined ? String(row.price_to_book) : null,
      roic: row.roic !== undefined ? String(row.roic) : null,
      grossMargin: row.gross_margin !== undefined ? String(row.gross_margin) : null,
      operatingMargin: row.operating_margin !== undefined ? String(row.operating_margin) : null,
      netMargin: row.net_margin !== undefined ? String(row.net_margin) : null,
      revenue: row.revenue !== undefined ? String(row.revenue) : null,
      ebitda: row.ebitda !== undefined ? String(row.ebitda) : null,
      eps: row.eps !== undefined ? String(row.eps) : null,
      source: "lseg_csv",
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
      .map((r) => {
        const v = r[metric];
        if (v === null || v === undefined) return null;
        const n = parseFloat(String(v));
        return isFinite(n) ? n : null;
      })
      .filter((v): v is number => v !== null);
  }

  computeHistoricalPercentile(currentValue: number, history: number[]): number {
    if (history.length === 0) return 0.5;
    const below = history.filter((v) => v <= currentValue).length;
    return below / history.length;
  }
}

export const stockDataManager = new StockDataManager();
