#!/usr/bin/env python3
"""S185 / A390 test — does per-name 30-DTE skew pick option trades that pay? (real quote mids, not model prices)

Pre-registered 2026-11-10, written before any skew_daily row existed:
  Data      skew_daily (s185_skew_history.py) + lse_option_greeks_daily mids; spot/expiry close = lseg daily_history.
  Entries   first trading day of each week, 2025-10-06 → last week whose expiry has a close.
  Trades    per name-week, on the skew_daily expiry (nearest 30 DTE, 14–50):
            short put = ladder put with |Δ| nearest 0.20 (0.10–0.32), sold at mid × 0.95, held to expiry:
                        ret = (credit − max(K − S_T, 0)) / K   (per $ collateral)
            long call = ladder call with Δ nearest 0.50 (0.38–0.62), bought at mid × 1.05, held to expiry:
                        ret = max(S_T − K, 0) / debit − 1      (per $ debit)
  Features  smirk = IV(25Δp) − IV(ATM); rr25 = IV(25Δc) − IV(25Δp); cw = IV(ATMc) − IV(ATMp) (Cremers–Weinbaum);
            control ivrv = IV(ATM) / RV20.
  Puts      within-week Spearman IC of smirk and rr25 vs put ret, and the partial IC after ranking out ivrv.
            PASS: |mean IC| ≥ 0.03, t ≥ 2 over non-overlapping 4-week origins, same sign in both halves.
  Calls     top fifth by cw minus all calls that week; month-block t. PASS: > 0, t ≥ 2, both halves > 0.
  Halves    split 2026-05-01. n_indep ≈ months; < 30 → UNDERPOWERED.
Packet → artifacts/api-server/out/opt/S185.md
"""
from __future__ import annotations

import math
import sys
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import lse_client as L  # noqa: E402

SPLIT = pd.Timestamp("2026-05-01")
OUT = ROOT / "artifacts/api-server/out/opt/S185.md"


def load(conn):
    sk = pd.DataFrame(conn.execute("SELECT ticker, date, expiry, iv_atm, cw, rr25, smirk FROM skew_daily").fetchall(),
                      columns=["t", "d", "e", "iv_atm", "cw", "rr25", "smirk"])
    g = pd.DataFrame(conn.execute("""SELECT ticker, date, expiry, side, strike::float8, delta, option_price
                                     FROM lse_option_greeks_daily WHERE option_price >= 0.05""").fetchall(),
                     columns=["t", "d", "e", "side", "k", "delta", "px"])
    names = sorted(sk["t"].unique().tolist())
    px = pd.DataFrame(conn.execute("""SELECT ticker, date, close FROM lseg_research.daily_history
                                      WHERE ticker = ANY(%s) AND date >= '2025-08-01' AND close > 0""", (names,)).fetchall(),
                      columns=["t", "d", "c"])
    for df in (sk, g, px):
        df["d"] = pd.to_datetime(df["d"])
    for df in (sk, g):
        df["e"] = pd.to_datetime(df["e"])
    return sk, g, px


def main() -> None:
    conn = L.connect()
    sk, g, px = load(conn)
    px = px.sort_values(["t", "d"])
    px["rv20"] = px.groupby("t")["c"].transform(lambda s: np.log(s).diff().rolling(20).std() * math.sqrt(252))
    close = {(t, d): c for t, d, c in px[["t", "d", "c"]].itertuples(index=False)}
    rv = {(t, d): v for t, d, v in px[["t", "d", "rv20"]].itertuples(index=False)}
    last_px = px["d"].max()

    sk["wk"] = sk["d"].dt.to_period("W-SUN")
    ent = sk.sort_values("d").groupby(["t", "wk"]).head(1)          # first trading day of each week per name
    ent = ent[ent["e"] <= last_px]
    gi = g.set_index(["t", "d", "e"]).sort_index()

    def settle(t, e):
        for k in range(4):                                         # expiry close (holiday → prior session)
            c = close.get((t, e - pd.Timedelta(days=k)))
            if c:
                return c
        return None

    rows = []
    for r in ent.itertuples(index=False):
        try:
            ch = gi.loc[(r.t, r.d, r.e)]
        except KeyError:
            continue
        st = settle(r.t, r.e)
        if st is None:
            continue
        pr = {"t": r.t, "d": r.d, "smirk": r.smirk, "rr25": r.rr25, "cw": r.cw,
              "ivrv": (r.iv_atm / rv[(r.t, r.d)]) if rv.get((r.t, r.d)) else np.nan}
        p = ch[(ch["side"] == "put") & ch["delta"].abs().between(0.10, 0.32)]
        if len(p):
            q = p.iloc[(p["delta"].abs() - 0.20).abs().argmin()]
            pr["put"] = (q["px"] * 0.95 - max(q["k"] - st, 0.0)) / q["k"]
        c = ch[(ch["side"] == "call") & ch["delta"].between(0.38, 0.62)]
        if len(c):
            q = c.iloc[(c["delta"] - 0.50).abs().argmin()]
            pr["call"] = max(st - q["k"], 0.0) / (q["px"] * 1.05) - 1.0
        rows.append(pr)
    T = pd.DataFrame(rows)
    T["o"] = T["d"].dt.to_period("W-SUN")
    T["m"] = T["d"].dt.to_period("M")
    T["half"] = np.where(T["d"] < SPLIT, "H1", "H2")
    lines = [f"# S185 — per-name 30-DTE skew as a put/call selection feature (A390)", "",
             f"Run {date.today()} · {T['t'].nunique()} names · {T['o'].nunique()} weeks · put trades {T['put'].notna().sum()}"
             f" · call trades {T['call'].notna().sum()} · real quote mids (LSE greeks), 5 % haircut, held to expiry.", ""]

    def tstat(x):
        x = pd.Series(x).dropna()
        return (x.mean() / (x.std(ddof=1) / math.sqrt(len(x)))) if len(x) > 2 and x.std() > 0 else float("nan")

    def ic_series(col, y, partial=False):
        out = {}
        for o, w in T.dropna(subset=[col, y] + (["ivrv"] if partial else [])).groupby("o"):
            if len(w) < 15:
                continue
            a, b = w[col].rank(), w[y].rank()
            if partial:
                z = w["ivrv"].rank()
                a = a - np.polyval(np.polyfit(z, a, 1), z)
                b = b - np.polyval(np.polyfit(z, b, 1), z)
            out[o] = float(np.corrcoef(a, b)[0, 1])
        return pd.Series(out).sort_index()

    lines += ["## Puts (0.20Δ short put, ret per $ collateral)", "", "| feature | mean IC | t (4-wk origins) | H1 | H2 | weeks | verdict |",
              "|---|---|---|---|---|---|---|"]
    verdicts = {}
    for col, part in [("smirk", False), ("rr25", False), ("ivrv", False), ("smirk", True), ("rr25", True)]:
        s = ic_series(col, "put", part)
        if s.empty:
            continue
        nonov = s.iloc[::4]
        h1, h2 = s[s.index.start_time < SPLIT].mean(), s[s.index.start_time >= SPLIT].mean()
        ok = abs(s.mean()) >= 0.03 and abs(tstat(nonov)) >= 2 and np.sign(h1) == np.sign(h2) == np.sign(s.mean())
        name = col + (" | ivrv" if part else "")
        verdicts[name] = ok
        lines.append(f"| {name} | {s.mean():+.3f} | {tstat(nonov):+.2f} | {h1:+.3f} | {h2:+.3f} | {len(s)} | {'PASS' if ok else 'fail'} |")

    lines += ["", "## Calls (0.50Δ long call, ret per $ debit)", "",
              "| sort | top-fifth − all (mean/wk) | month t | H1 | H2 | top win % | all win % | verdict |", "|---|---|---|---|---|---|---|---|"]
    C = T.dropna(subset=["call"])
    for col, sign in [("cw", 1), ("rr25", 1), ("smirk", -1)]:
        w = C.dropna(subset=[col]).copy()
        w["top"] = w.groupby("o")[col].transform(lambda s: (sign * s) >= (sign * s).quantile(0.8))
        wk = w.groupby("o").apply(lambda x: x.loc[x["top"], "call"].mean() - x["call"].mean()).dropna()
        mo = wk.groupby(wk.index.asfreq("M")).mean()
        h1, h2 = wk[wk.index.start_time < SPLIT].mean(), wk[wk.index.start_time >= SPLIT].mean()
        ok = wk.mean() > 0 and tstat(mo) >= 2 and h1 > 0 and h2 > 0
        verdicts[f"calls top {col}"] = ok
        lines.append(f"| {'high' if sign > 0 else 'low'} {col} | {wk.mean():+.3f} | {tstat(mo):+.2f} | {h1:+.3f} | {h2:+.3f} | "
                     f"{100*(w.loc[w['top'],'call']>0).mean():.0f} | {100*(w['call']>0).mean():.0f} | {'PASS' if ok else 'fail'} |")

    n_indep = T["m"].nunique()
    lines += ["", f"Independent episodes (n_indep, months): {n_indep} → {'UNDERPOWERED' if n_indep < 30 else 'ok'}.", "",
              "## Winner pass", "",
              "Winners = top decile of each week's put / call trades. Median feature, winners vs all:", "",
              "| trade | feature | winners | all |", "|---|---|---|---|"]
    for y in ("put", "call"):
        w = T.dropna(subset=[y]).copy()
        w["win"] = w.groupby("o")[y].transform(lambda s: s >= s.quantile(0.9))
        for col in ("smirk", "rr25", "cw", "ivrv"):
            lines.append(f"| {y} | {col} | {w.loc[w['win'], col].median():+.3f} | {w[col].median():+.3f} |")
    passed = [k for k, v in verdicts.items() if v]
    lines += ["", f"Verdict: RULE weekly entry × 30-DTE hold-to-expiry × (0.20Δ short put ranked by smirk/rr25 | 0.50Δ long call "
              f"top fifth by cw/rr25) — {'PASS on ' + ', '.join(passed) if passed else 'no feature passes'}; "
              f"{'UNDERPOWERED' if n_indep < 30 else 'powered'} ({n_indep} months)."]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
