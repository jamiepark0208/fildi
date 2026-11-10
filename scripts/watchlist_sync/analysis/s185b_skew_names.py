#!/usr/bin/env python3
"""S185b — proof run on Jamie's option names: does each name's skew vs its own history time short option holds?

Pre-registered 2026-11-10 (before data): names = Jamie's watchlist (59) + traded SPCE + SPY/QQQ (Jamie 11-10: 'mostly the tickers in my watchlist').
  Trades (real LSE quote mids, same contract held): long ATM call (Δ nearest 0.50) and long put (|Δ| nearest 0.30),
  30-DTE expiry from skew_daily; buy mid × 1.05 on day d, sell mid × 0.95 on day d+h, h ∈ {1, 3, 5} sessions.
  Feature z = (x − mean) / sd over the name's prior 40 skew days (≥ 20), x ∈ {rr25, smirk, cw, iv_atm}.
  Buckets low z ≤ −1 · mid · high z ≥ +1.  Test = high − low mean ret at h = 5 on non-overlapping 5-day origins,
  PASS: |t| ≥ 2 and same sign in both halves (split 2026-05-01).
  Amended 11-10 before the pooled run (Jamie: H1-26 bull, Oct→Nov selloff in both 2025 and 2026; calendar halves mix regimes):
  regime = QQQ 20-session return at entry (up ≥ 0 / down < 0). Rev 2 (Jamie: the right skew trade DEPENDS on regime — never
  require one sign across regimes): every feature is tested INSIDE each regime. Cell PASS = |Welch t| ≥ 2 on every-5th-day
  trades AND same sign in both episodes of that regime (before / after 2026-05-01 = fall-25 vs fall-26 selloff for down).
  Pre-registered cells (mechanics, written before the pooled run):
    D1 down · smirk high → long put5 worse (put wing already bid = rich)        D2 down · iv_atm high → long call5 worse (vol crush on rebound)
    U1 up   · rr25 high  → long call5 worse (call wing bid = rich, chasers)      U2 up   · iv_atm low  → long call5 better (cheap vol in trend)
  Other 12 cells exploratory: 16 cells → ~1 false |t| ≥ 2 expected by chance. Also report the stock's own h-day return per bucket
  (is skew just a direction call?). n_indep ≈ months → UNDERPOWERED below 30.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2] / "scripts"))
import lse_client as L  # noqa: E402

NAMES = """AAOI AAPL ACHR AEP ALOY AMZN ASML ASTS BABA BB CABA CAVA CELH CRWV DRAM FSLY GEV GOOGL GOSS HOOD HUT INTC IOND IONQ
 IREN JOBY LICN MP MRVL MSFT NET NFLX NLR NOW NVDA OKLO ONDS OPEN PLTR POET RDDT RDW RGTI RKLB RUM SCHD SECZ SHOP SKHY SMCI SNOW
 SOFI SPCX TSLA TTD URA USAR VIST VRT SPCE SPY QQQ""".split()   # Jamie watchlist (59) + traded SPCE + index
SPLIT = pd.Timestamp("2026-05-01")
OUT = HERE.parent / "out/opt/S185b.md"
H = (1, 3, 5)
HC = float(__import__("os").environ.get("S185_HAIRCUT", "0.05"))   # per side; NVDA-class ATM ≈ 0.01


def main() -> None:
    c = L.connect()
    sk = pd.DataFrame(c.execute("SELECT ticker, date, expiry, spot, iv_atm, cw, rr25, smirk FROM skew_daily WHERE ticker = ANY(%s)",
                                (NAMES,)).fetchall(), columns=["t", "d", "e", "spot", "iv_atm", "cw", "rr25", "smirk"])
    g = pd.DataFrame(c.execute("""SELECT occ, ticker, date, expiry, side, delta, option_price FROM lse_option_greeks_daily
                                  WHERE ticker = ANY(%s) AND option_price >= 0.05""", (NAMES,)).fetchall(),
                     columns=["occ", "t", "d", "e", "side", "delta", "px"])
    for df in (sk, g):
        df["d"], df["e"] = pd.to_datetime(df["d"]), pd.to_datetime(df["e"])
    sk = sk.sort_values(["t", "d"]).reset_index(drop=True)
    for x in ("rr25", "smirk", "cw", "iv_atm"):
        m = sk.groupby("t")[x].transform(lambda s: s.shift(1).rolling(40, min_periods=20).mean())
        s = sk.groupby("t")[x].transform(lambda s: s.shift(1).rolling(40, min_periods=20).std())
        sk["z_" + x] = (sk[x] - m) / s
    sk["sret5"] = sk.groupby("t")["spot"].transform(lambda s: s.shift(-5) / s - 1)

    g = g.sort_values(["occ", "d"])
    for h in H:
        g[f"px{h}"] = g.groupby("occ")["px"].shift(-h)
        g[f"gap{h}"] = (g.groupby("occ")["d"].shift(-h) - g["d"]).dt.days
    rows = []
    gk = g.groupby(["t", "d", "e"])
    for r in sk.itertuples(index=False):
        try:
            ch = gk.get_group((r.t, r.d, r.e))
        except KeyError:
            continue
        rec = r._asdict()
        for side, tgt in (("call", 0.50), ("put", 0.30)):
            w = ch[(ch["side"] == side) & ch["delta"].notna()]
            if w.empty:
                continue
            q = w.iloc[(w["delta"].abs() - tgt).abs().argmin()]
            if abs(abs(q["delta"]) - tgt) > 0.15:
                continue
            for h in H:
                if pd.notna(q[f"px{h}"]) and q[f"gap{h}"] <= h * 1.6 + 3:      # same contract, no long data hole
                    rec[f"{side}{h}"] = q[f"px{h}"] * (1 - HC) / (q["px"] * (1 + HC)) - 1
        rows.append(rec)
    T = pd.DataFrame(rows)
    T["half"] = np.where(T["d"] < SPLIT, "H1", "H2")
    q = pd.DataFrame(c.execute("SELECT date, close FROM prices_historical WHERE ticker = 'QQQ' ORDER BY date").fetchall(), columns=["d", "c"])
    q["d"] = pd.to_datetime(q["d"]); q["c"] = q["c"].astype(float); q["r20"] = q["c"] / q["c"].shift(20) - 1
    T = T.merge(q[["d", "r20"]], on="d", how="left")
    T["reg"] = np.where(T["r20"] >= 0, "up", "down")
    T["k"] = T.groupby("t").cumcount()
    nm = T["d"].dt.to_period("M").nunique()
    L_ = [f"# S185b — skew vs own history → short option holds, Jamie's names", "",
          f"{T['t'].nunique()} names ({', '.join(sorted(T['t'].unique()))}) · {len(T)} name-days · {T['d'].min():%Y-%m-%d} → "
          f"{T['d'].max():%Y-%m-%d} · real LSE quote mids, buy mid+{HC*100:.0f} % / sell mid−{HC*100:.0f} % · n_indep ≈ {nm} months "
          f"({'UNDERPOWERED' if nm < 30 else 'ok'}).", ""]
    L_ += ["Regime (QQQ 20d at entry): " + " · ".join(f"{rr} {(T['reg'] == rr).sum()} days: call5 {T.loc[T['reg'] == rr, 'call5'].mean()*100:+.1f} % · put5 "
                                                     f"{T.loc[T['reg'] == rr, 'put5'].mean()*100:+.1f} %" for rr in ("up", "down")), ""]
    L_ += [f"Baseline (all days): " + " · ".join(f"{s}{h} {T[f'{s}{h}'].mean()*100:+.1f} %" for s in ("call", "put") for h in H if f"{s}{h}" in T), ""]

    def t5(diff_by_day):
        x = diff_by_day.dropna().iloc[::5]
        return x.mean() / (x.std(ddof=1) / math.sqrt(len(x))) if len(x) > 3 and x.std() > 0 else float("nan")

    verdict = []
    for x in ("rr25", "smirk", "cw", "iv_atm"):
        z = T["z_" + x]
        T["b"] = np.select([z <= -1, z >= 1], ["low", "high"], "mid")
        T.loc[z.isna(), "b"] = None
        L_ += [f"## {x} (z vs own 40 days)", "", "| bucket | n | " + " | ".join(f"{s}{h}" for s in ("call", "put") for h in H) + " | stock 5d |",
               "|---" * (3 + 2 * len(H)) + "|"]
        for b in ("low", "mid", "high"):
            w = T[T["b"] == b]
            L_.append(f"| {b} | {len(w)} | " + " | ".join(f"{w[f'{s}{h}'].mean()*100:+.1f} %" if f"{s}{h}" in w else "–"
                                                         for s in ("call", "put") for h in H) + f" | {w['sret5'].mean()*100:+.1f} % |")
        for s in ("call", "put"):
            col = f"{s}5"
            ni = T[T["k"] % 5 == 0]
            for rr in ("up", "down"):
                hl = lambda m: T[m & (T["reg"] == rr) & (T["b"] == "high")][col].mean() - T[m & (T["reg"] == rr) & (T["b"] == "low")][col].mean()  # noqa: E731
                hv = [hl(T["half"] == hh) for hh in ("H1", "H2")]
                w_ = ni[ni["reg"] == rr]
                a_, b_ = w_.loc[w_["b"] == "high", col].dropna(), w_.loc[w_["b"] == "low", col].dropna()
                tt = (a_.mean() - b_.mean()) / math.sqrt(a_.var() / len(a_) + b_.var() / len(b_)) if len(a_) > 2 and len(b_) > 2 else float("nan")
                ok = abs(tt) >= 2 and np.sign(hv[0]) == np.sign(hv[1])
                pre = {("smirk", "put", "down"): "D1 expect −", ("iv_atm", "call", "down"): "D2 expect −",
                       ("rr25", "call", "up"): "U1 expect −", ("iv_atm", "call", "up"): "U2 expect − (low better)"}.get((x, s, rr), "explor.")
                L_.append(f"\n{s}5 · QQQ-{rr} · high − low {hl(T['half'].notna())*100:+.1f} % · ep1 {hv[0]*100:+.1f} % · ep2 {hv[1]*100:+.1f} % · "
                          f"t {tt:+.2f} (n {len(a_)}/{len(b_)}) · {pre} → {'PASS' if ok else 'fail'}")
                if ok:
                    verdict.append(f"{x}→{s} in {rr} tape ({'high' if tt > 0 else 'low'} z better; {pre})")
            continue
            if ok:
                verdict.append(f"{x}→{s} ({'high' if hv[0] > 0 else 'low'} z better)")
        L_.append("")
    last = sk.sort_values("d").groupby("t").tail(1)
    L_ += ["## Today's read (latest skew day per name)", "", "| name | date | IV atm | rr25 | z | smirk | z | cw |", "|---|---|---|---|---|---|---|---|"]
    for r in last.itertuples(index=False):
        f = lambda v, p=1: "–" if pd.isna(v) else f"{v*100:+.{p}f}"  # noqa: E731
        L_.append(f"| {r.t} | {r.d:%m-%d} | {r.iv_atm*100:.0f} | {f(r.rr25)} | {'–' if pd.isna(r.z_rr25) else f'{r.z_rr25:+.1f}'} | "
                  f"{f(r.smirk)} | {'–' if pd.isna(r.z_smirk) else f'{r.z_smirk:+.1f}'} | {f(r.cw)} |")
    w = T.dropna(subset=["call5"]).copy()
    w["win"] = w["call5"] >= w["call5"].quantile(0.9)
    L_ += ["", "## Winner pass", "", "Winners = top decile 5-day call holds. Median z, winners vs all: " +
           " · ".join(f"{x} {w.loc[w['win'], 'z_'+x].median():+.2f} vs {w['z_'+x].median():+.2f}" for x in ("rr25", "smirk", "cw", "iv_atm")), "",
           f"Verdict: RULE skew-z bucket entry × 1/3/5-session hold × long ATM call / 0.30Δ put on Jamie's names — "
           f"{'PASS: ' + '; '.join(verdict) if verdict else 'no skew feature separates winners'}; independent episodes ≈ {nm} months → "
           f"{'UNDERPOWERED' if nm < 30 else 'powered'}."]
    OUT.write_text("\n".join(L_) + "\n")
    print("\n".join(L_))


if __name__ == "__main__":
    main()
