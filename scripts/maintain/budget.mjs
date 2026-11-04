import { sh } from "./utils.mjs";

function budgetSnapshot() {
  // Prefer api_usage (API Monitor SoT). Map data_sources.name → api_usage.source
  // (alpha_vantage ↔ av). Fall back to 0 when no row for CURRENT_DATE.
  const src = sh(`psql "$DATABASE_URL" -tAc "
    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)::text FROM (
      SELECT d.name,
             COALESCE(u.calls_made, 0)::int AS calls_today,
             d.daily_limit,
             (d.daily_limit - COALESCE(u.calls_made, 0))::int AS remaining,
             CASE WHEN d.daily_limit > 0
               THEN ROUND(100.0 * COALESCE(u.calls_made, 0) / d.daily_limit, 1)
               ELSE 0 END AS pct_used
      FROM data_sources d
      LEFT JOIN api_usage u
        ON u.date = CURRENT_DATE
       AND u.source = CASE d.name WHEN 'alpha_vantage' THEN 'av' ELSE d.name END
      ORDER BY d.name
    ) t
  "`);
  const nr = sh(`psql "$DATABASE_URL" -tAc "SELECT COUNT(*) FROM field_provenance WHERE divergent"`);
  const gold = sh(`psql "$DATABASE_URL" -tAc "
    SELECT COUNT(*) FILTER (WHERE tf.fundamentals_last_fetched IS NOT NULL)::int || '/' ||
           COUNT(*)::int
    FROM ticker_registry r
    LEFT JOIN ticker_fundamentals tf ON tf.ticker = r.ticker
    WHERE r.fetch_fundamentals = true
  "`);
  // Field-fill coverage across core gold columns (true “current state” %, not just row existence)
  const fieldFill = sh(`psql "$DATABASE_URL" -tAc "
    WITH u AS (
      SELECT tf.* FROM ticker_fundamentals tf
      JOIN ticker_registry r ON r.ticker = tf.ticker AND r.fetch_fundamentals
    ),
    c AS (
      SELECT
        COUNT(*)::float AS n,
        (
          COUNT(pe_ratio)+COUNT(peg_ratio)+COUNT(forward_pe)+COUNT(price_to_book)+COUNT(price_to_sales)
          +COUNT(ev_ebitda)+COUNT(gross_margin)+COUNT(operating_margin)+COUNT(net_margin)
          +COUNT(return_on_equity)+COUNT(roic)+COUNT(revenue_growth_yoy)+COUNT(eps_growth)
          +COUNT(current_ratio)+COUNT(debt_to_equity)+COUNT(free_cash_flow)+COUNT(net_income)
          +COUNT(total_revenue)+COUNT(ebitda)+COUNT(cash_and_equivalents)+COUNT(total_debt)
          +COUNT(gross_profit)+COUNT(total_assets)+COUNT(annual_operating_cash_flow)
        )::float AS filled,
        24::float AS cols
      FROM u
    )
    SELECT ROUND((100.0 * filled / NULLIF(n * cols, 0))::numeric, 1) FROM c
  "`);
  // Active universe only: fetch_fundamentals + not ETF exclusion. Dead/acquired
  // (fetch=false) and ETFs stay NULL scores by design — don't anomaly them.
  const scored = sh(`psql "$DATABASE_URL" -tAc "
    SELECT COUNT(*) FILTER (WHERE tf.fund_total_score IS NOT NULL)::int
           || '/' || COUNT(*)::int
    FROM ticker_fundamentals tf
    JOIN ticker_registry r ON r.ticker = tf.ticker
    WHERE r.fetch_fundamentals = true
      AND UPPER(tf.ticker) NOT IN (
        'SMH','SOXX','IWM','QQQ','SPY','ARKG','CANE','BIZD','JBBB',
        'NVDY','SPCK','PSUS','HOOY','DRAM','ARKQ','XOP','GOOY','RVI'
      )
  "`);
  const unscoredActive = sh(`psql "$DATABASE_URL" -tAc "
    SELECT COUNT(*)::int
    FROM ticker_fundamentals tf
    JOIN ticker_registry r ON r.ticker = tf.ticker
    WHERE r.fetch_fundamentals = true
      AND tf.fund_total_score IS NULL
      AND UPPER(tf.ticker) NOT IN (
        'SMH','SOXX','IWM','QQQ','SPY','ARKG','CANE','BIZD','JBBB',
        'NVDY','SPCK','PSUS','HOOY','DRAM','ARKQ','XOP','GOOY','RVI'
      )
  "`);
  // Blended fair value health (lib/fair-value-snapshots.ts; refreshed by post-merge-scores above).
  // withValue|universe|extremes(>3x or <1/3)|jumps(>30% move with <5% price move)|ageHours|prevWithValue
  // Jumps ignore days whose market.riskFree/aaaYield look like the 2026-10-21 percent-as-decimal bug
  // (≥0.5) — that recovery was ~195 false jumps, not a live break (see fair-value-snapshots loadMarket).
  const fairValue = sh(`psql "$DATABASE_URL" -tAc "
    WITH t AS (SELECT max(as_of) d FROM fair_value_snapshots),
         p AS (SELECT max(as_of) d FROM fair_value_snapshots WHERE as_of < (SELECT d FROM t)),
         cur AS (SELECT * FROM fair_value_snapshots WHERE as_of = (SELECT d FROM t)),
         prev AS (SELECT * FROM fair_value_snapshots WHERE as_of = (SELECT d FROM p))
    SELECT COUNT(*) FILTER (WHERE c.fair_value IS NOT NULL) || '|' || COUNT(*) || '|' ||
           COUNT(*) FILTER (WHERE c.fair_value > 3 * c.price OR c.fair_value < c.price / 3) || '|' ||
           COUNT(*) FILTER (WHERE pv.fair_value > 0 AND c.fair_value > 0 AND pv.price > 0 AND c.price > 0
                              AND abs(ln(c.fair_value / pv.fair_value)) > ln(1.3) AND abs(ln(c.price / pv.price)) < ln(1.05)
                              AND COALESCE((pv.market->>'riskFree')::float, 0) < 0.5
                              AND COALESCE((pv.market->>'aaaYield')::float, 0) < 0.5
                              AND COALESCE((c.market->>'riskFree')::float, 0) < 0.5
                              AND COALESCE((c.market->>'aaaYield')::float, 0) < 0.5) || '|' ||
           COALESCE(round(extract(epoch FROM now() - max(c.computed_at)) / 3600), 9999) || '|' ||
           (SELECT COUNT(*) FILTER (WHERE fair_value IS NOT NULL) FROM prev)
    FROM cur c LEFT JOIN prev pv USING (ticker)
  " 2>/dev/null`);
  const earnWin = sh(`psql "$DATABASE_URL" -tAc "
    SELECT COUNT(DISTINCT UPPER(ticker))
    FROM earnings_calendar
    WHERE report_date BETWEEN CURRENT_DATE - 1 AND CURRENT_DATE + 2
  "`);
  let sources = [];
  try {
    sources = JSON.parse(src || "[]");
  } catch {
    sources = [];
  }
  const anomalies = [];
  for (const s of sources) {
    if (Number(s.pct_used) >= 90) anomalies.push(`${s.name}_budget_≥90%`);
    if (s.name === "factset" && Number(s.remaining) < 20) anomalies.push("factset_remaining_<20");
  }
  const nrN = Number(String(nr).trim());
  // Needs Review is the queue. A count over 500 is printed as NR= on the report.
  // It does not fail the morning job. FactSet used to close fights and hide them.
  const unscoredN = Number(String(unscoredActive).trim());
  // Soft ceiling: coverage/safety gates are intentional; rising counts = enrich gap.
  if (Number.isFinite(unscoredN) && unscoredN > 8) anomalies.push(`unscored_active_${unscoredN}`);
  // Baseline 2026-10-06: 436/568 valued, 17 extremes, 0 jumps. Thresholds catch data breaks, not market moves.
  const [fvWith, fvN, fvExt, fvJumps, fvAge, fvPrev] = String(fairValue || "").trim().split("|").map(Number);
  if (Number.isFinite(fvWith)) {
    if (fvAge > 36) anomalies.push(`fair_value_stale_${fvAge}h`);
    if (fvExt > 30) anomalies.push(`fair_value_extremes_${fvExt}`);
    if (fvJumps > 10) anomalies.push(`fair_value_jumps_${fvJumps}`);
    if (fvPrev > 0 && fvWith < fvPrev * 0.9) anomalies.push(`fair_value_coverage_drop_${fvPrev}_to_${fvWith}`);
  } else {
    anomalies.push("fair_value_missing");
  }
  return {
    sources,
    needsReview: Number.isFinite(nrN) ? nrN : null,
    goldCoverage: String(gold).trim() || null,
    fieldFillPct: Number(String(fieldFill).trim()) || null,
    fundScoreCoverage: String(scored).trim() || null,
    unscoredActive: Number.isFinite(unscoredN) ? unscoredN : null,
    fairValue: Number.isFinite(fvWith) ? `${fvWith}/${fvN} ext=${fvExt} jumps=${fvJumps}` : null,
    earningsWindowTickers: Number(String(earnWin).trim()) || 0,
    anomalies,
  };
}

export { budgetSnapshot };
