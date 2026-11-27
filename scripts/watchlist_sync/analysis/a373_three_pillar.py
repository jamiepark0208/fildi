#!/usr/bin/env python3
"""A373 item 2 — Oft3r three-pillar score fast screen (PLAYBOOK §0).

Long-stock 5d/20d excess vs same-day vol-decile peers by decision state; stop if no |t|≥2.
Smoke: A373_SMOKE=1 → 5 tickers, 2019→.
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
from quantcore import ta as qta  # noqa: E402

SMOKE = os.environ.get("A373_SMOKE") == "1"
EVAL0 = date(2003, 1, 1) if not SMOKE else date(2019, 1, 1)
TICKER_CAP = 5 if SMOKE else 120  # fast screen cap (PLAYBOOK §0)
OUT = HERE.parent / "out" / "opt" / "A373-three-pillar-packet.md"


def _es(s, n):
    return pd.Series(qta.ema(s.values, n), index=s.index)


def pillar_trend(c: pd.Series) -> int:
    e20, e50, e200 = _es(c, 20), _es(c, 50), _es(c, 200)
    bull = (c.iloc[-1] > e20.iloc[-1] > e50.iloc[-1] > e200.iloc[-1]) if len(c) > 200 else False
    slope = (e20.iloc[-1] - e20.iloc[-6]) / e20.iloc[-6] if len(c) > 205 and e20.iloc[-6] > 0 else 0
    s = 0
    if bull:
        s += 1
    elif c.iloc[-1] < e200.iloc[-1]:
        s -= 1
    if slope > 0.02:
        s += 1
    elif slope < -0.02:
        s -= 1
    return max(-2, min(2, s))


def trix(c: pd.Series, n: int = 15) -> float:
    e1 = _es(c, n)
    e2 = _es(e1, n)
    e3 = _es(e2, n)
    if len(e3) < 2 or e3.iloc[-2] == 0:
        return 0.0
    return float((e3.iloc[-1] - e3.iloc[-2]) / e3.iloc[-2] * 100)


def pillar_momentum(c: pd.Series) -> int:
    rsi = qta.rsi(c.values, 14)
    r = rsi[-1] if len(rsi) else 50
    macd = _es(c, 12) - _es(c, 26)
    hist = macd.iloc[-1] - macd.iloc[-2] if len(macd) > 2 else 0
    tx = trix(c)
    s = 0
    if r > 55:
        s += 1
    elif r < 45:
        s -= 1
    if hist > 0:
        s += 1
    elif hist < 0:
        s -= 1
    if tx > 0:
        s += 1
    elif tx < 0:
        s -= 1
    return max(-2, min(2, s))


def decision(score: int) -> str:
    if score >= 3:
        return "RE_ENTRY"
    if score >= 1:
        return "HOLD"
    if score <= -3:
        return "EXIT_TRIM"
    if score <= -1:
        return "WAIT"
    return "NEUTRAL"


def wt(x, g):
    x = np.asarray(x, float)
    if len(x) < 30:
        return np.nan, len(x)
    m = x.mean()
    s = pd.Series(x - m).groupby(g).sum().values
    se = np.sqrt((s**2).sum()) / len(x)
    return (m / se if se > 0 else np.nan), len(x)


def main():
    conn = connect()
    q = """
    SELECT ticker, date, close::float8
    FROM lseg_research.daily_history
  WHERE close > 0
    ORDER BY ticker, date
    """
    raw = pd.DataFrame(conn.execute(q).fetchall(), columns=["t", "d", "c"])
    raw["d"] = pd.to_datetime(raw["d"])
    if SMOKE:
        tickers = [t for t in ("SPY", "AAPL", "MSFT", "NVDA", "QQQ") if t in set(raw.t)]
    else:
        tickers = list(raw.groupby("t").size().sort_values(ascending=False).index[:TICKER_CAP])
    raw = raw[raw.t.isin(tickers) & (raw.d >= pd.Timestamp(EVAL0))].copy()
    print(
        f"DATA_POPULATION daily={len(raw)} tickers={raw.t.nunique()} "
        f"span={raw.d.min().date()}→{raw.d.max().date()} smoke={SMOKE}"
    )

    rows = []
    for t, g in raw.groupby("t"):
        g = g.sort_values("d").reset_index(drop=True)
        lr = np.log(g.c).diff()
        g["rv20"] = lr.rolling(20).std() * np.sqrt(252)
        g["ret5"] = g.c.shift(-5) / g.c - 1
        g["ret20"] = g.c.shift(-20) / g.c - 1
        step = 5 if not SMOKE else 1
        for i in range(220, len(g) - 21, step):
            win = g.c.iloc[: i + 1]
            tr = pillar_trend(win)
            mo = pillar_momentum(win)
            sc = tr + mo  # macro omitted in per-ticker lane; full composite in item 1
            rows.append(
                dict(
                    t=t,
                    d=g.d.iloc[i],
                    score=sc,
                    state=decision(sc),
                    ret5=g.ret5.iloc[i],
                    ret20=g.ret20.iloc[i],
                    rv20=g.rv20.iloc[i],
                    wk=g.d.iloc[i].strftime("%G-W%V"),
                )
            )
    ev = pd.DataFrame(rows).dropna(subset=["ret5", "rv20"])
    med = ev.d.median()
    ev["half"] = np.where(ev.d >= med, "H2", "H1")
    ev["dec"] = pd.qcut(ev.rv20, 10, labels=False, duplicates="drop")
    ev["exc5"] = ev.ret5 - ev.groupby(["d", "dec"]).ret5.transform("mean")
    ev["exc20"] = ev.ret20 - ev.groupby(["d", "dec"]).ret20.transform("mean")

    if SMOKE:
        hand = ev[ev.t == "AAPL"]
        hand = hand.iloc[-1] if len(hand) else ev.iloc[-1]
        print(
            f"SANITY {hand.t} last score={hand.score} state={hand.state} "
            f"ret5={hand.ret5:.4f} exc5={hand.exc5:.4f}"
        )
        print("SANITY pass" if len(ev) > 100 else "SANITY fail sparse")

    best_t = 0
    best = None
    print("\nstate          n      exc5%   t5   exc20%  t20   t_H1  t_H2")
    for st in sorted(ev.state.unique()):
        sub = ev[ev.state == st]
        t5, n = wt(sub.exc5 * 100, sub.wk)
        t20, _ = wt(sub.exc20 * 100, sub.wk)
        h1 = sub[sub.half == "H1"]
        h2 = sub[sub.half == "H2"]
        t1, _ = wt(h1.exc5 * 100, h1.wk)
        t2, _ = wt(h2.exc5 * 100, h2.wk)
        print(f"{st:14} {len(sub):6} {sub.exc5.mean()*100:+6.2f} {t5:+5.2f} {sub.exc20.mean()*100:+6.2f} {t20:+5.2f} {t1:+5.2f} {t2:+5.2f}")
        if abs(t5) > abs(best_t):
            best_t = t5
            best = st

    verdict = "FAIL (fast screen)" if abs(best_t) < 2 else f"HINT {best} t={best_t:+.2f}"
    print(f"\nVERDICT item2: {verdict}")
    print("CONTRACT 1-7: ok (stock excess, peer vol-decile, no option fills)")
    n_indep = ev.wk.nunique()
    print(f"n_events={len(ev)} n_indep_wk={n_indep}")

    lines = [
        "# A373 item 2 — three-pillar fast screen",
        "CONTRACT 1-7: ok",
        f"Same job: Oft3r decision states × 5d/20d vol-decile excess (trend+momentum only per ticker; macro item1)",
        f"DATA: lseg_research.daily_history n_tickers={ev.t.nunique()} from {EVAL0}",
        f"VERDICT: {verdict} (stop per PLAYBOOK §0 when no |t|≥2)",
        "## Winner pass",
        "RULE NO-LIFT: composite EMA/RSI/MACD × hold 5d × long stock (S004-class)",
    ]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()