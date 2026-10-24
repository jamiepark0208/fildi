"""IV-rank resolver — the one home for "IV percentile" (Jamie 10-24: one rules engine; lab O2 10-05: replace the RV proxy everywhere).

Priority per name (1-year percentile of today's IV within its own history, 0–1):
  1. LSEG 30d ATM put IV (fit_model_v14.iv_ranks: ≥ 120 days, newest ≤ 7 days old)
  2. tastytrade IV percentile (tasty_metrics_daily, newest ≤ 4 days old: Friday's row still counts on Monday)
  3. none → consumers drop the component (never the RV proxy: wrong-signed, lab IC −0.030 vs true IV rank +0.084)
Consumers: Model List PREMIUM (fit_model_v14 main), champion option score ivRelative (api-server option-score-snapshots,
model-track-record ← watchlist_sync.iv_rank_daily), Breakdown › Options history › IV rank.

  python3 scripts/watchlist_sync/iv_rank.py     # daily.py "model" stage, after tastytrade metrics, before the option scan
"""
from __future__ import annotations

from build_plan import connect

import fit_model_v14 as V
from tastytrade import APP_NAMES

TASTY_MAX_AGE_DAYS = 4
DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.iv_rank_daily (
  ticker text, date date, pctile real, source text, PRIMARY KEY (ticker, date))"""


def resolve(conn, tickers) -> dict[str, tuple[float, str]]:
    out = {t: (p, "lseg") for t, p in V.iv_ranks(conn, tickers).items()}
    for t, p in conn.execute(f"""SELECT DISTINCT ON (ticker) ticker, iv_percentile FROM watchlist_sync.tasty_metrics_daily
                                 WHERE ticker = ANY(%s) AND iv_percentile IS NOT NULL AND date >= current_date - {TASTY_MAX_AGE_DAYS}
                                 ORDER BY ticker, date DESC""", (list(tickers),)).fetchall():
        out.setdefault(t, (float(p), "tastytrade"))
    return out


def pctiles(conn, tickers) -> dict[str, float]:
    return {t: p for t, (p, _) in resolve(conn, tickers).items()}


if __name__ == "__main__":
    with connect() as conn:
        conn.execute(DDL)
        names = [r[0] for r in conn.execute(APP_NAMES)]
        res = resolve(conn, names)
        conn.execute("DELETE FROM watchlist_sync.iv_rank_daily WHERE date = current_date")
        with conn.cursor() as cur:
            cur.executemany("INSERT INTO watchlist_sync.iv_rank_daily VALUES (%s, current_date, %s, %s)",
                            [(t, p, s) for t, (p, s) in res.items()])
    n_l = sum(1 for _, s in res.values() if s == "lseg")
    print(f"IV rank resolver: {len(res)}/{len(names)} names · LSEG {n_l} · tastytrade {len(res) - n_l} · none {len(names) - len(res)}")
