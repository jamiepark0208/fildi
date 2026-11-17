#!/usr/bin/env python3
"""A410 part 3 / S192 — Jamie's short-put opens with entry traits + graded result → watchlist_sync.jamie_put_traits.

One home for the trait math (analysis/a410_jamie_diff.py imports feats from here). Traits use the PRIOR close
(no same-day look-ahead). Bucket = how far OTM (≥ 14 % below price = far) × stock beaten down (≥ 40 % off its
60-day closing high). Descriptive history of his own trades, never a forecast or a rule (jamie-rules).
Confidence scale (Jamie 11-16: "down 40 % higher confidence, 30 % slightly less, 20 % less…"): logistic
P(expires worthless) ~ strike % below price + % off 60 d high, fit on his graded opens. Per-row odds are leave-one-
month-out (the month never seen by its model). Month-held-out Brier 11-16: 0.160 vs 0.173 base rate; a 30 % step
scored 0.159, so the smooth scale costs nothing. Grid = model odds per band + what actually happened (n, kept, avg).
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


def _fit(X: np.ndarray, y: np.ndarray):
    from sklearn.linear_model import LogisticRegression
    return LogisticRegression(C=1.0, max_iter=1000).fit(X, y)


DD_BANDS = [(0, 10), (10, 20), (20, 30), (30, 40), (40, 999)]   # % below 60 d high
OTM_BANDS = [(-99, 5), (5, 10), (10, 15), (15, 99)]             # strike % below price


def model(J: pd.DataFrame) -> tuple[pd.DataFrame, dict, pd.DataFrame]:
    g = J.dropna(subset=["ret", "otm", "off_hi"]).copy()
    g["kept"] = (g["ret"] >= g["px"] / g["k"] * 100 - 1e-6).astype(int)
    g["dd"] = (-g["off_hi"]).clip(0, 80)
    g["otm_c"] = g["otm"].clip(-5, 40)
    X, y = g[["otm_c", "dd"]].to_numpy(), g["kept"].to_numpy()
    month = pd.to_datetime(g["d"]).dt.to_period("M").to_numpy()
    p = np.full(len(g), np.nan)
    for m in np.unique(month):
        tr = month != m
        p[~tr] = _fit(X[tr], y[tr]).predict_proba(X[~tr])[:, 1]
    g["p_kept"] = p
    lr = _fit(X, y)
    meta = dict(n=len(g), b0=float(lr.intercept_[0]), b_otm=float(lr.coef_[0][0]), b_dd=float(lr.coef_[0][1]),
                brier=float(((p - y) ** 2).mean()), brier_base=float(((y.mean() - y) ** 2).mean()), kept=float(y.mean()))
    rows = []
    for dlo, dhi in DD_BANDS:
        for olo, ohi in OTM_BANDS:
            w = g[(g.dd >= dlo) & (g.dd < dhi) & (g.otm >= olo) & (g.otm < ohi)]
            mid = np.array([[min(max((olo + ohi) / 2, 2.5), 20), min((dlo + dhi) / 2, 50)]])
            rows.append(dict(dd_lo=dlo, dd_hi=dhi, otm_lo=olo, otm_hi=ohi, p_model=float(lr.predict_proba(mid)[0, 1]),
                             n=len(w), kept=float(w.kept.mean()) if len(w) else None,
                             avg_ret=float(w.ret.mean()) if len(w) else None))
    # open (ungraded) puts: odds from the full fit — the trades the number is actually for
    o = J[J["ret"].isna() & J["otm"].notna() & J["off_hi"].notna()].copy()
    if len(o):
        o["p_kept"] = lr.predict_proba(np.c_[o["otm"].clip(-5, 40), (-o["off_hi"]).clip(0, 80)])[:, 1]
    return pd.concat([g[["order_id", "p_kept"]], o[["order_id", "p_kept"]]]), meta, pd.DataFrame(rows)


def refresh(c) -> int:
    J = load(c)
    pk, meta, grid = model(J)
    J = J.merge(pk, on="order_id", how="left")
    cur = c.cursor()
    cur.execute("""CREATE TABLE IF NOT EXISTS watchlist_sync.jamie_put_traits (order_id text PRIMARY KEY, d date, ticker text,
                   strike float, expiry date, px float, otm_pct float, off_hi_pct float, rv20 float, bucket text,
                   ret_pct float, touched bool, updated_at timestamptz DEFAULT now())""")
    cur.execute("ALTER TABLE watchlist_sync.jamie_put_traits ADD COLUMN IF NOT EXISTS p_kept float")
    cur.execute("""CREATE TABLE IF NOT EXISTS watchlist_sync.jamie_put_grid (dd_lo float, dd_hi float, otm_lo float, otm_hi float,
                   p_model float, n int, kept float, avg_ret float, meta jsonb, updated_at timestamptz DEFAULT now())""")
    cur.execute("DELETE FROM watchlist_sync.jamie_put_traits")
    cur.execute("DELETE FROM watchlist_sync.jamie_put_grid")
    f = lambda v: None if v is None or pd.isna(v) else float(v)  # noqa: E731
    for r in J.itertuples():
        cur.execute("INSERT INTO watchlist_sync.jamie_put_traits (order_id, d, ticker, strike, expiry, px, otm_pct, off_hi_pct, rv20, bucket, ret_pct, touched, p_kept) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    (r.order_id, r.d.date(), r.t, r.k, r.e.date(), r.px, f(r.otm), f(r.off_hi), f(r.rv20), r.bucket if isinstance(r.bucket, str) else None,
                     f(r.ret), None if pd.isna(r.touched) else bool(r.touched), f(r.p_kept)))
    import json
    for r in grid.itertuples():
        cur.execute("INSERT INTO watchlist_sync.jamie_put_grid (dd_lo, dd_hi, otm_lo, otm_hi, p_model, n, kept, avg_ret, meta) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    (r.dd_lo, r.dd_hi, r.otm_lo, r.otm_hi, r.p_model, int(r.n), f(r.kept), f(r.avg_ret), json.dumps(meta)))
    c.commit()
    print(f"jamie confidence scale: n {meta['n']} · held-out Brier {meta['brier']:.4f} vs base {meta['brier_base']:.4f} · "
          f"per +10 % down {meta['b_dd'] * 10:+.2f} log-odds · per +5 % farther strike {meta['b_otm'] * 5:+.2f}")
    return len(J)


if __name__ == "__main__":
    c = RS.L.connect()
    n = refresh(c)
    g = RS.q(c, "SELECT dd_lo, otm_lo, round(p_model::numeric, 2) p, n, round(kept::numeric, 2) kept, round(avg_ret::numeric, 2) ret FROM watchlist_sync.jamie_put_grid ORDER BY dd_lo DESC, otm_lo")
    print(f"jamie_put_traits: {n} opens\n{g.to_string(index=False)}")
