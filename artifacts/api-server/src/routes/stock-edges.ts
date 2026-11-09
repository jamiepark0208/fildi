/**
 * Breakdown › "Rules firing today" (Jamie 11-08: ship proven edges into the app; spec research/common/edge-surfaces.md).
 * GET /api/stocks/:ticker/edges — read-only, DB only. Every row comes from a table another surface already shows, so the
 * strip can never disagree with it:
 *   model_items (latest run)  → Model List lanes sell_puts / rich_puts / sell_calls (same rows the Model List renders)
 *   put_recs_daily (latest)   → band engine decision when the name is not a Model List put (why not a pick)
 *   put_ladder (latest)       → Rankings › Ladder picks with P(kept) ≥ 90 % (S088)
 *   strategy_signals (open)   → Strategy Library signals (panic puts S054 …) + their live graded record
 *   long_option_board (latest)→ Rankings › Long options arms holding this name + forward paper record
 * record.kind says what the number is: "backtest" (study / real-quote history) or "live" (graded forward rows). Never
 * re-computed here — copied from the producer's payload or counted from the live log.
 */
import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { TTLCache } from "../lib/ttl-cache.js";

const router = Router();

export interface EdgeRecord {
  kind: "backtest" | "live";
  n: number | null;
  hitPct: number | null;   // kept % (puts) / win % (calls)
  bpWk?: number | null;
  open?: number | null;
  note?: string;
}

export interface EdgeRow {
  rule: string;
  study: string | null;
  side: "sell put" | "sell call" | "buy call" | "buy put";
  status: "pick" | "shadow" | "signal" | "paper" | "gated";
  rank: number | null;
  of: number | null;
  strike: number | null;
  expiry: string | null;
  premium: number | null;
  why: string | null;
  blocked: string | null;
  asOf: string | null;
  record: EdgeRecord | null;
}

type Obj = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v !== "" && Number.isFinite(+v) ? +v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const rowsOf = async (q: ReturnType<typeof sql>): Promise<Obj[]> => {
  try { return (await db.execute(q)).rows as Obj[]; } catch (err) { logger.warn({ err }, "stock-edges query failed"); return []; }
};

const cache = new TTLCache<{ ticker: string; edges: EdgeRow[] }>(5 * 60_000, "stock-edges", 500);

const LANE: Record<string, { rule: string; study: string; side: EdgeRow["side"] }> = {
  sell_puts: { rule: "Model List put", study: "S047/S088 · S101 band", side: "sell put" },
  rich_puts: { rule: "Rich-put lane", study: "S109", side: "sell put" },
  sell_calls: { rule: "Covered call", study: "S046", side: "sell call" },
};

export async function buildEdges(t: string): Promise<EdgeRow[]> {
  const [items, recs, ladder, sigs, board] = await Promise.all([
    rowsOf(sql`
      WITH run AS (SELECT MAX(id) AS id FROM watchlist_sync.model_runs)
      SELECT i.folder_key, i.rank, i.status, i.why, i.contract, r.created_at::date::text AS as_of,
             (SELECT COUNT(*) FROM watchlist_sync.model_items c WHERE c.run_id = i.run_id AND c.folder_key = i.folder_key)::int AS of
      FROM watchlist_sync.model_items i JOIN watchlist_sync.model_runs r ON r.id = i.run_id
      WHERE i.run_id = (SELECT id FROM run) AND i.ticker = ${t} AND i.folder_key IN ('sell_puts', 'rich_puts', 'sell_calls')`),
    rowsOf(sql`
      SELECT as_of::text AS as_of, pass, payload FROM watchlist_sync.put_recs_daily
      WHERE ticker = ${t} AND as_of = (SELECT MAX(as_of) FROM watchlist_sync.put_recs_daily)`),
    rowsOf(sql`SELECT as_of::text AS as_of, payload FROM watchlist_sync.put_ladder ORDER BY as_of DESC LIMIT 1`),
    rowsOf(sql`
      WITH lib AS (SELECT DISTINCT ON (strategy_id) strategy_id, name, status, study_ref
                   FROM watchlist_sync.strategies ORDER BY strategy_id, version DESC),
           rec AS (SELECT strategy_id, COUNT(*) FILTER (WHERE ret IS NOT NULL)::int AS n,
                          COUNT(*) FILTER (WHERE ret > 0)::int AS wins,
                          COUNT(*) FILTER (WHERE status = 'open')::int AS open
                   FROM watchlist_sync.strategy_signals GROUP BY 1)
      SELECT s.strategy_id, s.as_of::text AS as_of, s.trigger, s.strike, s.expiry::text AS expiry, s.entry_mid,
             lib.name, lib.status AS lib_status, lib.study_ref, rec.n, rec.wins, rec.open
      FROM watchlist_sync.strategy_signals s
      LEFT JOIN lib USING (strategy_id) LEFT JOIN rec USING (strategy_id)
      WHERE s.ticker = ${t} AND s.status = 'open'
        AND s.as_of >= (SELECT MAX(as_of) FROM watchlist_sync.strategy_signals) - 3
      ORDER BY s.as_of DESC`),
    rowsOf(sql`SELECT as_of::text AS as_of, payload FROM watchlist_sync.long_option_board ORDER BY as_of DESC LIMIT 1`),
  ]);

  const out: EdgeRow[] = [];
  const rec = recs[0];
  const recPl = (rec?.payload ?? {}) as Obj;

  // A. Model List lanes — the exact rows the Model List shows.
  for (const it of items) {
    const lane = LANE[String(it.folder_key)];
    if (!lane) continue;
    const c = (it.contract ?? {}) as Obj;
    const why = Array.isArray(it.why) ? (it.why as unknown[]).map(String) : [];
    const block = why.find((w) => w.startsWith("Engine blocks:"));
    let record: EdgeRecord | null = null;
    if (it.folder_key === "rich_puts") {
      const tr = ((c.rich as Obj | undefined)?.tier_record ?? null) as Obj | null;
      if (tr) record = { kind: "backtest", n: num(tr.n), hitPct: num(tr.kept), bpWk: num(tr.bp_wk), note: `tier ${str(tr.name) ?? "?"}, real quotes; worst-5 % week ${num(tr.w5)} bp` };
    } else if (it.folder_key === "sell_puts" && rec) {
      const k = num(recPl.hist_kept);
      record = { kind: "backtest", n: null, hitPct: k == null ? null : Math.round(k * 1000) / 10, bpWk: num(recPl.hist_bp) == null ? null : Math.round(num(recPl.hist_bp)!), note: str(recPl.why) ?? undefined };
    }
    out.push({
      ...lane,
      status: it.status === "shadow" ? "shadow" : "pick",
      rank: num(it.rank), of: num(it.of),
      strike: num(c.strike), expiry: str(c.expiry), premium: num(c.premium),
      why: why[0] ?? null, blocked: block ? block.replace(/^Engine blocks:\s*/, "") : null,
      asOf: str(it.as_of), record,
    });
  }

  // B. Band engine: say why it is not a Model List put today (or that it passes but is not published yet).
  if (rec && !items.some((i) => i.folder_key === "sell_puts")) {
    const gates = Array.isArray(recPl.gates) ? (recPl.gates as unknown[]).map(String) : [];
    out.push({
      rule: "Put band engine", study: "S047/S101", side: "sell put",
      status: rec.pass ? "pick" : "gated", rank: num(recPl.rank), of: null,
      strike: num(recPl.strike), expiry: str(recPl.expiry), premium: num(recPl.bid),
      why: str(recPl.why), blocked: rec.pass ? null : gates[0] ?? "not in the top list", asOf: str(rec.as_of),
      record: num(recPl.hist_kept) == null ? null : { kind: "backtest", n: null, hitPct: Math.round(num(recPl.hist_kept)! * 1000) / 10, bpWk: num(recPl.hist_bp) == null ? null : Math.round(num(recPl.hist_bp)!) },
    });
  }

  // C. Rankings › Ladder: best P(kept) ≥ 90 % pick for this name across horizons/bands.
  const lad = ladder[0];
  if (lad) {
    const hz = (((lad.payload as Obj)?.horizons ?? {}) as Record<string, Array<{ band?: string; picks?: Obj[] }>>);
    let best: { h: string; band: string; p: Obj; of: number } | null = null;
    for (const [h, bands] of Object.entries(hz)) for (const b of bands ?? []) for (const p of b.picks ?? []) {
      if (p.ticker !== t || (num(p.pKept) ?? 0) < 0.9) continue;
      if (!best || (num(p.expPnlBpWk) ?? -1e9) > (num(best.p.expPnlBpWk) ?? -1e9)) best = { h, band: String(b.band ?? ""), p, of: (b.picks ?? []).length };
    }
    if (best) {
      const p = best.p;
      out.push({
        rule: `Put ladder ${best.h}`, study: "S088", side: "sell put", status: "pick",
        rank: null, of: null, strike: num(p.strike), expiry: null, premium: num(p.credit),
        why: `${best.band}Δ · P(kept) ${Math.round((num(p.pKept) ?? 0) * 100)} % · ${num(p.creditPctWk)?.toFixed(2)} %/wk${p.earningsInWindow ? " · earnings in window" : ""}`,
        blocked: null, asOf: str(lad.as_of),
        record: { kind: "backtest", n: null, hitPct: Math.round((num(p.pKept) ?? 0) * 1000) / 10, bpWk: num(p.expPnlBpWk) == null ? null : Math.round(num(p.expPnlBpWk)!) },
      });
    }
  }

  // D. Strategy Library signals (open) + live graded record from the same log.
  const seen = new Set<string>();
  for (const s of sigs) {
    const id = String(s.strategy_id);
    if (seen.has(id) || s.name == null) continue;   // not in the Strategy Library = unproven paper id → not a rule
    seen.add(id);
    const n = num(s.n) ?? 0, wins = num(s.wins) ?? 0;
    out.push({
      rule: str(s.name) ?? id, study: str(s.study_ref), side: "sell put",
      status: s.lib_status === "live" ? "signal" : "paper",
      rank: null, of: null, strike: num(s.strike), expiry: str(s.expiry), premium: num(s.entry_mid),
      why: str(s.trigger), blocked: null, asOf: str(s.as_of),
      record: { kind: "live", n, hitPct: n ? Math.round((1000 * wins) / n) / 10 : null, open: num(s.open), note: n ? undefined : "no graded signals yet" },
    });
  }

  // E. Rankings › Long options: one row per side, listing the arms (S085/S086 board) that hold this name.
  const b = board[0];
  const strategies = (((b?.payload as Obj)?.strategies ?? []) as Obj[]);
  for (const leg of ["call", "put"] as const) {
    const hits: { arm: string; x: Obj; idx: number; of: number; fw: Obj | null }[] = [];
    for (const st of strategies) {
      const names = (((st[leg] as Obj | undefined)?.names ?? []) as Obj[]);
      const idx = names.findIndex((x) => x.ticker === t);
      if (idx >= 0) hits.push({ arm: str(st.name) ?? "arm", x: names[idx], idx, of: names.length, fw: (st.forward ?? null) as Obj | null });
    }
    if (!hits.length) continue;
    const x = hits[0].x;
    const fws = hits.map((h) => h.fw).filter((f): f is Obj => !!f);
    const n = fws.reduce((a, f) => a + (num(f.n) ?? 0), 0), wins = fws.reduce((a, f) => a + (num(f.wins) ?? 0), 0);
    const open = fws.reduce((a, f) => a + (num(f.open) ?? 0), 0);
    out.push({
      rule: `Long-${leg} board`, study: "S085/S086", side: leg === "call" ? "buy call" : "buy put",
      status: "paper", rank: null, of: strategies.length,
      strike: num(x.strike), expiry: str((b?.payload as Obj)?.expiry), premium: num(x.debit),
      why: `on ${hits.length} of ${strategies.length} arms: ${hits.map((h) => `${h.arm} #${h.idx + 1}`).join(", ")} · debit ${str(x.src) ?? "?"} · breakeven +${((num(x.breakeven) ?? 0) * 100).toFixed(1)} %`,
      blocked: null, asOf: str(b?.as_of),
      record: fws.length ? { kind: "live", n, hitPct: n ? Math.round((1000 * wins) / n) / 10 : null, open, note: n ? "these arms' forward paper record" : "forward record not graded yet" } : null,
    });
  }
  return out;
}

// GET /api/stocks/:ticker/edges — mounted before stocksRouter.
router.get("/stocks/:ticker/edges", async (req, res) => {
  const t = String(req.params.ticker ?? "").toUpperCase();
  if (!/^[A-Z0-9.\-^]{1,12}$/.test(t)) return res.status(400).json({ error: "bad ticker" });
  try {
    return res.json(await cache.getOrCompute(t, async () => ({ ticker: t, edges: await buildEdges(t) })));
  } catch (err) {
    logger.warn({ err, t }, "stock-edges failed");
    return res.json({ ticker: t, edges: [] });
  }
});

export default router;
