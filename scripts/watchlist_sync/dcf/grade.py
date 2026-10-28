"""DCF v2 learning loop (A283 step 2): grade every stored dcf_detail snapshot as it matures. → watchlist_sync.dcf_grades
+ research/fair_value/out/dcf_grades.md. Pre-registered (A283 § Eval, 10-27):
  rank       Spearman IC of log(value / price) vs the next 63 / 126 / 252-session return in excess of SPY, per snapshot date,
             averaged over dates; same names + dates for the comparators fv-1.x (fair_value_snapshots) and StarMine IV.
             Pass = DCF IC ≥ fv-1.x IC with ≥ 20 dates × ≥ 20 names. Reported, never gates on its own (S009).
  drift      share of names where street PT (signals_daily pt_mean) and StarMine IV moved toward our P50 over 63 sessions.
  stability  day-over-day |ΔP50| / P50 when no input date (TTM end, consensus as-of, CMA month) changed. Pass = max ≤ 2 %.
Usage: .venv/bin/python dcf/grade.py   (daily.py model stage, soft; ranks stay empty until snapshots are 3 months old)"""
from __future__ import annotations

import json
import sys
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_plan import connect, rows  # noqa: E402

OUT = Path(__file__).resolve().parents[3] / "research" / "fair_value" / "out" / "dcf_grades.md"
HORIZONS = (63, 126, 252)
DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.dcf_grades (as_of date NOT NULL, metric text NOT NULL, horizon int NOT NULL,
         forecaster text NOT NULL, value double precision, n_dates int, n_names int, detail jsonb,
         PRIMARY KEY (as_of, metric, horizon, forecaster))"""


def closes(conn, tickers: list[str], lo: date) -> pd.DataFrame:
    r = rows(conn, """SELECT ticker, date, close::float c FROM prices_historical WHERE ticker = ANY(%s) AND date >= %s AND close > 0""",
             (tickers + ["SPY"], lo))
    return pd.DataFrame(r).pivot_table(index="date", columns="ticker", values="c").sort_index() if r else pd.DataFrame()


def snapshots(conn) -> pd.DataFrame:
    r = rows(conn, """SELECT d.ticker, d.as_of, (d.detail->>'p50')::float p50, (d.detail->>'price')::float price, d.detail->'inputs_asof' inp,
                      (SELECT s.fair_value FROM fair_value_snapshots s WHERE s.ticker = d.ticker AND s.as_of <= d.as_of ORDER BY s.as_of DESC LIMIT 1) fv,
                      (SELECT x.value FROM watchlist_sync.external_intrinsic x WHERE x.ticker = d.ticker AND x.source = 'starmine' AND x.as_of <= d.as_of
                       ORDER BY x.as_of DESC LIMIT 1) sm
                      FROM watchlist_sync.dcf_detail d WHERE d.valued""")
    return pd.DataFrame(r)


def rank(df: pd.DataFrame, px: pd.DataFrame) -> list[dict]:
    out = []
    if px.empty:
        return out
    dates = list(px.index)
    for h in HORIZONS:
        ics = {"dcf": [], "fv": [], "starmine": []}
        names = 0
        for d, g in df.groupby("as_of"):
            i = next((k for k, x in enumerate(dates) if x >= d), None)
            if i is None or i + h >= len(dates):
                continue
            p0, p1 = px.iloc[i], px.iloc[i + h]
            ret = (p1 / p0 - 1) - (p1["SPY"] / p0["SPY"] - 1)
            g = g[g.ticker.isin(ret.dropna().index)].copy()
            g = g[g.fv.notna() & g.sm.notna() & (g.price > 0)]
            if len(g) < 20:
                continue
            g["r"] = g.ticker.map(ret)
            for k, col in (("dcf", "p50"), ("fv", "fv"), ("starmine", "sm")):
                ics[k].append(float(pd.Series(np.log(g[col].clip(lower=0.01) / g.price)).rank().corr(g.r.rank())))
            names = max(names, len(g))
        for k, v in ics.items():
            out.append({"metric": "rank_ic", "horizon": h, "forecaster": k, "value": float(np.mean(v)) if v else None,
                        "n_dates": len(v), "n_names": names, "detail": {"pass_bar": "dcf ≥ fv with ≥ 20 dates × ≥ 20 names"}})
    return out


def drift(conn, df: pd.DataFrame) -> list[dict]:
    hits = {"street_pt": [], "starmine": []}
    for d, g in df.groupby("as_of"):
        if (date.today() - d).days < 91:
            continue
        for _, s in g.iterrows():
            later = d + timedelta(days=91)
            pt = rows(conn, """SELECT (SELECT pt_mean FROM lseg_research.signals_daily WHERE ticker = %s AND as_of <= %s ORDER BY as_of DESC LIMIT 1) a,
                                      (SELECT pt_mean FROM lseg_research.signals_daily WHERE ticker = %s AND as_of <= %s ORDER BY as_of DESC LIMIT 1) b""",
                      (s.ticker, d, s.ticker, later))[0]
            if pt["a"] and pt["b"]:
                hits["street_pt"].append(abs(s.p50 - float(pt["b"])) < abs(s.p50 - float(pt["a"])))
            sm1 = rows(conn, """SELECT value FROM watchlist_sync.external_intrinsic WHERE ticker = %s AND source = 'starmine' AND as_of <= %s
                                ORDER BY as_of DESC LIMIT 1""", (s.ticker, later))
            if s.sm and sm1:
                hits["starmine"].append(abs(s.p50 - float(sm1[0]["value"])) < abs(s.p50 - float(s.sm)))
    return [{"metric": "drift_toward", "horizon": 63, "forecaster": k, "value": float(np.mean(v)) if v else None,
             "n_dates": None, "n_names": len(v), "detail": {"read": "share of snapshots where the source moved toward our P50"}} for k, v in hits.items()]


def stability(df: pd.DataFrame) -> list[dict]:
    moves = []
    for t, g in df.sort_values("as_of").groupby("ticker"):
        g = g.reset_index(drop=True)
        for k in range(1, len(g)):
            a, b = g.loc[k - 1], g.loc[k]
            if json.dumps(a.inp, sort_keys=True) == json.dumps(b.inp, sort_keys=True) and a.inp is not None and a.p50 > 0:
                moves.append((abs(b.p50 / a.p50 - 1), t, str(b.as_of)))
    worst = max(moves) if moves else None
    return [{"metric": "stability_max_move", "horizon": 1, "forecaster": "dcf", "value": worst[0] if worst else None,
             "n_dates": None, "n_names": len(moves), "detail": {"worst": worst[1:] if worst else None, "pass_bar": "≤ 0.02"}}]


def main() -> None:
    with connect() as c:
        c.execute(DDL); c.commit()
        df = snapshots(c)
        if df.empty:
            print("dcf grades: no snapshots"); return
        px = closes(c, sorted(df.ticker.unique()), df.as_of.min())
        res = rank(df, px) + drift(c, df) + stability(df)
        for r in res:
            c.execute("""INSERT INTO watchlist_sync.dcf_grades VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (as_of, metric, horizon, forecaster)
                         DO UPDATE SET value = EXCLUDED.value, n_dates = EXCLUDED.n_dates, n_names = EXCLUDED.n_names, detail = EXCLUDED.detail""",
                      (date.today(), r["metric"], r["horizon"], r["forecaster"], r["value"], r["n_dates"], r["n_names"], json.dumps(r["detail"])))
        c.commit()
    fmt = lambda v: "—" if v is None else f"{v:.3f}"
    lines = [f"# DCF v2 grades ({date.today()}) — `dcf/grade.py`", "", f"Snapshots: {len(df)} ({df.as_of.min()} → {df.as_of.max()}, {df.ticker.nunique()} names)", "",
             "| metric | horizon | forecaster | value | dates | names |", "|---|---|---|---|---|---|"]
    lines += [f"| {r['metric']} | {r['horizon']} | {r['forecaster']} | {fmt(r['value'])} | {r['n_dates'] or ''} | {r['n_names']} |" for r in res]
    OUT.write_text("\n".join(lines) + "\n")
    st = res[-1]
    print(f"dcf grades: {len(df)} snapshots · rank dates {max((r['n_dates'] or 0) for r in res if r['metric'] == 'rank_ic')} · "
          f"stability max {fmt(st['value'])} over {st['n_names']} unchanged-input days")


if __name__ == "__main__":
    main()
