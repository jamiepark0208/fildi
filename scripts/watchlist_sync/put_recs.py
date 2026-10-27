#!/usr/bin/env python3
"""One sold-put recommendation per name per day — the table every surface reads (A277 §1, Jamie 10-26: "consistency").

Before: four engines picked four NVDA puts (Model List 0.09Δ, Rankings/Live TS option score, Structures on the skew survey).
Now this writer is the only picker; Model List (build_plan.restrike_puts), Structures (CSP), Rankings › Sell Puts and Live ›
Best strikes read `watchlist_sync.put_recs_daily` and only re-price the chosen contract.

Per name, on the latest saved chain (option_chain_history, ~445 names):
  expiry  listed expiry nearest 7 calendar days out, rules.DTE[0]–14 days (S088/S101: 1-week puts earn the most per week)
  band    strategy_engine.engine_put_band (band_engine table: market state × stock state; panic → none;
          market state is per name: SPY's, or sector_drop when the name's sector ETF is ≥ 15 % off its high)
          + build_plan.put_far_reason (earnings before expiry · credit < 20 · put-risk / low-OWN) → never closer than 0.06–0.08Δ
  strike  listed put nearest the band middle, bid ≥ rules.PUT_MIN_RESTRIKE_BID; empty band → one band farther, then one closer
  gates   strategy_rules.json sell_put gates (verdict not red · put-edge Q ≥ 4 · IV/RV ≥ 1.15) via strategy_engine.fit
  rank    strategy_rules.json sell_put rank (put-edge Q · ev_rv_cap = bid − realized-vol value, % of strike per week)

    .venv/bin/python put_recs.py            # writes today's rows (idempotent per as_of)
    .venv/bin/python put_recs.py --print    # no write
"""
from __future__ import annotations

import json
import math
import sys
from collections import defaultdict
from datetime import date

import numpy as np

import build_plan as BP
import rules as R
import strategy_engine as SE
from build_plan import connect, rows

FAR_BAND = "0.06-0.08"   # far rule (rules.PUT_EARNINGS_ABS_DELTA 0.10 cap / 0.07 target) as a band


def _ncdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def bs_put(S, K, v, t):
    if v <= 0 or t <= 0:
        return max(K - S, 0.0)
    sd = v * math.sqrt(t)
    d1 = (math.log(S / K) + 0.5 * sd * sd) / sd
    return K * _ncdf(-(d1 - sd)) - S * _ncdf(-d1)


def pick_expiry(exps: list[date], as_of: date):
    ok = [e for e in exps if R.DTE[0] <= (e - as_of).days <= 14]   # the band history is 1-week puts; monthlies only → none
    return min(ok, key=lambda e: abs((e - as_of).days - 7)) if ok else None


def pick_strike(puts: list[dict], band: str):
    """Listed put nearest the band middle; empty band → one band farther, then one closer (≤ 0.20Δ). (row, band used)."""
    order = SE.ENGINE["strategies"]["sell_put"]["strike"]["bands"]
    i = order.index(band)
    for j in [i] + [k for k in (i - 1, i + 1) if 0 <= k < len(order) and SE.band_bounds(order[k])[1] <= 0.20 + 1e-9]:
        lo, hi = SE.band_bounds(order[j])
        inb = [p for p in puts if lo <= -p["delta"] < hi and p["bid"] >= R.PUT_MIN_RESTRIKE_BID]
        if inb:
            return min(inb, key=lambda p: abs(-p["delta"] - (lo + hi) / 2)), order[j]
    return None, None


def compute(conn) -> tuple[date, list[dict], dict]:
    as_of = conn.execute("SELECT MAX(as_of) FROM option_chain_history").fetchone()[0]
    chain = rows(conn, """SELECT ticker, expiry, strike::float8, dte, spot::float8, bid::float8, ask::float8, iv::float8, delta::float8
                          FROM option_chain_history WHERE as_of = %s AND side = 'put' AND bid > 0 AND delta < 0""", (as_of,))
    by = defaultdict(list)
    for r in chain:
        by[r["ticker"]].append(r)
    names = sorted(by)
    I = SE.load_inputs(conn, names)
    market, states = SE.band_states(conn, names)
    ctx = BP.put_context(conn)
    rv = {}
    for t, cl in conn.execute("""SELECT ticker, array_agg(close::float8 ORDER BY date DESC) FROM lseg_research.daily_history
                                 WHERE ticker = ANY(%s) AND date >= CURRENT_DATE - 45 AND close > 0 GROUP BY 1""", (names,)).fetchall():
        if len(cl) >= 21:
            rv[t] = float(np.std(np.diff(np.log(cl[:21][::-1]))) * math.sqrt(252))
    tech = {t: x for t, x in conn.execute("""SELECT DISTINCT ON (ticker) ticker, payload FROM watchlist_sync.indicators_daily
                                             WHERE ticker = ANY(%s) ORDER BY ticker, as_of DESC""", (names,)).fetchall()} if conn.execute(
        "SELECT to_regclass('watchlist_sync.indicators_daily')").fetchone()[0] else {}   # display only (S102: no put edge)
    out = []
    for t in names:
        exp = pick_expiry(sorted({p["expiry"] for p in by[t]}), as_of)
        ms = (states.get(t) or {}).get("market_state", market["state"])
        rec = {"ticker": t, "as_of": str(as_of), "market_state": ms, "stock_state": (states.get(t) or {}).get("state"),
               "sector": (states.get(t) or {}).get("sector"), "tech": tech.get(t),
               "expiry": str(exp) if exp else None}
        band, why = SE.engine_put_band(market, states.get(t))
        far = BP.put_far_reason(t, exp, ctx) if exp else None
        if band and far and SE.band_bounds(band)[0] >= SE.band_bounds(FAR_BAND)[1]:
            band, why = FAR_BAND, f"{why} · {far} → {FAR_BAND}Δ (farther, not smaller)"
        rec.update(band_target=band, why=why, far=far)
        if not band or not exp:
            rec.update(pass_=False, gates=["panic: no new puts" if not band else "no weekly expiry 2–14 days out"])
            out.append(rec)
            continue
        pe = I.get(t, {}).get("put_edge_q")
        for g in SE.ENGINE["strategies"]["sell_put"]["gates"]:   # gate relaxed in this state → capped band (S102)
            rl = g.get("relax") or {}
            v = pe if g["input"] == "put_edge_q" else None
            if ms in rl.get("market_state", []) and v is not None and v < g["min"] and \
                    SE.band_bounds(band)[0] >= SE.band_bounds(rl["max_band"])[1]:
                band, why = rl["max_band"], f"{why} · put-edge Q{v} in a sector drop → {rl['max_band']}Δ (S102)"
                rec.update(band_target=band, why=why)
        p, used = pick_strike([x for x in by[t] if x["expiry"] == exp], band)
        if not p:
            rec.update(pass_=False, gates=[f"no listed put with bid ≥ {R.PUT_MIN_RESTRIKE_BID} within one band of {band}"])
            out.append(rec)
            continue
        days = (exp - as_of).days + BP._settle_offset(exp)
        iv = p["iv"] / 100 if p["iv"] > 3 else p["iv"]
        rec.update(band=used, strike=p["strike"], delta=p["delta"], bid=p["bid"], ask=p["ask"], spot=p["spot"], iv=iv, dte=p["dte"],
                   income_wk_pct=100 * p["bid"] / p["strike"] * 7 / days, iv_rv=iv / rv[t] if rv.get(t) else None)
        if rv.get(t):
            fair = bs_put(p["spot"], p["strike"], rv[t], max(p["dte"], 1) / 365)
            rec["ev_rv_cap"] = (p["bid"] - fair) / p["strike"] * 7 / days
        h = SE.band_table().get(f"{ms}|{rec['stock_state'] or 'normal'}|{used}")
        if h:
            rec.update(hist_bp=h["bp"], hist_w5=h["w5"], hist_kept=h["kept"])
        ok, gates = SE.fit({"ticker": t, "structure": "csp", "iv_rv": rec["iv_rv"], "market_state": ms}, I, {})
        rec.update(pass_=ok, gates=gates, put_edge_q=I.get(t, {}).get("put_edge_q"), verdict=I.get(t, {}).get("verdict"))
        out.append(rec)
    ranked = [r for r in out if r.get("strike") is not None]
    score = SE.rank_key(ranked, "sell_put")
    ranked.sort(key=lambda r: (not r["pass_"], -score.get(id(r), 0.0)))
    for i, r in enumerate(ranked, 1):
        r["rank"] = i
    return as_of, out, market


def write(conn, as_of, recs):
    conn.execute("""CREATE TABLE IF NOT EXISTS watchlist_sync.put_recs_daily (
                      as_of date NOT NULL, ticker text NOT NULL, rank int, pass boolean NOT NULL, payload jsonb NOT NULL,
                      computed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (as_of, ticker))""")
    conn.execute("DELETE FROM watchlist_sync.put_recs_daily WHERE as_of = %s", (as_of,))
    for r in recs:
        conn.execute("INSERT INTO watchlist_sync.put_recs_daily (as_of, ticker, rank, pass, payload) VALUES (%s,%s,%s,%s,%s)",
                     (as_of, r["ticker"], r.get("rank"), r["pass_"], json.dumps({k: v for k, v in r.items() if k != "pass_"}, default=str)))
    conn.commit()


def main():
    with connect() as conn:
        as_of, recs, market = compute(conn)
        top = sorted((r for r in recs if r.get("rank")), key=lambda r: r["rank"])
        n_pass = sum(r["pass_"] for r in recs)
        print(f"put_recs {as_of}: market {market['state']} · {len(recs)} names · {n_pass} pass gates · "
              f"{sum(1 for r in recs if r.get('strike'))} with a strike")
        for r in top[:12]:
            print(f"  #{r['rank']:>3} {r['ticker']:6s} {r['expiry']} {r['strike']:>8g} {-r['delta']:.3f}Δ {r['income_wk_pct']:.2f}%/wk "
                  f"{'PASS' if r['pass_'] else 'gated: ' + '; '.join(r['gates'])} | {r['why']}")
        if "--print" not in sys.argv[1:]:
            write(conn, as_of, recs)
            print("→ watchlist_sync.put_recs_daily")


if __name__ == "__main__":
    main()
