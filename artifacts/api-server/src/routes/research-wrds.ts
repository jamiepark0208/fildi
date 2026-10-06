/**
 * Local sole-user research reads from wrds_research.* (never calls WRDS live).
 * Feeds Breakdown verdict + optional options streetEventRisk.
 * Fund growth extras are applied in scoreUniverse (fundamentals-db), not here.
 */
import { Router } from "express";
import { pool } from "@workspace/db";
import { requireAuth } from "../middleware/requireAuth.js";
import {
  ibesRevBreadth,
  avgIbesSue,
  streetEventRisk,
} from "../lib/fund-derived-metrics.js";
import { wrdsPeerRelative } from "../lib/research-peer-rel.js";

const router = Router();

type StatsumRow = {
  oftic: string;
  fiscalp: string | null;
  fpi: string | null;
  statpers: string;
  numest: number | null;
  numup: number | null;
  numdown: number | null;
  medest: number | null;
  meanest: number | null;
};

type SurpRow = {
  oftic: string;
  anndats: string | null;
  actual: number | null;
  surpmean: number | null;
  suescore: number | null;
};

function n(v: unknown): number | null {
  if (v == null) return null;
  const x = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(x) ? x : null;
}

type Verdict = "supportive" | "neutral" | "caution";

function streetVerdict(breadth: number | null, sue: number | null): {
  verdict: Verdict;
  headline: string;
  putHint: string;
  callHint: string;
  directionalHint: string;
} {
  const b = breadth ?? 0;
  const s = sue ?? 0;
  const has = breadth != null || sue != null;
  if (!has) {
    return {
      verdict: "neutral",
      headline: "No WRDS IBES cache for this ticker yet.",
      putHint: "Sync IBES or pick a book name — fund score uses Street only when cached.",
      callHint: "Same — missing Street data does not punish the score.",
      directionalHint: "Use tech oversold/overbought alone; no Street confirmation.",
    };
  }
  // Compact API strings — UI report rebuilds richer evidence client-side from numbers.
  if (b >= 0.08 || s >= 0.5) {
    return {
      verdict: "supportive",
      headline: `Supportive IBES: breadth ${b.toFixed(2)}, avg SUE ${s.toFixed(2)} (thresholds ≥0.08 / ≥0.5).`,
      putHint: "Street helps underlyer quality/stockQuality after rescore — still verify put credit vs IV buffer.",
      callHint: "Positive revisions raise upside risk for short calls; not a covered-call green light.",
      directionalHint: "No directional instruction from IBES alone — use Technical for timing.",
    };
  }
  if (b <= -0.08 || s <= -0.5) {
    return {
      verdict: "caution",
      headline: `Caution IBES: breadth ${b.toFixed(2)}, avg SUE ${s.toFixed(2)} (thresholds ≤-0.08 / ≤-0.5).`,
      putHint: "Street softens growth/stockQuality — require better premium or wider OTM if selling puts.",
      callHint: "Softer Street can help covered calls; still price the chain and ER calendar.",
      directionalHint: "No directional instruction from IBES alone — use Technical for timing.",
    };
  }
  return {
    verdict: "neutral",
    headline: `Neutral IBES: breadth ${b.toFixed(2)}, avg SUE ${s.toFixed(2)} (inside ±0.08 / ±0.5 bands).`,
    putHint: "No incremental put edge from IBES — fund/tech + IV economics decide.",
    callHint: "No incremental call edge from IBES — fund/tech + IV economics decide.",
    directionalHint: "No directional instruction from IBES alone — use Technical for timing.",
  };
}

async function schemaReady(): Promise<boolean> {
  const schemaCheck = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.schemata WHERE schema_name = 'wrds_research'
     ) AS exists`,
  );
  return !!schemaCheck.rows[0]?.exists;
}

/** Batch signals for options scanner streetEventRisk. */
router.get("/research/wrds/signals", requireAuth, async (req, res, next) => {
  try {
    const raw = String(req.query.tickers || "");
    const tickers = [...new Set(
      raw.split(",").map((t) => t.trim().toUpperCase()).filter((t) => /^[A-Z.]{1,12}$/.test(t)),
    )].slice(0, 80);
    if (tickers.length === 0) {
      res.json({ signals: {} });
      return;
    }
    if (!(await schemaReady())) {
      res.json({ signals: Object.fromEntries(tickers.map((t) => [t, { revBreadth: null, sue: null, streetEventRisk: false }])) });
      return;
    }

    const stats = await pool.query<{
      oftic: string; numup: number | null; numdown: number | null; numest: number | null;
    }>(
      `SELECT DISTINCT ON (oftic) oftic, numup, numdown, numest
       FROM wrds_research.ibes_statsum
       WHERE oftic = ANY($1::text[]) AND measure = 'EPS'
       ORDER BY oftic,
         CASE WHEN fpi IN ('1','1.0') THEN 0 ELSE 1 END,
         CASE WHEN fiscalp IN ('ANN','Y') THEN 0 ELSE 1 END,
         statpers DESC`,
      [tickers],
    );
    const surp = await pool.query<{ oftic: string; suescore: number | null }>(
      `SELECT oftic, suescore FROM wrds_research.ibes_surpsum
       WHERE oftic = ANY($1::text[]) AND suescore IS NOT NULL
       ORDER BY oftic, anndats DESC NULLS LAST`,
      [tickers],
    );
    const breadth = new Map<string, number | null>();
    for (const r of stats.rows) {
      breadth.set(r.oftic.toUpperCase(), ibesRevBreadth(r.numup, r.numdown, r.numest));
    }
    const sueLists = new Map<string, number[]>();
    for (const r of surp.rows) {
      const t = r.oftic.toUpperCase();
      if (!sueLists.has(t)) sueLists.set(t, []);
      const arr = sueLists.get(t)!;
      if (arr.length < 4 && r.suescore != null) arr.push(Number(r.suescore));
    }
    const signals: Record<string, { revBreadth: number | null; sue: number | null; streetEventRisk: boolean }> = {};
    for (const t of tickers) {
      const revBreadth = breadth.get(t) ?? null;
      const sue = avgIbesSue(sueLists.get(t) ?? []);
      signals[t] = { revBreadth, sue, streetEventRisk: streetEventRisk(revBreadth, sue) };
    }
    res.json({ signals });
  } catch (err) {
    next(err);
  }
});

router.get("/research/wrds/:ticker", requireAuth, async (req, res, next) => {
  try {
    const ticker = String(req.params.ticker || "").trim().toUpperCase();
    if (!/^[A-Z.]{1,12}$/.test(ticker)) {
      res.status(400).json({ error: "Invalid ticker" });
      return;
    }

    if (!(await schemaReady())) {
      res.json({
        ticker,
        available: false,
        reason: "wrds_research schema missing — run research/wrds sync_ibes.py",
        ...streetVerdict(null, null),
        consensus: null,
        revisionSeries: [],
        surprises: [],
        sync: null,
      });
      return;
    }

    const idRow = await pool.query<{ ibes_oftic: string | null; crsp_permno: number | null; cusip: string | null }>(
      `SELECT ibes_oftic, crsp_permno, cusip FROM research_common.security_map WHERE ticker = $1`,
      [ticker],
    ).catch(() => ({ rows: [] as { ibes_oftic: string | null; crsp_permno: number | null; cusip: string | null }[] }));
    const oftic = (idRow.rows[0]?.ibes_oftic || ticker).toUpperCase();

    const [statsum, surp, sync, fund, finratio, tech] = await Promise.all([
      pool.query<StatsumRow>(
        `SELECT oftic, fiscalp, fpi, statpers::text, numest, numup, numdown, medest, meanest
         FROM wrds_research.ibes_statsum
         WHERE oftic = $1 AND measure = 'EPS'
         ORDER BY statpers DESC LIMIT 120`,
        [oftic],
      ),
      pool.query<SurpRow>(
        `SELECT oftic, anndats::text, actual, surpmean, suescore
         FROM wrds_research.ibes_surpsum
         WHERE oftic = $1
         ORDER BY anndats DESC NULLS LAST LIMIT 12`,
        [oftic],
      ),
      pool.query<{ dataset: string; watermark: string | null; last_ok_at: Date | null; last_rows: number | null }>(
        `SELECT dataset, watermark, last_ok_at, last_rows
         FROM wrds_research.sync_state
         WHERE dataset IN ('ibes_statsum', 'ibes_surpsum', 'crsp_dsf', 'finratio_snapshot', 'security_map_wrds')
         ORDER BY dataset`,
      ),
      pool.query<{
        fund_total_score: string | null;
        fund_growth_score: string | null;
        fund_score_computed_at: Date | null;
      }>(
        `SELECT fund_total_score::text, fund_growth_score::text, fund_score_computed_at
         FROM ticker_fundamentals WHERE ticker = $1`,
        [ticker],
      ),
      pool.query<{
        public_date: string | null; pe_exi: number | null; bm: number | null; roe: number | null;
        roa: number | null; de_ratio: number | null; curr_ratio: number | null;
      }>(
        `SELECT public_date::text, pe_exi, bm, roe, roa, de_ratio, curr_ratio
         FROM wrds_research.finratio_snapshot WHERE ticker = $1`,
        [ticker],
      ).catch(() => ({ rows: [] as {
        public_date: string | null; pe_exi: number | null; bm: number | null; roe: number | null;
        roa: number | null; de_ratio: number | null; curr_ratio: number | null;
      }[] })),
      pool.query<{ atm_put_iv: number | null; realized_vol_20d: number | null; implied_move_weekly: number | null }>(
        `SELECT atm_put_iv, realized_vol_20d, implied_move_weekly FROM ticker_technicals WHERE ticker = $1`,
        [ticker],
      ).catch(() => ({ rows: [] as { atm_put_iv: number | null; realized_vol_20d: number | null; implied_move_weekly: number | null }[] })),
    ]);

    const rows = statsum.rows;
    const fy1 = rows.filter((r) => (r.fiscalp === "ANN" || r.fiscalp === "Y") && (r.fpi === "1" || r.fpi === "1.0"));
    const seriesSrc = fy1.length >= 3 ? fy1 : rows.filter((r) => r.fiscalp === "ANN" || r.fiscalp === "Y");
    const series = (seriesSrc.length >= 2 ? seriesSrc : rows).slice(0, 24).reverse();
    const latest = series.length ? series[series.length - 1] : rows[0] ?? null;
    const prior = series.length >= 2 ? series[series.length - 2] : null;

    const breadth = latest ? ibesRevBreadth(latest.numup, latest.numdown, latest.numest) : null;
    const sueVals = surp.rows.map((r) => n(r.suescore));
    const sue = avgIbesSue(sueVals);
    const meanNow = latest ? n(latest.meanest) : null;
    const meanPrev = prior ? n(prior.meanest) : null;
    const meanDriftPct =
      meanNow != null && meanPrev != null && meanPrev !== 0
        ? ((meanNow - meanPrev) / Math.abs(meanPrev)) * 100
        : null;

    const verdict = streetVerdict(breadth, sue);
    const fundRow = fund.rows[0];
    const fr = finratio.rows[0] ?? null;
    const peers = await wrdsPeerRelative(ticker, {
      breadth,
      sue,
      meanest: meanNow,
    }).catch(() => null);

    res.json({
      ticker,
      oftic,
      ids: {
        ibesOftic: idRow.rows[0]?.ibes_oftic ?? null,
        crspPermno: idRow.rows[0]?.crsp_permno ?? null,
        cusip: idRow.rows[0]?.cusip ?? null,
      },
      available: rows.length > 0 || surp.rows.length > 0,
      reason: rows.length === 0 && surp.rows.length === 0
        ? "No WRDS IBES rows — sync_ibes.py --force --tickers " + ticker
        : null,
      ...verdict,
      streetEventRisk: streetEventRisk(breadth, sue),
      consensus: latest
        ? {
            asOf: latest.statpers?.slice(0, 10) ?? null,
            fiscalp: latest.fiscalp,
            fpi: latest.fpi,
            meanest: meanNow,
            medest: n(latest.medest),
            numest: latest.numest,
            numup: latest.numup,
            numdown: latest.numdown,
            breadth,
            meanDriftPct,
            sue,
          }
        : null,
      fundImpact: {
        fundTotalScore: n(fundRow?.fund_total_score),
        fundGrowthScore: n(fundRow?.fund_growth_score),
        scoredAt: fundRow?.fund_score_computed_at ?? null,
        note: "ibesRevBreadth + ibesSue feed growth family on next fund rescore (post-merge-scores / maintain).",
      },
      revisionSeries: series.slice(-18).map((r) => ({
        statpers: r.statpers?.slice(0, 10) ?? null,
        meanest: n(r.meanest),
        medest: n(r.medest),
        numest: r.numest,
        numup: r.numup,
        numdown: r.numdown,
        breadth: ibesRevBreadth(r.numup, r.numdown, r.numest),
        fiscalp: r.fiscalp,
        fpi: r.fpi,
      })),
      surprises: surp.rows.slice(0, 10).map((r) => ({
        anndats: r.anndats?.slice(0, 10) ?? null,
        actual: n(r.actual),
        surpmean: n(r.surpmean),
        sue: n(r.suescore),
      })),
      finratio: fr
        ? {
            asOf: fr.public_date?.slice(0, 10) ?? null,
            pe: n(fr.pe_exi),
            bm: n(fr.bm),
            roe: n(fr.roe),
            roa: n(fr.roa),
            deRatio: n(fr.de_ratio),
            currRatio: n(fr.curr_ratio),
          }
        : null,
      tech: {
        iv: n(tech.rows[0]?.atm_put_iv),
        rv: n(tech.rows[0]?.realized_vol_20d),
        weeklyMove: n(tech.rows[0]?.implied_move_weekly),
        price: null as number | null,
      },
      peers,
      sync: Object.fromEntries(
        sync.rows.map((r) => [
          r.dataset,
          { watermark: r.watermark, lastOkAt: r.last_ok_at, lastRows: r.last_rows },
        ]),
      ),
      source: "wrds_research (local cache)",
    });
  } catch (err) {
    next(err);
  }
});

export default router;
