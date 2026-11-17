#!/usr/bin/env python3
"""A410 part 3 / S192 — Jamie's short-put opens with entry traits + graded result → watchlist_sync.jamie_put_traits.

One home for the trait math (analysis/a410_jamie_diff.py imports feats from here). Traits use the PRIOR close
(no same-day look-ahead). Bucket = how far OTM (≥ 14 % below price = far) × stock beaten down (≥ 40 % off its
60-day closing high). Descriptive history of his own trades, never a forecast or a rule (jamie-rules).
Read by GET /api/trade-journal → Track Record › Journal "Your put sales by type". Refreshed in daily step "rec cells".
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import rec_scoreboard as RS  # noqa: E402

FAR_OTM_PCT = 14.0       # S192 top-tercile cut 13.7 % (rounded)
BEATEN_OFF_HI_PCT = -40.0  # S192: ≥ 40 % off the 60 d high


def feats(df: pd.DataFrame, P: dict) -> pd.DataFrame:
    rows = []
    for r in df.itertuples():
        g = P.get(r.t)
        h = None if g is None else g[g.index < r.d].tail(260)
        if h is None or len(h) < 25:
            rows.append({}); continue
        s = h["c"].iloc[-1]
        lr = np.log(h["c"]).diff().dropna()
        rv = lr.tail(20).std() * np.sqrt(252)
        dte = max((r.e - r.d).days, 1)
        otm = 1 - r.k / s
        rows.append(dict(S=s, otm=otm * 100, dte=dte, rv20=rv * 100,
                         otm_sd=otm / (rv * np.sqrt(dte / 365)) if rv > 0 else np.nan,
                         r5=(s / h["c"].iloc[-6] - 1) * 100, r20=(s / h["c"].iloc[-21] - 1) * 100,
                         off_lo=(s / h["lo"].tail(20).min() - 1) * 100,
                         off_hi=(s / h["c"].tail(60).max() - 1) * 100,
                         yld=r.px / r.k * 100, wd=r.d.dayofweek))
    return pd.concat([df.reset_index(drop=True), pd.DataFrame(rows)], axis=1)


def bucket(otm: float, off_hi: float) -> str | None:
    if pd.isna(otm) or pd.isna(off_hi):
        return None
    return ("far" if otm >= FAR_OTM_PCT else "near") + ("_beaten" if off_hi <= BEATEN_OFF_HI_PCT else "")


def load(c) -> pd.DataFrame:
    jam = RS.q(c, """SELECT DISTINCT ON (order_id) order_id, created_at::date d, account a, symbol t, option_strike::float k,
                     option_expiration e, avg_fill_price::float px, quantity::float qn
                     FROM portfolio_orders WHERE state = 'filled' AND is_option AND option_side = 'put'
                     AND side = 'credit' AND leg_effect = 'open' AND order_id IS NOT NULL ORDER BY order_id, created_at""")
    names = sorted(set(jam.t) | {"QQQ"})
    px = RS.q(c, "SELECT ticker t, date, close::float c, low::float lo FROM prices_historical WHERE date >= %s AND ticker = ANY(%s)",
              (pd.to_datetime(jam.d).min() - pd.Timedelta(days=400), names))
    px["date"] = pd.to_datetime(px["date"])
    P = {t: g.set_index("date").sort_index() for t, g in px.groupby("t")}
    qq = P["QQQ"]["c"]
    J = feats(RS.grade(jam, P, px["date"].max(), qq / qq.shift(20) - 1), P)
    J["bucket"] = [bucket(o, h) for o, h in zip(J.otm, J.off_hi)]
    return J


def refresh(c) -> int:
    J = load(c)
    cur = c.cursor()
    cur.execute("""CREATE TABLE IF NOT EXISTS watchlist_sync.jamie_put_traits (order_id text PRIMARY KEY, d date, ticker text,
                   strike float, expiry date, px float, otm_pct float, off_hi_pct float, rv20 float, bucket text,
                   ret_pct float, touched bool, updated_at timestamptz DEFAULT now())""")
    cur.execute("DELETE FROM watchlist_sync.jamie_put_traits")
    f = lambda v: None if pd.isna(v) else float(v)  # noqa: E731
    for r in J.itertuples():
        cur.execute("INSERT INTO watchlist_sync.jamie_put_traits (order_id, d, ticker, strike, expiry, px, otm_pct, off_hi_pct, rv20, bucket, ret_pct, touched) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    (r.order_id, r.d.date(), r.t, r.k, r.e.date(), r.px, f(r.otm), f(r.off_hi), f(r.rv20), r.bucket if isinstance(r.bucket, str) else None,
                     f(r.ret), None if pd.isna(r.touched) else bool(r.touched)))
    c.commit()
    return len(J)


if __name__ == "__main__":
    c = RS.L.connect()
    n = refresh(c)
    s = RS.q(c, """SELECT bucket, count(ret_pct) n, round(avg(ret_pct)::numeric, 2) avg, round(avg((ret_pct > 0)::int)::numeric, 2) win
                   FROM watchlist_sync.jamie_put_traits GROUP BY bucket ORDER BY bucket""")
    print(f"jamie_put_traits: {n} opens\n{s.to_string(index=False)}")
