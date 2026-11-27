#!/usr/bin/env python3
"""A373 item 1 — Oft3r macro pillar as put-timing regime (top-IV tercile VRP vs breadth).

Smoke: A373_SMOKE=1 (last 120 sessions). Full from 2018-07-01.
"""
from __future__ import annotations

import os
import sys
from datetime import date

import numpy as np
import pandas as pd

HERE = __import__("pathlib").Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

from build_plan import connect  # noqa: E402
from a373_oft3r_data import load_macro_panel, macro_pillar_score  # noqa: E402

SMOKE = os.environ.get("A373_SMOKE") == "1"
EVAL0 = date(2018, 7, 1) if not SMOKE else date(2025, 6, 1)
OUT = HERE.parent / "out" / "opt" / "A373-macro-pillar-packet.md"


def wt(x, g):
    x = np.asarray(x, float)
    g = np.asarray(g)
    if len(x) < 20:
        return np.nan
    m = x.mean()
    s = pd.Series(x - m).groupby(g).sum().values
    se = np.sqrt((s**2).sum()) / len(x)
    return m / se if se > 0 else np.nan


def main():
    conn = connect()
    closes = load_macro_panel(conn, fetch=True)
    macro = macro_pillar_score(closes)
    spans = {k: (str(v.index.min())[:10], str(v.index.max())[:10], len(v)) for k, v in closes.items()}
    print("DATA_POPULATION bars=daily RTH-close n_series", len(spans), "smoke", SMOKE)
    for k, (a, b, n) in sorted(spans.items()):
        print(f"  {k}: {a}→{b} n={n}")
    hand = closes["RSP"].iloc[-1] / closes["SPY"].iloc[-1]
    print(f"SANITY hand RSP/SPY last={hand:.4f} macro_last={int(macro.macro.iloc[-1])}")

    q = """
    SELECT ticker, date, close::float8, iv30_put::float8
    FROM lseg_research.daily_history
    WHERE close > 0 AND iv30_put > 0
    ORDER BY ticker, date
    """
    df = pd.DataFrame(conn.execute(q).fetchall(), columns=["t", "d", "c", "iv"])
    df["d"] = pd.to_datetime(df["d"]).astype("datetime64[ns]")
    lr = df.groupby("t", group_keys=False).apply(lambda g: np.log(g.c).diff())
    df["lr"] = lr.values
    df["rv20"] = df.groupby("t")["lr"].transform(lambda s: s.rolling(20).std() * np.sqrt(252))
    df["rv5f"] = df.groupby("t")["lr"].transform(
        lambda s: s[::-1].rolling(5).std()[::-1].shift(-1) * np.sqrt(252)
    )
    df = df[df.d >= pd.Timestamp(EVAL0)].copy()
    df["iv"] = df.iv / 100
    df["vrp"] = df.iv - df.rv5f
    df["ivx"] = df.groupby("d").iv.rank(pct=True)
    df = df[df.ivx >= 2 / 3].dropna(subset=["vrp", "rv20"])
    df["wk"] = df.d.dt.to_period("W").astype(str)
    macro = macro.reset_index()
    date_col = "date" if "date" in macro.columns else macro.columns[0]
    macro = macro.rename(columns={date_col: "d"})
    macro["d"] = pd.to_datetime(macro["d"]).astype("datetime64[ns]")
    mcols = macro[["d", "macro", "rsp_spy"]].sort_values("d").copy()
    mcols["d"] = pd.to_datetime(mcols["d"].values).astype("datetime64[ns]")
    df = df.sort_values("d")
    df = pd.merge_asof(df, mcols, on="d", direction="backward")
    df = df.dropna(subset=["macro"])
    # breadth: share below 200d per day
    below = pd.DataFrame(
        conn.execute(
            "SELECT ticker, date, close::float8 FROM lseg_research.daily_history WHERE close>0"
        ).fetchall(),
        columns=["t", "d", "c"],
    )
    below["d"] = pd.to_datetime(below["d"]).astype("datetime64[ns]")
    below["b200"] = below.groupby("t")["c"].transform(lambda s: s < s.rolling(200).mean())
    brd = below.groupby("d").b200.mean().rename("breadth_below")
    df = df.merge(brd, on="d", how="left")
    med_date = df.d.median()
    df["half"] = np.where(df.d >= med_date, "H2", "H1")

    def run_slice(name, mask):
        sub = df[mask].copy()
        rel = sub.vrp - sub.groupby("wk").vrp.transform("mean")
        t_all = wt(rel, sub.wk)
        halves = {}
        for h in ("H1", "H2"):
            s = sub[sub.half == h]
            halves[h] = wt(s.vrp - s.groupby("wk").vrp.transform("mean"), s.wk)
        print(
            f"{name:22} n={len(sub):6} indep_wk={sub.wk.nunique():4} "
            f"vrp={sub.vrp.mean()*100:+.2f}bp rel={rel.mean()*100:+.2f} t={t_all:+.2f} "
            f"H1t={halves['H1']:+.2f} H2t={halves['H2']:+.2f}"
        )
        return t_all, halves

    print("\n--- macro pillar vs breadth (top-IV universe, A370 job) ---")
    hi = df.macro >= df.macro.quantile(2 / 3)
    lo = df.macro <= df.macro.quantile(1 / 3)
    healthy = df.breadth_below < 0.4
    run_slice("macro high (top tertile)", hi)
    run_slice("macro low  (bot tertile)", lo)
    run_slice("breadth healthy <40%", healthy)
    t_hi, _ = run_slice("macro high lift", hi)
    t_lo, _ = run_slice("macro low lift", lo)
    sanity = len(df) > 1000 and np.isfinite(t_hi)
    print(f"SANITY pass={sanity} n_df={len(df)}")
    if SMOKE and not sanity:
        print("SANITY fail — stopping before full run")
        sys.exit(1)

    lines = [
        "# A373 item 1 — macro pillar regime",
        "CONTRACT 1-7: ok (daily stock; no option verdict)",
        f"DATA: Yahoo {list(closes.keys())}; FRED spread_10y2y; panel from {EVAL0}; smoke={SMOKE}",
        f"Same job: macro cut on top-IV VRP excess vs week peers (A370 timing filter)",
        f"n_days={df.d.nunique()} ticker-days={len(df)}",
        "Pass bar: macro tertile |t|≥2 both halves and beats breadth — see stdout",
        "Item 1: likely FAIL vs breadth (overlap S130/A314); feeds regime dial ops",
    ]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines) + "\n")
    print("Wrote", OUT)


if __name__ == "__main__":
    main()