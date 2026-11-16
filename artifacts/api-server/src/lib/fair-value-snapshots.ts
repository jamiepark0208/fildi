/**
 * Daily blended fair value → fair_value_snapshots (A14-style: ticker, as_of, components, model_version,
 * inputs_digest). Runs after every fund-score recompute (fundamentals-db.ts) so nightly, Maintain's
 * post-merge-scores, peer overrides and admin recomputes all refresh it. Zero vendor calls except
 * two FRED yields (AAA, 10Y), with fallbacks.
 *
 * Math lives in fair-value.ts; params in scorecard_params lane "fair_value".
 */
import { createHash } from "crypto";
import { pool } from "@workspace/db";
import { computeFairValues, type FairValueParams, type FvTickerInput, type FvMarket, type FairValueResult } from "./fair-value.js";
import { getChampionScorecardParams } from "./scorecard-params.js";
import { fetchFredLatest } from "./macro/macro-fred.js";
import { loadMacroCache } from "./macro/macro-cache.js";
import { logger } from "./logger.js";
import { TTLCache } from "./ttl-cache.js";
import { activeAssumptions, computeAdjusted, ensureAssumptionTables, recordInputs } from "./fv-assumptions.js";

function etDateKey(d = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export async function ensureFairValueTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fair_value_snapshots (
      ticker text NOT NULL,
      as_of date NOT NULL,
      price numeric,
      fair_value numeric,
      low numeric,
      high numeric,
      price_to_fair numeric,
      confidence text,
      spread numeric,
      implied_growth numeric,
      mode text,
      votes jsonb NOT NULL DEFAULT '[]'::jsonb,
      null_reason text,
      market jsonb,
      model_version text,
      inputs_digest text,
      trigger text NOT NULL DEFAULT 'nightly',
      computed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (ticker, as_of)
    );
    CREATE INDEX IF NOT EXISTS idx_fair_value_snapshots_as_of ON fair_value_snapshots (as_of);
    ALTER TABLE fair_value_snapshots ADD COLUMN IF NOT EXISTS cyclical boolean;
    ALTER TABLE fair_value_snapshots ADD COLUMN IF NOT EXISTS value_trap boolean;
  `);
}

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
};

// AAA is monthly and DGS10 daily — a 6h cache keeps bursts of recomputes (peer-override edits)
// from re-hitting FRED. Registered in cache-registry as "fair-value-yields".
export const fredYieldCache = new TTLCache<{ aaa: number | null; dgs10: number | null }>(6 * 60 * 60 * 1000, "fair-value-yields", 1);

/** Live AAA + 10Y from FRED; fall back to the macro cache 10Y, then constants. */
export async function loadMarket(p: { aaaYieldFallbackSpread?: number }): Promise<FvMarket & { source: string }> {
  const spread = p.aaaYieldFallbackSpread ?? 0.008;
  const y = await fredYieldCache.getOrCompute("latest", async () => {
    const [a, t] = await Promise.all([
      fetchFredLatest("AAA").catch(() => null),
      fetchFredLatest("DGS10").catch(() => null),
    ]);
    if (a?.value == null && t?.value == null) throw new Error("FRED unavailable"); // don't cache a total miss
    return { aaa: a?.value ?? null, dgs10: t?.value ?? null };
  }).catch(() => ({ aaa: null, dgs10: null }));
  const aaa = { value: y.aaa };
  const dgs10 = { value: y.dgs10 };
  // FRED AAA/DGS10 are percent points (e.g. 5.12). Persist decimals (0.0512).
  // 2026-10-21: admin_recompute wrote aaaYield=4, riskFree=4 (percent left as "decimal") →
  // grahamForward collapsed (median ~$2, 0 kept). Next day's correct run looked like
  // 195 "fair_value_jumps" — recovery, not a market break. Normalize + range-check.
  const toDecimal = (v: number | null | undefined): number | null => {
    if (v == null || !Number.isFinite(v) || v <= 0) return null;
    return v >= 0.5 ? v / 100 : v; // ≥0.5 → still percent points; else already decimal
  };
  let rf = toDecimal(dgs10?.value ?? null);
  let source = "fred";
  if (rf == null) {
    const cached = loadMacroCache()?.yield10y?.value;
    rf = toDecimal(cached ?? null) ?? 0.045;
    source = cached != null ? "macro_cache" : "constant";
  }
  let aaaYield = toDecimal(aaa?.value ?? null);
  if (aaaYield == null) {
    aaaYield = rf + spread;
    source += "+aaa_fallback";
  }
  if (rf < 0.005 || rf > 0.25 || aaaYield < 0.005 || aaaYield > 0.25) {
    throw new Error(
      `loadMarket: yield units out of range rf=${rf} aaa=${aaaYield} (raw dgs10=${dgs10?.value} aaa=${aaa?.value})`,
    );
  }
  return { riskFree: rf, aaaYield, source };
}

export async function loadInputs(): Promise<FvTickerInput[]> {
  const { rows } = await pool.query(`
    WITH px AS (
      SELECT DISTINCT ON (ticker) ticker, close, date FROM prices_historical ORDER BY ticker, date DESC
    ), lpx AS (
      SELECT DISTINCT ON (ticker) ticker, close, date FROM lseg_research.daily_history
      WHERE close IS NOT NULL AND date >= CURRENT_DATE - 30 ORDER BY ticker, date DESC
    ), mom AS (
      -- lab mom_12_1: close 21 trading days ago / close 252 trading days ago − 1
      SELECT ticker, MAX(close) FILTER (WHERE rn = 22) / NULLIF(MAX(close) FILTER (WHERE rn = 253), 0) - 1 AS mom_12_1
      FROM (SELECT ticker, close, ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) rn
            FROM prices_historical WHERE date >= CURRENT_DATE - 420 AND close > 0) x
      WHERE rn IN (22, 253) GROUP BY ticker
    ), sig AS (
      SELECT DISTINCT ON (ticker) ticker, eps_mean_fy1, pt_mean, price_to_intrinsic, price_close
      FROM lseg_research.signals_daily WHERE as_of >= CURRENT_DATE - 10 ORDER BY ticker, as_of DESC
    ), ib AS (
      -- keyed by oftic (official ticker), same as the fund engine's IBES extras; the IBES "ticker" code can collide
      SELECT DISTINCT ON (UPPER(oftic), fpi) UPPER(oftic) AS ticker, fpi, meanest
      FROM wrds_research.ibes_statsum
      WHERE measure = 'EPS' AND fpi IN ('0','1','2') AND statpers >= CURRENT_DATE - 120 AND meanest IS NOT NULL AND oftic IS NOT NULL
      ORDER BY UPPER(oftic), fpi, statpers DESC
    )
    SELECT f.ticker, COALESCE(po.scoring_mode, g.scoring_mode, 'standard') AS mode, r.primary_peer_group_id AS peer_group_id,
           COALESCE(g.metric_exclusions, '{}') AS metric_exclusions,
           -- freshest close: our Yahoo history, or LSEG when it is newer / ours is missing
           CASE WHEN lpx.date IS NOT NULL AND (px.date IS NULL OR lpx.date > px.date) THEN lpx.close ELSE px.close END AS price,
           f.earnings_per_share, f.total_revenue, f.price_to_sales, f.forward_pe, f.revenue_growth_yoy, f.free_cash_flow, f.shares_outstanding,
           f.total_debt, f.cash_and_equivalents, f.ebitda, f.total_stockholders_equity, f.return_on_equity,
           f.beta, f.ffo_proxy, f.analyst_target_price,
           sig.eps_mean_fy1, sig.pt_mean, sig.price_to_intrinsic, sig.price_close AS lseg_price,
           i1.meanest AS ibes_fy1, i2.meanest AS ibes_fy2, i0.meanest AS ibes_ltg, mom.mom_12_1
    FROM ticker_fundamentals f
    JOIN ticker_registry r ON r.ticker = f.ticker AND COALESCE(r.is_active, true)
    LEFT JOIN peer_groups g ON g.id = r.primary_peer_group_id
    LEFT JOIN peer_group_overrides po ON po.ticker = f.ticker  -- A148: per-ticker mode (e.g. ZTO/TCOM keep 'chinese')
    LEFT JOIN px ON px.ticker = f.ticker
    LEFT JOIN lpx ON lpx.ticker = f.ticker
    LEFT JOIN mom ON mom.ticker = f.ticker
    LEFT JOIN sig ON sig.ticker = f.ticker
    LEFT JOIN ib i0 ON i0.ticker = f.ticker AND i0.fpi = '0'
    LEFT JOIN ib i1 ON i1.ticker = f.ticker AND i1.fpi = '1'
    LEFT JOIN ib i2 ON i2.ticker = f.ticker AND i2.fpi = '2'
  `);
  return rows.map((r: Record<string, unknown>): FvTickerInput => {
    const price = num(r.price);
    const trailing = num(r.earnings_per_share);
    const lsegFy1 = num(r.eps_mean_fy1);
    const ibesFy1 = num(r.ibes_fy1);
    const fpe = num(r.forward_pe);
    const consistent = (x: number | null, ref: number | null, lo = 0.4, hi = 3) =>
      x != null && ref != null && x > 0 && ref > 0 && x / ref > lo && x / ref < hi;
    // IBES statsum is keyed by IBES ticker (can collide with ours) and is not split-adjusted:
    // use it only when corroborated by LSEG FY1 or trailing EPS.
    // Forward EPS sources are sometimes in the ADR's local currency (LSEG FY1 for BABA/HMC, vendor forward
    // P/E for PDD = 0.97), so every source must agree with USD trailing EPS. LSEG gets a wider band
    // (genuine boom-cycle jumps); with no positive trailing EPS only LSEG is accepted.
    const fromFpe = price != null && fpe != null && fpe > 0 ? price / fpe : null;
    // 10-27: check LSEG FY1 against the other *forward* source when there is one: GAAP trailing EPS with one-off charges
    // rejected good consensus (GM 2.24 vs FY1 13.4), while its 0.25–5× band let a local-currency FY1 through once LSEG
    // covered the whole universe (BAP: PEN 100.75 vs USD 26.55 trailing, 34.8 forward). Implied P/E ≥ 3 also rejects
    // ADR values in CNY/JPY (BABA ~1.7, HMC ~0.15) even when the vendor's forward P/E shares the mistake (PDD 0.97).
    const saneFwd = (eps: number | null) => price != null && eps != null && eps > 0 && price / eps >= 3 && price / eps <= 150;
    const lsegOk = lsegFy1 != null && lsegFy1 > 0 && (fromFpe != null
      ? consistent(lsegFy1, fromFpe, 0.5, 2) && saneFwd(lsegFy1)
      : trailing == null || trailing <= 0 || consistent(lsegFy1, trailing, 0.25, 5));
    const ibesTrusted = lsegOk ? consistent(ibesFy1, lsegFy1) : consistent(ibesFy1, trailing);
    const forwardEps = (lsegOk ? lsegFy1 : null) ?? (ibesTrusted ? ibesFy1 : null) ?? (consistent(fromFpe, trailing) ? fromFpe : null);
    let eps2 = ibesTrusted ? num(r.ibes_fy2) : null;
    if (eps2 != null && !consistent(eps2, forwardEps)) eps2 = null;
    if (eps2 != null && forwardEps != null && !(eps2 / forwardEps > 0.5 && eps2 / forwardEps < 2)) eps2 = null;
    const ltgPct = ibesTrusted ? num(r.ibes_ltg) : null;
    // Statement totals can be in the reporting currency (HMC revenue in JPY) while price is USD per ADR.
    // Vendor price-to-sales is currency-consistent, so recompute it from our totals: if they disagree by
    // > 2×, the totals can't be compared with the price and every totals-based method is skipped.
    // (Net income was tried first and rejected: one-off charges made HPE/PVH/BP look like FX mismatches.)
    const shares = num(r.shares_outstanding);
    const revenue = num(r.total_revenue);
    const vendorPs = num(r.price_to_sales);
    let totalsOk = true;
    if (price != null && shares != null && revenue != null && revenue > 0 && vendorPs != null && vendorPs > 0) {
      const ratio = (price * shares) / revenue / vendorPs;
      totalsOk = ratio > 0.5 && ratio < 2;
    }
    const money = (v: unknown) => (totalsOk ? num(v) : null);
    // StarMine IV is relative to LSEG's own close — convert to a per-share value on that price.
    const lsegPrice = num(r.lseg_price);
    const p2i = num(r.price_to_intrinsic);
    const starmineValue = lsegPrice != null && p2i != null && p2i > 0 ? lsegPrice / p2i : null;
    return {
      ticker: String(r.ticker),
      mode: String(r.mode),
      peerGroupId: (r.peer_group_id as string | null) ?? null,
      metricExclusions: (r.metric_exclusions as string[] | null) ?? [],
      price,
      forwardEps,
      eps2,
      ltg: ltgPct != null ? ltgPct / 100 : null,
      trailingEps: trailing,
      revenue: money(r.total_revenue),
      revenueGrowth: num(r.revenue_growth_yoy),
      fcf: money(r.free_cash_flow),
      shares,
      totalDebt: money(r.total_debt),
      cash: money(r.cash_and_equivalents),
      ebitda: money(r.ebitda),
      equity: money(r.total_stockholders_equity),
      roe: num(r.return_on_equity),
      beta: num(r.beta),
      ffo: money(r.ffo_proxy),
      analystTarget: num(r.pt_mean) ?? num(r.analyst_target_price),
      // Re-express StarMine on our price so the voter is a per-share value regardless of whose close it used.
      starminePriceToIntrinsic: starmineValue != null && price != null ? price / starmineValue : null,
      momentum12_1: num(r.mom_12_1),
    };
  });
}

export interface FairValueRunSummary {
  asOf: string;
  modelVersion: string;
  market: FvMarket & { source: string };
  universe: number;
  withValue: number;
  medianFairToPrice: number | null;
  above3x: number;          // fair value > 3× price
  below1_3: number;         // fair value < price / 3
  confidence: Record<string, number>;
  nullReasons: Record<string, number>;
  /** Day-over-day fair value moves > 30% while price moved < 5% — usually an input/data error. */
  suspectJumps: { ticker: string; prev: number; now: number }[];
}

// Bursts of fund-score recomputes (several peer-override edits, nightly + admin overlap) collapse to
// at most one run in flight plus one queued run that sees the newest inputs.
let running: Promise<FairValueRunSummary> | null = null;
let queued: Promise<FairValueRunSummary> | null = null;
export let lastFairValueSummary: FairValueRunSummary | null = null;

export function persistFairValueSnapshots(opts?: { asOf?: string; trigger?: string }): Promise<FairValueRunSummary> {
  if (!running) {
    running = runFairValueSnapshots(opts).finally(() => { running = null; });
    return running;
  }
  queued ??= running.catch(() => undefined).then(() => {
    queued = null;
    return persistFairValueSnapshots(opts);
  });
  return queued;
}

async function runFairValueSnapshots(opts?: { asOf?: string; trigger?: string }): Promise<FairValueRunSummary> {
  await ensureFairValueTables();
  const asOf = opts?.asOf ?? etDateKey();
  const trigger = opts?.trigger ?? "nightly";
  const { version, params } = await getChampionScorecardParams("fair_value");
  const p = params as unknown as FairValueParams & { aaaYieldFallbackSpread?: number };
  const [market, inputs] = await Promise.all([loadMarket(p), loadInputs()]);
  const results = computeFairValues(inputs, market, p);
  const byTicker = new Map(inputs.map((i) => [i.ticker, i]));

  const prev = new Map<string, { fv: number; price: number }>();
  const { rows: prevRows } = await pool.query(
    `SELECT DISTINCT ON (ticker) ticker, fair_value, price FROM fair_value_snapshots
     WHERE as_of < $1 AND fair_value IS NOT NULL ORDER BY ticker, as_of DESC`, [asOf]);
  for (const r of prevRows) prev.set(r.ticker, { fv: Number(r.fair_value), price: Number(r.price) });

  const COLS = 19;
  const values: unknown[] = [];
  const placeholders: string[] = [];
  results.forEach((r, i) => {
    const digest = createHash("sha1").update(JSON.stringify([byTicker.get(r.ticker), market, version])).digest("hex").slice(0, 16);
    const b = i * COLS;
    placeholders.push(`(${Array.from({ length: COLS }, (_, j) => `$${b + j + 1}`).join(",")})`);
    values.push(r.ticker, asOf, r.price, r.fairValue, r.low, r.high, r.priceToFair, r.confidence, r.spread,
      r.impliedGrowth, r.mode, JSON.stringify(r.votes), r.nullReason, JSON.stringify(market), version, digest, trigger, r.cyclical, r.valueTrap);
  });
  // Chunk to stay well under Postgres' 65k bind-parameter limit.
  const CHUNK = 500;
  for (let s = 0; s < placeholders.length; s += CHUNK) {
    const ph = placeholders.slice(s, s + CHUNK).map((x) =>
      x.replace(/\$(\d+)/g, (_, n) => `$${Number(n) - s * COLS}`));
    await pool.query(
      `INSERT INTO fair_value_snapshots (ticker, as_of, price, fair_value, low, high, price_to_fair, confidence, spread,
         implied_growth, mode, votes, null_reason, market, model_version, inputs_digest, trigger, cyclical, value_trap)
       VALUES ${ph.join(",")}
       ON CONFLICT (ticker, as_of) DO UPDATE SET price = EXCLUDED.price, fair_value = EXCLUDED.fair_value,
         low = EXCLUDED.low, high = EXCLUDED.high, price_to_fair = EXCLUDED.price_to_fair,
         confidence = EXCLUDED.confidence, spread = EXCLUDED.spread, implied_growth = EXCLUDED.implied_growth,
         mode = EXCLUDED.mode, votes = EXCLUDED.votes, null_reason = EXCLUDED.null_reason, market = EXCLUDED.market,
         model_version = EXCLUDED.model_version, inputs_digest = EXCLUDED.inputs_digest,
         trigger = EXCLUDED.trigger, cyclical = EXCLUDED.cyclical, value_trap = EXCLUDED.value_trap, computed_at = now()`,
      values.slice(s * COLS, (s + CHUNK) * COLS),
    );
  }

  // Assumption trail (fv-assumptions.ts): store changed input sets, then the adjusted value for stocks with active judgement.
  try {
    await ensureAssumptionTables();
    await recordInputs(inputs, asOf);
    const adjusted = computeAdjusted(inputs, market, p, await activeAssumptions(asOf));
    await pool.query(`UPDATE fair_value_snapshots SET adjusted_fair_value = NULL, adjustments = NULL
                      WHERE as_of = $1 AND adjustments IS NOT NULL`, [asOf]);
    for (const [ticker, a] of adjusted) {
      await pool.query(`UPDATE fair_value_snapshots SET adjusted_fair_value = $3, adjustments = $4::jsonb WHERE ticker = $1 AND as_of = $2`,
        [ticker, asOf, a.result.fairValue, JSON.stringify({ applied: a.applied, confidence: a.result.confidence, votes: a.result.votes })]);
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "fair value: assumption trail failed (base values unaffected)");
  }

  const summary = summarize(results, prev, asOf, version, market);
  lastFairValueSummary = summary;
  logger.info(summary, "fair value snapshots persisted");
  return summary;
}

function summarize(
  results: FairValueResult[], prev: Map<string, { fv: number; price: number }>,
  asOf: string, modelVersion: string, market: FvMarket & { source: string },
): FairValueRunSummary {
  const withValue = results.filter((r) => r.fairValue != null);
  const ratios = withValue.map((r) => r.fairValue! / r.price!).sort((a, b) => a - b);
  const count = (xs: (string | null)[]) => xs.reduce<Record<string, number>>((a, k) => {
    const key = k ?? "none"; a[key] = (a[key] ?? 0) + 1; return a;
  }, {});
  const suspectJumps = withValue.flatMap((r) => {
    const p = prev.get(r.ticker);
    if (!p || !(p.fv > 0) || !(p.price > 0)) return [];
    const fvMove = Math.abs(Math.log(r.fairValue! / p.fv));
    const pxMove = Math.abs(Math.log(r.price! / p.price));
    return fvMove > Math.log(1.3) && pxMove < Math.log(1.05) ? [{ ticker: r.ticker, prev: p.fv, now: r.fairValue! }] : [];
  });
  return {
    asOf, modelVersion, market,
    universe: results.length,
    withValue: withValue.length,
    medianFairToPrice: ratios.length ? Math.round(ratios[ratios.length >> 1]! * 1000) / 1000 : null,
    above3x: ratios.filter((x) => x > 3).length,
    below1_3: ratios.filter((x) => x < 1 / 3).length,
    confidence: count(withValue.map((r) => r.confidence)),
    nullReasons: count(results.filter((r) => r.fairValue == null).map((r) => r.nullReason)),
    suspectJumps: suspectJumps.slice(0, 25),
  };
}

export interface LatestFairValue {
  fairValue: number | null;
  /** Close the snapshot was computed on (for "vs price" text where no live quote is at hand). */
  price: number | null;
  low: number | null;
  high: number | null;
  confidence: string | null;
  impliedGrowth: number | null;
  votes: { name: string; value: number; kept: boolean }[];
  asOf: string;
  modelVersion: string | null;
  /** Fair value change vs the snapshot ~3 months back (decimal); null until 85+ days of history exist. */
  change3m: number | null;
  cyclical: boolean;
  valueTrap: boolean;
}

/** Latest snapshot for one ticker (Breakdown). Null when never computed. */
export async function readLatestFairValue(ticker: string): Promise<LatestFairValue | null> {
  try {
    const { rows } = await pool.query(
      `SELECT s.fair_value, s.price, s.low, s.high, s.confidence, s.implied_growth, s.votes, s.as_of::text, s.model_version, s.cyclical, s.value_trap,
              (SELECT o.fair_value FROM fair_value_snapshots o
               WHERE o.ticker = s.ticker AND o.as_of <= s.as_of - 85 AND o.fair_value IS NOT NULL
               ORDER BY o.as_of DESC LIMIT 1) AS fair_value_3m_ago
       FROM fair_value_snapshots s WHERE s.ticker = $1 ORDER BY s.as_of DESC LIMIT 1`, [ticker.toUpperCase()]);
    const r = rows[0];
    if (!r) return null;
    return {
      fairValue: num(r.fair_value), price: num(r.price), low: num(r.low), high: num(r.high), confidence: r.confidence ?? null,
      impliedGrowth: num(r.implied_growth), votes: Array.isArray(r.votes) ? r.votes : [],
      asOf: r.as_of, modelVersion: r.model_version ?? null,
      change3m: num(r.fair_value) != null && num(r.fair_value_3m_ago)
        ? num(r.fair_value)! / num(r.fair_value_3m_ago)! - 1 : null,
      cyclical: r.cyclical === true,
      valueTrap: r.value_trap === true,
    };
  } catch {
    return null; // table not created yet (first boot before any recompute)
  }
}
