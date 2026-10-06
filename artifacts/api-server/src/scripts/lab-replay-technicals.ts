/**
 * Scorecard lab (research, read-only for live tables): replay Fildi's OWN technical engines on history.
 *
 * Feeds point-in-time OHLCV + LSEG 30d ATM IV (lseg_research.daily_history) through the live code — computeFromOHLCV →
 * scoreTechnicalRowV2 (UI / snapshots) and computeTechnicalRankingsV2 put + call (options scanner) — and stores inputs,
 * totals and per-component scores in watchlist_sync.lab_tech. No scoring logic is copied: a weight change in the engines is
 * re-tested by re-running this (rows are keyed by engine_digest, a hash of the engine source files).
 *
 * Per-component v2 scores use the engine itself: one-hot weights → the engine's available-weight normalisation returns that
 * component's score alone.
 * History-limited inputs (null → the engines re-normalise, same as live when a field is missing): analystUpside, shortRatio,
 * putCallVolumeRatio, basicSkew, ivTermStructure. ivRankEffective = 1-year percentile of LSEG 30d ATM put IV (the live
 * "hist" path). Window = WINDOW trailing bars (fixed; live currently uses every stored bar, so its percentiles drift as
 * history is backfilled: 10/05 rows were computed on ~289 bars, the table now holds ~340; see lab-fidelity-technicals.ts).
 *
 *   pnpm exec tsx src/scripts/lab-replay-technicals.ts [--variant=ivhist] [--freq=month|week] [--from=2020-02-01] [--tickers=A,B] [--window=252]
 */
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { pool } from "@workspace/db";
import { computeTechnicalRankingsV2, type TechnicalRow } from "@workspace/option-scoring";
import { computeFromOHLCV } from "../lib/technicals-db.js";
import { scoreTechnicalRowV2 } from "../lib/technical-scorer-v2.js";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const FREQ = arg("freq", "month");
const FROM = arg("from", "2020-02-01");
const WINDOW = Number(arg("window", "252"));
const VARIANT = arg("variant", "");   // "ivhist": feed the true LSEG IV rank into ivRank (v2 still reads the RV proxy live)
const ONLY = arg("tickers", "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const ETFS = new Set(["SPY", "QQQ", "IWM", "XLK", "XLF", "DIA", "XLE", "XLV", "XLI", "XLY", "XLP", "XLU", "XLB", "XLRE", "XLC", "SMH", "TLT", "HYG", "GLD"]);
const V2_KEYS = ["oversoldDepth", "reversalSignal", "volatilityState", "trendContext", "optionsFlow", "volumeConfirm"] as const;

const here = dirname(fileURLToPath(import.meta.url));
const ENGINE_DIGEST = createHash("sha1").update([
  join(here, "../lib/technicals-db.ts"), join(here, "../lib/technical-scorer-v2.ts"),
  join(here, "../../../../lib/option-scoring/src/technical-rankings.ts"),
].map((p) => readFileSync(p, "utf8")).join("\n")).digest("hex").slice(0, 12) + (VARIANT ? `-${VARIANT}` : "");

type Bar = { d: string; c: number; h: number; l: number; v: number; iv: number | null };

const DDL = `CREATE TABLE IF NOT EXISTS watchlist_sync.lab_tech (
  ticker text NOT NULL, as_of date NOT NULL, engine_digest text NOT NULL, window_bars int NOT NULL,
  inputs jsonb NOT NULL, v2 jsonb, v4_put jsonb, v4_call jsonb, computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticker, as_of, engine_digest))`;

function pctRank(cur: number, hist: number[], minN: number): number | null {
  const f = hist.filter((x) => Number.isFinite(x) && x > 0);
  if (f.length < minN) return null;
  return f.filter((x) => x < cur).length / f.length;
}

function sampleDates(all: string[]): string[] {
  const out: string[] = [];
  let last = "";
  for (const d of all) {
    if (d < FROM) continue;
    const key = FREQ === "week" ? weekKey(d) : d.slice(0, 7);
    if (key !== last) { out.push(d); last = key; }
  }
  return out;
}
function weekKey(d: string): string {
  const t = new Date(d + "T12:00:00Z");
  const mon = new Date(t.getTime() - ((t.getUTCDay() + 6) % 7) * 86400000);
  return mon.toISOString().slice(0, 10);
}

async function main() {
  await pool.query(DDL);
  const tick = ONLY.length ? ONLY : (await pool.query(
    `SELECT DISTINCT ticker FROM lseg_research.daily_history WHERE high IS NOT NULL ORDER BY 1`)).rows.map((r) => r.ticker as string);
  const hist = new Map<string, Bar[]>();
  const { rows } = await pool.query(
    `SELECT ticker, date::text d, close::float8 c, high::float8 h, low::float8 l, volume::float8 v, iv30_put::float8 iv
     FROM lseg_research.daily_history WHERE ticker = ANY($1) AND close IS NOT NULL AND high IS NOT NULL ORDER BY ticker, date`,
    [[...new Set([...tick, "SPY"])]]);
  for (const r of rows) {
    if (!hist.has(r.ticker)) hist.set(r.ticker, []);
    hist.get(r.ticker)!.push({ d: r.d, c: r.c, h: r.h, l: r.l, v: r.v ?? 0, iv: r.iv });
  }
  const peer = new Map<string, string | null>((await pool.query(
    `SELECT UPPER(ticker) t, primary_peer_group_id::text p FROM ticker_registry`)).rows.map((r) => [r.t, r.p]));
  const er = new Map<string, string[]>();
  for (const r of (await pool.query(`SELECT ticker, report_date::text d FROM lseg_research.earnings_moves
       UNION SELECT ticker, event_date::text FROM lseg_research.events WHERE event_type = 'EarningsReleases' ORDER BY 2`)).rows) {
    if (!er.has(r.ticker)) er.set(r.ticker, []);
    er.get(r.ticker)!.push(r.d);
  }
  const spy = hist.get("SPY") ?? [];
  const spyIdx = new Map(spy.map((b, i) => [b.d, i]));
  const dates = sampleDates(spy.map((b) => b.d));
  const names = tick.filter((t) => !ETFS.has(t));
  console.log(`lab_tech: ${names.length} tickers · ${dates.length} ${FREQ} dates ${dates[0]} → ${dates.at(-1)} · window ${WINDOW} · engine ${ENGINE_DIGEST}`);

  let written = 0;
  for (const asOf of dates) {
    const si = spyIdx.get(asOf)!;
    const spyRet = si >= 20 ? (spy[si].c / spy[si - 20].c - 1) * 100 : null;
    const trs: TechnicalRow[] = [];
    const inputs = new Map<string, Record<string, unknown>>();
    for (const t of names) {
      const bars = hist.get(t);
      if (!bars) continue;
      let i = -1;
      for (let k = bars.length - 1; k >= 0; k--) if (bars[k].d <= asOf) { i = k; break; }
      if (i < 0 || Date.parse(asOf) - Date.parse(bars[i].d) > 5 * 86400000) continue;   // no fresh bar at this date
      const win = bars.slice(Math.max(0, i - WINDOW + 1), i + 1);
      if (win.length < WINDOW * 0.97) continue;   // need a near-full window for the engine's own-history percentiles
      const o = computeFromOHLCV(win.map((b) => b.c), win.map((b) => b.h), win.map((b) => b.l), win.map((b) => b.v));
      const iv = bars[i].iv;
      const rv = o.realizedVol20d;
      const ivHist = bars.slice(Math.max(0, i - 252), i).map((b) => b.iv ?? NaN);
      const nextEr = (er.get(t) ?? []).find((d) => d >= asOf);
      const edo = nextEr ? Math.round((Date.parse(nextEr + "T12:00:00Z") - Date.parse(asOf + "T12:00:00Z")) / 86400000) : null;
      const tRet = i >= 20 ? (bars[i].c / bars[i - 20].c - 1) * 100 : null;
      const row: any = {
        ...o, ticker: t, technicalsCoverage: null,
        atmPutIv: iv, ivVsRealizedVol: iv != null && rv != null && rv > 0 ? Math.round((iv / rv) * 100) / 100 : null,
        ivRankEffective: iv != null ? pctRank(iv, ivHist, 10) : null,
        putCallVolumeRatio: null, basicSkew: null, ivTermStructure: null, impliedMoveWeekly: iv != null ? iv / 100 / Math.sqrt(52) : null,
        earningsDaysOut: edo, peerGroupId: peer.get(t) ?? null, analystUpside: null, shortRatio: null,
        vsSpy20d: tRet != null && spyRet != null ? Math.round((tRet - spyRet) * 100) / 100 : null,
      };
      if (VARIANT === "ivhist" && row.ivRankEffective != null) row.ivRank = row.ivRankEffective;
      trs.push(row as TechnicalRow);
      inputs.set(t, {
        close: bars[i].c, rsi14: o.rsi14, rsi14Pct: o.rsi14Pct, mfi14Pct: o.mfi14Pct, stochPct: o.stochPct, macdDirection: o.macdDirection,
        rsiVelocity: o.rsiVelocity, volumeRatioPct: o.volumeRatioPct, realizedVol20d: rv, ivRankRvProxy: o.ivRank, bbWidthPct: o.bbWidthPct,
        priceZScore: o.priceZScore, priceVsMa50Atr: o.priceVsMa50Atr, priceVsMa200Atr: o.priceVsMa200Atr, priceVsVwapPct: o.priceVsVwapPct,
        nearestSupportDistPct: o.nearestSupportDistPct, nearestResistDistPct: o.nearestResistDistPct, regime: o.regime, fallingKnife: o.fallingKnife,
        atmPutIv: iv, ivVsRealizedVol: row.ivVsRealizedVol, ivRankEffective: row.ivRankEffective, earningsDaysOut: edo, vsSpy20d: row.vsSpy20d,
        peerGroupId: row.peerGroupId,
      });
    }
    if (!trs.length) continue;
    const v4 = { put: computeTechnicalRankingsV2(trs, {}, undefined, "put"), call: computeTechnicalRankingsV2(trs, {}, undefined, "call") };
    const byT = { put: new Map(v4.put.map((s) => [s.ticker, s])), call: new Map(v4.call.map((s) => [s.ticker, s])) };
    const vals: unknown[] = [];
    const ph: string[] = [];
    for (const r of trs) {
      const comps: Record<string, number | null> = {};
      for (const k of V2_KEYS) {
        const s = scoreTechnicalRowV2(r as any, Object.fromEntries(V2_KEYS.map((x) => [x, x === k ? 1 : 0])) as any);
        comps[k] = s != null && Number.isFinite(s) ? s / 100 : null;
      }
      const pack = (s: any) => s ? { total: s.totalScore, signal: s.gateStatus ?? s.signal,
        comps: Object.fromEntries(Object.entries(s.componentScores ?? {}).map(([k, v]: any) => [k, v.score])) } : null;
      const n = vals.length;
      ph.push(`($${n + 1},$${n + 2},$${n + 3},$${n + 4},$${n + 5},$${n + 6},$${n + 7},$${n + 8})`);
      vals.push(r.ticker, asOf, ENGINE_DIGEST, WINDOW, JSON.stringify(inputs.get(r.ticker)),
        JSON.stringify({ total: scoreTechnicalRowV2(r as any), comps }), JSON.stringify(pack(byT.put.get(r.ticker))), JSON.stringify(pack(byT.call.get(r.ticker))));
    }
    await pool.query(`INSERT INTO watchlist_sync.lab_tech (ticker, as_of, engine_digest, window_bars, inputs, v2, v4_put, v4_call)
      VALUES ${ph.join(",")} ON CONFLICT (ticker, as_of, engine_digest) DO UPDATE SET inputs = EXCLUDED.inputs, v2 = EXCLUDED.v2,
      v4_put = EXCLUDED.v4_put, v4_call = EXCLUDED.v4_call, window_bars = EXCLUDED.window_bars, computed_at = now()`, vals);
    written += trs.length;
  }
  console.log(`lab_tech: ${written} rows written (engine ${ENGINE_DIGEST})`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
