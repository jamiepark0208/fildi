#!/usr/bin/env python3
"""S185d (A390 amendment 2026-11-18) — own-history put skew × short puts on LSEG expired-option history, 2021-02 → 2026-10.

Pre-registered in research/common/asks/A390.md before the data. S185c answered "can't answer" at 13 months; this is ~70.
  Entry   first session ≥ 30 d before each monthly expiry, one per name-month (holds don't overlap).
  Legs    P |Δ| 0.20 (the trade) + C Δ 0.25, strikes from split-adjusted spot + iv30 (BS); LSEG mids + IMP_VOLT.
  Feature putrich = IV(P20) − IV(C25); smirk = IV(P20) − iv30_put. z over prior 12 monthly obs (≥ 8); high z ≥ +0.84.
          Secondary: cross-section pct that month (≥ 20 names), high = top fifth.
  Regime  QQQ 20-session return at entry (up ≥ 0 / down < 0). Episodes split 2024-01-01.
  PASS    |t| over months ≥ 2 and same sign both episodes; < 30 high trades or < 8 months → can't answer.
  Fetch:  cd research/lseg && .venv/bin/python ../../scripts/watchlist_sync/analysis/s185d_lseg_skew.py --fetch
  Test:   same command without --fetch (cache only, no requests).
"""
from __future__ import annotations

import math
import sys
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[2] / "research" / "lseg"))
from build_plan import connect  # noqa: E402
from s049_panic_puts import split_factor, third_friday  # noqa: E402
from quantcore import bs as QB  # noqa: E402
from s185b_skew_names import NAMES  # noqa: E402
import option_prices as OP  # noqa: E402

FETCH = "--fetch" in sys.argv
REQ_CAP = next((int(a.split("=")[1]) for a in sys.argv if a.startswith("--cap=")), 6000)
OUT = HERE.parent / "out/opt/S185d.md"
SPLIT = date(2024, 1, 1)
Z_HI, LOOK, MIN_HIST = 0.84, 12, 8
SKIP = {"SPY", "QQQ"}


def strike_for(S, v, T, cp, target):
    lo, hi = (S * 0.4, S) if cp == "P" else (S, S * 2.5)
    for _ in range(50):
        k = (lo + hi) / 2
        dl = (QB.put_delta if cp == "P" else QB.call_delta)(spot=S, strike=k, iv=v, years=T)
        if cp == "P":
            lo, hi = (k, hi) if dl > target else (lo, k)   # put Δ rises toward 0 as K falls
        else:
            lo, hi = (k, hi) if dl > target else (lo, k)   # call Δ falls as K rises
    return (lo + hi) / 2


def leg(ld, conn, t, e, cp, K, d):
    """(strike, mid, iv) on day d for the nearest listed strike with a usable quote, else None."""
    for k in OP.candidates(conn, t, e, cp, K, None):
        try:
            h = OP.history(ld, conn, t, e, cp, k)
        except RuntimeError:  # cache-only miss
            continue
        if not h:
            continue
        r = next((x for x in h if x[0] == d), None)
        if r is None:
            return None  # contract exists but no quote that day → don't walk to a worse strike
        mid = r[3] or ((r[1] + r[2]) / 2 if r[1] is not None and r[2] is not None else None)
        iv = r[6]
        if not mid or mid < 0.05 or not iv:
            return None
        return k, mid, QB.iv_fraction(iv, unit="pct")  # LSEG IMP_VOLT is percent
    return None


def build(ld, conn):
    px = {}
    for t, d, c, ivp, ivc in conn.execute("""SELECT ticker, date, close::float, iv30_put::float, iv30_call::float
            FROM lseg_research.daily_history WHERE ticker = ANY(%s) AND close > 0 AND date >= '2020-12-01'
            ORDER BY ticker, date""", (NAMES + ["QQQ"],)).fetchall():
        px.setdefault(t, []).append((d, c, ivp, ivc))
    q = px["QQQ"]
    qd = [r[0] for r in q]
    qqq20 = {q[i][0]: q[i][1] / q[i - 20][1] - 1 for i in range(20, len(q))}
    exps = [third_friday(y, m) for y in range(2021, 2027) for m in range(1, 13)]
    exps = [e for e in exps if date(2021, 2, 1) <= e <= date(2026, 10, 31)]
    rows, stop = [], False
    for e in exps:  # chronological → a capped run still has full early history for z
        dd = next((x for x in qd if x >= e - timedelta(days=30)), None)
        if dd is None or dd not in qqq20:
            continue
        for t in NAMES:
            if t in SKIP or t not in px:
                continue
            if ld is not None and (ld.requests > REQ_CAP or ld.remaining < 200):
                print(f"stopped at {e} {t}: {ld.requests} requests (cap {REQ_CAP}); re-run continues from cache")
                stop = True
                break
            hist = px[t]
            day = next((r for r in hist if r[0] == dd), None)
            if day is None or not day[2] or not day[3]:
                continue
            fd = split_factor(conn, t, dd)
            if split_factor(conn, t, e) != fd:
                continue  # split inside the hold → contract terms changed
            S, T = day[1] * fd, (e - dd).days / 365
            p = leg(ld, conn, t, e, "P", strike_for(S, day[2] / 100, T, "P", -0.20), dd)
            if p is None:
                continue
            c = leg(ld, conn, t, e, "C", strike_for(S, day[3] / 100, T, "C", 0.25), dd)
            settle = next((r[1] * fd for r in reversed(hist) if r[0] <= e), None)
            if settle is None or (e - next(r[0] for r in reversed(hist) if r[0] <= e)).days > 4:
                continue
            rows.append(dict(t=t, d=dd, e=e, K=p[0], S=S, prem=p[1], ivp=p[2], ivc=c[2] if c else np.nan,
                             atm=day[2] / 100, intr=max(0.0, p[0] - settle), qqq20=qqq20[dd]))
        if stop:
            break
        print(f"{e}: {sum(1 for r in rows if r['e'] == e)} names" + (f" · {ld.requests} req" if ld is not None else ""), flush=True)
    return pd.DataFrame(rows)


def tstat(x):
    x = pd.Series(x).dropna()
    return float(x.mean() / (x.std(ddof=1) / math.sqrt(len(x)))) if len(x) > 2 and x.std() > 0 else float("nan")


def analyse(T: pd.DataFrame) -> str:
    T = T.sort_values(["t", "d"]).copy()
    T["putrich"] = T["ivp"] - T["ivc"]
    T["smirk"] = T["ivp"] - T["atm"]
    for col in ("putrich", "smirk"):
        g = T.groupby("t")[col]
        m = g.transform(lambda s: s.shift(1).rolling(LOOK, min_periods=MIN_HIST).mean())
        sd = g.transform(lambda s: s.shift(1).rolling(LOOK, min_periods=MIN_HIST).std())
        T[f"own_{col}"] = (T[col] - m) / sd
        cnt = T.groupby("e")[col].transform("count")
        T[f"xs_{col}"] = T.groupby("e")[col].rank(pct=True).where(cnt >= 20)
    T["regime"] = np.where(T["qqq20"] >= 0, "up", "down")
    T["ep"] = np.where(T["d"] < SPLIT, "E1", "E2")
    out = [f"# S185d — own-history put skew × short puts, LSEG 2021-02 → 2026-10 (A390 amendment 11-18)", "",
           f"{T['t'].nunique()} names · {T['e'].nunique()} monthly expiries · {len(T)} short puts · "
           f"putrich legs {T['putrich'].notna().sum()} · up {(T.regime == 'up').sum()} / down {(T.regime == 'down').sum()} entries", ""]
    verdicts = []
    for hc in (0.95, 0.98):
        T["ret"] = (T["prem"] * hc - T["intr"]) / T["K"]
        out += [f"## Fill = mid × {hc}", "", "| feature | regime | high n / all | months | high − rest /mo | t | E1 | E2 | high mean | rest mean | verdict |",
                "|---|---|---|---|---|---|---|---|---|---|---|"]
        for feat, thr in (("own_putrich", Z_HI), ("own_smirk", Z_HI), ("xs_putrich", 0.8), ("xs_smirk", 0.8)):
            for reg in ("down", "up"):
                w = T[T["regime"] == reg].dropna(subset=[feat]).copy()
                w["hi"] = w[feat] >= thr
                pv = w.pivot_table(index="e", columns="hi", values="ret", aggfunc="mean")
                mo = (pv[True] - pv[False]).dropna() if {True, False} <= set(pv.columns) else pd.Series(dtype=float)
                e1 = mo[[x < SPLIT for x in mo.index]]
                e2 = mo[[x >= SPLIT for x in mo.index]]
                nh, t_ = int(w["hi"].sum()), tstat(mo)
                if nh < 30 or len(mo) < 8:
                    v = f"can't answer (high n {nh}, {len(mo)} mo)"
                elif abs(t_) >= 2 and np.sign(e1.mean()) == np.sign(e2.mean()) == np.sign(mo.mean()):
                    v = "PASS " + ("H1 rich→sell" if mo.mean() > 0 else "H2 rich→avoid")
                else:
                    v = "fail"
                if hc == 0.95:
                    verdicts.append((feat, reg, v, mo.mean(), t_))
                out.append(f"| {feat} | {reg} | {nh} / {len(w)} | {len(mo)} | {mo.mean():+.2%} | {t_:+.2f} | {e1.mean():+.2%} | "
                           f"{e2.mean():+.2%} | {w.loc[w.hi, 'ret'].mean():+.2%} | {w.loc[~w.hi, 'ret'].mean():+.2%} | {v} |")
        out.append("")
    out.append("Returns = per $ strike per ~30-day hold. Months = monthly expiries with both buckets. E1 < 2024-01-01 ≤ E2.")
    passes = [x for x in verdicts if x[2].startswith("PASS")]
    own = [x for x in verdicts if x[0].startswith("own_")]
    out += ["", "Verdict: RULE monthly 0.20Δ ~30-DTE short put × skew z ≥ +0.84 (own 12 mo) inside QQQ-20d regime — " +
            ("; ".join(f"{f} {r}: {v} ({m:+.2%}/mo, t {t:+.1f})" for f, r, v, m, t in passes) if passes else
             "no cell passes at mid × 0.95 (" + "; ".join(f"{f} {r} {m:+.2%} t {t:+.1f}" for f, r, v, m, t in own) + ")")]
    return "\n".join(out)


def main():
    conn = connect()
    if FETCH:
        from _session import lseg_session
        with lseg_session() as ld:
            T = build(ld, conn)
    else:
        T = build(None, conn)
    if T.empty:
        print("no trades")
        return
    T.to_csv(HERE.parent / "out/opt/S185d_trades.csv", index=False)
    md = analyse(T)
    OUT.write_text(md + "\n")
    print(md)


if __name__ == "__main__":
    main()
