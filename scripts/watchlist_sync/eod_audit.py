"""End-of-day missed-trade audit — step 4 of research/common/trade-funnel-plan.md (Jamie 11-09: "end of day check, verify,
learn from mistakes — incl. tickers where the model failed to capture a better trade, understand why, improve").

Oracle: every name × family (0.20Δ sold put, 0.50Δ call, 0.50Δ put, 30 DTE — same strikes as trade_funnel) priced at the
entry close from iv30, re-priced h sessions later at that day's close + iv30 (intrinsic at expiry). Fills lose FILL each way.
  long  P&L = exit value ÷ debit − 1           short put  P&L = (credit − buy-back) ÷ strike (per $ collateral)
Winners = top decile per family that day. Each winner gets the first stage that dropped it:
  universe (no history / iv30 / < $5) → shortlist (funnel rank > K, no chains) → today (chains, but no rule picked it) → shown.
Stage recall = share of winners still alive after the stage; shortlist baseline = K ÷ universe (a random pick's recall).
Also: mean P&L of what we showed vs the whole universe (did the list beat picking at random?).

→ watchlist_sync.missed_trades (one row per missed winner, with stage + reason) + watchlist_sync.eod_audit_daily (recall).
Caveat: model-priced (iv30 flat skew, no chain), same model as the funnel's cheap stage — it judges the ranking, not fills.

    .venv/bin/python eod_audit.py                      # daily: audit the entry days whose 5/10/21-session horizon ended today
    .venv/bin/python eod_audit.py --as-of=2026-10-30 [--h=5] [--replay]   # one day; --replay re-runs the funnel as of that day
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "analysis"))
import trade_funnel as TF  # noqa: E402
from build_plan import connect  # noqa: E402

HORIZONS = (5, 10, 21)
WIN_Q = 0.10

DDL = ["""CREATE TABLE IF NOT EXISTS watchlist_sync.missed_trades (
  as_of date NOT NULL, horizon int NOT NULL, family text NOT NULL, ticker text NOT NULL, pnl double precision,
  pnl_rank int, stage text NOT NULL, reason text, payload jsonb, run_at timestamptz DEFAULT now(),
  PRIMARY KEY (as_of, horizon, family, ticker))""",
       """CREATE TABLE IF NOT EXISTS watchlist_sync.eod_audit_daily (
  as_of date NOT NULL, horizon int NOT NULL, family text NOT NULL, exit_date date, n_universe int, n_winners int,
  recall_universe double precision, recall_shortlist double precision, base_shortlist double precision,
  recall_shown double precision, n_shown int, shown_mean double precision, all_mean double precision, win_cut double precision,
  missed_by jsonb, run_at timestamptz DEFAULT now(), PRIMARY KEY (as_of, horizon, family))"""]


def sessions(conn) -> list[date]:
    return [d for (d,) in conn.execute("""SELECT date FROM lseg_research.daily_history WHERE date >= CURRENT_DATE - 120
                                          GROUP BY 1 HAVING COUNT(*) > 500 ORDER BY 1""")]


def bars(conn, d0: date, d1: date) -> dict:
    out = defaultdict(dict)
    for t, d, c, ip, ic in conn.execute("""SELECT ticker, date, close::float8, iv30_put::float8, iv30_call::float8
                                           FROM lseg_research.daily_history WHERE date IN (%s, %s) AND close > 0""", (d0, d1)):
        out[t][d] = (c, (ip or 0) / 100, (ic or 0) / 100)
    return out


def oracle(conn, d0: date, d1: date) -> dict:
    """{family: {ticker: pnl}} for every name with both closes and an entry iv30."""
    b = bars(conn, d0, d1)
    T0, T1 = TF.DTE / 365, (TF.DTE - (d1 - d0).days) / 365
    res = {f: {} for f in TF.K}
    for t, x in b.items():
        if d0 not in x or d1 not in x:
            continue
        (S0, ip0, ic0), (S1, ip1, ic1) = x[d0], x[d1]
        for f in TF.K:
            put = f != "long_call"
            v0, v1 = (ip0, ip1) if put else (ic0, ic1)
            if not 0.05 <= v0 <= 3.0 or S0 < 1:   # 11-09 replay: sub-$5 names with iv30 > 300 % gave a +39 % 'sold put'
                continue
            K = TF.strike_at(S0, v0, T0, TF.DELTA[f], put)
            p0 = TF.bs(S0, K, v0, T0, put)
            p1 = TF.bs(S1, K, v1 or v0, max(T1, 0), put)
            if p0 <= 0:
                continue
            if f == "short_put":
                res[f][t] = (p0 * (1 - TF.FILL) - p1 * (1 + TF.FILL)) / K
            else:
                res[f][t] = p1 * (1 - TF.FILL) / (p0 * (1 + TF.FILL)) - 1
    return res


def funnel_rows(conn, d0: date) -> dict:
    st = defaultdict(dict)
    for stage, t, f, kept, reason in conn.execute("""SELECT stage, ticker, family, kept, reason FROM watchlist_sync.trade_funnel_daily
                                                     WHERE as_of = %s""", (d0,)):
        st[stage][(t, f)] = (kept, reason)
    return st


def audit(conn, d0: date, h: int, d1: date, dry: bool) -> list[str]:
    st = funnel_rows(conn, d0)
    if "shortlist" not in st:
        return [f"  {d0} h{h}: no funnel rows (run with --replay)"]
    orc = oracle(conn, d0, d1)
    er = {t for (t,) in conn.execute("""SELECT ticker FROM lseg_research.events WHERE event_type = 'EarningsReleases'
                                         AND event_date > %s AND event_date <= %s
                                         UNION SELECT UPPER(ticker) FROM earnings_calendar WHERE report_date::date > %s AND report_date::date <= %s""",
                                      (d0, d1, d0, d1))}
    lines, missed, summ = [], [], []
    for f, pnl in orc.items():
        if len(pnl) < 50:
            continue
        ranked = sorted(pnl, key=lambda t: -pnl[t])
        nw = max(1, int(len(ranked) * WIN_Q))
        win = ranked[:nw]
        uni_ok = {t for (t, _), (k, _) in st["universe"].items() if k}
        sl = {t: st["shortlist"][(t, f)] for t in pnl if (t, f) in st["shortlist"]}
        shown = {t for (t, ff) in st.get("today", {}) if ff == f}
        by = defaultdict(int)
        for i, t in enumerate(win, 1):
            if t not in uni_ok:
                stage, why = "universe", (st["universe"].get((t, ""), (False, "not in funnel universe"))[1])
            elif t not in sl or not sl[t][0]:
                stage, why = "shortlist", sl[t][1] if t in sl else "not ranked"
            elif t not in shown:
                stage, why = "today", "chains pulled, no rule picked it"
            else:
                by["shown"] += 1
                continue
            by[stage] += 1
            by["earnings"] += t in er
            missed.append((d0, h, f, t, pnl[t], i, stage, why + (" · earnings in window" if t in er else ""),
                           {"exit": str(d1), "earnings": t in er}))
        r_uni = sum(t in uni_ok for t in win) / nw
        r_sl = sum(t in sl and sl[t][0] for t in win) / nw
        base = sum(1 for v in sl.values() if v[0]) / max(len(uni_ok & set(pnl)), 1)
        r_sh = by["shown"] / nw
        sh = [pnl[t] for t in shown if t in pnl]
        sh_m = sum(sh) / len(sh) if sh else None
        all_m = sum(pnl.values()) / len(pnl)
        summ.append((d0, h, f, d1, len(pnl), nw, r_uni, r_sl, base, r_sh, len(sh), sh_m, all_m, pnl[win[-1]], json.dumps(dict(by))))
        lines.append(f"  {d0}→{d1} h{h} {f:10s} winners {nw:3d} (≥ {100 * pnl[win[-1]]:+.1f} %) · recall universe "
                     f"{100 * r_uni:.0f} % → shortlist {100 * r_sl:.0f} % (random {100 * base:.0f} %) → shown {100 * r_sh:.0f} % · "
                     f"shown mean {'—' if sh_m is None else f'{100 * sh_m:+.1f} %'} (n {len(sh)}) vs all {100 * all_m:+.1f} % · "
                     f"misses w/ earnings {by['earnings']}/{nw - by['shown']} · "
                     f"top misses " + ", ".join(f"{m[3]}[{m[6][:2]}] {100 * m[4]:+.0f}%" for m in missed if m[2] == f and m[1] == h)[:200])
    if not dry:
        for q in DDL:
            conn.execute(q)
        conn.execute("DELETE FROM watchlist_sync.missed_trades WHERE as_of = %s AND horizon = %s", (d0, h))
        conn.execute("DELETE FROM watchlist_sync.eod_audit_daily WHERE as_of = %s AND horizon = %s", (d0, h))
        with conn.cursor() as cur:
            cur.executemany("INSERT INTO watchlist_sync.missed_trades (as_of, horizon, family, ticker, pnl, pnl_rank, stage, reason, payload) "
                            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)", [m[:8] + (json.dumps(m[8]),) for m in missed])
            cur.executemany("""INSERT INTO watchlist_sync.eod_audit_daily (as_of, horizon, family, exit_date, n_universe, n_winners,
                               recall_universe, recall_shortlist, base_shortlist, recall_shown, n_shown, shown_mean, all_mean, win_cut, missed_by)
                               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""", summ)
        conn.commit()
    return lines


def main():
    arg = {a.split("=", 1)[0]: (a.split("=", 1) + [""])[1] for a in sys.argv[1:]}
    dry = "--dry" in arg
    with connect() as conn:
        ss = sessions(conn)
        jobs = []
        if "--as-of" in arg:
            d0 = date.fromisoformat(arg["--as-of"])
            for h in ([int(arg["--h"])] if "--h" in arg else HORIZONS):
                i = ss.index(d0) if d0 in ss else None
                if i is not None and i + h < len(ss):
                    jobs.append((d0, h, ss[i + h]))
            if "--replay" in arg:
                TF.shortlist(conn, dry, d0)
                TF.today_list(conn, dry, d0)
        else:   # daily: entry days whose horizon ends on the latest full session
            jobs = [(ss[-1 - h], h, ss[-1]) for h in HORIZONS if len(ss) > h]
        out = []
        for d0, h, d1 in jobs:
            out += audit(conn, d0, h, d1, dry)
    print(f"eod_audit: {len(jobs)} entry-day × horizon jobs")
    print("\n".join(out) if out else "  nothing to grade")


if __name__ == "__main__":
    main()
