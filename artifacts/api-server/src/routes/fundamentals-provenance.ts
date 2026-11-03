import { Router } from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  db, sourceFundamentals, fieldProvenance, manualOverrides, tickerFundamentals,
  yahooFundamentals, edgarFundamentals, finnhubFundamentals, polygonFundamentals,
  avFundamentals, fmpFundamentals,
  type ManualOverridesRow,
} from "@workspace/db";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { resolveField, writeProvenance, FIELD_DEFS } from "../scripts/merge-trusted.js";
import { computeAndPersistFundamentalScores } from "../lib/fundamentals-db.js";
import { getLatestRegime } from "./regime.js";
import { logger } from "../lib/logger.js";
import { WRDS_FIELD_MAP } from "../lib/database-agent-resolve.js";

const router = Router();

// All sources we track across all fields
const ALL_SOURCES = ["yahoo", "finnhub", "fmp", "edgar", "polygon", "alpha_vantage", "factset", "derived"];
// Research / desk sources shown in the cell popup (local caches — not bronze priority).
const RESEARCH_SOURCES = ["wrds", "lseg", "schwab"] as const;

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
    // Was mislabeled "definitionally incompatible" — actually a parser bug (finnhub-client.ts
    // wrongly divided the raw ratio by 100). Fixed 2026-07-23 and now agrees closely with fmp,
    // but left out of default priority pending broader validation; used via manual override
    // on tickers where yahoo's own scaling is ambiguous (see manual_overrides notes).
    debtToEquity:   "excluded from default priority pending broader validation (parser bug fixed 2026-07-23 — see override notes on affected tickers)",
    priceToSales:   "not tracked by Finnhub",
    wacc:           "not tracked by Finnhub",
    effectiveTaxRate: "not tracked by Finnhub",
    forwardPe:      "not tracked by Finnhub",
    pegRatio:       "Finnhub only exposes forwardPEG — not comparable to trailing/5yr PEG; gold uses derived PE÷growth",
    dividendYield:  "Finnhub DY may be decimal or percent-points; populate normalizes (v>0.2 → ÷100)",
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
    const [provRows, sfRows, overrideRows, yahooRow, edgarRow, finnhubRow, polygonRow, avRow, fmpRow, wrdsPack, lsegPack] = await Promise.all([
      db.select().from(fieldProvenance).where(eq(fieldProvenance.ticker, ticker)),
      db.select().from(sourceFundamentals).where(eq(sourceFundamentals.ticker, ticker)),
      db.select().from(manualOverrides).where(eq(manualOverrides.ticker, ticker)),
      db.select({ fetchedAt: yahooFundamentals.fetchedAt }).from(yahooFundamentals).where(eq(yahooFundamentals.ticker, ticker)),
      db.select({ fetchedAt: edgarFundamentals.fetchedAt }).from(edgarFundamentals).where(eq(edgarFundamentals.ticker, ticker)),
      db.select({ fetchedAt: finnhubFundamentals.fetchedAt }).from(finnhubFundamentals).where(eq(finnhubFundamentals.ticker, ticker)),
      db.select({ fetchedAt: polygonFundamentals.fetchedAt }).from(polygonFundamentals).where(eq(polygonFundamentals.ticker, ticker)),
      db.select({ fetchedAt: avFundamentals.fetchedAt }).from(avFundamentals).where(eq(avFundamentals.ticker, ticker)),
      db.select({ fetchedAt: fmpFundamentals.fetchedAt }).from(fmpFundamentals).where(eq(fmpFundamentals.ticker, ticker)),
      db.execute(sql`
        SELECT pe_exi, bm, ps, roe, roa, npm, gpm, de_ratio, curr_ratio, fetched_at
        FROM wrds_research.finratio_snapshot WHERE ticker = ${ticker}
      `).catch(() => ({ rows: [] as any[] })),
      db.execute(sql`
        SELECT field, lseg_value, checked_at
        FROM lseg_research.gold_audit WHERE ticker = ${ticker}
      `).catch(() => ({ rows: [] as any[] })),
    ]);

    const wrdsRow = ((wrdsPack as any).rows ?? wrdsPack)?.[0] as Record<string, unknown> | undefined;
    const lsegByField = new Map<string, { value: number; at: Date | null }>();
    for (const row of ((lsegPack as any).rows ?? lsegPack) as any[]) {
      const v = Number(row.lseg_value);
      if (Number.isFinite(v)) lsegByField.set(String(row.field), { value: v, at: row.checked_at ?? null });
    }

    // Last time each source's fetch job actually ran for this ticker, independent
    // of whether any given field came back — distinguishes "queried, source had
    // nothing for this field" from "this source has never been fetched for this
    // ticker at all". See lastQueriedAt on each source entry below.
    const lastQueried: Record<string, Date | null> = {
      yahoo:         yahooRow[0]?.fetchedAt ?? null,
      edgar:         edgarRow[0]?.fetchedAt ?? null,
      finnhub:       finnhubRow[0]?.fetchedAt ?? null,
      polygon:       polygonRow[0]?.fetchedAt ?? null,
      alpha_vantage: avRow[0]?.fetchedAt ?? null,
      fmp:           fmpRow[0]?.fetchedAt ?? null,
    };

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
          // Sources excluded from priority still get looked up under the canonical field
          // name — source_fundamentals always stores rows under it regardless of source —
          // so an admin override pointing at an excluded source (e.g. after a parser fix
          // makes it trustworthy again) can still surface its value here.
          const sfField = priority.find(([s]) => s === source)?.[1] ?? field;
          const sfEntry = sfByField.get(sfField)?.get(source);
          const isWinner = !override && prov?.winningSource === source;

          let status: "used" | "available" | "excluded" | "no_data";
          let exclusionReason: string | undefined;

          if (override?.overrideSource === source && sfEntry) {
            // Active override wins even if the source is normally excluded from priority —
            // an admin deliberately picked it, so it shouldn't read as "excl" in the table.
            status = "used";
          } else if (isWinner) {
            // Derived ratios have no source_fundamentals row and are not in the priority
            // list. The winner check has to beat "excluded", or the popup hides them.
            status = "used";
          } else if (!prioritySources.has(source)) {
            status = "excluded";
            exclusionReason = EXCLUDED_REASONS[source]?.[field] ?? "not in priority list for this field";
          } else if (!sfEntry) {
            status = "no_data";
          } else {
            status = "available";
          }

          const winningNum = prov?.winningValue != null ? parseFloat(String(prov.winningValue)) : null;
          return {
            source,
            value:        sfEntry?.value ?? (isWinner && winningNum != null && isFinite(winningNum) ? winningNum : null),
            fetchedAt:    sfEntry?.fetchedAt ?? (isWinner ? prov?.fetchedAt ?? null : null),
            lastQueriedAt: lastQueried[source] ?? null,
            status,
            exclusionReason,
          };
        });

        // Local research refs (WRDS / LSEG / Schwab) — desk gold, never bronze priority.
        const research: Array<{
          source: (typeof RESEARCH_SOURCES)[number];
          value: number | null;
          fetchedAt: string | null;
          status: "available" | "no_data" | "n/a";
          note?: string;
        }> = [];
        const wrdsMap = WRDS_FIELD_MAP[field];
        if (wrdsMap && wrdsRow) {
          const raw = wrdsRow[wrdsMap.col];
          const num = raw != null ? Number(raw) : NaN;
          const transformed = Number.isFinite(num)
            ? (wrdsMap.transform ? wrdsMap.transform(num) : num)
            : NaN;
          research.push({
            source: "wrds",
            value: Number.isFinite(transformed) ? transformed : null,
            fetchedAt: wrdsRow.fetched_at ? String(wrdsRow.fetched_at) : null,
            status: Number.isFinite(transformed) ? "available" : "no_data",
            note: wrdsMap.col === "bm" ? "WRDS bm→P/B=1/bm" : `finratio.${wrdsMap.col}`,
          });
        } else {
          research.push({
            source: "wrds",
            value: null,
            fetchedAt: wrdsRow?.fetched_at ? String(wrdsRow.fetched_at) : null,
            status: wrdsMap ? "no_data" : "n/a",
            note: wrdsMap ? undefined : "no WRDS mapping for this field",
          });
        }
        const lseg = lsegByField.get(field);
        research.push({
          source: "lseg",
          value: lseg?.value ?? null,
          fetchedAt: lseg?.at ? String(lseg.at) : null,
          status: lseg ? "available" : "no_data",
          note: "lseg_research.gold_audit",
        });
        research.push({
          source: "schwab",
          value: null,
          fetchedAt: null,
          status: "n/a",
          note: "quotes/chains only — not a fundamentals ratio source",
        });

        const agentNote = typeof override?.note === "string" && override.note.startsWith("agent:")
          ? override.note
          : null;

        return {
          field,
          winningSource: prov?.winningSource ?? null,
          winningValue:  prov?.winningValue != null ? parseFloat(String(prov.winningValue)) : null,
          isOverride:    prov?.isOverride ?? false,
          divergent:     prov?.divergent ?? false,
          fetchedAt:     prov?.fetchedAt ?? null,
          isAgentOverride: !!agentNote,
          agentNote,
          override: override ? {
            source:    override.overrideSource,
            value:     override.overrideValue != null ? parseFloat(String(override.overrideValue)) : null,
            note:      override.note,
            createdAt: override.createdAt,
          } : null,
          sources,
          research,
        };
      });

    const fwdMap = sfByField.get("forwardEps");
    if (fwdMap && fwdMap.size > 0) {
      const ranked = [...fwdMap.entries()].sort((a, b) => +new Date(b[1].fetchedAt) - +new Date(a[1].fetchedAt));
      const [winSrc, win] = ranked[0]!;
      fields.push({
        field: "forwardEps",
        winningSource: winSrc,
        winningValue: win.value,
        isOverride: false,
        divergent: false,
        fetchedAt: win.fetchedAt,
        isAgentOverride: false,
        agentNote: null,
        override: null,
        sources: ALL_SOURCES.map(source => {
          const hit = fwdMap.get(source);
          const used = source === winSrc;
          return {
            source,
            value: hit?.value ?? null,
            fetchedAt: hit?.fetchedAt ?? null,
            lastQueriedAt: lastQueried[source] ?? null,
            status: used ? "used" as const : hit ? "available" as const : "no_data" as const,
            exclusionReason: undefined,
          };
        }),
        research: [],
      });
    }

    const payload = { ticker, fields };
    return res.json(payload);
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// ── GET /fundamentals/divergent ───────────────────────────────────────────────
// Review queue: every (ticker, field) where sources disagree and no admin has
// resolved it via override yet. Divergence detection alone doesn't pick a
// value — this just makes the backlog visible so a human can decide.

router.get("/fundamentals/divergent", requireAdmin, async (_req, res) => {
  try {
    const rows = await db.select({
      ticker:        fieldProvenance.ticker,
      field:         fieldProvenance.field,
      winningSource: fieldProvenance.winningSource,
      winningValue:  fieldProvenance.winningValue,
      fetchedAt:     fieldProvenance.fetchedAt,
    }).from(fieldProvenance).where(and(eq(fieldProvenance.divergent, true), eq(fieldProvenance.isOverride, false)));

    const items = rows
      .map(r => ({
        ticker:        r.ticker,
        field:         r.field,
        winningSource: r.winningSource,
        winningValue:  r.winningValue != null ? parseFloat(String(r.winningValue)) : null,
        fetchedAt:     r.fetchedAt,
      }))
      .sort((a, b) => a.ticker.localeCompare(b.ticker) || a.field.localeCompare(b.field));

    return res.json({ items, count: items.length });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// Recompute the comma-separated override_flags column for a ticker from manual_overrides —
// keeps the bulk grid view's blue-outline indicator in sync without a per-cell provenance
// fetch. Mirrors discrepancy_flags, which does the same for divergent fields.
async function syncOverrideFlags(ticker: string) {
  const rows = await db.select({ field: manualOverrides.field, note: manualOverrides.note })
    .from(manualOverrides).where(eq(manualOverrides.ticker, ticker));
  const overrideFlags = rows.length > 0 ? rows.map(r => r.field).join(",") : null;
  const agentRows = rows.filter(r => typeof r.note === "string" && r.note.startsWith("agent:"));
  const agentOverrideFlags = agentRows.length > 0 ? agentRows.map(r => r.field).join(",") : null;
  await db.insert(tickerFundamentals)
    .values({ ticker, overrideFlags, agentOverrideFlags } as any)
    .onConflictDoUpdate({
      target: tickerFundamentals.ticker,
      set: { overrideFlags, agentOverrideFlags } as any,
    });
}

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

    await syncOverrideFlags(t);
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

    await syncOverrideFlags(t);
    getLatestRegime().then(regime => computeAndPersistFundamentalScores(regime)).catch(err =>
      logger.warn({ err: String(err) }, "fundamentals: score recompute after override delete failed")
    );
    return res.json({ ok: true, resolved: result });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

export default router;
