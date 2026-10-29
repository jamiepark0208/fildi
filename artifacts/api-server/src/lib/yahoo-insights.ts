/**
 * Yahoo `insights` → Trading Central valuation / key technicals / outlooks, Argus target + rating, Morningstar bull/bear
 * text, Yahoo company scores (Jamie 10-29, A283: "add all of these"). Display + AI context only — no score reads these
 * until a study passes. One home: `yahoo_insights_daily` (one row per ticker per ET day); raw payload → vendor_raw.
 * Argus PT also lands in watchlist_sync.external_intrinsic (source argus_pt, street family) next to StarMine / FMP.
 */
import { pool } from "@workspace/db";
import { yahooFinance, withDeadline, assertYahooAvailable, noteYahooFailure, noteYahooSuccess } from "./yahoo-client.js";
import { rememberVendorPayload } from "./vendor-raw.js";
import { logApiCall } from "./api-logger.js";
import { logger } from "./logger.js";

const DDL = `CREATE TABLE IF NOT EXISTS yahoo_insights_daily (
  ticker text NOT NULL, as_of date NOT NULL,
  tc_valuation text, tc_discount_pct double precision, tc_relative_value text,
  tc_support double precision, tc_resistance double precision, tc_stop_loss double precision,
  tc_short_dir text, tc_short_score int, tc_mid_dir text, tc_mid_score int, tc_long_dir text, tc_long_score int,
  tc_outlook jsonb, argus_target double precision, argus_rating text,
  ms_bull jsonb, ms_bear jsonb, company_scores jsonb, sector_scores jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (ticker, as_of))`;

type Outlook = { direction?: string; score?: number; scoreDescription?: string; stateDescription?: string;
  sectorDirection?: string; sectorScore?: number; indexDirection?: string; indexScore?: number };
type Insights = {
  instrumentInfo?: {
    technicalEvents?: { shortTermOutlook?: Outlook; intermediateTermOutlook?: Outlook; longTermOutlook?: Outlook };
    keyTechnicals?: { support?: number; resistance?: number; stopLoss?: number };
    valuation?: { description?: string; discount?: string; relativeValue?: string };
  };
  recommendation?: { targetPrice?: number; rating?: string; provider?: string };
  companySnapshot?: { company?: Record<string, number>; sector?: Record<string, number> };
  upsell?: { msBullishSummary?: string[]; msBearishSummary?: string[] };
};

export interface InsightsRow {
  ticker: string;
  tcValuation: string | null;
  /** + = Trading Central says undervalued by this %, − = overvalued (its "discount" is unsigned). */
  tcDiscountPct: number | null;
  tcRelativeValue: string | null;
  support: number | null; resistance: number | null; stopLoss: number | null;
  short: Outlook | null; mid: Outlook | null; long: Outlook | null;
  argusTarget: number | null; argusRating: string | null;
  msBull: string[] | null; msBear: string[] | null;
  company: Record<string, number> | null; sector: Record<string, number> | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function parseInsights(ticker: string, r: Insights): InsightsRow {
  const ii = r.instrumentInfo ?? {};
  const val = ii.valuation ?? {};
  const pct = val.discount ? Number(String(val.discount).replace("%", "")) : NaN;
  const desc = (val.description ?? "").toLowerCase();
  const sign = desc.startsWith("over") ? -1 : desc.startsWith("under") ? 1 : 0;
  const te = ii.technicalEvents ?? {};
  const rec = r.recommendation?.provider === "Argus Research" ? r.recommendation : undefined;
  return {
    ticker,
    tcValuation: val.description ?? null,
    tcDiscountPct: Number.isFinite(pct) && sign !== 0 ? sign * pct : null,
    tcRelativeValue: val.relativeValue ?? null,
    support: num(ii.keyTechnicals?.support), resistance: num(ii.keyTechnicals?.resistance), stopLoss: num(ii.keyTechnicals?.stopLoss),
    short: te.shortTermOutlook ?? null, mid: te.intermediateTermOutlook ?? null, long: te.longTermOutlook ?? null,
    argusTarget: num(rec?.targetPrice), argusRating: rec?.rating ?? null,
    msBull: r.upsell?.msBullishSummary ?? null, msBear: r.upsell?.msBearishSummary ?? null,
    company: r.companySnapshot?.company ?? null, sector: r.companySnapshot?.sector ?? null,
  };
}

let ensured = false;
async function ensure(): Promise<void> {
  if (ensured) return;
  await pool.query(DDL);
  ensured = true;
}

async function store(row: InsightsRow, price: number | null): Promise<void> {
  const j = (v: unknown) => (v == null ? null : JSON.stringify(v));
  await pool.query(
    `INSERT INTO yahoo_insights_daily (ticker, as_of, tc_valuation, tc_discount_pct, tc_relative_value, tc_support, tc_resistance,
       tc_stop_loss, tc_short_dir, tc_short_score, tc_mid_dir, tc_mid_score, tc_long_dir, tc_long_score, tc_outlook, argus_target,
       argus_rating, ms_bull, ms_bear, company_scores, sector_scores)
     VALUES ($1, (now() AT TIME ZONE 'America/New_York')::date, $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     ON CONFLICT (ticker, as_of) DO UPDATE SET tc_valuation = EXCLUDED.tc_valuation, tc_discount_pct = EXCLUDED.tc_discount_pct,
       tc_relative_value = EXCLUDED.tc_relative_value, tc_support = EXCLUDED.tc_support, tc_resistance = EXCLUDED.tc_resistance,
       tc_stop_loss = EXCLUDED.tc_stop_loss, tc_short_dir = EXCLUDED.tc_short_dir, tc_short_score = EXCLUDED.tc_short_score,
       tc_mid_dir = EXCLUDED.tc_mid_dir, tc_mid_score = EXCLUDED.tc_mid_score, tc_long_dir = EXCLUDED.tc_long_dir,
       tc_long_score = EXCLUDED.tc_long_score, tc_outlook = EXCLUDED.tc_outlook, argus_target = EXCLUDED.argus_target,
       argus_rating = EXCLUDED.argus_rating, ms_bull = EXCLUDED.ms_bull, ms_bear = EXCLUDED.ms_bear,
       company_scores = EXCLUDED.company_scores, sector_scores = EXCLUDED.sector_scores, fetched_at = now()`,
    [row.ticker, row.tcValuation, row.tcDiscountPct, row.tcRelativeValue, row.support, row.resistance, row.stopLoss,
      row.short?.direction ?? null, num(row.short?.score), row.mid?.direction ?? null, num(row.mid?.score),
      row.long?.direction ?? null, num(row.long?.score), j({ short: row.short, mid: row.mid, long: row.long }),
      row.argusTarget, row.argusRating, j(row.msBull), j(row.msBear), j(row.company), j(row.sector)],
  );
  if (row.argusTarget != null) {
    await pool.query(
      `INSERT INTO watchlist_sync.external_intrinsic (ticker, as_of, source, value, price, detail)
       VALUES ($1, (now() AT TIME ZONE 'America/New_York')::date, 'argus_pt', $2, $3, $4)
       ON CONFLICT (ticker, as_of, source) DO UPDATE SET value = EXCLUDED.value, price = EXCLUDED.price, detail = EXCLUDED.detail`,
      [row.ticker, row.argusTarget, price, JSON.stringify({ rating: row.argusRating, family: "street" })],
    );
  }
}

/** Sequential, ≥ 1.2 s apart, 8 s deadline per call, stops when the shared Yahoo circuit opens (AGENTS.md 8c). */
export async function syncYahooInsights(tickers: string[], gapMs = 1200): Promise<{ ok: number; failed: number }> {
  await ensure();
  const prices = new Map<string, number>(
    (await pool.query<{ ticker: string; p: number }>(
      `SELECT DISTINCT ON (ticker) ticker, price_close p FROM lseg_research.signals_daily WHERE ticker = ANY($1) ORDER BY ticker, as_of DESC`,
      [tickers],
    ).catch(() => ({ rows: [] as { ticker: string; p: number }[] }))).rows.map((r) => [r.ticker, Number(r.p)]),
  );
  let ok = 0, failed = 0;
  for (const t of tickers) {
    try {
      assertYahooAvailable("yahoo-insights");
    } catch {
      logger.warn({ left: tickers.length - ok - failed }, "yahoo-insights: circuit open, stopping");
      break;
    }
    try {
      const r = (await withDeadline(
        yahooFinance.insights(t, { reportsCount: 0 }, { validateResult: false }),
        8000,
        `insights ${t}`,
      )) as Insights;
      noteYahooSuccess();
      logApiCall({ source: "yahoo", fn: "insights", trigger: "sync-yahoo-insights", ticker: t, outcome: "success" });
      await rememberVendorPayload({ source: "yahoo", endpoint: "insights", key: t, payload: r });
      await store(parseInsights(t, r), prices.get(t) ?? null);
      ok++;
    } catch (err) {
      noteYahooFailure(err);
      logApiCall({ source: "yahoo", fn: "insights", trigger: "sync-yahoo-insights", ticker: t, outcome: "failure", error: String(err) });
      failed++;
    }
    await new Promise((res) => setTimeout(res, gapMs));
  }
  return { ok, failed };
}

export async function latestInsights(ticker: string): Promise<Record<string, unknown> | null> {
  await ensure();
  const r = await pool.query(`SELECT * FROM yahoo_insights_daily WHERE ticker = $1 ORDER BY as_of DESC LIMIT 1`, [ticker.toUpperCase()]);
  return r.rows[0] ?? null;
}
