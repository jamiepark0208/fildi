#!/usr/bin/env python3
"""lab_fund revision features from LSEG after WRDS IBES stops (11-09: WRDS statsum ends 2026-08-20).

LSEG serves the same I/B/E/S consensus daily (research/lseg/sync_signals.py → lseg_research.signals_daily). Checked vs
WRDS IBES on 2026-08-20, 120 names: consensus level median gap 0.13 %, 1-month drift corr 0.79 (sign 95 %), breadth
corr 0.93 (LSEG counts ~17 % more brokers: detail includes estimates IBES excludes).

Same feature names as lab_fund_features.py so S085/S086/S100 pick them up unchanged:
  ibes_drift     (FY1 mean − FY1 mean 30 days ago) / |30 days ago|        (IBES: vs previous monthly statpers)
  ibes_drift_3m  same vs 90 days ago
  ibes_breadth   (brokers up − brokers down vs 30 days ago) / brokers      (latest weekly pull ≤ 7 days old)
  ibes_disp      FY1 stdev / |FY1 mean|
  ibes_numest    FY1 estimate count
  ibes_fwd_growth  FY2/FY1 − 1, FY1 > 0, clamped [−0.9, 3]  (no one-off-FY1 check: LSEG history is too short yet)
ibes_sue is not rebuilt here (no LSEG SUE yet) — it keeps carrying from IBES.

Rows go only on lab_tech's weekly dates after the IBES watermark (adds no new panel weeks) and never overwrite an IBES
value: features = LSEG || existing (existing keys win).

    cd scripts/watchlist_sync && .venv/bin/python analysis/lab_fund_lseg.py [--dry-run]
"""
from __future__ import annotations

import json
import sys
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_plan import connect  # noqa: E402

FRESH_DAYS = 7


def rel(a, b):
    return (a - b) / abs(b) if a is not None and b not in (None, 0) else None


def features(r: dict) -> dict:
    m = r["eps_mean_fy1"]
    f = {"ibes_drift": rel(m, r["eps_mean_fy1_30d_ago"]), "ibes_drift_3m": rel(m, r["eps_mean_fy1_90d_ago"]),
         "ibes_disp": r["eps_std_fy1"] / abs(m) if r["eps_std_fy1"] is not None and m else None,
         "ibes_numest": float(r["eps_num_est_fy1"]) if r["eps_num_est_fy1"] else None}
    n = r.get("brokers")
    if n:
        f["ibes_breadth"] = ((r["up"] or 0) - (r["down"] or 0)) / n
    if m is not None and m > 0 and r["eps_mean_fy2"] is not None:
        f["ibes_fwd_growth"] = max(-0.9, min(3.0, r["eps_mean_fy2"] / m - 1))
    return {k: v for k, v in f.items() if v is not None}


def main() -> int:
    dry = "--dry-run" in sys.argv[1:]
    with connect() as conn:
        wm = conn.execute("SELECT MAX(statpers) FROM wrds_research.ibes_statsum").fetchone()[0]
        dates = [r[0] for r in conn.execute(
            "SELECT DISTINCT as_of FROM watchlist_sync.lab_tech WHERE as_of > %s ORDER BY 1", (wm,))]
        # + the latest LSEG snapshot, so today's board row carries this week's revisions (lab_tech already holds dates
        # with no outcomes yet; those never enter the backtest weeks)
        last = conn.execute("SELECT MAX(as_of) FROM lseg_research.signals_daily").fetchone()[0]
        if last and last not in dates:
            dates.append(last)
        out = []
        for d in dates:
            q = conn.execute(
                """WITH snap AS (
                     SELECT DISTINCT ON (ticker) ticker, eps_mean_fy1, eps_mean_fy1_30d_ago, eps_mean_fy1_90d_ago, eps_std_fy1,
                            eps_num_est_fy1, eps_mean_fy2
                     FROM lseg_research.signals_daily WHERE as_of <= %(d)s AND as_of > %(d0)s AND eps_mean_fy1 IS NOT NULL
                     ORDER BY ticker, as_of DESC),
                   br AS (
                     SELECT DISTINCT ON (ticker) ticker, eps_num_brokers_fy1 brokers, eps_num_up_fy1 up, eps_num_down_fy1 down
                     FROM lseg_research.signals_daily WHERE as_of <= %(d)s AND as_of > %(d0)s AND eps_num_brokers_fy1 IS NOT NULL
                     ORDER BY ticker, as_of DESC)
                   SELECT snap.*, br.brokers, br.up, br.down FROM snap LEFT JOIN br USING (ticker)""",
                {"d": d, "d0": d - timedelta(days=FRESH_DAYS)})
            cols = [c.name for c in q.description]
            for row in q.fetchall():
                r = dict(zip(cols, row))
                f = features(r)
                if f:
                    out.append((r["ticker"], d, json.dumps(f)))
        cover = {}
        for t, d, f in out:
            c = cover.setdefault(str(d), [0, 0, 0])
            j = json.loads(f)
            c[0] += 1
            c[1] += "ibes_drift_3m" in j
            c[2] += "ibes_breadth" in j
        print(f"lab_fund_lseg: IBES watermark {wm} → {len(dates)} lab dates; rows/date (n, drift_3m, breadth): {cover}")
        if dry or not out:
            return 0
        with conn.cursor() as cur:
            cur.executemany("""INSERT INTO watchlist_sync.lab_fund (ticker, as_of, features) VALUES (%s, %s, %s::jsonb)
                               ON CONFLICT (ticker, as_of) DO UPDATE SET features = EXCLUDED.features || lab_fund.features,
                                 computed_at = now()
                               WHERE lab_fund.features IS DISTINCT FROM EXCLUDED.features || lab_fund.features""", out)
        conn.commit()
        print(f"lab_fund_lseg: {len(out)} rows upserted")
    return 0


if __name__ == "__main__":
    sys.exit(main())
