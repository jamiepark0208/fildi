/**
 * Key Themes engine (Macro › Key Themes, Jamie 10-28).
 *
 * Registry = research/market-views/themes.json (Claude-maintained: themes, signposts, scenarios, baskets).
 * Signposts read data the other Macro tabs already cache — macro-charts.json / macro-data.json, LSEG
 * signals_daily (revisions), cds_daily — plus two new tables: gov_flows_* (scripts/watchlist_sync/gov_flows.py)
 * and market-cap flows computed here from prices_historical × shares. No vendor calls.
 *
 * Unified read = themes lean + Volatility + Liquidity tab reads + house view (S057 odds). Display only:
 * macro timing failed as a put-band input (S087, S027); the band engine keeps deciding (S101).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChartPoint, MacroCharts, MacroData } from "../macro-data.js";
import { loadChartsCache, loadMacroCache } from "./macro-cache.js";

// dev (tsx, src/lib/macro) and bundle (dist/) sit at different depths → walk up to the workspace root
function repoRoot(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, "pnpm-workspace.yaml"))) return d;
    d = resolve(d, "..");
  }
  return process.cwd();
}
const VIEWS = join(repoRoot(), "research/market-views");

type Op = ">" | ">=" | "<" | "<=";
type Rule = [Op, number];
export type Status = "bull" | "bear" | "neutral" | "stale" | "missing";

export interface Signpost {
  id: string; label: string; kind: "chart" | "fred" | "revision" | "flow" | "cds" | "gov" | "series" | "manual";
  series?: string; transform?: string; scale?: number; field?: string; basket?: string; vs?: string;
  stat?: "median" | "breadth"; window?: "1w" | "1m" | "3m"; ticker?: string; metric?: string; value?: number; as_of?: string;
  stale_days?: number; bull_if?: Rule; bear_if?: Rule; unit?: string; tab?: string; note?: string;
}
interface ThemeDef {
  id: string; name: string; horizon: "secular" | "cyclical" | "event"; weight: number; thesis: string;
  view: { stance: "bull" | "bear" | "neutral"; p: number; text: string; check: string };
  refs: string[]; signposts: Signpost[];
}
interface Registry {
  updated: string; baskets: Record<string, string[]>; themes: ThemeDef[];
  scenarios: { id: string; name: string; path: string; spx_12m: string; p: number; up_if: string[] }[];
  scenario_source: string;
  playbook?: PlayRule[];
}
/** Structure guidance keyed on a tested state or a signpost (themes.json playbook). tier: tested = a study passed;
 *  hint = consistent but unproven; avoid = a study failed (don't use this input for that decision). */
interface PlayRule {
  id: string; when: { market_state?: string[]; signpost?: string; status?: Status[]; always?: boolean };
  do: string; tier: "tested" | "hint" | "avoid"; evidence: string;
}

const fileCache = new Map<string, { mtimeMs: number; body: unknown }>();
export function readViewsJson<T>(name: string): T | null {
  const p = join(VIEWS, name);
  if (!existsSync(p)) return null;
  const mtimeMs = statSync(p).mtimeMs;
  const hit = fileCache.get(p);
  if (hit && hit.mtimeMs === mtimeMs) return hit.body as T;
  const body = JSON.parse(readFileSync(p, "utf8"));
  fileCache.set(p, { mtimeMs, body });
  return body as T;
}

// ── market-cap flows (shared with /macro/money-flows) ───────────────────────────────────────────

export interface CapRow {
  ticker: string; sector: string; group: string; shares: number;
  c0: number; c1w: number | null; c1m: number | null; c3m: number | null;
}
export interface CapPanel { asOf: string; d1w: string; d1m: string; d3m: string; rows: CapRow[] }

/** Close at the last price date and 5 / 21 / 63 sessions back × shares outstanding (constant-shares approximation:
 *  buybacks/issuance over 3 m are small next to price moves). Shares: LSEG (all classes) → FMP → themes.json
 *  share_overrides for dual-class names priced on one line. Sector = our peer-group taxonomy (941 names). */
export async function loadCapPanel(): Promise<CapPanel | null> {
  const { pool } = await import("@workspace/db");
  const r = await pool.query(`
    WITH d AS (SELECT DISTINCT date FROM prices_historical WHERE date > CURRENT_DATE - 140),
    pts AS (SELECT (SELECT max(date) FROM d) d0,
                   (SELECT date FROM d ORDER BY date DESC OFFSET 5 LIMIT 1) d1w,
                   (SELECT date FROM d ORDER BY date DESC OFFSET 21 LIMIT 1) d1m,
                   (SELECT date FROM d ORDER BY date DESC OFFSET 63 LIMIT 1) d3m),
    grp AS (SELECT DISTINCT ON (m.ticker) m.ticker, g.id AS gid, g.name AS gname
            FROM peer_group_members m JOIN peer_groups g ON g.id = m.group_id
            WHERE m.removed_at IS NULL ORDER BY m.ticker, g.id)
    SELECT p.ticker, COALESCE(split_part(grp.gid, '.', 1), 'unclassified') AS sector,
           COALESCE(grp.gname, 'Unclassified') AS grp,
           COALESCE(sd.shares_out, tf.shares_outstanding)::float8 AS shares,
           max(p.close) FILTER (WHERE p.date = pts.d0)::float8  AS c0,
           max(p.close) FILTER (WHERE p.date = pts.d1w)::float8 AS c1w,
           max(p.close) FILTER (WHERE p.date = pts.d1m)::float8 AS c1m,
           max(p.close) FILTER (WHERE p.date = pts.d3m)::float8 AS c3m,
           pts.d0::text AS d0, pts.d1w::text AS d1w, pts.d1m::text AS d1m, pts.d3m::text AS d3m
    FROM prices_historical p CROSS JOIN pts
    JOIN ticker_fundamentals tf ON tf.ticker = p.ticker
    LEFT JOIN lseg_research.signals_daily sd ON sd.ticker = p.ticker
      AND sd.as_of = (SELECT max(as_of) FROM lseg_research.signals_daily)
    LEFT JOIN grp ON grp.ticker = p.ticker
    WHERE p.date IN (pts.d0, pts.d1w, pts.d1m, pts.d3m) AND COALESCE(sd.shares_out, tf.shares_outstanding) > 0
    GROUP BY p.ticker, grp.gid, grp.gname, sd.shares_out, tf.shares_outstanding, pts.d0, pts.d1w, pts.d1m, pts.d3m`);
  const over = readViewsJson<{ share_overrides?: Record<string, number> }>("themes.json")?.share_overrides ?? {};
  const rows = (r.rows as Record<string, unknown>[]).filter((x) => x.c0 != null);
  if (!rows.length) return null;
  const n = (v: unknown) => (v == null ? null : Number(v));
  return {
    asOf: String(rows[0].d0), d1w: String(rows[0].d1w), d1m: String(rows[0].d1m), d3m: String(rows[0].d3m),
    rows: rows.map((x) => ({
      ticker: String(x.ticker), sector: String(x.sector), group: String(x.grp), shares: over[String(x.ticker)] ?? Number(x.shares),
      c0: Number(x.c0), c1w: n(x.c1w), c1m: n(x.c1m), c3m: n(x.c3m),
    })),
  };
}

const PAST = { "1w": "c1w", "1m": "c1m", "3m": "c3m" } as const;
/** Cap now, cap then, % change over the window for a set of rows (names missing the past close are skipped). */
export function capChange(rows: CapRow[], w: keyof typeof PAST) {
  let now = 0, then = 0, n = 0;
  for (const x of rows) {
    const p = x[PAST[w]];
    if (p == null || p <= 0) continue;
    now += x.c0 * x.shares; then += p * x.shares; n++;
  }
  return { now, then, chg: now - then, pct: then > 0 ? (now / then - 1) * 100 : null, n };
}

// ── signpost resolvers ──────────────────────────────────────────────────────────────────────────

interface Ctx {
  charts: MacroCharts | null; macro: MacroData | null; reg: Registry; caps: CapPanel | null;
  drift: Map<string, number>; driftAsOf: string | null; cds: Map<string, { date: string; bp: number }[]>;
  gov: Record<string, number | null>; govAsOf: string | null;
  series: Map<string, { date: string; value: number }[]>;
}

function chartValue(pts: ChartPoint[] | undefined, transform = "last"): { v: number | null; asOf: string | null } {
  if (!pts?.length) return { v: null, asOf: null };
  const last = pts[pts.length - 1];
  if (transform === "last") return { v: last.value, asOf: last.date };
  const m = /^(pct_)?chg_(\d+)[dw]$/.exec(transform);
  if (!m) return { v: null, asOf: last.date };
  const back = pts[pts.length - 1 - Number(m[2])];
  if (!back) return { v: null, asOf: last.date };
  const v = m[1] ? (back.value ? (last.value / back.value - 1) * 100 : null) : last.value - back.value;
  return { v, asOf: last.date };
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

function basketRows(ctx: Ctx, basket: string): CapRow[] {
  const set = new Set(ctx.reg.baskets[basket] ?? []);
  return (ctx.caps?.rows ?? []).filter((r) => set.has(r.ticker));
}

function resolve1(sp: Signpost, ctx: Ctx): { v: number | null; asOf: string | null; detail?: string } {
  switch (sp.kind) {
    case "chart": {
      const r = chartValue((ctx.charts as unknown as Record<string, ChartPoint[]> | null)?.[sp.series ?? ""], sp.transform);
      return { v: r.v == null ? null : r.v * (sp.scale ?? 1), asOf: r.asOf };
    }
    case "fred": {
      const s = (ctx.macro?.series as unknown as Record<string, Record<string, number | string | null>> | undefined)?.[sp.series ?? ""];
      const v = s?.[sp.field ?? "value"];
      return { v: typeof v === "number" ? v : null, asOf: (s?.date as string) ?? null };
    }
    case "revision": {
      const tickers = sp.basket === "*" ? [...ctx.drift.keys()] : ctx.reg.baskets[sp.basket ?? ""] ?? [];
      const xs = tickers.map((t) => ctx.drift.get(t)).filter((x): x is number => x != null);
      // breadth = % of names revised up > 1 % minus % down > 1 % (same cut as Heatmap › revision breadth, A95)
      const v = sp.stat === "breadth"
        ? (xs.length ? ((xs.filter((x) => x > 1).length - xs.filter((x) => x < -1).length) / xs.length) * 100 : null)
        : median(xs);
      return { v, asOf: ctx.driftAsOf, detail: `${xs.length}/${tickers.length} names` };
    }
    case "flow": {
      if (!ctx.caps) return { v: null, asOf: null };
      const w = sp.window ?? "1m";
      const a = capChange(basketRows(ctx, sp.basket ?? ""), w);
      const b = sp.vs ? capChange(basketRows(ctx, sp.vs), w) : capChange(ctx.caps.rows, w);
      const v = a.pct != null && b.pct != null ? a.pct - b.pct : null;
      return { v, asOf: ctx.caps.asOf, detail: `${a.n} names ${a.pct?.toFixed(1)} % vs ${sp.vs ?? "market"} ${b.pct?.toFixed(1)} %` };
    }
    case "cds": {
      const s = ctx.cds.get(sp.ticker ?? "") ?? [];
      if (!s.length) return { v: null, asOf: null };
      const last = s[s.length - 1];
      const m = /^chg_(\d+)d$/.exec(sp.transform ?? "");
      if (!m) return { v: last.bp, asOf: last.date };
      const back = s[s.length - 1 - Number(m[1])];
      return { v: back ? last.bp - back.bp : null, asOf: last.date, detail: `now ${last.bp.toFixed(0)} bp` };
    }
    case "gov":
      return { v: ctx.gov[sp.metric ?? ""] ?? null, asOf: ctx.govAsOf };
    case "series": {
      const s = ctx.series.get(sp.series ?? "") ?? [];
      if (!s.length) return { v: null, asOf: null };
      const last = s[s.length - 1];
      if (!sp.transform || sp.transform === "last") return { v: last.value, asOf: last.date };
      if (sp.transform === "pctile") {   // percentile of today's value since 2000 (where it sits in 26 years of history)
        const below = s.filter((x) => x.value < last.value).length;
        return { v: (below / s.length) * 100, asOf: last.date, detail: `now ${last.value.toFixed(1)}` };
      }
      const m = /^(pct_)?chg_(\d+)d$/.exec(sp.transform);
      const back = m ? s[s.length - 1 - Number(m[2])] : undefined;
      if (!back) return { v: null, asOf: last.date };
      return { v: m![1] ? (last.value / back.value - 1) * 100 : last.value - back.value, asOf: last.date, detail: `now ${last.value.toFixed(1)}` };
    }
    case "manual":
      return { v: sp.value ?? null, asOf: sp.as_of ?? null };
  }
}

const test = (v: number, [op, x]: Rule) =>
  op === ">" ? v > x : op === ">=" ? v >= x : op === "<" ? v < x : v <= x;

function statusOf(sp: Signpost, v: number | null, asOf: string | null): Status {
  if (v == null) return "missing";
  if (sp.kind === "manual" && asOf) {
    const age = (Date.now() - Date.parse(asOf)) / 86_400_000;
    if (age > (sp.stale_days ?? 30)) return "stale";
  }
  if (sp.bull_if && test(v, sp.bull_if)) return "bull";
  if (sp.bear_if && test(v, sp.bear_if)) return "bear";
  return "neutral";
}

// ── context loaders ─────────────────────────────────────────────────────────────────────────────

async function loadGov(): Promise<{ m: Record<string, number | null>; asOf: string | null }> {
  const { pool } = await import("@workspace/db");
  const r = await pool.query(`
    WITH last AS (SELECT max(date) d FROM watchlist_sync.gov_flows_daily)
    SELECT (SELECT d FROM last)::text AS as_of,
      sum(deficit) FILTER (WHERE date >  (SELECT d FROM last) - 91)::float8 AS def_3m,
      sum(deficit) FILTER (WHERE date >  (SELECT d FROM last) - 456 AND date <= (SELECT d FROM last) - 365)::float8 AS def_3m_ly,
      sum(defense) FILTER (WHERE date >  (SELECT d FROM last) - 91)::float8 AS dod_3m,
      sum(defense) FILTER (WHERE date >  (SELECT d FROM last) - 456 AND date <= (SELECT d FROM last) - 365)::float8 AS dod_3m_ly,
      (SELECT tga_close FROM watchlist_sync.gov_flows_daily WHERE tga_close IS NOT NULL ORDER BY date DESC LIMIT 1)::float8 AS tga,
      (SELECT tga_close FROM watchlist_sync.gov_flows_daily WHERE tga_close IS NOT NULL
         AND date <= (SELECT d FROM last) - 30 ORDER BY date DESC LIMIT 1)::float8 AS tga_1m
    FROM watchlist_sync.gov_flows_daily`).catch(() => null);
  const x = r?.rows[0] as Record<string, number | string | null> | undefined;
  if (!x || x.as_of == null) return { m: {}, asOf: null };
  const f = (k: string) => (x[k] == null ? null : Number(x[k]));
  const sub = (a: number | null, b: number | null) => (a != null && b != null ? (a - b) / 1e3 : null); // $M → $B
  const pct = (a: number | null, b: number | null) => (a != null && b ? (a / b - 1) * 100 : null);
  return {
    asOf: String(x.as_of),
    m: {
      deficit_3m_yoy: sub(f("def_3m"), f("def_3m_ly")),
      tga_chg_1m: sub(f("tga"), f("tga_1m")),
      defense_3m_yoy_pct: pct(f("dod_3m"), f("dod_3m_ly")),
    },
  };
}

async function loadContext(reg: Registry, caps: CapPanel | null): Promise<Ctx> {
  const { pool } = await import("@workspace/db");
  const seriesNames = [...new Set(reg.themes.flatMap((t) => t.signposts).filter((s) => s.kind === "series").map((s) => s.series!))];
  const cdsTickers = [...new Set(reg.themes.flatMap((t) => t.signposts).filter((s) => s.kind === "cds").map((s) => s.ticker!))];
  const [dr, cr, gov] = await Promise.all([
    pool.query(`SELECT ticker, eps_drift_30d_pct::float8 AS d, as_of::text AS as_of FROM lseg_research.signals_daily
                WHERE as_of = (SELECT max(as_of) FROM lseg_research.signals_daily) AND eps_drift_30d_pct IS NOT NULL`),
    pool.query(`SELECT ticker, date::text AS date, par_mid_bp::float8 AS bp FROM lseg_research.cds_daily
                WHERE ticker = ANY($1) AND date > CURRENT_DATE - 120 ORDER BY ticker, date`, [cdsTickers]),
    loadGov(),
  ]);
  const sr = await pool.query(`SELECT series, date::text AS date, value FROM watchlist_sync.macro_daily
                               WHERE series = ANY($1) AND date >= '2000-01-01' AND value IS NOT NULL ORDER BY series, date`, [seriesNames])
    .catch(() => null);
  const series = new Map<string, { date: string; value: number }[]>();
  for (const x of (sr?.rows ?? []) as { series: string; date: string; value: number }[]) {
    (series.get(x.series) ?? series.set(x.series, []).get(x.series)!).push({ date: x.date, value: x.value });
  }
  const drift = new Map<string, number>();
  for (const x of dr.rows as { ticker: string; d: number }[]) drift.set(x.ticker, x.d);
  const cds = new Map<string, { date: string; bp: number }[]>();
  for (const x of cr.rows as { ticker: string; date: string; bp: number }[]) {
    (cds.get(x.ticker) ?? cds.set(x.ticker, []).get(x.ticker)!).push({ date: x.date, bp: x.bp });
  }
  return {
    charts: loadChartsCache(), macro: loadMacroCache(),
    reg, caps, drift, driftAsOf: (dr.rows[0] as { as_of?: string } | undefined)?.as_of ?? null, cds,
    gov: gov.m, govAsOf: gov.asOf, series,
  };
}

const fmtLean = (x: number) => (x >= 0.34 ? "bull" : x <= -0.34 ? "bear" : "mixed") + ` ${x >= 0 ? "+" : ""}${x.toFixed(2)}`;

/** Compact Key Themes context for AI explanations (explain-context): tested state, active playbook, theme leans. */
export interface ThemesBrief { marketState: string | null; playbook: string[]; themes: string[] }
let briefCache: { at: number; v: ThemesBrief | null } | null = null;
export async function themesBrief(): Promise<ThemesBrief | null> {
  if (briefCache && Date.now() - briefCache.at < 15 * 60_000) return briefCache.v;
  const t = await buildThemes(await loadCapPanel());
  const v = t && {
    marketState: t.read.marketState,
    playbook: t.read.playbook.filter((r) => r.active).map((r) => `[${r.tier}] ${r.do}`),
    themes: t.themes.map((th) => `${th.name}: data ${th.lean}, Claude ${th.view.stance} ${Math.round(th.view.p * 100)} %`),
  };
  briefCache = { at: Date.now(), v };
  return v;
}

// ── themes + unified read ───────────────────────────────────────────────────────────────────────

const STANCE_SCORE = { bull: 1, neutral: 0, bear: -1 } as const;

export async function buildThemes(caps: CapPanel | null) {
  const reg = readViewsJson<Registry>("themes.json");
  if (!reg) return null;
  const ctx = await loadContext(reg, caps);

  const themes = reg.themes.map((t) => {
    const signposts = t.signposts.map((sp) => {
      const r = resolve1(sp, ctx);
      return { ...sp, current: r.v, asOf: r.asOf, detail: r.detail ?? null, status: statusOf(sp, r.v, r.asOf) };
    });
    const live = signposts.filter((s) => s.status === "bull" || s.status === "bear" || s.status === "neutral");
    const bull = live.filter((s) => s.status === "bull").length;
    const bear = live.filter((s) => s.status === "bear").length;
    const score = live.length ? (bull - bear) / live.length : null;
    const lean = score == null ? "no data" : score >= 0.34 ? "bull" : score <= -0.34 ? "bear" : "neutral";
    // Claude's view disagrees with its own signposts → re-check the view (learning loop: theme_snapshots + LOG.md)
    const divergence = score != null && STANCE_SCORE[t.view.stance] * score < 0;
    return {
      ...t, signposts, lean, score, bull, bear, neutral: live.length - bull - bear,
      missing: signposts.length - live.length, divergence,
      checkDue: Date.parse(t.view.check) <= Date.now(),
    };
  });

  // scenario pressure: how many of each scenario's "moves it up" signposts point its way today (context, not a re-weight)
  const byId = new Map(themes.flatMap((t) => t.signposts).map((s) => [s.id, s]));
  const scenarios = reg.scenarios.map((s) => {
    const towardBad = s.id === "B" || s.id === "C";
    const hits = s.up_if.filter((id) => byId.get(id)?.status === (towardBad ? "bear" : "bull"));
    return { ...s, signals: s.up_if.length, pointing: hits.length, pointingIds: hits };
  });

  const { pool } = await import("@workspace/db");
  const [hv, ms, cyc] = await Promise.all([
    pool.query(`SELECT view_date::text AS d, view FROM watchlist_sync.house_view ORDER BY view_date DESC LIMIT 1`).catch(() => null),
    // tested market state = the band engine's (S101), as stamped on today's put recs; sector_drop is a per-name override
    pool.query(`SELECT as_of::text AS d, payload->>'market_state' AS s, count(*)::int AS n FROM watchlist_sync.put_recs_daily
                WHERE as_of = (SELECT max(as_of) FROM watchlist_sync.put_recs_daily) GROUP BY 1, 2 ORDER BY 3 DESC`).catch(() => null),
    pool.query(`SELECT regime, confidence FROM market_regime ORDER BY id DESC LIMIT 1`).catch(() => null),
  ]);
  const hvRow = hv?.rows[0] as { d: string; view: { odds?: { up?: Record<string, number>; tail?: Record<string, number> } } } | undefined;
  const tail = hvRow?.view.odds?.tail;
  const msRows = (ms?.rows ?? []) as { d: string; s: string; n: number }[];
  const marketState = msRows.find((r) => r.s !== "sector_drop")?.s ?? null;
  const sectorDrop = msRows.find((r) => r.s === "sector_drop")?.n ?? 0;
  const cycle = cyc?.rows[0] as { regime: string; confidence: number } | undefined;

  const wsum = themes.reduce((a, t) => a + (t.score == null ? 0 : t.weight), 0);
  const themeScore = wsum ? themes.reduce((a, t) => a + (t.score ?? 0) * t.weight, 0) / wsum : null;
  const volLvl = ctx.charts?.volatilityImplications?.overall.level;
  const liqLvl = ctx.charts?.liquidityImplications?.overall.level;
  const pUp = scenarios.filter((s) => s.id === "A" || s.id === "D").reduce((a, s) => a + s.p, 0)
    + 0.5 * (scenarios.find((s) => s.id === "B")?.p ?? 0);

  // Layers, strongest evidence first. Only the market state and S057 tail odds have passed tests; the rest is context.
  const layers = [
    { key: "state", label: "Market state", tier: "tested", tab: "regime",
      readout: marketState ? `${marketState.replace("_", " ")}${sectorDrop ? ` · ${sectorDrop} names in sector drops` : ""}` : "—",
      why: "Band engine (S101): panic / sharp drop / bear grind / rally / normal from SPY drawdown, 3–6 m return, VIX ÷ VIX3M. Changes which put band wins." },
    { key: "tail", label: "Drop odds (S057)", tier: "tested", tab: "regime",
      readout: tail ? `P(−5 % leg, 21 d) ${(tail.s057_logit * 100).toFixed(0)} % · base ${(tail.base_rate * 100).toFixed(0)} % · VIX-implied ${((tail.market_vix ?? 0) * 100).toFixed(0)} %` : "—",
      why: "Beats VIX barrier odds (+0.205 skill): options price index tails ~2× what happens → index put premium rich. Direction odds = base rate." },
    { key: "cycle", label: "Business cycle", tier: "untested", tab: "regime",
      readout: cycle ? `${cycle.regime.replace("_", " ")} (${cycle.confidence})` : "—",
      why: "regime-classifier (VIX, Fed lean, bank notes): no earnings/credit inputs, said 'expansion' 20 of 21 days; being rebuilt (earnings-led cycle study)." },
    { key: "themes", label: "Themes lean", tier: "untested", tab: "themes",
      readout: themeScore == null ? "—" : `${fmtLean(themeScore)} · ${themes.filter((t) => t.lean === "bull").length} bull / ${themes.filter((t) => t.lean === "bear").length} bear`,
      why: "Judgment thresholds on signposts; graded on each view's check date (theme_snapshots)." },
    { key: "volatility", label: "Volatility", tier: "context", tab: "volatility", readout: volLvl ?? "—", why: "Macro › Volatility read." },
    { key: "liquidity", label: "Liquidity", tier: "context", tab: "liquidity", readout: liqLvl ?? "—", why: "Macro › Liquidity read." },
  ];

  // playbook: rules whose condition holds today
  const byStatus = new Map(themes.flatMap((t) => t.signposts).map((s) => [s.id, s.status]));
  const playbook = (reg.playbook ?? []).map((r) => {
    const w = r.when;
    const active = !!w.always
      || (w.market_state != null && marketState != null && w.market_state.includes(marketState))
      || (w.signpost != null && (w.status ?? ["bear"]).includes(byStatus.get(w.signpost) as Status));
    return { ...r, active };
  });

  return {
    updated: reg.updated, registryAgeDays: Math.round((Date.now() - Date.parse(reg.updated)) / 86_400_000),
    themes, scenarios, scenarioSource: reg.scenario_source,
    read: {
      marketState, sectorDrop, themeLean: themeScore, layers, pUp12m: pUp, playbook,
      note: "Macro direction (themes, cycle, house-view up odds) failed as a timing or sizing input (S006, S027, S057, S087): it explains, it does not trade. Trades key off the tested market state and the playbook.",
    },
    asOf: { prices: caps?.asOf ?? null, revisions: ctx.driftAsOf, gov: ctx.govAsOf, charts: ctx.charts?.fetchedAt ?? null, houseView: hvRow?.d ?? null },
  };
}
