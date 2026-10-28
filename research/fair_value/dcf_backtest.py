"""S116 — point-in-time backtest of the DCF v2 engine (A283 step 2). Pre-registered 10-27 (research/studies/INDEX.md):
  dates     quarter ends 2017-06-30 … 2023-12-31; names = every name with stored SEC facts and CRSP history (s116_crsp.py)
  inputs    SEC facts filed ≤ date (financials.facts_asof), IBES SAL/EBI consensus at the date (engine._ibes_rows), CRSP
            traded price at the month end and 36–60-month beta vs the CRSP value-weighted market, FRED DGS10 at the date, Damodaran implied ERP at the prior year end,
            terminal g capped at that rf; base rates (1990–2020) = today's (documented simplification). Same engine + gate (engine.unvalued) as the live watchlist run.
  signal    log(P50 / price) · comparators: IBES EPS FY1 / price (earnings yield), StarMine-history street PT / price (2018-09+)
  outcome   next 6 / 12-month CRSP total return minus the value-weighted market (dividends in; survivors only — today's names)
  pass      mean per-date Spearman IC (252 d) > 0 with t ≥ 2 on non-overlapping annual dates AND ≥ the earnings-yield IC
  stop      fail → DCF stays display-only (no blend vote); report sector split. Smoke: --smoke runs 5 names × 3 dates.
CRSP prc is the traded price (no split guessing); StarMine PT history is on today's basis → divided by prc ÷ cfacpr.
Usage: scripts/watchlist_sync/.venv/bin/python research/fair_value/dcf_backtest.py [--smoke] [--summary]"""
from __future__ import annotations

import sys
import urllib.request
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/watchlist_sync"))
sys.path.insert(0, str(ROOT / "scripts/watchlist_sync/dcf"))
from build_plan import connect, rows  # noqa: E402
from engine import BaseRates, inputs, simulate, unvalued  # noqa: E402
from financials import facts_asof, stored_facts, ttm_base  # noqa: E402

OUT = Path(__file__).parent / "out"
ROWS = OUT / "dcf_backtest_rows.csv"
DATES = [d.date() for d in pd.date_range("2017-06-30", "2023-12-31", freq="QE")]
CRSP = OUT / "s116_crsp_msf.csv"
# Damodaran histimpl.xls "Implied ERP (FCFE)" at each year end (fetched 10-27); a date uses the prior year end (known then)
ERP_YE = {2016: 0.0569, 2017: 0.0508, 2018: 0.0596, 2019: 0.0520, 2020: 0.0472, 2021: 0.0424, 2022: 0.0594, 2023: 0.0460, 2024: 0.0433}


def dgs10() -> pd.Series:
    text = urllib.request.urlopen("https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10&cosd=2016-01-01", timeout=30).read().decode()
    obs = [ln.split(",") for ln in text.strip().splitlines()[1:]]
    s = pd.Series({pd.Timestamp(d): float(v) / 100 for d, v in obs if v not in (".", "")})
    return s.sort_index()


def run(smoke: bool) -> pd.DataFrame:
    br = BaseRates()
    rf = dgs10()
    out = []
    m = pd.read_csv(CRSP, parse_dates=["date"])
    m["ym"] = m.date.dt.to_period("M")
    ret = m.pivot_table(index="ym", columns="ticker", values="ret")
    prc = m.pivot_table(index="ym", columns="ticker", values="prc")
    cfp = m.pivot_table(index="ym", columns="ticker", values="cfacpr")
    mkt = m.drop_duplicates("ym").set_index("ym").vwretd.sort_index()
    with connect() as c:
        late = {}  # splits after CRSP's last month (NFLX 10:1 2025-11) are in today's-basis PT history but not in cfacpr
        for r in rows(c, "SELECT ticker, split_from, split_to FROM optlab.splits WHERE exec_date > '2024-12-31'"):
            late[r["ticker"]] = late.get(r["ticker"], 1.0) * r["split_to"] / r["split_from"]
        names = sorted(set(ret.columns))
        dates = DATES
        if smoke:
            names, dates = ["AAPL", "MSFT", "NVDA", "KO", "NFLX"], [date(2018, 6, 30), date(2020, 12, 31), date(2023, 3, 31)]
        for n_t, t in enumerate(names):
            facts = stored_facts(c, t)
            if not facts:
                continue
            for d in dates:
                try:
                    ym = pd.Period(d, "M")
                    if ym not in prc.index or pd.isna(prc.at[ym, t]):
                        continue
                    base = ttm_base(c, t, facts=facts_asof(facts, d.isoformat()))
                    if not base or not base.get("revenue") or (d - date.fromisoformat(base["revenue"]["end"])).days > 200:
                        continue
                    hist = pd.concat([ret[t], mkt], axis=1, keys=["r", "m"]).loc[:ym].tail(60).dropna()
                    if len(hist) < 36:
                        continue
                    beta = float(np.cov(hist.r, hist.m)[0, 1] / np.var(hist.m, ddof=1))
                    price = float(prc.at[ym, t])
                    r_f = float(rf.loc[:pd.Timestamp(d)].iloc[-1])
                    x = inputs(c, t, base, pit={"asof": d, "price": price, "beta": beta, "rf": r_f, "erp": ERP_YE[d.year - 1]})
                    if not x.get("cons") or unvalued(x) or x["shares"] <= 0:
                        continue
                    p50 = float(np.median(simulate(x, br, n=400)["vps"]))
                    eps = rows(c, """SELECT meanest FROM wrds_research.ibes_statsum WHERE oftic = %s AND measure = 'EPS' AND fpi = '1'
                                     AND statpers <= %s AND statpers > %s::date - 45 ORDER BY statpers DESC LIMIT 1""", (t, d, d))
                    pt = rows(c, """SELECT value FROM lseg_research.starmine_history WHERE ticker = %s AND metric = 'pt_mean'
                                    AND obs_date <= %s AND obs_date > %s::date - 45 ORDER BY obs_date DESC LIMIT 1""", (t, d, d))
                    adj = (price / float(cfp.at[ym, t]) if not pd.isna(cfp.at[ym, t]) and cfp.at[ym, t] else price) / late.get(t, 1.0)
                    row = {"ticker": t, "date": d, "price": price, "p50": p50, "sector": x["sector"], "m0": x["m0"],
                           "ey": float(eps[0]["meanest"]) / price if eps and eps[0]["meanest"] is not None else None,
                           "pt_p": float(pt[0]["value"]) / adj if pt and pt[0]["value"] else None, "beta": beta, "rf": r_f}
                    for h in (6, 12):
                        fw = pd.concat([ret[t], mkt], axis=1, keys=["r", "m"]).loc[ym + 1: ym + h]
                        if len(fw) == h and fw.r.notna().all():
                            row[f"xr{h}"] = float((1 + fw.r).prod() - (1 + fw.m).prod())
                    out.append(row)
                except Exception as e:  # one bad filer/date must not stop the run
                    c.rollback()
                    print(t, d, "error", str(e)[:80])
            if n_t % 50 == 0:
                print(f"{n_t}/{len(names)} names, {len(out)} rows", flush=True)
                pd.DataFrame(out).to_csv(ROWS, index=False)
    df = pd.DataFrame(out)
    df.to_csv(ROWS, index=False)
    return df


def summary(df: pd.DataFrame) -> str:
    df = df.copy()
    df["dcf"] = np.log(df.p50.clip(lower=0.01) / df.price)
    lines = [f"# S116 DCF v2 point-in-time backtest ({date.today()})", "",
             f"{len(df)} name-dates · {df.ticker.nunique()} names · {df.date.nunique()} dates · median V/P {np.exp(df.dcf.median()):.2f}", ""]
    for h in (12, 6):
        y = f"xr{h}"
        lines += [f"## {h}-month excess return vs the CRSP value-weighted market", "", "| signal | mean IC | t (annual, non-overlap) | dates | top − bottom tercile |", "|---|---|---|---|---|"]
        for sig in ("dcf", "ey", "pt_p"):
            ics, spreads, ds = [], [], []
            for d, g in df.dropna(subset=[y, sig]).groupby("date"):
                if len(g) < 30:
                    continue
                ics.append(g[sig].rank().corr(g[y].rank())); ds.append(pd.Timestamp(d))
                q = pd.qcut(g[sig].rank(method="first"), 3, labels=False)
                spreads.append(g[y][q == 2].mean() - g[y][q == 0].mean())
            if not ics:
                lines.append(f"| {sig} | — | — | 0 | — |"); continue
            s = pd.Series(ics, index=ds)
            ann = s[s.index.month == 12] if h == 12 else s[s.index.month.isin([6, 12])]
            t = ann.mean() / ann.std(ddof=1) * np.sqrt(len(ann)) if len(ann) > 2 else float("nan")
            lines.append(f"| {sig} | {s.mean():+.3f} | {t:+.2f} (n {len(ann)}) | {len(s)} | {np.mean(spreads):+.1%} |")
        lines.append("")
    lines += ["## 12-month IC by sector (DCF)", "", "| sector | name-dates | mean IC |", "|---|---|---|"]
    for sec, g in df.dropna(subset=["xr12"]).groupby("sector"):
        ics = [h.dcf.rank().corr(h.xr12.rank()) for _, h in g.groupby("date") if len(h) >= 10]
        if ics:
            lines.append(f"| {sec} | {len(g)} | {np.mean(ics):+.3f} |")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    if "--summary" in sys.argv:
        df = pd.read_csv(ROWS, parse_dates=["date"])
    else:
        df = run("--smoke" in sys.argv)
    if "--smoke" in sys.argv:
        print(df[["ticker", "date", "price", "p50", "ey", "pt_p", "beta", "rf", "xr12"]].round(3).to_string(index=False))
    else:
        md = summary(df)
        (OUT / "dcf_backtest.md").write_text(md)
        print(md)
