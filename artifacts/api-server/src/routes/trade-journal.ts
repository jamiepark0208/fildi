/**
 * GET /api/trade-journal?days=90 (A393). Admin. Every filled order + what Fildi said that day, graded.
 * Stored data only (portfolio_orders, put_recs_daily, model_items, prices_historical); no vendor calls.
 * Grading ports scripts/rec_scoreboard.py via lib/trade-journal.ts (one home: the Python CLI stays the agent view).
 */
import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireAdmin } from "../middleware/requireAdmin.js";
import {
  buildJournal, gradeOption, summarize,
  type Bar, type JournalOrder, type PriceMap, type JournalRow,
} from "../lib/trade-journal.js";

const router = Router();
type SqlRows<T> = T[] | { rows?: T[] };
const rowsOf = <T,>(r: SqlRows<T>): T[] => (Array.isArray(r) ? r : r.rows ?? []);

interface OrderRow {
  order_id: string; at: string; day: string; account: string; symbol: string; is_option: boolean;
  option_side: string | null; strike: string | null; expiry: string | null; side: string;
  leg_effect: string | null; qty: string; px: string | null; fees: string | null;
}
interface RecRow { as_of: string; ticker: string; pass: boolean; payload: Record<string, unknown> }

const num = (v: unknown): number | null => {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

export function fildiSaid(rec: RecRow | undefined, lists: string[] | undefined, optionSide: "put" | "call" | null = "put"): string {
  // 11-10 review: lists deduped; the engine only judges short puts → label it on call/stock trades
  const ml = lists?.length ? ` · list: ${[...new Set(lists)].join(", ")}` : "";
  const eng = optionSide === "put" ? "engine" : "put engine";
  if (!rec) return `${eng}: not scanned${ml}`;
  const p = rec.payload ?? {};
  if (rec.pass) {
    const d = num(p.delta), k = num(p.strike);
    return `${eng}: pass${d != null ? ` ${Math.abs(d).toFixed(2)}Δ` : ""}${k != null ? ` $${k} strike` : ""}${ml}`;
  }
  const gates = Array.isArray(p.gates) ? (p.gates as unknown[]).map(String) : [];
  let g = gates[0] ?? "ranked out";
  if (g.startsWith("no listed put")) g = `no liquid put in the ${String(p.band_target ?? "target")}Δ band`;
  else if (g.length > 90) g = `${g.slice(0, g.lastIndexOf(" ", 90))}…`;
  return `${eng}: no — ${g}${ml}`;
}

router.get("/trade-journal", requireAdmin, async (req, res, next) => {
  try {
    const days = Math.min(730, Math.max(7, Number(req.query.days) || 90));
    const orders = rowsOf<OrderRow>(
      (await db.execute(sql`
        SELECT * FROM (
          SELECT DISTINCT ON (order_id) order_id, created_at::text AS at,
                 (created_at AT TIME ZONE 'America/New_York')::date::text AS day,
                 account, symbol, COALESCE(is_option, false) AS is_option, option_side,
                 option_strike::text AS strike, option_expiration::text AS expiry, side, leg_effect,
                 COALESCE(NULLIF(cumulative_qty, 0), quantity)::text AS qty, avg_fill_price::text AS px, fees::text AS fees
          FROM portfolio_orders
          WHERE state = 'filled' AND order_id IS NOT NULL
            AND (created_at >= now() - make_interval(days => ${days})
                 OR (is_option AND option_expiration >= (now() - make_interval(days => ${days}))::date))
          ORDER BY order_id, id DESC
        ) o ORDER BY at
      `)) as unknown as SqlRows<OrderRow>,
    );
    const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
    const journalOrders: JournalOrder[] = orders
      .filter((o) => num(o.px) != null && num(o.qty))
      .map((o) => ({
        orderId: o.order_id, at: o.at, day: o.day, account: o.account, symbol: o.symbol, isOption: o.is_option,
        optionSide: o.option_side === "put" || o.option_side === "call" ? o.option_side : null,
        strike: num(o.strike), expiry: o.expiry, side: o.side,
        legEffect: o.leg_effect === "open" || o.leg_effect === "close" ? o.leg_effect : null,
        qty: num(o.qty) ?? 0, px: num(o.px) ?? 0, fees: num(o.fees),
      }));

    const recs = rowsOf<RecRow>(
      (await db.execute(sql`
        SELECT as_of::text AS as_of, ticker, pass, payload FROM watchlist_sync.put_recs_daily
        WHERE as_of >= ${since}::date - 4
      `)) as unknown as SqlRows<RecRow>,
    );
    const engPass = recs.filter((r) => r.pass);
    const names = Array.from(new Set([...journalOrders.map((o) => o.symbol), ...engPass.map((r) => r.ticker)]));
    const pxRows = rowsOf<{ t: string; d: string; c: string; lo: string }>(
      (await db.execute(sql`
        SELECT ticker AS t, date::text AS d, close::text AS c, low::text AS lo FROM prices_historical
        WHERE date >= ${since}::date - 40 AND ticker = ANY(${sql.raw(`ARRAY[${names.map((n) => `'${n.replace(/[^A-Za-z0-9.\-^]/g, "")}'`).join(",") || "''"}]::text[]`)})
        ORDER BY ticker, date
      `)) as SqlRows<never>,
    );
    const prices: PriceMap = new Map();
    for (const r of pxRows) {
      const arr = prices.get(r.t) ?? [];
      arr.push({ date: r.d, close: Number(r.c), low: Number(r.lo) } as Bar);
      prices.set(r.t, arr);
    }

    // Model List: latest run on/before each day -> folders holding the ticker
    const runs = rowsOf<{ id: string; d: string }>(
      (await db.execute(sql`
        SELECT id::text AS id, (created_at AT TIME ZONE 'America/New_York')::date::text AS d
        FROM watchlist_sync.model_runs WHERE created_at >= now() - make_interval(days => ${days + 14}) ORDER BY created_at
      `)) as SqlRows<never>,
    );
    const items = runs.length
      ? rowsOf<{ run_id: string; ticker: string; folder_key: string }>(
          (await db.execute(sql`
            SELECT run_id::text AS run_id, ticker, folder_key FROM watchlist_sync.model_items
            WHERE run_id = ANY(${sql.raw(`ARRAY[${runs.map((r) => Number(r.id)).join(",")}]::bigint[]`)})
              AND ticker = ANY(${sql.raw(`ARRAY[${Array.from(new Set(journalOrders.map((o) => o.symbol))).map((n) => `'${n.replace(/[^A-Za-z0-9.\-^]/g, "")}'`).join(",") || "''"}]::text[]`)})
              AND folder_key NOT IN ('watch', 'avoid', 'context')
          `)) as SqlRows<never>,
        )
      : [];
    const listBy = new Map<string, string[]>(); // runId|ticker -> folders
    for (const it of items) {
      const k = `${it.run_id}|${it.ticker}`;
      listBy.set(k, [...(listBy.get(k) ?? []), it.folder_key]);
    }
    const runFor = (day: string) => [...runs].reverse().find((r) => r.d <= day)?.id;

    const recBy = new Map<string, RecRow>();
    for (const r of recs) recBy.set(`${r.ticker}|${r.as_of}`, r);

    const all = buildJournal(journalOrders, prices);
    const out = all.filter((r) => r.at.slice(0, 10) >= since || r.day >= since);
    const enriched = out.map((r) => {
      const rec = recBy.get(`${r.symbol}|${r.day}`);
      const run = runFor(r.day);
      const p = rec?.payload ?? {};
      const tag = rec ? [p.market_state, p.stock_state].filter(Boolean).join("/") || "—" : "—";
      return { ...r, fildi: fildiSaid(rec, run ? listBy.get(`${run}|${r.symbol}`) : undefined, r.optionSide), tag };
    });

    // Jamie vs engine, same window (port of rec_scoreboard.py)
    const jamieOpens = out.filter((r) => r.kind === "option" && r.optionSide === "put" && r.side === "credit" && r.legEffect === "open");
    const jamieG = jamieOpens.map((r) => gradeOption({ optionSide: "put", strike: r.strike, expiry: r.expiry, px: r.px, day: r.day, short: true }, prices.get(r.symbol)))
      .filter((g) => g.retPct != null).map((g) => g.retPct as number);
    const engG = engPass.filter((r) => r.as_of >= since).map((r) => {
      const p = r.payload; const bid = num(p.bid), ask = num(p.ask);
      if (bid == null || ask == null) return null;
      return gradeOption({ optionSide: "put", strike: num(p.strike), expiry: typeof p.expiry === "string" ? p.expiry : null, px: bid + 0.1 * (ask - bid), day: r.as_of, short: true }, prices.get(r.ticker), num(p.spot)).retPct;
    }).filter((x): x is number => x != null);
    const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

    const tags = Array.from(new Set(enriched.map((r) => r.tag)));
    const asJ = enriched as unknown as JournalRow[];
    res.json({
      days, count: enriched.length,
      summary: {
        ...summarize(asJ),
        byTag: tags.map((t) => ({ tag: t, ...summarize(asJ, (r) => (r as unknown as { tag: string }).tag === t) })),
        jamiePuts: { n: jamieG.length, avgPct: mean(jamieG) },
        enginePass: { n: engG.length, avgPct: mean(engG) },
      },
      rows: enriched.reverse(),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
