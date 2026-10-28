"""Historical analogs for today's macro setup (Jamie 10-28: "cross check with history to see if there were similar times").

Data: Shiller monthly S&P (P, E, CPI, GS10, CAPE; 1871 → 2023-09, http://www.econ.yale.edu/~shiller/data/ie_data.xls) +
FRED FEDFUNDS, WTISPLC (CSV, no key). Window 1954-07 → 2022-09 (12 m forward known).
Today (2026-10): S&P −2 % off 12 m high · Fed funds +12 bp (first hike after 2025 cuts) · CPI 3.7 % y/y · WTI +52 % y/y ·
10y +100 bp in 12 m (≈ 5.0 %) · CAPE ≈ 41 · trailing EPS ≈ +30 % y/y.
Outputs per condition: months, episodes (distinct runs ≥ 6 m apart), median 6/12 m price return, % up at 12 m,
P(peak-to-trough ≥ 10 % within 12 m), P(≥ 20 %). Plus 20 nearest-neighbour months on standardized features.
Usage: analogs.py <shiller.xls> <fred_dir>
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import xlrd

TODAY = {"dd12": -0.02, "ff3": 0.12, "cpi_yoy": 0.037, "oil_yoy": np.log(97.31 / 63.96), "y10_12": 1.0, "cape": 41.0,
         "eps_g": 0.30}


def load(xls: str, fred: Path) -> pd.DataFrame:
    s = xlrd.open_workbook(xls).sheet_by_name("Data")
    rows = []
    for r in range(8, s.nrows):
        v = s.row_values(r)
        if not isinstance(v[0], float) or v[1] in ("", None):
            continue
        y, m = int(v[0]), int(round((v[0] - int(v[0])) * 100))
        rows.append((pd.Timestamp(y, m, 1), v[1], v[3] if v[3] != "" else np.nan, v[4], v[6],
                     v[12] if isinstance(v[12], float) else np.nan))
    d = pd.DataFrame(rows, columns=["date", "P", "E", "CPI", "GS10", "cape"]).set_index("date")
    for sid, col in (("FEDFUNDS", "ff"), ("WTISPLC", "oil")):
        f = pd.read_csv(fred / f"{sid}.csv", parse_dates=["observation_date"]).set_index("observation_date")
        d[col] = pd.to_numeric(f.iloc[:, 0], errors="coerce").reindex(d.index)
    d["dd12"] = d.P / d.P.rolling(12).max() - 1
    d["ff3"] = d.ff - d.ff.shift(3)
    d["cpi_yoy"] = d.CPI / d.CPI.shift(12) - 1
    d["oil_yoy"] = np.log(d.oil / d.oil.shift(12))
    d["y10_12"] = d.GS10 - d.GS10.shift(12)
    d["eps_g"] = d.E / d.E.shift(12) - 1
    fwd = [d.P.shift(-k) for k in range(1, 13)]
    d["r6"] = d.P.shift(-6) / d.P - 1
    d["r12"] = d.P.shift(-12) / d.P - 1
    d["mdd12"] = pd.concat(fwd, axis=1).min(axis=1) / d.P - 1   # worst close in the next 12 m vs today
    d = d.loc["1954-07":"2022-09"].dropna(subset=["ff3", "cpi_yoy", "oil_yoy", "y10_12", "cape", "eps_g", "r12"])
    return d


def episodes(idx) -> int:
    n, last = 0, None
    for t in idx:
        if last is None or (t.year * 12 + t.month) - (last.year * 12 + last.month) > 6:
            n += 1
        last = t
    return n


def row(name, g) -> str:
    if len(g) == 0:
        return f"| {name} | 0 | 0 | | | | | |"
    yrs = sorted({t.year for t in g.index})
    span = f"{yrs[0]}–{yrs[-1]}" if len(yrs) > 1 else str(yrs[0])
    return (f"| {name} | {len(g)} | {episodes(g.index)} | {g.r6.median():+.1%} | {g.r12.median():+.1%} | {(g.r12 > 0).mean():.0%} | "
            f"{(g.mdd12 <= -0.10).mean():.0%} | {(g.mdd12 <= -0.20).mean():.0%} | {span} |")


def main():
    d = load(sys.argv[1], Path(sys.argv[2]))
    near, hike = d.dd12 > -0.05, d.ff3 > 0
    conds = [
        ("all months (base rate)", d.index == d.index),
        ("near high (≤ 5 % off) + Fed hiking", near & hike),
        ("… + oil up > 30 % y/y", near & hike & (d.oil_yoy > np.log(1.3))),
        ("… + CPI > 3 %", near & hike & (d.cpi_yoy > 0.03)),
        ("near high + 10y up ≥ 75 bp in 12 m", near & (d.y10_12 >= 0.75)),
        ("CAPE > 30", d.cape > 30),
        ("CAPE > 30 + 10y up ≥ 75 bp", (d.cape > 30) & (d.y10_12 >= 0.75)),
        ("CAPE > 30 + Fed hiking", (d.cape > 30) & hike),
        ("EPS growth > 20 % + near high", (d.eps_g > 0.20) & near),
        ("EPS growth > 20 % + Fed hiking", (d.eps_g > 0.20) & hike),
        ("oil up > 30 % y/y (any)", d.oil_yoy > np.log(1.3)),
    ]
    out = ["| condition | months | episodes | med 6 m | med 12 m | % up 12 m | P(≥ 10 % drop in 12 m) | P(≥ 20 %) | years |",
           "|---|---|---|---|---|---|---|---|---|"]
    out += [row(n, d[c]) for n, c in conds]
    feats = list(TODAY)
    z = (d[feats] - d[feats].mean()) / d[feats].std()
    t = (pd.Series(TODAY) - d[feats].mean()) / d[feats].std()
    t["cape"] = min(t["cape"], z["cape"].max())   # today's CAPE is above every month but 1999–2000; cap at the sample max
    dist = np.sqrt(((z - t) ** 2).sum(axis=1)).sort_values()
    pick, used = [], []
    for when in dist.index:   # one month per episode (≥ 12 m apart) so one era can't fill the list
        if all(abs((when.year * 12 + when.month) - (u.year * 12 + u.month)) > 12 for u in used):
            pick.append(when); used.append(when)
        if len(pick) == 12:
            break
    nn = d.loc[pick]
    out += ["", "12 nearest analog months (one per episode; features: off-high, Fed 3 m change, CPI, oil, 10y 12 m change, CAPE, EPS growth)", "",
            "| month | dist | off high | Fed 3 m | CPI | oil y/y | 10y Δ12 m | CAPE | EPS g | 6 m | 12 m | worst in 12 m |",
            "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for when, r in nn.iterrows():
        out.append(f"| {when:%Y-%m} | {dist[when]:.2f} | {r.dd12:+.0%} | {r.ff3:+.2f} | {r.cpi_yoy:.1%} | {np.exp(r.oil_yoy)-1:+.0%} | "
                   f"{r.y10_12:+.2f} | {r.cape:.0f} | {r.eps_g:+.0%} | {r.r6:+.1%} | {r.r12:+.1%} | {r.mdd12:+.1%} |")
    out.append("")
    out.append(row("12 analogs", nn).replace("| 12 analogs", "| **12 analogs summary**"))
    print("\n".join(out))


if __name__ == "__main__":
    main()
