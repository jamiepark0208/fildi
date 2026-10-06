/**
 * Local sole-user research reads from lseg_research.* (never calls LSEG live).
 * Soft context for Breakdown — does not write fund_score / FIELD_DEFS.
 * Populated by research/lseg/sync_*.py (lane contract: research/LSEG_WRDS_SYNC.md).
 */
import { Router } from "express";
import { pool } from "@workspace/db";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { lsegPeerRelative } from "../lib/research-peer-rel.js";

const router = Router();

type SignalRow = {
  as_of: string;
  ric: string;
  price_close: number | null;
  eps_mean_fy1: number | null;
  eps_drift_30d_pct: number | null;
  eps_num_est_fy1: number | null;
  fy1_period: string | null;
  revenue_mean_fy1: number | null;
  rec_mean: number | null;
  pt_mean: number | null;
  pt_upside_pct: number | null;
  eps_smart_fy1: number | null;
  smart_vs_cons_pct: number | null;
  pred_surprise_pct_fq1: number | null;
  fq1_period_end: string | null;
  arm_rank: number | null;
  combined_alpha_rank: number | null;
  valmo_rank: number | null;
  short_pct: number | null;
  short_interest: number | null;
  free_float: number | null;
  issuer_rating: string | null;
  cds_ric: string | null;
  credit_combined_rank: number | null;
  price_mo_rank: number | null;
  relval_rank: number | null;
  price_to_intrinsic: number | null;
  eps_mean_fq1: number | null;
  eps_std_fq1: number | null;
  eps_num_est_fq1: number | null;
};

type EventRow = { event_date: string; event_type: string; title: string | null };
type HistRow = { metric: string; obs_date: string; value: number | null };
type OptRow = {
  option_type: string | null;
  direction: string | null;
  strike: string | null;
  expiration: string | null;
  qty: string | null;
};

function n(v: unknown): number | null {
  if (v == null) return null;
  const x = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(x) ? x : null;
}

function daysUntil(isoDate: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((new Date(`${isoDate}T00:00:00`).getTime() - today.getTime()) / 86_400_000);
}

/**
 * LSEG audit of the gold layer (research/lseg/audit_gold.py → lseg_research.gold_audit).
 * Read-only: disagreements between ticker_fundamentals / earnings_calendar and cached LSEG values,
 * for the Stock DB tab to review (never overwrites gold). Admin-only like the other Stock DB audit routes.
 */
router.get("/research/lseg/audit", requireAdmin, async (_req, res, next) => {
  try {
    const ready = await pool.query<{ ok: boolean }>(`SELECT to_regclass('lseg_research.gold_audit') IS NOT NULL AS ok`);
    if (!ready.rows[0]?.ok) {
      res.json({ available: false, reason: "Run research/lseg/audit_gold.py", rows: [] });
      return;
    }
    const rows = await pool.query(
      `SELECT ticker, field, gold_value, gold_source, lseg_value, diff, severity, checked_at
       FROM lseg_research.gold_audit ORDER BY severity = 'high' DESC, ABS(diff) DESC`,
    );
    res.json({
      available: true,
      rows: rows.rows,
      notes: {
        shares_outstanding: "Dual-class companies differ by share-class basis (gold = all classes, LSEG = listed class); not necessarily an error.",
      },
    });
  } catch (err) {
    next(err);
  }
});

/** Same thresholds as stock-compare/src/lib/lseg-interpret.ts (PRED_SURPRISE_SIGNAL) and WRDS streetEventRisk (≤7d). */
const PS_SIGNAL = 2;
const ER_WINDOW_DAYS = 7;

/**
 * Batch signals for the options scanner (Cursor's streetEventRisk — LSEG_WRDS_SYNC.md §11.4).
 * Shape mirrors GET /research/wrds/signals: { signals: { [ticker]: {...} } }.
 * Also reports earnings-date disagreement between LSEG events and the app's earnings_calendar,
 * so the ER haircut can use the EARLIER date when sources conflict.
 */
router.get("/research/lseg/signals", requireAuth, async (req, res, next) => {
  try {
    const tickers = String(req.query.tickers ?? "")
      .split(",")
      .map((t) => t.trim().toUpperCase())
      .filter((t) => /^[A-Z.]{1,12}$/.test(t))
      .slice(0, 200);
    if (!tickers.length) {
      res.status(400).json({ error: "tickers=A,B,C required" });
      return;
    }
    const ready = await pool.query<{ ok: boolean }>(`SELECT to_regclass('lseg_research.signals_daily') IS NOT NULL AS ok`);
    if (!ready.rows[0]?.ok) {
      res.json({ signals: Object.fromEntries(tickers.map((t) => [t, null])) });
      return;
    }
    const rows = await pool.query(
      `WITH latest AS (
         SELECT DISTINCT ON (ticker) ticker, as_of, pred_surprise_pct_fq1, arm_rank, combined_alpha_rank
         FROM lseg_research.signals_daily WHERE ticker = ANY($1) ORDER BY ticker, as_of DESC
       ), l AS (
         SELECT ticker, MIN(event_date) AS d FROM lseg_research.events
         WHERE event_type = 'EarningsReleases' AND event_date >= CURRENT_DATE AND ticker = ANY($1) GROUP BY 1
       ), a AS (
         SELECT UPPER(ticker) AS ticker, MIN(report_date::date) AS d FROM earnings_calendar
         WHERE report_date::date >= CURRENT_DATE AND UPPER(ticker) = ANY($1) GROUP BY 1
       )
       SELECT t AS ticker, latest.as_of::text, latest.pred_surprise_pct_fq1, latest.arm_rank, latest.combined_alpha_rank,
              l.d::text AS lseg_er, a.d::text AS app_er
       FROM unnest($1::text[]) AS t
       LEFT JOIN latest ON latest.ticker = t
       LEFT JOIN l ON l.ticker = t
       LEFT JOIN a ON a.ticker = t`,
      [tickers],
    );
    const signals: Record<string, unknown> = {};
    for (const r of rows.rows as Record<string, string | null>[]) {
      const ps = n(r.pred_surprise_pct_fq1);
      const dates = [r.lseg_er, r.app_er].filter((d): d is string => !!d).sort();
      const er = dates[0] ?? null; // earlier date wins when sources disagree — conservative for short options
      const days = er ? daysUntil(er) : null;
      const conflictDays = r.lseg_er && r.app_er ? Math.abs(daysUntil(r.lseg_er) - daysUntil(r.app_er)) : null;
      signals[r.ticker as string] = {
        asOf: r.as_of,
        predSurprisePct: ps,
        armRank: n(r.arm_rank),
        combinedAlphaRank: n(r.combined_alpha_rank),
        nextEarnings: er,
        daysToEarnings: days,
        earningsSources: { lseg: r.lseg_er, app: r.app_er, conflictDays },
        streetEventRisk: ps != null && Math.abs(ps) >= PS_SIGNAL && days != null && days <= ER_WINDOW_DAYS,
        lean: ps == null ? null : ps >= PS_SIGNAL ? "beat" : ps <= -PS_SIGNAL ? "miss" : "inline",
      };
    }
    res.json({ signals, source: "lseg_research + earnings_calendar (local cache)" });
  } catch (err) {
    next(err);
  }
});

/**
 * Radar: every name in lseg_research.coverage (held / traded / watchlist / lookalike / book) with its
 * latest LSEG snapshot + local technicals (IV, IV/RV, RSI) + next earnings + your open position.
 * Scoring/wording happens client-side in lib/lseg-radar.ts. Registered before /:ticker on purpose.
 */
router.get("/research/lseg/radar", requireAuth, async (_req, res, next) => {
  try {
    const ready = await pool.query<{ ok: boolean }>(`SELECT to_regclass('lseg_research.coverage') IS NOT NULL AS ok`);
    if (!ready.rows[0]?.ok) {
      res.json({ available: false, reason: "Run research/lseg/coverage.py then sync_signals.py", rows: [] });
      return;
    }
    const [rows, opts] = await Promise.all([
      pool.query(
        `WITH latest AS (
           SELECT DISTINCT ON (ticker) * FROM lseg_research.signals_daily ORDER BY ticker, as_of DESC
         ), next_er AS (
           SELECT DISTINCT ON (ticker) ticker, event_date FROM lseg_research.events
           WHERE event_type = 'EarningsReleases' AND event_date >= CURRENT_DATE
           ORDER BY ticker, event_date
         ), moves AS (
           SELECT ticker, ARRAY_AGG(move_pct ORDER BY report_date DESC) AS past_moves
           FROM (SELECT ticker, report_date, move_pct,
                        ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY report_date DESC) AS rn
                 FROM lseg_research.earnings_moves) x
           WHERE rn <= 9 GROUP BY ticker
         ), held AS (
           SELECT UPPER(symbol) AS ticker, SUM(quantity) AS shares FROM portfolio_positions
           WHERE snapshot_id = (SELECT MAX(id) FROM portfolio_snapshots) GROUP BY 1
         )
         SELECT c.ticker, c.tier, c.label, c.reason, c.computed_at::text AS coverage_at,
                s.as_of::text, s.price_close, s.eps_mean_fy1, s.eps_drift_30d_pct, s.eps_num_est_fy1, s.fy1_period,
                s.rec_mean, s.pt_mean, s.pt_upside_pct, s.pred_surprise_pct_fq1, s.fq1_period_end::text,
                s.arm_rank, s.combined_alpha_rank, s.valmo_rank, s.short_pct, s.issuer_rating,
                s.credit_combined_rank, s.price_mo_rank, s.relval_rank, s.price_to_intrinsic,
                s.eps_mean_fq1, s.eps_std_fq1, s.eps_num_est_fq1,
                CASE WHEN s.free_float > 0 THEN s.short_interest / s.free_float * 100 END AS short_pct_float,
                t.atm_put_iv, t.iv_vs_realized_vol, t.implied_move_weekly, t.rsi14, t.price_z_score, t.regime,
                t.falling_knife, t.realized_vol_20d, e.event_date::text AS next_earnings, h.shares, mv.past_moves
         FROM lseg_research.coverage c
         LEFT JOIN latest s USING (ticker)
         LEFT JOIN ticker_technicals t USING (ticker)
         LEFT JOIN next_er e USING (ticker)
         LEFT JOIN held h USING (ticker)
         LEFT JOIN moves mv USING (ticker)
         ORDER BY c.tier, c.score DESC`,
      ),
      pool.query<OptRow & { ticker: string }>(
        `SELECT UPPER(symbol) AS ticker, option_type, direction, strike::text, expiration::text, SUM(qty)::text AS qty
         FROM portfolio_options
         WHERE snapshot_id = (SELECT MAX(id) FROM portfolio_snapshots) AND expiration >= CURRENT_DATE
         GROUP BY 1, option_type, direction, strike, expiration
         ORDER BY expiration`,
      ),
    ]);
    const optsBy = new Map<string, unknown[]>();
    for (const o of opts.rows) {
      const list = optsBy.get(o.ticker) ?? [];
      list.push({
        type: (o.option_type ?? "").toLowerCase(),
        direction: (o.direction ?? "").toLowerCase(),
        strike: n(o.strike),
        expiration: o.expiration,
        qty: n(o.qty),
      });
      optsBy.set(o.ticker, list);
    }
    res.json({
      available: true,
      coverageAt: rows.rows[0]?.coverage_at?.slice(0, 10) ?? null,
      rows: rows.rows.map((r: Record<string, unknown>) => {
        const ticker = String(r.ticker);
        const er = (r.next_earnings as string | null) ?? null;
        return {
          ticker,
          tier: r.tier,
          label: r.label,
          reason: r.reason,
          signals: r.as_of
            ? {
                asOf: r.as_of,
                price: n(r.price_close),
                epsMeanFy1: n(r.eps_mean_fy1),
                epsDrift30dPct: n(r.eps_drift_30d_pct),
                numEst: r.eps_num_est_fy1 as number | null,
                fy1Period: r.fy1_period,
                recMean: n(r.rec_mean),
                ptMean: n(r.pt_mean),
                ptUpsidePct: n(r.pt_upside_pct),
                predSurprisePct: n(r.pred_surprise_pct_fq1),
                fq1PeriodEnd: r.fq1_period_end,
                armRank: r.arm_rank as number | null,
                combinedAlphaRank: r.combined_alpha_rank as number | null,
                valmoRank: r.valmo_rank as number | null,
                shortPct: n(r.short_pct),
                shortPctFloat: n(r.short_pct_float),
                issuerRating: r.issuer_rating,
                creditRank: r.credit_combined_rank as number | null,
                priceMoRank: r.price_mo_rank as number | null,
                relValRank: r.relval_rank as number | null,
                priceToIntrinsic: n(r.price_to_intrinsic),
                epsMeanFq1: n(r.eps_mean_fq1),
                epsStdFq1: n(r.eps_std_fq1),
                numEstFq1: r.eps_num_est_fq1 as number | null,
              }
            : null,
          tech: {
            iv: n(r.atm_put_iv),
            ivVsRealized: n(r.iv_vs_realized_vol),
            impliedMoveWeekly: n(r.implied_move_weekly),
            rsi: n(r.rsi14),
            z: n(r.price_z_score),
            regime: r.regime ?? null,
            fallingKnife: n(r.falling_knife) === 1,
            rv: n(r.realized_vol_20d),
          },
          pastMovesPct: ((r.past_moves as unknown[] | null) ?? []).map((m) => n(m)).filter((m): m is number => m != null),
          nextEarnings: er
            ? { date: er, type: "EarningsReleases", title: null, daysUntil: daysUntil(er) }
            : null,
          myPosition: { shares: n(r.shares), options: optsBy.get(ticker) ?? [] },
        };
      }),
      source: "lseg_research + ticker_technicals (local cache; academic research)",
    });
  } catch (err) {
    next(err);
  }
});

router.get("/research/lseg/:ticker", requireAuth, async (req, res, next) => {
  try {
    const ticker = String(req.params.ticker || "").trim().toUpperCase();
    if (!/^[A-Z.]{1,12}$/.test(ticker)) {
      res.status(400).json({ error: "Invalid ticker" });
      return;
    }

    // Schema may not exist yet on a fresh DB — return empty payload, not 500.
    const schemaCheck = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.schemata WHERE schema_name = 'lseg_research'
       ) AS exists`,
    );
    if (!schemaCheck.rows[0]?.exists) {
      res.json({
        ticker,
        available: false,
        reason: "lseg_research schema missing — run research/lseg sync_signals.py",
        signals: null,
        prior: null,
        events: [],
        nextEarnings: null,
        myPosition: null,
        history: { combinedAlpha: [], predSurprise: [] },
        sync: null,
      });
      return;
    }

    const [signals, events, hist, sync, shares, opts, moves, tech, holders] = await Promise.all([
      pool.query<SignalRow>(
        `SELECT as_of::text, ric, price_close, eps_mean_fy1, eps_drift_30d_pct, eps_num_est_fy1, fy1_period,
                revenue_mean_fy1, rec_mean, pt_mean, pt_upside_pct, eps_smart_fy1, smart_vs_cons_pct,
                pred_surprise_pct_fq1, fq1_period_end::text, arm_rank, combined_alpha_rank, valmo_rank,
                short_pct, short_interest, free_float, issuer_rating, cds_ric,
                credit_combined_rank, price_mo_rank, relval_rank, price_to_intrinsic,
                eps_mean_fq1, eps_std_fq1, eps_num_est_fq1
         FROM lseg_research.signals_daily
         WHERE ticker = $1
         ORDER BY as_of DESC
         LIMIT 2`,
        [ticker],
      ),
      pool.query<EventRow>(
        `SELECT event_date::text, event_type, title
         FROM lseg_research.events
         WHERE ticker = $1 AND event_date >= CURRENT_DATE
         ORDER BY event_date
         LIMIT 8`,
        [ticker],
      ),
      pool.query<HistRow>(
        `SELECT metric, obs_date::text, value
         FROM lseg_research.starmine_history
         WHERE ticker = $1 AND obs_date >= CURRENT_DATE - INTERVAL '24 months'
         ORDER BY obs_date`,
        [ticker],
      ),
      pool.query<{ dataset: string; watermark: string | null; last_ok_at: Date | null; last_rows: number | null }>(
        `SELECT dataset, watermark, last_ok_at, last_rows
         FROM lseg_research.sync_state
         ORDER BY dataset`,
      ),
      // Your position in this ticker (latest Robinhood snapshot) — lets the panel say whether
      // short options expire before or after the next earnings report.
      pool.query<{ qty: string | null; snapshot_at: string | null }>(
        `SELECT (SELECT SUM(quantity) FROM portfolio_positions
                  WHERE snapshot_id = s.id AND UPPER(symbol) = $1)::text AS qty,
                s.imported_at::text AS snapshot_at
         FROM (SELECT id, imported_at FROM portfolio_snapshots ORDER BY id DESC LIMIT 1) s`,
        [ticker],
      ),
      pool.query<OptRow>(
        `SELECT option_type, direction, strike::text, expiration::text, SUM(qty)::text AS qty
         FROM portfolio_options
         WHERE snapshot_id = (SELECT MAX(id) FROM portfolio_snapshots) AND UPPER(symbol) = $1
           AND expiration >= CURRENT_DATE -- snapshot can be stale; drop already-expired contracts
         GROUP BY option_type, direction, strike, expiration
         ORDER BY expiration, strike`,
        [ticker],
      ),
      pool.query<{ report_date: string; move_pct: number }>(
        `SELECT report_date::text, move_pct FROM lseg_research.earnings_moves
         WHERE ticker = $1 ORDER BY report_date DESC LIMIT 9`,
        [ticker],
      ),
      pool.query<{ atm_put_iv: number | null; realized_vol_20d: number | null }>(
        `SELECT atm_put_iv, realized_vol_20d FROM ticker_technicals WHERE UPPER(ticker) = $1`,
        [ticker],
      ),
      pool.query<{ rank: number; investor: string; investor_type: string | null; pct_out: number | null; change_shares: number | null; filing_date: string | null }>(
        `SELECT rank, investor, investor_type, pct_out, change_shares, filing_date::text
         FROM lseg_research.holders_top
         WHERE ticker = $1 AND as_of = (SELECT MAX(as_of) FROM lseg_research.holders_top WHERE ticker = $1)
         ORDER BY rank`,
        [ticker],
      ),
    ]);

    const toSignals = (r: SignalRow | undefined) =>
      r
        ? {
            asOf: r.as_of,
            ric: r.ric,
            price: n(r.price_close),
            epsMeanFy1: n(r.eps_mean_fy1),
            epsDrift30dPct: n(r.eps_drift_30d_pct),
            numEst: r.eps_num_est_fy1,
            fy1Period: r.fy1_period,
            revenueMeanFy1: n(r.revenue_mean_fy1),
            recMean: n(r.rec_mean),
            ptMean: n(r.pt_mean),
            ptUpsidePct: n(r.pt_upside_pct),
            smartEstFy1: n(r.eps_smart_fy1),
            smartVsConsPct: n(r.smart_vs_cons_pct),
            predSurprisePct: n(r.pred_surprise_pct_fq1),
            fq1PeriodEnd: r.fq1_period_end,
            armRank: r.arm_rank,
            combinedAlphaRank: r.combined_alpha_rank,
            valmoRank: r.valmo_rank,
            shortPct: n(r.short_pct),
            shortPctFloat:
              n(r.short_interest) != null && n(r.free_float)
                ? (n(r.short_interest)! / n(r.free_float)!) * 100
                : null,
            issuerRating: r.issuer_rating,
            cdsRic: r.cds_ric,
            creditRank: r.credit_combined_rank,
            priceMoRank: r.price_mo_rank,
            relValRank: r.relval_rank,
            priceToIntrinsic: n(r.price_to_intrinsic),
            epsMeanFq1: n(r.eps_mean_fq1),
            epsStdFq1: n(r.eps_std_fq1),
            numEstFq1: r.eps_num_est_fq1,
          }
        : null;

    const ev = events.rows.map((e) => ({
      date: e.event_date,
      type: e.event_type,
      title: e.title,
      daysUntil: daysUntil(e.event_date),
    }));
    const series = (metric: string) =>
      hist.rows.filter((h) => h.metric === metric).map((h) => ({ date: h.obs_date, value: n(h.value) }));

    const sig0 = toSignals(signals.rows[0]);
    const peers = sig0
      ? await lsegPeerRelative(ticker, {
          armRank: sig0.armRank,
          combinedAlphaRank: sig0.combinedAlphaRank,
          predSurprisePct: sig0.predSurprisePct,
          epsDrift30dPct: sig0.epsDrift30dPct,
        }).catch(() => null)
      : null;

    res.json({
      ticker,
      available: signals.rows.length > 0,
      reason:
        signals.rows.length === 0
          ? "No LSEG snapshot for this ticker — add to research/common/universe_book.txt or run sync_signals.py --tickers"
          : null,
      signals: sig0,
      prior: toSignals(signals.rows[1]),
      events: ev,
      nextEarnings: ev.find((e) => e.type === "EarningsReleases") ?? null,
      myPosition: {
        shares: n(shares.rows[0]?.qty),
        snapshotAt: shares.rows[0]?.snapshot_at?.slice(0, 10) ?? null,
        options: opts.rows.map((o) => ({
          type: (o.option_type ?? "").toLowerCase(),
          direction: (o.direction ?? "").toLowerCase(),
          strike: n(o.strike),
          expiration: o.expiration,
          qty: n(o.qty),
        })),
      },
      earningsHistory: moves.rows.map((m) => ({ date: m.report_date, movePct: n(m.move_pct) })),
      topHolders: holders.rows.map((h) => ({
        rank: h.rank,
        investor: h.investor,
        type: h.investor_type,
        pctOut: n(h.pct_out),
        changeShares: n(h.change_shares),
        filingDate: h.filing_date,
      })),
      tech: { iv: n(tech.rows[0]?.atm_put_iv), rv: n(tech.rows[0]?.realized_vol_20d) },
      history: {
        combinedAlpha: series("combined_alpha_rank"),
        predSurprise: series("pred_surprise_pct_fq1"),
      },
      peers,
      sync: Object.fromEntries(
        sync.rows.map((r) => [r.dataset, { watermark: r.watermark, lastOkAt: r.last_ok_at, lastRows: r.last_rows }]),
      ),
      source: "lseg_research (local cache; academic research)",
    });
  } catch (err) {
    next(err);
  }
});

export default router;
