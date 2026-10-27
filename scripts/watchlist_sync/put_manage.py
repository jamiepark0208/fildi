#!/usr/bin/env python3
"""Open sold-put management (A279 / S103, Jamie 10-26: "close at a win when the daily rate is far above plan and re-sell").

Per open short put (latest portfolio snapshot): captured = (entry credit − buy-back at ask − 23 % of the spread) ÷ credit;
pace = captured per elapsed day ÷ (1 ÷ days entry→expiry). Rules from S103 on real LSEG quotes:
  take + re-sell  weekly (≤ 10 days entry→expiry), captured ≥ 25 % and pace ≥ 4× (+0.018…0.021 % of strike per trade vs
                  holding, ≈ +25 %, t ≈ 1 — positive in model and real quotes, never worse) → next engine pick to re-sell
  hold            everything else; puts of 2+ weeks: every early exit lost on real quotes (t −2…−4)
  never stop on a trend flip  UT Bot / SuperTrend-cluster stops lost (t −1.8…−3.7; S017 same) — shown as a note only

    .venv/bin/python put_manage.py            # → watchlist_sync.put_manage_daily + printout
"""
from __future__ import annotations

import json
from datetime import date

from build_plan import connect

PACE, MIN_CAP, WEEKLY_DAYS = 4.0, 0.25, 10


def main():
    today = date.today()
    with connect() as conn:
        snap = conn.execute("SELECT MAX(id) FROM portfolio_snapshots").fetchone()[0]
        pos = conn.execute("""SELECT symbol, strike::float8, expiration, qty::float8, avg_premium::float8, bid::float8, ask::float8
                              FROM portfolio_options WHERE snapshot_id = %s AND direction = 'short' AND option_type ILIKE 'put%%'""",
                           (snap,)).fetchall()
        opened = dict(((s, k, e), d) for s, k, e, d in conn.execute(
            """SELECT o.symbol, o.strike::float8, o.expiration, MIN(p.imported_at)::date FROM portfolio_options o
               JOIN portfolio_snapshots p ON p.id = o.snapshot_id WHERE o.direction = 'short' AND o.option_type ILIKE 'put%%'
               GROUP BY 1, 2, 3"""))
        tech = dict(conn.execute("""SELECT DISTINCT ON (ticker) ticker, payload FROM watchlist_sync.indicators_daily
                                    ORDER BY ticker, as_of DESC""").fetchall()) if conn.execute(
            "SELECT to_regclass('watchlist_sync.indicators_daily')").fetchone()[0] else {}
        held = {p[0] for p in pos}
        nxt = [r for (r,) in conn.execute("""SELECT payload FROM watchlist_sync.put_recs_daily
                                             WHERE as_of = (SELECT MAX(as_of) FROM watchlist_sync.put_recs_daily) AND pass ORDER BY rank""")
               if r["ticker"] not in held][:3]
        out = []
        agg = {}
        for s, k, e, q, prem, b, a in pos:   # merge lots of the same contract (weighted credit)
            g = agg.setdefault((s, k, e), [0.0, 0.0, b, a])
            g[0] += q; g[1] += q * prem
        for (s, k, e), (q, tot_prem, b, a) in agg.items():
            credit = tot_prem / q / 100
            if credit <= 0 or a is None or b is None:
                continue
            buy = max(a - 0.23 * (a - b), 0.0)
            od = opened.get((s, k, e), today)
            el, tot = max((today - od).days, 1), max((e - od).days, 1)
            cap = (credit - buy) / credit
            pace = (cap / el) / (1 / tot)
            weekly = tot <= WEEKLY_DAYS
            take = weekly and cap >= MIN_CAP and pace >= PACE
            t = tech.get(s) or {}
            note = []
            if t.get("ut_dir") == -1 or (t.get("stc_bull") is not None and t["stc_bull"] <= 0.4):
                note.append("trend turned down — not a reason to close (S103: trend stops lost)")
            r = {"ticker": s, "strike": k, "expiry": str(e), "qty": q, "opened": str(od), "credit": round(credit, 4), "buy_back": round(buy, 4),
                 "captured_pct": round(100 * cap, 1), "pace": round(pace, 2), "days_held": el, "days_total": tot,
                 "action": "take + re-sell" if take else "hold",
                 "why": (f"captured {100 * cap:.0f} % in {el} of {tot} days = {pace:.1f}× plan pace ≥ {PACE:g}× (S103)" if take else
                         f"{100 * cap:.0f} % captured, {pace:.1f}× pace" + ("" if weekly else " · 2+ week put: hold (S103: early exits lost)")),
                 "notes": note, "resell": [{"ticker": n["ticker"], "strike": n["strike"], "expiry": n["expiry"], "income_wk_pct": n["income_wk_pct"]}
                                           for n in nxt] if take else []}
            out.append(r)
        conn.execute("""CREATE TABLE IF NOT EXISTS watchlist_sync.put_manage_daily (as_of date, ticker text, strike float8, expiry date,
                        payload jsonb, computed_at timestamptz DEFAULT now(), PRIMARY KEY (as_of, ticker, strike, expiry))""")
        conn.execute("DELETE FROM watchlist_sync.put_manage_daily WHERE as_of = %s", (today,))
        for r in out:
            conn.execute("INSERT INTO watchlist_sync.put_manage_daily (as_of, ticker, strike, expiry, payload) VALUES (%s,%s,%s,%s,%s)",
                         (today, r["ticker"], r["strike"], r["expiry"], json.dumps(r)))
        conn.commit()
    for r in sorted(out, key=lambda r: r["action"] != "take + re-sell"):
        print(f"{r['action']:14s} {r['ticker']:6s} {r['strike']:g}p {r['expiry']} ×{r['qty']:g}: {r['why']}"
              + (f" → re-sell {r['resell'][0]['ticker']} {r['resell'][0]['strike']:g}p" if r["resell"] else "")
              + (f" [{'; '.join(r['notes'])}]" if r["notes"] else ""))
    print(f"put manage: {len(out)} open short puts, {sum(r['action'] != 'hold' for r in out)} to take → watchlist_sync.put_manage_daily")


if __name__ == "__main__":
    main()
