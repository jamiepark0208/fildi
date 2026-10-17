/**
 * A102 — weekly extreme-score review list (Claude-narrowed 10-15).
 * Facts only: top/bottom fund+tech, |FV/price| outside 0.25–4×, PT upside >300%, thin-data extremes.
 */
import { pool } from "@workspace/db";

export type OutlierKind =
  | "fund_high"
  | "fund_low"
  | "tech_high"
  | "tech_low"
  | "fv_ratio"
  | "pt_upside"
  | "thin_data";

export type OutlierRow = {
  kind: OutlierKind;
  ticker: string;
  score: number | null;
  detail: string;
  dominantInput: string | null;
  why: string;
  thinData: boolean;
  disposition: "bug" | "explained" | "false_positive" | null;
  dispositionNote: string | null;
};

export type Disposition = "bug" | "explained" | "false_positive";

async function ensureDispositionTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS score_outlier_dispositions (
      ticker text NOT NULL,
      kind text NOT NULL,
      disposition text NOT NULL,
      note text,
      set_by text,
      set_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (ticker, kind)
    )
  `);
}

function dominantFromTopMetrics(raw: unknown): string | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const sorted = [...raw].sort((a, b) => Math.abs(Number((b as any)?.contrib ?? 0)) - Math.abs(Number((a as any)?.contrib ?? 0)));
  const top = sorted[0] as { key?: string; contrib?: number; peerPct?: number } | undefined;
  if (!top?.key) return null;
  const bits = [top.key];
  if (top.contrib != null && Number.isFinite(Number(top.contrib))) bits.push(`contrib ${Number(top.contrib).toFixed(1)}`);
  if (top.peerPct != null && Number.isFinite(Number(top.peerPct))) bits.push(`p${Math.round(Number(top.peerPct))}`);
  return bits.join(" · ");
}

async function loadDispositions(): Promise<Map<string, { disposition: Disposition; note: string | null }>> {
  await ensureDispositionTable();
  const r = await pool.query<{ ticker: string; kind: string; disposition: Disposition; note: string | null }>(
    `SELECT ticker, kind, disposition, note FROM score_outlier_dispositions`,
  );
  const m = new Map<string, { disposition: Disposition; note: string | null }>();
  for (const row of r.rows) m.set(`${row.kind}:${row.ticker}`, { disposition: row.disposition, note: row.note });
  return m;
}

function attach(
  rows: Omit<OutlierRow, "disposition" | "dispositionNote">[],
  disp: Map<string, { disposition: Disposition; note: string | null }>,
): OutlierRow[] {
  return rows.map((r) => {
    const d = disp.get(`${r.kind}:${r.ticker}`);
    return { ...r, disposition: d?.disposition ?? null, dispositionNote: d?.note ?? null };
  });
}

export async function buildScoreOutliers(): Promise<{ asOf: string; rows: OutlierRow[]; counts: Record<string, number> }> {
  const disp = await loadDispositions();
  const out: Omit<OutlierRow, "disposition" | "dispositionNote">[] = [];

  // Latest fund snapshot per ticker
  const fund = await pool.query<{
    ticker: string;
    fund_total: string | null;
    coverage: string | null;
    top_metrics: unknown;
  }>(`
    SELECT DISTINCT ON (ticker) ticker, fund_total::text, coverage::text, top_metrics
    FROM fund_score_snapshots
    WHERE fund_total IS NOT NULL
    ORDER BY ticker, as_of DESC
  `);
  const fundRows = fund.rows
    .map((r) => ({
      ticker: r.ticker,
      score: r.fund_total != null ? parseFloat(r.fund_total) : null,
      coverage: r.coverage != null ? parseFloat(r.coverage) : null,
      dominant: dominantFromTopMetrics(r.top_metrics),
    }))
    .filter((r) => r.score != null && Number.isFinite(r.score!))
    .sort((a, b) => (b.score! - a.score!));

  const nFund = fundRows.length;
  for (const r of fundRows.slice(0, 10)) {
    out.push({
      kind: "fund_high",
      ticker: r.ticker,
      score: r.score,
      detail: `fund ${r.score!.toFixed(0)}`,
      dominantInput: r.dominant,
      why: "top-10 fund score",
      thinData: r.coverage != null && r.coverage < 0.6,
    });
  }
  for (const r of fundRows.slice(-10).reverse()) {
    out.push({
      kind: "fund_low",
      ticker: r.ticker,
      score: r.score,
      detail: `fund ${r.score!.toFixed(0)}`,
      dominantInput: r.dominant,
      why: "bottom-10 fund score",
      thinData: r.coverage != null && r.coverage < 0.6,
    });
  }

  // Thin-data extremes (coverage < 0.6 in top/bottom decile) — Claude S024 add
  if (nFund >= 10) {
    const decile = Math.max(1, Math.floor(nFund / 10));
    const extreme = new Set([
      ...fundRows.slice(0, decile).map((r) => r.ticker),
      ...fundRows.slice(-decile).map((r) => r.ticker),
    ]);
    for (const r of fundRows) {
      if (r.coverage != null && r.coverage < 0.6 && extreme.has(r.ticker)) {
        out.push({
          kind: "thin_data",
          ticker: r.ticker,
          score: r.score,
          detail: `fund ${r.score!.toFixed(0)} · cov ${(r.coverage * 100).toFixed(0)}%`,
          dominantInput: r.dominant,
          why: "coverage < 0.6 and in fund top/bottom decile",
          thinData: true,
        });
      }
    }
  }

  // Tech top/bottom 10
  const tech = await pool.query<{ ticker: string; tech_total: string | null; coverage: string | null }>(`
    SELECT DISTINCT ON (ticker) ticker, tech_total::text, coverage::text
    FROM tech_score_snapshots
    WHERE tech_total IS NOT NULL
    ORDER BY ticker, as_of DESC
  `);
  const techRows = tech.rows
    .map((r) => ({
      ticker: r.ticker,
      score: r.tech_total != null ? parseFloat(r.tech_total) : null,
      coverage: r.coverage != null ? parseFloat(r.coverage) : null,
    }))
    .filter((r) => r.score != null && Number.isFinite(r.score!))
    .sort((a, b) => (b.score! - a.score!));
  for (const r of techRows.slice(0, 10)) {
    out.push({
      kind: "tech_high",
      ticker: r.ticker,
      score: r.score,
      detail: `tech ${r.score!.toFixed(0)}`,
      dominantInput: null,
      why: "top-10 tech score",
      thinData: r.coverage != null && r.coverage < 0.6,
    });
  }
  for (const r of techRows.slice(-10).reverse()) {
    out.push({
      kind: "tech_low",
      ticker: r.ticker,
      score: r.score,
      detail: `tech ${r.score!.toFixed(0)}`,
      dominantInput: null,
      why: "bottom-10 tech score",
      thinData: r.coverage != null && r.coverage < 0.6,
    });
  }

  // FV / price outside 0.25–4×
  const fv = await pool.query<{ ticker: string; fv: string; close: string; ratio: string }>(`
    WITH latest_fv AS (
      SELECT DISTINCT ON (UPPER(ticker)) UPPER(ticker) AS ticker,
             fair_value::float8 AS fv
      FROM fair_value_snapshots
      WHERE fair_value IS NOT NULL
      ORDER BY UPPER(ticker), as_of DESC
    ),
    px AS (
      SELECT DISTINCT ON (UPPER(ticker)) UPPER(ticker) AS ticker, close::float8 AS close
      FROM prices_historical
      WHERE close IS NOT NULL AND close > 0
      ORDER BY UPPER(ticker), date DESC
    )
    SELECT f.ticker, f.fv::text, p.close::text, (f.fv / p.close)::text AS ratio
    FROM latest_fv f
    JOIN px p ON p.ticker = f.ticker
    WHERE f.fv / p.close < 0.25 OR f.fv / p.close > 4
    ORDER BY ABS(LN(GREATEST(f.fv / p.close, 1e-9))) DESC
    LIMIT 50
  `);
  for (const r of fv.rows) {
    const ratio = parseFloat(r.ratio);
    const fvN = parseFloat(r.fv);
    const px = parseFloat(r.close);
    out.push({
      kind: "fv_ratio",
      ticker: r.ticker,
      score: ratio,
      detail: `FV $${fvN.toFixed(2)} / px $${px.toFixed(2)} = ${ratio.toFixed(2)}×`,
      dominantInput: null,
      why: ratio > 4 ? "fair value > 4× price" : "fair value < 0.25× price",
      thinData: false,
    });
  }

  // Analyst target upside > 300%
  const pt = await pool.query<{ ticker: string; tgt: string; close: string; upside: string }>(`
    WITH px AS (
      SELECT DISTINCT ON (UPPER(ticker)) UPPER(ticker) AS ticker, close::float8 AS close
      FROM prices_historical
      WHERE close IS NOT NULL AND close > 0
      ORDER BY UPPER(ticker), date DESC
    )
    SELECT UPPER(tf.ticker) AS ticker,
           tf.analyst_target_price::float8::text AS tgt,
           p.close::text,
           ((tf.analyst_target_price::float8 / p.close) - 1)::text AS upside
    FROM ticker_fundamentals tf
    JOIN px p ON p.ticker = UPPER(tf.ticker)
    WHERE tf.analyst_target_price IS NOT NULL
      AND tf.analyst_target_price::float8 > 0
      AND (tf.analyst_target_price::float8 / p.close) - 1 > 3
    ORDER BY (tf.analyst_target_price::float8 / p.close) - 1 DESC
    LIMIT 30
  `);
  for (const r of pt.rows) {
    const up = parseFloat(r.upside) * 100;
    out.push({
      kind: "pt_upside",
      ticker: r.ticker,
      score: up,
      detail: `PT $${parseFloat(r.tgt).toFixed(2)} vs $${parseFloat(r.close).toFixed(2)} (+${up.toFixed(0)}%)`,
      dominantInput: "analystTargetPrice",
      why: "analyst target upside > 300%",
      thinData: false,
    });
  }

  const rows = attach(out, disp);
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.kind] = (counts[r.kind] ?? 0) + 1;

  return { asOf: new Date().toISOString(), rows, counts };
}

export async function setOutlierDisposition(
  ticker: string,
  kind: OutlierKind,
  disposition: Disposition,
  note: string | null,
  setBy: string,
): Promise<void> {
  await ensureDispositionTable();
  await pool.query(
    `INSERT INTO score_outlier_dispositions (ticker, kind, disposition, note, set_by, set_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (ticker, kind) DO UPDATE SET
       disposition = EXCLUDED.disposition,
       note = EXCLUDED.note,
       set_by = EXCLUDED.set_by,
       set_at = now()`,
    [ticker.toUpperCase(), kind, disposition, note, setBy],
  );
}
