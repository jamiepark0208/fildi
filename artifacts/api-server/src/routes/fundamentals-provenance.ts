import { Router } from "express";
import { and, eq } from "drizzle-orm";
import {
  db, sourceFundamentals, fieldProvenance, manualOverrides, tickerFundamentals,
  type ManualOverridesRow,
} from "@workspace/db";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { resolveField, writeProvenance, FIELD_DEFS } from "../scripts/merge-trusted.js";
import { provenanceCache } from "../lib/provenance-cache.js";
import { computeAndPersistFundamentalScores } from "../lib/fundamentals-db.js";
import { getLatestRegime } from "./regime.js";
import { logger } from "../lib/logger.js";

const router = Router();

// All sources we track across all fields
const ALL_SOURCES = ["yahoo", "finnhub", "fmp", "edgar", "polygon", "alpha_vantage"];

// Derive excluded sources per field from FIELD_DEFS priority lists
const EXCLUDED_REASONS: Record<string, Record<string, string>> = {
  edgar: {
    grossMargin:    "period mismatch (EDGAR=annual, field is TTM)",
    operatingMargin:"period mismatch (EDGAR=annual, field is TTM)",
    netMargin:      "period mismatch (EDGAR=annual, field is TTM)",
    returnOnEquity: "period mismatch (EDGAR=annual, field is TTM)",
    returnOnAssets: "period mismatch (EDGAR=annual, field is TTM)",
    revenueGrowthYoY: "period mismatch (EDGAR=annual, field is TTM)",
    roic:           "not tracked by EDGAR",
    peRatio:        "not tracked by EDGAR",
    forwardPe:      "not tracked by EDGAR",
    pegRatio:       "not tracked by EDGAR",
    evEbitda:       "not tracked by EDGAR",
    evRevenue:      "not tracked by EDGAR",
    priceToBook:    "not tracked by EDGAR",
    priceToSales:   "not tracked by EDGAR",
    beta:           "not tracked by EDGAR",
    dividendYield:  "not tracked by EDGAR",
    analystTargetPrice: "not tracked by EDGAR",
    earningsPerShare:   "not tracked by EDGAR",
    wacc:           "not tracked by EDGAR",
    effectiveTaxRate:   "not tracked by EDGAR",
  },
  finnhub: {
    debtToEquity:   "definitionally incompatible (different calculation)",
    priceToSales:   "not tracked by Finnhub",
    wacc:           "not tracked by Finnhub",
    effectiveTaxRate: "not tracked by Finnhub",
    forwardPe:      "not tracked by Finnhub",
    pegRatio:       "not tracked by Finnhub",
    evEbitda:       "not tracked by Finnhub",
    evRevenue:      "not tracked by Finnhub",
    totalRevenue:   "not tracked by Finnhub",
    netIncome:      "not tracked by Finnhub",
    ebitda:         "not tracked by Finnhub",
    ebit:           "not tracked by Finnhub",
    interestExpense:"not tracked by Finnhub",
    cashAndEquivalents: "not tracked by Finnhub",
    totalDebt:      "not tracked by Finnhub",
    totalStockholdersEquity: "not tracked by Finnhub",
    sharesOutstanding:   "not tracked by Finnhub",
    sharesOutstandingPrior: "not tracked by Finnhub",
    freeCashFlow:    "not tracked by Finnhub",
    quarterlyOperatingCashFlow: "not tracked by Finnhub",
    dividendYield:   "not tracked by Finnhub",
    analystTargetPrice: "not tracked by Finnhub",
  },
  polygon: {
    // Polygon only covers 7 income-stmt fields — everything else is excluded
    grossMargin:     "not tracked by Polygon",
    netMargin:       "not tracked by Polygon",
    returnOnEquity:  "not tracked by Polygon",
    returnOnAssets:  "not tracked by Polygon",
    peRatio:         "not tracked by Polygon",
    forwardPe:       "not tracked by Polygon",
    pegRatio:        "not tracked by Polygon",
    evEbitda:        "not tracked by Polygon",
    evRevenue:       "not tracked by Polygon",
    priceToBook:     "not tracked by Polygon",
    priceToSales:    "not tracked by Polygon",
    beta:            "not tracked by Polygon",
    dividendYield:   "not tracked by Polygon",
    analystTargetPrice: "not tracked by Polygon",
    earningsPerShare:   "not tracked by Polygon",
    wacc:            "not tracked by Polygon",
    effectiveTaxRate:"not tracked by Polygon",
    roic:            "not tracked by Polygon",
    revenueGrowthYoY:"not tracked by Polygon",
    epsGrowth:       "not tracked by Polygon",
    debtToEquity:    "not tracked by Polygon",
    cashAndEquivalents: "not tracked by Polygon",
    sharesOutstanding:  "not tracked by Polygon",
    sharesOutstandingPrior: "not tracked by Polygon",
    freeCashFlow:    "not tracked by Polygon",
  },
  alpha_vantage: {
    grossMargin:     "not tracked by Alpha Vantage",
    operatingMargin: "not tracked by Alpha Vantage",
    roic:            "not tracked by Alpha Vantage",
    wacc:            "not tracked by Alpha Vantage",
    debtToEquity:    "not tracked by Alpha Vantage",
    priceToBook:     "not tracked by Alpha Vantage",
    currentRatio:    "not tracked by Alpha Vantage",
    sharesOutstanding: "not tracked by Alpha Vantage",
    sharesOutstandingPrior: "not tracked by Alpha Vantage",
    totalDebt:       "not tracked by Alpha Vantage",
    cashAndEquivalents: "not tracked by Alpha Vantage",
    totalStockholdersEquity: "not tracked by Alpha Vantage",
    freeCashFlow:    "not tracked by Alpha Vantage",
    quarterlyOperatingCashFlow: "not tracked by Alpha Vantage",
    earningsPerShare:"not tracked by Alpha Vantage",
    interestExpense: "not tracked by Alpha Vantage",
    effectiveTaxRate:"not tracked by Alpha Vantage",
  },
};

// ── GET /fundamentals/provenance/:ticker ──────────────────────────────────────
// Returns per-field provenance + all source values for a ticker.

router.get("/fundamentals/provenance/:ticker", requireAdmin, async (req, res) => {
  const ticker = String(req.params.ticker).toUpperCase();
  try {
    const cached = provenanceCache.get(ticker);
    if (cached) return res.json(cached);

    const [provRows, sfRows, overrideRows] = await Promise.all([
      db.select().from(fieldProvenance).where(eq(fieldProvenance.ticker, ticker)),
      db.select().from(sourceFundamentals).where(eq(sourceFundamentals.ticker, ticker)),
      db.select().from(manualOverrides).where(eq(manualOverrides.ticker, ticker)),
    ]);

    // Index provenance rows by field
    const provByField = new Map(provRows.map(r => [r.field, r]));

    // Index source_fundamentals: field → source → {value, fetchedAt}
    const sfByField = new Map<string, Map<string, { value: number; fetchedAt: Date }>>();
    for (const row of sfRows) {
      const val = parseFloat(String(row.value));
      if (!isFinite(val)) continue;
      if (!sfByField.has(row.field)) sfByField.set(row.field, new Map());
      sfByField.get(row.field)!.set(row.source, { value: val, fetchedAt: row.fetchedAt });
    }

    // Index overrides by field
    const overrideByField = new Map(overrideRows.map(r => [r.field, r]));

    // Build response for each FIELD_DEF (valid fields only)
    const fields = FIELD_DEFS
      .filter(({ tfCol }) => (tfCol as string) !== "grossProfit")
      .map(({ tfCol, priority }) => {
        const field = tfCol as string;
        const prov = provByField.get(field);
        const override = overrideByField.get(field) ?? null;

        // Sources in priority list for this field
        const prioritySources = new Set(priority.map(([src]) => src));

        // Build per-source breakdown
        const sources = ALL_SOURCES.map(source => {
          const sfField = priority.find(([s]) => s === source)?.[1];
          const sfEntry = sfField ? sfByField.get(sfField)?.get(source) : undefined;

          let status: "used" | "available" | "excluded" | "no_data";
          let exclusionReason: string | undefined;

          if (!prioritySources.has(source)) {
            status = "excluded";
            exclusionReason = EXCLUDED_REASONS[source]?.[field] ?? "not in priority list for this field";
          } else if (!sfEntry) {
            status = "no_data";
          } else if (prov?.winningSource === source && !override) {
            status = "used";
          } else if (override?.overrideSource === source) {
            status = "used";
          } else {
            status = "available";
          }

          return {
            source,
            value:       sfEntry?.value ?? null,
            fetchedAt:   sfEntry?.fetchedAt ?? null,
            status,
            exclusionReason,
          };
        });

        return {
          field,
          winningSource: prov?.winningSource ?? null,
          winningValue:  prov?.winningValue != null ? parseFloat(String(prov.winningValue)) : null,
          isOverride:    prov?.isOverride ?? false,
          divergent:     prov?.divergent ?? false,
          fetchedAt:     prov?.fetchedAt ?? null,
          override: override ? {
            source:    override.overrideSource,
            value:     override.overrideValue != null ? parseFloat(String(override.overrideValue)) : null,
            note:      override.note,
            createdAt: override.createdAt,
          } : null,
          sources,
        };
      });

    const payload = { ticker, fields };
    provenanceCache.set(ticker, payload);
    return res.json(payload);
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// ── PUT /fundamentals/override ────────────────────────────────────────────────
// Upsert a manual override, then immediately re-resolve and persist that field.
// Body: { ticker, field, source, value?, note? }

router.put("/fundamentals/override", requireAdmin, async (req, res) => {
  const { ticker, field, source, value, note } = req.body ?? {};
  if (!ticker || !field || !source) {
    return res.status(400).json({ error: "ticker, field, and source are required" });
  }
  const t = String(ticker).toUpperCase();
  const f = String(field);
  const s = String(source);
  const v = value != null ? String(parseFloat(value)) : null;

  try {
    // Upsert override
    await db
      .insert(manualOverrides)
      .values({ ticker: t, field: f, overrideSource: s, overrideValue: v, note: note ?? null })
      .onConflictDoUpdate({
        target: [manualOverrides.ticker, manualOverrides.field],
        set: { overrideSource: s, overrideValue: v, note: note ?? null, createdAt: new Date() },
      });

    // Re-resolve and persist immediately
    const result = await resolveField(t, f);
    if (result) {
      const now = new Date();
      await Promise.all([
        db.insert(tickerFundamentals)
          .values({ ticker: t, [f]: result.value } as any)
          .onConflictDoUpdate({
            target: tickerFundamentals.ticker,
            set: { [f]: result.value } as any,
          }),
        writeProvenance(t, f, result, now),
      ]);
    }

    provenanceCache.delete(t);
    // Scores are cross-sectional — any override invalidates all. Fire-and-forget.
    getLatestRegime().then(regime => computeAndPersistFundamentalScores(regime)).catch(err =>
      logger.warn({ err: String(err) }, "fundamentals: score recompute after override failed")
    );
    return res.json({ ok: true, resolved: result });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// ── DELETE /fundamentals/override/:ticker/:field ───────────────────────────────
// Remove a manual override and re-resolve the field using normal priority.

router.delete("/fundamentals/override/:ticker/:field", requireAdmin, async (req, res) => {
  const t = String(req.params.ticker).toUpperCase();
  const f = String(req.params.field);

  try {
    await db
      .delete(manualOverrides)
      .where(and(eq(manualOverrides.ticker, t), eq(manualOverrides.field, f)));

    // Re-resolve without override and persist
    const result = await resolveField(t, f);
    if (result) {
      const now = new Date();
      await Promise.all([
        db.insert(tickerFundamentals)
          .values({ ticker: t, [f]: result.value } as any)
          .onConflictDoUpdate({
            target: tickerFundamentals.ticker,
            set: { [f]: result.value } as any,
          }),
        writeProvenance(t, f, result, now),
      ]);
    }

    provenanceCache.delete(t);
    getLatestRegime().then(regime => computeAndPersistFundamentalScores(regime)).catch(err =>
      logger.warn({ err: String(err) }, "fundamentals: score recompute after override delete failed")
    );
    return res.json({ ok: true, resolved: result });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

export default router;
