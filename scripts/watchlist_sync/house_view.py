"""House view (Claude 10-19, Jamie: "express a view, forward expectations as probabilities, evals throughout").
Daily, after publish. Script only, no AI. Every number is either a tested probability or labelled context.

  1. Index odds (S057, SPY, next 21 trading days) → forecast ledger, graded by Brier like every other forecaster:
       base_rate        unconditional rate (S057: direction has no skill beyond it → the view's direction IS the base rate)
       s057_logit       VIX z / drawdown / below-200d / 5-day z / credit — beat the market's own tail odds (+0.205 skill, CI > 0)
       market_vix       risk-neutral barrier odds from VIX (S057: ~2× too high → the put premium on the index is rich)
  2. Context (not forecasts): sector drawdowns, panic-put breadth (S049/S054), credit_wide (S028), catalysts on the book.
  3. Coherence gate on the latest published plan: stale plan, trim ∩ sell-puts, panic breadth with 0 live puts.
Writes watchlist_sync.house_view (one row/day) + out/house_view/<date>.md. Never fails the pipeline.

    .venv/bin/python house_view.py [--no-log]
"""
from __future__ import annotations

import json
import math
import sys
from datetime import date, datetime
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "analysis"))
import rules as R  # noqa: E402
from build_plan import connect, rows  # noqa: E402

PT_TICKER = "SPY"
SECTORS = ["SPY", "QQQ", "IWM", "SMH", "XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLP", "XLU"]
DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.house_view (
  view_date date PRIMARY KEY, view jsonb NOT NULL, memo text NOT NULL, warnings jsonb NOT NULL DEFAULT '[]', created_at timestamptz DEFAULT now())"""


def index_odds():
    import s057_market_view as V
    V.refresh_gspc()
    P = V.panel()
    lab = [r for r in P if r["y"]]
    X = np.array([[r[f] for f in V.FEATS] for r in lab])
    t = P[-1]
    xt = np.array([[t[f] for f in V.FEATS]])
    out = {"as_of": str(t["d"]), "vix": t["vix"], "features": {f: round(t[f], 3) for f in V.FEATS}}
    for tgt in ("up", "tail"):
        y = np.array([r["y"][tgt] for r in lab])
        out[tgt] = {"base_rate": float(y.mean()), "s057_logit": float(V.pred(V.fit(X, y), xt)[0])}
    out["tail"]["market_vix"] = 2 * V.N.cdf(math.log(V.TAIL) / (t["vix"] / 100 * math.sqrt(V.H / 252)))
    return out


def log_forecasts(conn, odds, made_on):
    from forecast_ledger import UPSERT
    sc = rows(conn, "SELECT date, close::float8 c FROM lseg_research.daily_history WHERE ticker = %s ORDER BY date DESC LIMIT 1", (PT_TICKER,))[0]
    res = np.busday_offset(sc["date"], 21, roll="forward").astype(date)
    n = 0
    for tgt, qtype, q in (("up", "index_up_21d", f"Will {PT_TICKER} close {res} above its {sc['date']} close ({sc['c']:.2f})?"),
                          ("tail", "index_tail_21d", f"Will {PT_TICKER} close ≥ 5 % below {sc['c']:.2f} on any day through {res}?")):
        for fc, p in odds[tgt].items():
            meta = {"from": str(sc["date"]), "start_close": sc["c"], "kind": tgt, "study": "S057"}
            conn.execute(UPSERT, (f"{qtype}:{PT_TICKER}:{sc['date']}", q, qtype, PT_TICKER, fc, round(p, 4), datetime.now(), made_on, res,
                                  json.dumps(meta)))
            n += 1
    return n


def context(conn):
    dd = {}
    for t in SECTORS:
        c = [r["c"] for r in rows(conn, """SELECT close::float8 c FROM lseg_research.daily_history WHERE ticker = %s
                                          ORDER BY date DESC LIMIT 63""", (t,))]
        if len(c) >= 20:
            dd[t] = {"off_63d_high": round(100 * (c[0] / max(c) - 1), 1), "ret_5d": round(100 * (c[0] / c[5] - 1), 1)}
    last = conn.execute("SELECT MAX(as_of) FROM watchlist_sync.strategy_signals WHERE strategy_id = 'panic-puts-hiv'").fetchone()[0]
    sig = rows(conn, "SELECT ticker, details->>'peer_group' g FROM watchlist_sync.strategy_signals WHERE as_of = %s", (last,)) if last else []
    groups: dict[str, int] = {}
    for s in sig:
        groups[s["g"] or "?"] = groups.get(s["g"] or "?", 0) + 1
    credit = None
    try:
        from s028_macro_stress import series
        bd, bv = series("BAA10Y")
        win = sorted(bv[-252:])
        credit = {"baa10y": bv[-1], "p80_1y": win[int(0.8 * (len(win) - 1))], "wide": bv[-1] > win[int(0.8 * (len(win) - 1))], "as_of": str(bd[-1])}
    except Exception as e:  # noqa: BLE001
        credit = {"error": str(e)[:80]}
    book = rows(conn, """SELECT DISTINCT UPPER(symbol) t FROM portfolio_positions WHERE snapshot_id = (SELECT MAX(id) FROM portfolio_snapshots)
                         UNION SELECT DISTINCT UPPER(symbol) FROM portfolio_options WHERE snapshot_id = (SELECT MAX(id) FROM portfolio_snapshots)
                           AND expiration >= CURRENT_DATE""")
    names = [b["t"] for b in book]
    er = rows(conn, """SELECT ticker, MIN(d) d FROM (SELECT ticker, event_date d FROM lseg_research.events WHERE event_type = 'EarningsReleases'
                         AND event_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 14
                       UNION ALL SELECT UPPER(ticker), report_date::date FROM earnings_calendar WHERE report_date::date BETWEEN CURRENT_DATE AND CURRENT_DATE + 14) x
                       WHERE ticker = ANY(%s) GROUP BY 1 ORDER BY 2""", (names,))
    return {"drawdowns": dd, "panic": {"as_of": str(last), "n": len(sig), "groups": dict(sorted(groups.items(), key=lambda x: -x[1])[:6])},
            "credit": credit, "earnings_14d": [f"{r['ticker']} {r['d']}" for r in er]}


def coherence(conn, ctx, plan_id=None):
    warn = []
    run = rows(conn, "SELECT id, created_at, close_date FROM watchlist_sync.plans WHERE id = COALESCE(%s, (SELECT MAX(id) FROM watchlist_sync.plans))",
               (plan_id,))[0]
    if R.trading_days_between(run["close_date"], R.last_close_date()) > 0:
        warn.append(f"STALE: latest plan #{run['id']} is for close {run['close_date']}, last close {R.last_close_date()} (a step failed?)")
    items = rows(conn, """SELECT list_key, ticker, verify_status FROM watchlist_sync.plan_items WHERE plan_id = %s AND l1_pass""", (run["id"],))
    trim = {i["ticker"] for i in items if i["list_key"] == "trim_risk"}
    puts = {i["ticker"] for i in items if i["list_key"] == "sell_puts"}
    if trim & puts:
        warn.append(f"CONTRADICTION: trim and sell-puts on {sorted(trim & puts)}")
    live = [i for i in items if i["list_key"] == "sell_puts" and i["verify_status"] in ("pass", "pass_after_hours")]
    pending = [i for i in items if i["list_key"] == "sell_puts" and i["verify_status"] == "pending"]
    if pending and not live:
        warn.append(f"UNVERIFIED: plan #{run['id']} has {len(pending)} puts awaiting the live quote check (verify step not run)")
    elif ctx["panic"]["n"] >= 5 and not live:
        warn.append(f"ANOMALY: {ctx['panic']['n']} panic-put signals but 0 puts pass live checks — read the plan's blockers")
    return warn, {"plan": run["id"], "puts_live": len(live), "trim": sorted(trim)}


def memo(today, odds, ctx, warn, lists):
    up, tl = odds["up"], odds["tail"]
    rich = tl["market_vix"] / max(tl["s057_logit"], 1e-6)
    dd = ctx["drawdowns"]
    worst = sorted(dd.items(), key=lambda x: x[1]["off_63d_high"])[:4]
    lines = [f"# House view {today}", "",
             f"**Index (SPY, next 21 trading days; S057 as of {odds['as_of']}, VIX {odds['vix']:.1f}).** "
             f"P(up) {up['s057_logit']:.0%} vs base {up['base_rate']:.0%} — direction has no tested edge, read it as the base rate. "
             f"P(another −5 % leg) {tl['s057_logit']:.0%} (base {tl['base_rate']:.0%}); the market prices {tl['market_vix']:.0%} "
             f"→ index put premium ≈ {rich:.1f}× the history-calibrated risk.",
             "",
             "**Where the stress is (off 63-day high / 5-day).** " + " · ".join(f"{t} {v['off_63d_high']:+.1f} % / {v['ret_5d']:+.1f} %" for t, v in worst),
             f"**Panic-put breadth (S049/S054, {ctx['panic']['as_of']}).** {ctx['panic']['n']} names; by group " +
             ", ".join(f"{g.split('.')[-1]} {n}" for g, n in ctx["panic"]["groups"].items()),
             f"**Credit (S028).** " + (f"Baa−10y {ctx['credit']['baa10y']:.2f} vs 1-y 80th pct {ctx['credit']['p80_1y']:.2f} → "
                                      f"{'WIDE: drawdown warning, size down' if ctx['credit']['wide'] else 'normal'}" if "baa10y" in ctx["credit"] else "n/a"),
             f"**Catalysts on your book (14 days).** " + (", ".join(ctx["earnings_14d"]) or "none"),
             f"**Options board check (Focus = put edge Q4–Q5).** {ctx.get('board_check', 'n/a')}",
             "**Today's put picks (the engine — same strike and order as Model List, Rankings, Live).** " +
             (", ".join(f"{e['ticker']} {e['strike']:g}p {e['expiry'][5:]} ({e['income_wk_pct']:.2f} %/wk, {e['market_state']})"
                        for e in ctx.get("engine_top", [])) or "n/a"),
             "",
             "**Stance (rules, not vibes).** " +
             ("Credit wide → cut new put size; " if ctx["credit"].get("wide") else "") +
             (f"premium rich ({rich:.1f}×) and tail odds ≤ base → sell puts, sized and spread (≤ 2 per peer group); " if rich > 1.5 and tl["s057_logit"] <= tl["base_rate"] else
              "tail odds above base → smaller new puts, prefer panic-put names with IV > 48.7; ") +
             "trim only distress/estimate-cut names (falling knife is not a reason, S058).",
             f"**Published list (plan #{lists['plan']}).** {lists['puts_live']} puts pass live checks · trim {', '.join(lists['trim']) or 'none'}.",
             "", "**Coherence gate.** " + ("; ".join(warn) if warn else "ok"),
             "", "_Graded: index odds go to the forecast ledger (Brier vs base and market, Settings › Forecasts). Studies: S057, S058, S049/S054, S028._"]
    return "\n".join(lines)


def main():
    today = date.today()
    with connect() as conn:
        conn.execute(DDL)
        odds = index_odds()
        n = 0 if "--no-log" in sys.argv else log_forecasts(conn, odds, today)
        ctx = context(conn)
        warn, lists = coherence(conn, ctx)
        import put_edge
        edge = put_edge.scores(conn)
        put_edge.persist(conn, edge)
        n_sim = 0 if "--no-log" in sys.argv else put_edge.log_sim(conn, edge)
        warn += put_edge.drift(conn)
        if put_edge.set_status(conn, warn):
            warn.append("ENFORCED: put edge demoted — Model List and Options Focus rank by option_score until drift clears")
        # panic-puts-hiv live grades vs S049/S054 (+2.1 %/trade holdout): demote once ≥ 20 graded and the mean is negative
        g = conn.execute("""SELECT COUNT(*), AVG(ret) FROM watchlist_sync.strategy_signals
                            WHERE strategy_id = 'panic-puts-hiv' AND status = 'graded'""").fetchone()
        if g[0] >= 20 and (g[1] or 0) < 0:
            warn.append(f"DRIFT: panic-puts-hiv live mean {100 * g[1]:+.2f} %/trade on {g[0]} graded (backtest +2.1 %) → demote")
        ctx["edge_top"] = sorted(((t, e) for t, e in edge.items() if e["quintile"] == 5), key=lambda x: -x[1]["pct"])[:8]
        ctx["engine_top"] = [p for (p,) in conn.execute("""SELECT payload FROM watchlist_sync.put_recs_daily WHERE pass AND as_of = (
                               SELECT MAX(as_of) FROM watchlist_sync.put_recs_daily) ORDER BY rank LIMIT 8""")]   # 10-26: one engine
        ctx["sim_logged"] = n_sim
        # board verification (Options › Focus = put edge Q4–Q5): last resolved sim week, focus vs rest breach
        v = conn.execute("""SELECT resolves_on, AVG(CASE WHEN outcome THEN 0 ELSE 1 END) FILTER (WHERE (meta->>'quintile')::int >= 4),
                                   AVG(CASE WHEN outcome THEN 0 ELSE 1 END) FILTER (WHERE (meta->>'quintile')::int < 4), COUNT(*)
                            FROM watchlist_sync.forecast_ledger WHERE qtype = 'sim_put_otm' AND forecaster = 'put_edge' AND outcome IS NOT NULL
                            GROUP BY 1 ORDER BY 1 DESC LIMIT 1""").fetchone()
        ctx["board_check"] = (f"week to {v[0]}: focus breach {100 * v[1]:.0f} % vs rest {100 * v[2]:.0f} % ({v[3]} sim puts)"
                              if v and v[1] is not None and v[2] is not None else "first grade Fri (no resolved week yet)")
        text = memo(today, odds, ctx, warn, lists)
        conn.execute("""INSERT INTO watchlist_sync.house_view (view_date, view, memo, warnings) VALUES (%s, %s, %s, %s)
                        ON CONFLICT (view_date) DO UPDATE SET view = excluded.view, memo = excluded.memo, warnings = excluded.warnings, created_at = now()""",
                     (today, json.dumps({"odds": odds, "context": ctx, "lists": lists}, default=str), text, json.dumps(warn)))
        conn.commit()
    out = HERE / "out/house_view"
    out.mkdir(parents=True, exist_ok=True)
    (out / f"{today}.md").write_text(text + "\n")
    print(text)
    print(f"\nhouse view: {n} forecasts + {ctx.get('sim_logged', 0)} simulated puts logged · {len(warn)} warning(s)")


if __name__ == "__main__":
    main()
