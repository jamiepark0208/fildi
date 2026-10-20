"""A186 — simulated Rec base rate per ticker, for names with no graded model_recs. Labelled "sim", never a model grade.

Per ticker: of the weekly 1σ puts in the lab panel (S045 build(): K = S·exp(−IV·√(5/252)), 5-session hold) over the
last 52 weeks, how many finished OTM (W) vs breached (L). Writes watchlist_sync.sim_rec; the API shows it only when the
ticker has 0 graded picks. Stop rule (A186): at ≥ 100 graded picks, Spearman(sim OTM rate, graded win rate) ≤ 0 → remove.

    cd scripts/watchlist_sync && .venv/bin/python analysis/sim_rec.py
"""
from __future__ import annotations

import sys
from collections import defaultdict
from datetime import timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent), str(HERE)]
import s045_put_retest as M  # noqa: E402

DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.sim_rec (
  ticker text PRIMARY KEY, wins int NOT NULL, losses int NOT NULL, window_start date, window_end date,
  method text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())"""
METHOD = "1σ weekly puts, 52 wk (lab panel, BS-priced strikes)"


def load_events(conn) -> list[tuple]:
    """Same events + breach rule as S045 build() (K = S·exp(−Z·IV30·√(HOLD/252)), bar index ≥ LOOKBACK + 22, HOLD bars ahead),
    but only the last ~13 months and only IV30 + closes. 10-19 audit: the full lab panel (features, tech, fund, every OHLC bar
    since 2020, per-event list rebuilds) peaked at 793 MB / 17.5 s for a 52-week win count."""
    return conn.execute(
        """WITH o AS (SELECT ticker, as_of, (features->>'iv30')::float8 / 100 iv FROM watchlist_sync.lab_outcomes
                      WHERE as_of >= (SELECT MAX(as_of) FROM watchlist_sync.lab_outcomes) - 400
                        AND (features->>'iv30')::float8 <> 0),
                b AS (SELECT ticker, date, close::float8 c, ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date) - 1 i
                      FROM lseg_research.daily_history
                      WHERE ticker IN (SELECT ticker FROM o) AND close > 0 AND high > 0 AND low > 0)
           SELECT o.ticker, o.as_of, b.c * exp(-%s * o.iv * sqrt(%s / 252.0)) > f.c AS breach
           FROM o JOIN b ON b.ticker = o.ticker AND b.date = o.as_of
           JOIN b f ON f.ticker = o.ticker AND f.i = b.i + %s
           WHERE o.iv > 0.05 AND o.iv < 3.0 AND b.i >= %s""",
        (M.Z, M.HOLD, M.HOLD, M.LOOKBACK + 22)).fetchall()


def main():
    conn = M.connect()
    ev = load_events(conn)
    end = max(d for _, d, _ in ev)
    start = end - timedelta(days=364)
    wl = defaultdict(lambda: [0, 0])
    for t, d, breach in ev:
        if d >= start:
            wl[t][1 if breach else 0] += 1
    conn.execute(DDL)
    conn.execute("DELETE FROM watchlist_sync.sim_rec")
    with conn.cursor() as cur:
        cur.executemany("INSERT INTO watchlist_sync.sim_rec (ticker, wins, losses, window_start, window_end, method) "
                        "VALUES (%s,%s,%s,%s,%s,%s)", [(t, w, l, start, end, METHOD) for t, (w, l) in wl.items()])
    conn.commit()
    rates = sorted((w / (w + l), t) for t, (w, l) in wl.items() if w + l)
    print(f"sim_rec: {len(wl)} tickers, window {start} → {end}; OTM rate min {rates[0][0]:.0%} ({rates[0][1]}), "
          f"median {rates[len(rates) // 2][0]:.0%}, max {rates[-1][0]:.0%} ({rates[-1][1]})")


if __name__ == "__main__":
    main()
