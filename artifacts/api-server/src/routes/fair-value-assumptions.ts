/**
 * Fair value assumptions (Breakdown › Assumptions tab). Ledger + model: lib/fv-assumptions.ts.
 * GET  /api/fair-value/:ticker/assumptions                 → shared rules, cohort, this stock's inputs (+ last changed), judgement rows, FV history
 * GET  /api/fair-value/:ticker/assumptions/history?field=X → every value that input has had (and overrides of it)
 * POST /api/fair-value/assumptions        (admin)          → new proposed/active row (reason required; never edits an old row)
 * POST /api/fair-value/assumptions/:id    (admin)          → {action: accept | reject | retire, note}
 */
import { Router, type Request } from "express";
import { pool } from "@workspace/db";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { getChampionScorecardParams } from "../lib/scorecard-params.js";
import { impliedGrowth, type FvTickerInput, type FairValueParams } from "../lib/fair-value.js";
import { loadMarket } from "../lib/fair-value-snapshots.js";
import { persistFairValueSnapshots } from "../lib/fair-value-snapshots.js";
import { COHORT_PARAMS, INPUT_FIELDS, OVERRIDABLE_INPUTS, ensureAssumptionTables, type InputField } from "../lib/fv-assumptions.js";

const router = Router();
const TICKER = /^[A-Z][A-Z0-9.-]{0,9}$/;
const SHARED_KEYS = ["equityRiskPremium", "terminalGrowth", "growthCap", "growthFloor", "costOfEquityClamp", "betaClamp", "analystBias", "blend", "minPeers"];

/** A86 — reverse-DCF on street PT + voters furthest from target (display). */
async function streetBackOut(
  ticker: string,
  streetPt: number | null,
  params: FairValueParams,
  votesRaw: unknown,
): Promise<{
  streetImpliedGrowth: number | null;
  growthCap: number;
  furthestVoters: { name: string; value: number; gapPct: number }[];
}> {
  const growthCap = params.growthCap;
  let furthestVoters: { name: string; value: number; gapPct: number }[] = [];
  if (streetPt != null && streetPt > 0 && Array.isArray(votesRaw)) {
    furthestVoters = (votesRaw as { name?: string; value?: number }[])
      .filter((v) => v?.name && typeof v.value === "number" && Number.isFinite(v.value))
      .map((v) => ({
        name: String(v.name),
        value: Number(v.value),
        gapPct: ((Number(v.value) - streetPt) / streetPt) * 100,
      }))
      .sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct))
      .slice(0, 3);
  }
  let streetImpliedGrowth: number | null = null;
  if (streetPt != null && streetPt > 0) {
    const inp = (await pool.query(
      `SELECT inputs FROM fair_value_inputs WHERE ticker = $1 ORDER BY first_seen DESC LIMIT 1`,
      [ticker],
    )).rows[0]?.inputs as Record<string, unknown> | undefined;
    if (inp && typeof inp === "object") {
      const n = (k: string) => {
        const v = inp[k];
        return typeof v === "number" && Number.isFinite(v) ? v : null;
      };
      const t: FvTickerInput = {
        ticker,
        mode: typeof inp.mode === "string" ? inp.mode : "standard",
        peerGroupId: typeof inp.peerGroupId === "string" ? inp.peerGroupId : null,
        metricExclusions: Array.isArray(inp.metricExclusions) ? inp.metricExclusions as string[] : [],
        price: streetPt,
        forwardEps: n("forwardEps"),
        eps2: n("eps2"),
        ltg: n("ltg"),
        trailingEps: n("trailingEps"),
        revenueGrowth: n("revenueGrowth"),
        fcf: n("fcf"),
        shares: n("shares"),
        totalDebt: n("totalDebt"),
        cash: n("cash"),
        ebitda: n("ebitda"),
        equity: n("equity"),
        roe: n("roe"),
        beta: n("beta"),
        ffo: n("ffo"),
        analystTarget: n("analystTarget"),
        starminePriceToIntrinsic: n("starminePriceToIntrinsic"),
      };
      try {
        const market = await loadMarket(params as FairValueParams & { aaaYieldFallbackSpread?: number });
        streetImpliedGrowth = impliedGrowth(t, market, params, streetPt);
      } catch {
        streetImpliedGrowth = null;
      }
    }
  }
  return { streetImpliedGrowth, growthCap, furthestVoters };
}

const who = (req: Request) => String((req as Request & { session?: { userId?: unknown } }).session?.userId ?? "admin");

router.get("/fair-value/:ticker/assumptions", async (req, res, next) => {
  const t = String(req.params.ticker ?? "").toUpperCase();
  if (!TICKER.test(t)) return res.status(400).json({ error: "bad ticker" });
  try {
    await ensureAssumptionTables();
    const { version, params } = await getChampionScorecardParams("fair_value");
    const meta = (await pool.query(`SELECT created_at, promoted_at, rationale, approved_by FROM scorecard_params WHERE version = $1 LIMIT 1`, [version])).rows[0] ?? null;
    const cohort = (await pool.query(`
      SELECT g.id, g.name, g.scoring_mode, (SELECT COUNT(*) FROM ticker_registry r2 WHERE r2.primary_peer_group_id = g.id AND COALESCE(r2.is_active, true))::int AS members
      FROM ticker_registry r JOIN peer_groups g ON g.id = r.primary_peer_group_id WHERE r.ticker = $1`, [t])).rows[0] ?? null;
    const hist = (await pool.query(`SELECT digest, inputs, first_seen::text FROM fair_value_inputs WHERE ticker = $1 ORDER BY first_seen, digest`, [t])).rows as
      { inputs: Record<string, unknown>; first_seen: string }[];
    const latest = hist[hist.length - 1]?.inputs ?? null;
    const inputs = (Object.keys(INPUT_FIELDS) as InputField[]).map((f) => {
      let changed: string | null = null;
      for (let i = 1; i < hist.length; i++) if (JSON.stringify(hist[i].inputs[f]) !== JSON.stringify(hist[i - 1].inputs[f])) changed = hist[i].first_seen;
      return { field: f, ...INPUT_FIELDS[f], value: latest ? latest[f] ?? null : null, lastChanged: changed ?? hist[0]?.first_seen ?? null,
               overridable: (OVERRIDABLE_INPUTS as string[]).includes(f), versions: new Set(hist.map((h) => JSON.stringify(h.inputs[f]))).size };
    });
    const rows = (await pool.query(`
      SELECT * FROM fv_assumptions WHERE (scope = 'ticker' AND scope_key = $1) OR (scope = 'peer_group' AND scope_key = $2)
      ORDER BY created_at DESC`, [t, cohort?.id ?? ""])).rows;
    const fv = (await pool.query(`
      SELECT as_of::text, price::float8, fair_value::float8, adjusted_fair_value::float8, confidence, mode, model_version,
             implied_growth::float8, adjustments, votes
      FROM fair_value_snapshots WHERE ticker = $1 ORDER BY as_of DESC LIMIT 180`, [t])).rows;
    const streetPtRaw = (await pool.query(`
      SELECT median_pt::float8 AS median_pt FROM street_pt_daily
      WHERE ticker = $1 ORDER BY as_of DESC LIMIT 1`, [t])).rows[0]?.median_pt as number | null | undefined;
    const streetPt = streetPtRaw != null ? Number(streetPtRaw) : null;
    const back = await streetBackOut(t, streetPt, params as unknown as FairValueParams, fv[0]?.votes);
    return res.json({
      ticker: t,
      shared: { version, changedAt: meta?.promoted_at ?? meta?.created_at ?? null, rationale: meta?.rationale ?? null, approvedBy: meta?.approved_by ?? null,
                params: Object.fromEntries(SHARED_KEYS.map((k) => [k, (params as Record<string, unknown>)[k]])) },
      cohort, cohortParams: COHORT_PARAMS, inputs, inputsSince: hist[0]?.first_seen ?? null, assumptions: rows,
      latest: fv[0] ?? null, history: fv.map(({ votes: _v, adjustments: _a, ...r }) => r).reverse(),
      streetPt,
      streetImpliedGrowth: back.streetImpliedGrowth,
      growthCap: back.growthCap,
      furthestVoters: back.furthestVoters,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/fair-value/:ticker/assumptions/history", async (req, res, next) => {
  const t = String(req.params.ticker ?? "").toUpperCase();
  const field = String(req.query.field ?? "");
  if (!TICKER.test(t) || !(field in INPUT_FIELDS)) return res.status(400).json({ error: "bad ticker or field" });
  try {
    await ensureAssumptionTables();
    const hist = (await pool.query(`SELECT inputs->$2 AS v, first_seen::text AS date FROM fair_value_inputs WHERE ticker = $1 ORDER BY first_seen`, [t, field])).rows;
    const changes: { date: string; value: unknown }[] = [];
    for (const h of hist) if (!changes.length || JSON.stringify(changes[changes.length - 1].value) !== JSON.stringify(h.v)) changes.push({ date: h.date, value: h.v });
    const overrides = (await pool.query(`SELECT id, value, reason, source, status, created_at, decided_at, expires_at FROM fv_assumptions
      WHERE scope = 'ticker' AND scope_key = $1 AND field = $2 ORDER BY created_at`, [t, field])).rows;
    return res.json({ ticker: t, field, ...INPUT_FIELDS[field as InputField], changes, overrides });
  } catch (err) {
    return next(err);
  }
});

router.post("/fair-value/assumptions", requireAdmin, async (req, res, next) => {
  const b = req.body ?? {};
  const scope = b.scope === "peer_group" ? "peer_group" : "ticker";
  const key = String(b.scopeKey ?? "").trim();
  const field = String(b.field ?? "");
  const value = Number(b.value);
  const reason = String(b.reason ?? "").trim();
  const allowed = scope === "ticker" ? (OVERRIDABLE_INPUTS as string[]) : (COHORT_PARAMS as readonly string[]);
  if (!key || !allowed.includes(field) || !Number.isFinite(value) || reason.length < 5) {
    return res.status(400).json({ error: "need scopeKey, an allowed field, a numeric value and a reason (≥ 5 chars)", allowed });
  }
  try {
    await ensureAssumptionTables();
    const scopeKey = scope === "ticker" ? key.toUpperCase() : key;
    let expires: string | null = b.expiresAt ? String(b.expiresAt) : null;
    if (!expires && scope === "ticker") {
      // default: lapses at the next earnings report, so a judgement never silently outlives the facts it was based on
      const e = (await pool.query(`SELECT MIN(report_date::date)::text AS d FROM earnings_calendar WHERE UPPER(ticker) = $1 AND report_date::date > CURRENT_DATE`, [scopeKey])).rows[0];
      expires = e?.d ?? null;
    }
    const status = b.status === "active" ? "active" : "proposed";
    const row = (await pool.query(`
      INSERT INTO fv_assumptions (scope, scope_key, field, value, reason, source, status, created_by, expires_at, decided_by, decided_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date, CASE WHEN $7 = 'active' THEN $8 END, CASE WHEN $7 = 'active' THEN now() END) RETURNING *`,
      [scope, scopeKey, field, value, reason, b.source ? String(b.source) : "manual", status, who(req), expires])).rows[0];
    if (status === "active") await retireOthers(row.id, scope, scopeKey, field, who(req));
    if (status === "active") void persistFairValueSnapshots({ trigger: "assumption" });
    return res.json({ assumption: row });
  } catch (err) {
    return next(err);
  }
});

async function retireOthers(id: number, scope: string, key: string, field: string, by: string): Promise<void> {
  await pool.query(`UPDATE fv_assumptions SET status = 'retired', decided_by = $5, decided_at = now(), decision_note = 'superseded by #' || $1
    WHERE scope = $2 AND scope_key = $3 AND field = $4 AND status = 'active' AND id <> $1`, [id, scope, key, field, by]);
  await pool.query(`UPDATE fv_assumptions SET supersedes = (SELECT MAX(id) FROM fv_assumptions WHERE scope = $2 AND scope_key = $3 AND field = $4 AND id < $1)
    WHERE id = $1 AND supersedes IS NULL`, [id, scope, key, field]);
}

router.post("/fair-value/assumptions/:id", requireAdmin, async (req, res, next) => {
  const id = Number(req.params.id);
  const action = String(req.body?.action ?? "");
  const next_ = { accept: ["proposed", "active"], reject: ["proposed", "rejected"], retire: ["active", "retired"] } as const;
  if (!Number.isInteger(id) || !(action in next_)) return res.status(400).json({ error: "action must be accept | reject | retire" });
  const [from, to] = next_[action as keyof typeof next_];
  try {
    await ensureAssumptionTables();
    const row = (await pool.query(`UPDATE fv_assumptions SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4
      WHERE id = $1 AND status = $5 RETURNING *`, [id, to, who(req), req.body?.note ? String(req.body.note) : null, from])).rows[0];
    if (!row) return res.status(409).json({ error: `row is not ${from}` });
    if (to === "active") await retireOthers(row.id, row.scope, row.scope_key, row.field, who(req));
    if (to === "active" || to === "retired") void persistFairValueSnapshots({ trigger: "assumption" });
    return res.json({ assumption: row });
  } catch (err) {
    return next(err);
  }
});

/** A86 — largest Fildi-vs-street gaps (review queue; not an alert). */
router.get("/fair-value/street-gaps", async (req, res, next) => {
  try {
    const { listLargestStreetGaps } = await import("../lib/street-pt.js");
    const limit = Math.min(80, Math.max(5, Number(req.query.limit) || 30));
    const gaps = await listLargestStreetGaps(limit);
    return res.json({
      gaps,
      note: "Largest |FV − street PT| / street. Review queue only — gaps do not time returns (FINDINGS).",
    });
  } catch (err) {
    return next(err);
  }
});

/** A86 — FV vs street consensus PT series (display / disagreement lab). */
router.get("/fair-value/:ticker/vs-street", async (req, res, next) => {
  const t = String(req.params.ticker ?? "").toUpperCase();
  if (!TICKER.test(t)) return res.status(400).json({ error: "bad ticker" });
  try {
    const { getFvVsStreet } = await import("../lib/street-pt.js");
    const days = Math.min(800, Math.max(30, Number(req.query.days) || 400));
    const points = await getFvVsStreet(t, days);
    return res.json({
      ticker: t,
      points,
      note: "Street = median analyst price_target on event days, forward-filled. Display only (A86).",
    });
  } catch (err) {
    return next(err);
  }
});

const EXTERNAL_LABELS: Record<string, { label: string; method: string }> = {
  starmine: { label: "LSEG StarMine intrinsic value", method: "LSEG model on bias-corrected consensus (StarMine IV ÷ price)" },
  fmp_dcf: { label: "FMP DCF", method: "FMP discounted cash flow (unlevered; levered in detail)" },
};

/** A283 — outside intrinsic-value estimates for display next to Fildi fair value (watchlist_sync.external_intrinsic). */
router.get("/fair-value/:ticker/external", async (req, res, next) => {
  const t = String(req.params.ticker ?? "").toUpperCase();
  if (!TICKER.test(t)) return res.status(400).json({ error: "bad ticker" });
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (source) source, value, price, as_of::text AS as_of, detail
       FROM watchlist_sync.external_intrinsic WHERE ticker = $1 AND value IS NOT NULL AND as_of >= CURRENT_DATE - 45
       ORDER BY source, as_of DESC`, [t]).catch(() => ({ rows: [] as Record<string, unknown>[] }));
    const estimates = rows.map((r) => {
      const value = Number(r.value);
      const price = r.price != null ? Number(r.price) : null;
      const meta = EXTERNAL_LABELS[String(r.source)] ?? { label: String(r.source), method: "" };
      return { source: r.source, label: meta.label, method: meta.method, value, price, asOf: r.as_of,
        gapVsItsPrice: price && price > 0 ? value / price - 1 : null, detail: r.detail ?? null };
    });
    return res.json({
      ticker: t,
      estimates,
      note: "Outside intrinsic values, display only. Each gap is vs the price that source used. Not blended beyond the existing StarMine vote.",
    });
  } catch (err) {
    return next(err);
  }
});

/** A283/A289 — DCF v2 (lab): range, scenarios, reverse DCF and every assumption with its source (watchlist_sync.dcf_detail). */
router.get("/fair-value/:ticker/dcf", async (req, res, next) => {
  const t = String(req.params.ticker ?? "").toUpperCase();
  if (!TICKER.test(t)) return res.status(400).json({ error: "bad ticker" });
  try {
    const { rows } = await pool.query(
      `SELECT as_of::text AS as_of, version, valued, detail FROM watchlist_sync.dcf_detail WHERE ticker = $1 ORDER BY as_of DESC LIMIT 1`,
      [t]).catch(() => ({ rows: [] as Record<string, unknown>[] }));
    if (!rows.length) return res.json({ ticker: t, dcf: null });
    const r = rows[0];
    return res.json({ ticker: t, dcf: { asOf: r.as_of, version: r.version, valued: r.valued, ...(r.detail as object) },
      note: "Lab model (not in the fair value blend). Watchlist names only until Jamie signs fv-2.0.0." });
  } catch (err) {
    return next(err);
  }
});

export default router;
