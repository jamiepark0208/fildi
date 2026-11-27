"""A373 — Yahoo/FRED + LSEG loads for Oft3r macro / three-pillar panels."""
from __future__ import annotations

import hashlib
import json
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys_path = str(HERE.parent)
import sys

if sys_path not in sys.path:
    sys.path.insert(0, sys_path)
from build_plan import connect  # noqa: E402

YAHOO_D = "chart/1d/1993"
PERIOD1 = 725811600
PERIOD2 = 4102444800
YAHOO_SYMS = ("RSP", "HYG", "LQD", "TLT", "SPY", "IWM", "XLY", "XLP", "^TNX", "^FVX")


def fetch_yahoo(conn, sym: str) -> None:
    cur = conn.cursor()
    cur.execute(
        "SELECT 1 FROM vendor_raw WHERE source='yahoo' AND endpoint=%s AND key=%s LIMIT 1",
        (YAHOO_D, sym),
    )
    if cur.fetchone():
        return
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
        f"?period1={PERIOD1}&period2={PERIOD2}&interval=1d"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    raw = json.load(urllib.request.urlopen(req, timeout=60))
    payload = json.dumps(raw)
    sha = hashlib.sha256(payload.encode()).hexdigest()
    today = date.today()
    cur.execute(
        """INSERT INTO vendor_raw (source, endpoint, key, fetched_on, payload, payload_sha)
           VALUES ('yahoo', %s, %s, %s, %s::jsonb, %s)
           ON CONFLICT (source, endpoint, key, fetched_on) DO UPDATE
           SET payload = EXCLUDED.payload, payload_sha = EXCLUDED.payload_sha""",
        (YAHOO_D, sym, today, payload, sha),
    )
    conn.commit()


def quotes_df(conn, sym: str) -> pd.DataFrame:
    cur = conn.cursor()
    cur.execute(
        """SELECT payload FROM vendor_raw
           WHERE source='yahoo' AND endpoint=%s AND key=%s
           ORDER BY fetched_on DESC LIMIT 1""",
        (YAHOO_D, sym),
    )
    row = cur.fetchone()
    if row:
        p = row[0]
        if "quotes" in p:
            q = p["quotes"]
        else:
            r = p["chart"]["result"][0]
            ts = r["timestamp"]
            qd = r["indicators"]["quote"][0]
            q = [
                {
                    "date": datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d"),
                    "close": qd["close"][i],
                }
                for i, t in enumerate(ts)
                if qd["close"][i] is not None
            ]
        d = pd.DataFrame(q)
        d["date"] = pd.to_datetime(d["date"], utc=True).dt.tz_localize(None)
        d = d.dropna(subset=["close"]).drop_duplicates("date").set_index("date").sort_index()
        return d["close"].astype(float)

    cur.execute(
        "SELECT date, close::float8 FROM lseg_research.daily_history WHERE ticker=%s AND close > 0 ORDER BY date",
        (sym,),
    )
    rows = cur.fetchall()
    if not rows:
        raise KeyError(sym)
    d = pd.DataFrame(rows, columns=["date", "close"])
    d["date"] = pd.to_datetime(d["date"])
    return d.set_index("date")["close"].astype(float)


def yield_spread(conn) -> pd.Series:
    """10Y−5Y yield spread proxy: Yahoo ^TNX − ^FVX (# global: FRED DGS10−DGS2 when macro_daily empty)."""
    for sym in ("^TNX", "^FVX"):
        try:
            quotes_df(conn, sym)
        except KeyError:
            fetch_yahoo(conn, sym)
    tnx = quotes_df(conn, "^TNX") / 10
    fvx = quotes_df(conn, "^FVX") / 10
    idx = tnx.index.intersection(fvx.index)
    return (tnx.reindex(idx) - fvx.reindex(idx)).dropna().astype(float)


def load_macro_panel(conn, fetch: bool = True) -> dict[str, pd.Series]:
    closes = {}
    for sym in YAHOO_SYMS:
        try:
            closes[sym] = quotes_df(conn, sym)
        except KeyError:
            if fetch:
                fetch_yahoo(conn, sym)
                closes[sym] = quotes_df(conn, sym)
            else:
                raise
    closes["spread_10y2y"] = yield_spread(conn)
    for k, s in list(closes.items()):
        if getattr(s.index, "tz", None) is not None:
            closes[k] = s.tz_localize(None)
    return closes


def trend_sign(s: pd.Series, n: int = 50) -> pd.Series:
    """Oft3r macro component: +1 if ratio above its n-day mean trend, else −1."""
    r = s / s.rolling(n, min_periods=n).mean()
    return np.sign(r - 1).replace(0, np.nan).ffill().fillna(0).astype(int)


def macro_pillar_score(closes: dict[str, pd.Series]) -> pd.DataFrame:
    """Seven Oft3r macro inputs (asks/A373.md). Sources: Yahoo vendor_raw + FRED spread_10y2y."""
    idx = closes["SPY"].index
    out = pd.DataFrame(index=idx)
    out["rsp_spy"] = trend_sign(closes["RSP"] / closes["SPY"])
    sp = closes["spread_10y2y"].reindex(idx).ffill()  # TNX−FVX proxy (% pts)
    out["yc_10y2y"] = np.sign(sp - sp.rolling(50, min_periods=50).mean()).fillna(0).astype(int)
    out["hyg_lqd"] = trend_sign(closes["HYG"] / closes["LQD"])
    out["iwm_spy"] = trend_sign(closes["IWM"] / closes["SPY"])
    out["spy_tlt"] = trend_sign(closes["SPY"] / closes["TLT"])
    out["xly_xlp"] = trend_sign(closes["XLY"] / closes["XLP"])
    spr = closes["SPY"].pct_change()
    tlr = closes["TLT"].pct_change()
    spy_tlt = pd.concat([spr, tlr], axis=1, keys=("s", "t")).dropna()
    corr = spy_tlt["s"].rolling(20, min_periods=20).corr(spy_tlt["t"]).reindex(idx)
    out["spy_tlt_corr"] = pd.Series(
        np.where(corr > 0, -1, np.where(corr < 0, 1, 0)), index=idx
    ).fillna(0).astype(int)
    comps = ["rsp_spy", "yc_10y2y", "hyg_lqd", "iwm_spy", "spy_tlt", "xly_xlp", "spy_tlt_corr"]
    out["macro"] = out[comps].sum(axis=1)
    return out