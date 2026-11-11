#!/usr/bin/env python3
"""Rec scoreboard (Jamie 11-10: "how can you not verify and measure if any of it changed a trade I made or a model rec?").

Runs every session from agent_start. Three questions, same window, same grading:
  1. Did Fildi change a trade?   Jamie's short-put opens matched to put-engine PASS / Model List recs (same contract or name only).
  2. Did the recs make money?     short put P&L at expiry (or last close if open) = premium − intrinsic, as % of strike.
  3. Where did they lose?          by regime (QQQ 20d), by sector bucket, top losing names.
Grading guard: a rec whose spot differs from the table close that day by > 35 % is skipped (split / bad print), counted in 'skipped'.
Usage: python3 scripts/rec_scoreboard.py [--days 28] [--brief]
"""
from __future__ import annotations

import argparse
import sys
import warnings
from pathlib import Path

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import lse_client as L  # noqa: E402

SEMIS = set("MRVL INTC STX MU AMD NVDA AVGO SNDK WDC LRCX AMAT KLAC ASML TSM QCOM SMH SOXX ARM ON TXN MCHP ADI".split())


def q(c, s, a=()):
    cur = c.execute(s, a)
    return pd.DataFrame(cur.fetchall(), columns=[d.name for d in cur.description])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=28)
    ap.add_argument("--brief", action="store_true", help="3-line digest for agent_start")
    a = ap.parse_args()
    c = L.connect()
    since = (pd.Timestamp.today().normalize() - pd.Timedelta(days=a.days)).date()

    jam = q(c, """SELECT DISTINCT ON (order_id) created_at::date d, symbol t, option_strike::float k, option_expiration e, avg_fill_price::float px
                  FROM portfolio_orders WHERE created_at >= %s AND state = 'filled' AND is_option AND option_side = 'put'
                  AND side = 'credit' AND leg_effect = 'open' ORDER BY order_id, created_at""", (since,))
    eng_all = q(c, """SELECT as_of d, ticker t, pass, (payload->>'strike')::float k, (payload->>'expiry')::date e,
                      (payload->>'bid')::float bid, (payload->>'ask')::float ask, (payload->>'spot')::float spot
                      FROM watchlist_sync.put_recs_daily WHERE as_of >= %s""", (since,))
    eng = eng_all[eng_all["pass"]].copy()
    eng["px"] = eng["bid"] + 0.1 * (eng["ask"] - eng["bid"])            # realistic fill: bid + 10 % of spread
    ml = q(c, """SELECT snapshot_date d, ticker t, strike::float k, expiry e, premium::float px, spot::float spot
                 FROM model_recs WHERE side = 'put' AND snapshot_date >= %s""", (since,))
    names = sorted(set(jam.t) | set(eng.t) | set(ml.t) | {"QQQ"})
    px = q(c, "SELECT ticker t, date, close::float c, low::float lo FROM prices_historical WHERE date >= %s AND ticker = ANY(%s)",
           (since - pd.Timedelta(days=40), names))
    px["date"] = pd.to_datetime(px["date"])
    last = px["date"].max()
    P = {t: g.set_index("date").sort_index() for t, g in px.groupby("t")}
    qq = P["QQQ"]["c"]
    r20 = qq / qq.shift(20) - 1

    def grade(df: pd.DataFrame) -> pd.DataFrame:
        df = df.copy()
        df["d"], df["e"] = pd.to_datetime(df["d"]), pd.to_datetime(df["e"])
        ret, touch, exp, reg, skip = [], [], [], [], []
        for r in df.itertuples():
            g = P.get(r.t)
            w = None if g is None else g[(g.index > r.d) & (g.index <= min(r.e, last))]
            d0 = None if g is None else g[g.index <= r.d]
            bad = (w is None or w.empty or d0 is None or d0.empty or
                   (hasattr(r, "spot") and pd.notna(r.spot) and abs(d0["c"].iloc[-1] / r.spot - 1) > 0.35))
            skip.append(bad)
            if bad:
                ret.append(np.nan); touch.append(np.nan); exp.append(np.nan); reg.append(None); continue
            s = w["c"].iloc[-1]
            ret.append((r.px - max(0.0, r.k - s)) / r.k * 100)
            touch.append(float(w["lo"].min() < r.k))
            exp.append(float(r.e <= last))
            rv = r20[r20.index <= r.d]
            reg.append("up" if len(rv) and rv.iloc[-1] >= 0 else "down")
        df["ret"], df["touched"], df["expired"], df["reg"], df["skip"] = ret, touch, exp, reg, skip
        return df

    J, E, M = grade(jam), grade(eng), grade(ml)

    def match(r, src):
        w = src[(src.t == r.t) & (pd.to_datetime(src.d) <= r.d) & (pd.to_datetime(src.d) >= r.d - pd.Timedelta(days=4))]
        if w.empty:
            return "none"
        same = (pd.to_datetime(w.e) == r.e) & ((w.k - r.k).abs() <= max(0.5, 0.03 * r.k))
        return "same" if same.any() else "name"
    J["m_eng"] = [match(r, eng) for r in J.itertuples()]
    J["m_ml"] = [match(r, M) for r in J.itertuples()]

    def line(nm, df):
        w = df.dropna(subset=["ret"])
        if w.empty:
            return f"{nm}: no graded rows"
        return (f"{nm}: n {len(w)} ({w.t.nunique()} names, {int(w.expired.sum())} expired, {int(df.skip.sum())} skipped) · "
                f"{w.ret.mean():+.2f} % of strike · win {(w.ret > 0).mean():.0%} · strike touched {w.touched.mean():.0%} · worst {w.ret.min():+.1f} %")

    adopt = (f"Fildi → Jamie trades: {len(J)} short-put opens · engine same contract {(J.m_eng == 'same').sum()} / name {(J.m_eng == 'name').sum()}"
             f" · Model List same {(J.m_ml == 'same').sum()} / name {(J.m_ml == 'name').sum()}")
    lines = [f"REC SCOREBOARD since {since} (prices to {last:%m-%d})", adopt, line("Jamie puts", J), line("Engine PASS", E), line("Model List puts", M)]
    # Engine vs Jamie on the overlap window
    if len(J.dropna(subset=["ret"])) and len(E.dropna(subset=["ret"])):
        e0 = E["d"].min()
        jw = J[(J.d >= e0)].dropna(subset=["ret"])
        if len(jw):
            gap = E.dropna(subset=["ret"]).ret.mean() - jw.ret.mean()
            lines.append(f"Engine − Jamie (same window from {e0:%m-%d}): {gap:+.2f} pts of strike (Jamie n {len(jw)})"
                         + ("  ← ENGINE TRAILS JAMIE: fix the producer before any new study" if gap < 0 else ""))
    if a.brief:
        print("\n".join(lines[:2] + lines[-1:] if len(lines) > 5 else lines[:3]))
        return
    for nm, df in (("Engine PASS", E), ("Model List puts", M), ("Jamie puts", J)):
        w = df.dropna(subset=["ret"])
        if w.empty:
            continue
        lines.append(f"\n{nm} by regime: " + " · ".join(f"{k} n {len(g)} {g.ret.mean():+.2f} %" for k, g in w.groupby("reg")))
        lines.append(f"{nm} semis vs rest: semis n {w.t.isin(SEMIS).sum()} {w[w.t.isin(SEMIS)].ret.mean():+.2f} % · "
                     f"rest n {(~w.t.isin(SEMIS)).sum()} {w[~w.t.isin(SEMIS)].ret.mean():+.2f} %")
        worst = w.groupby("t").ret.agg(["size", "sum"]).sort_values("sum").head(5)
        lines.append(f"{nm} worst names (sum % of strike): " + " · ".join(f"{t} {r['sum']:+.1f} (n {int(r['size'])})" for t, r in worst.iterrows()))
    # producer health: days with zero passes / no model_recs
    ed = set(pd.to_datetime(eng_all.d)); md = set(pd.to_datetime(ml.d))
    de = pd.bdate_range(min(ed), last) if ed else []
    wk = sorted({d.to_period("W") for d in md})
    miss_w = [w for w in pd.period_range(min(md).to_period("W"), last.to_period("W") - 1, freq="W") if w not in wk] if md else []
    lines.append(f"\nProducer gaps: put engine missing {sum(d not in ed for d in de)} business days · engine 0-pass "
                 f"{sum((d in ed) and d not in set(pd.to_datetime(eng.d)) for d in de)} · Model List (weekly Fri snapshot) missing weeks {len(miss_w)}"
                 + (f" ({', '.join(str(w.start_time.date())[5:] for w in miss_w)})" if miss_w else ""))
    ung = q(c, "SELECT count(*) n FROM model_recs WHERE expiry < CURRENT_DATE - 1 AND status = 'PENDING'").n.iloc[0]
    lines.append(f"Model List expired but ungraded: {ung}")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
