"""Implied vs realized earnings move per past report → lseg_research.earnings_implied (north-star gap #3, Claude 11-10).

Inputs (all local, $0): lseg_research.earnings_moves (report dates + realized move) and lseg_research.daily_history
(close + 30-day constant-maturity IV, mean of put/call). Method (Dubinsky-Johannes constant-maturity approximation):
event variance = (IV30_before² − IV30_after²) · 30/365, plus normal-day variance over the window (IV30_after² · days/252);
priced move (expected |move|) = sqrt(total variance) · sqrt(2/π)
— the same quantity an at-the-money straddle prices (≈ 0.8 σ). Calibrated against real straddles in optlab.earnings_moves
(printed at the end). Window: the before/after closes are the pair whose return matches the stored move (amc: d→d+1,
bmo: d−1→d, unknown: d−1→d+1). IV crush = IV30_after − IV30_before (vol points). Drift = close(after+5 / +20 trading
days) ÷ close(after) − 1 (post-earnings drift, signed).

Usage: .venv/bin/python sync_earnings_implied.py [--tickers T …]
"""
from __future__ import annotations

import argparse
import math
from bisect import bisect_left, bisect_right
from collections import defaultdict

from _session import connect_local

DDL = """
CREATE TABLE IF NOT EXISTS lseg_research.earnings_implied (
  ticker        text NOT NULL,
  report_date   date NOT NULL,
  before_date   date NOT NULL,
  after_date    date NOT NULL,
  iv_before     double precision,            -- IV30 % (vol points) at the close before
  iv_after      double precision,            -- IV30 % at the first close after
  implied       double precision,            -- priced |move|, fraction (NULL when IV did not fall)
  realized      double precision NOT NULL,   -- |move|, fraction
  move          double precision NOT NULL,   -- signed move, fraction
  ratio         double precision,            -- realized / implied
  crush_pts     double precision,            -- iv_after - iv_before
  drift_5d      double precision,            -- close(after+5) / close(after) - 1
  drift_20d     double precision,
  computed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticker, report_date)
)"""

UPSERT = """
INSERT INTO lseg_research.earnings_implied (ticker, report_date, before_date, after_date, iv_before, iv_after, implied,
  realized, move, ratio, crush_pts, drift_5d, drift_20d, computed_at)
VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s, now())
ON CONFLICT (ticker, report_date) DO UPDATE SET before_date=EXCLUDED.before_date, after_date=EXCLUDED.after_date,
  iv_before=EXCLUDED.iv_before, iv_after=EXCLUDED.iv_after, implied=EXCLUDED.implied, realized=EXCLUDED.realized,
  move=EXCLUDED.move, ratio=EXCLUDED.ratio, crush_pts=EXCLUDED.crush_pts, drift_5d=EXCLUDED.drift_5d,
  drift_20d=EXCLUDED.drift_20d, computed_at=now()
"""

TAU = 30 / 365
K = math.sqrt(2 / math.pi)


def iv_of(put, call):
    v = [x for x in (put, call) if x is not None and x > 0]
    return sum(v) / len(v) if v else None


def row_for(t, d, move_pct, days, closes, ivs):
    """Pick the window whose close-to-close return matches the stored move; None when the data has a gap."""
    i_on = bisect_left(days, d)
    on_day = i_on < len(days) and days[i_on] == d
    i_prev, i_next = i_on - 1, bisect_right(days, d)
    cands = [(i_prev, i_next)]
    if on_day:
        cands += [(i_on, i_on + 1), (i_prev, i_on)]
    best = None
    for a, b in cands:
        if a < 0 or b >= len(days) or (days[b] - days[a]).days > 7 or closes[a] <= 0:
            continue
        err = abs((closes[b] / closes[a] - 1) * 100 - move_pct)
        if best is None or err < best[0]:
            best = (err, a, b)
    if best is None or best[0] > max(1.0, abs(move_pct) * 0.25):  # price sources disagree → skip, don't guess
        return None
    _, a, b = best
    move = move_pct / 100
    ivb, iva = ivs[a], ivs[b]
    implied = crush = None
    if ivb is not None and iva is not None:
        crush = iva - ivb
        ev = ((ivb / 100) ** 2 - (iva / 100) ** 2) * TAU
        # + ordinary diffusion over the same window (b - a trading days at the post-report vol)
        implied = math.sqrt(ev + (iva / 100) ** 2 * (b - a) / 252) * K if ev > 0 else None
    d5 = closes[b + 5] / closes[b] - 1 if b + 5 < len(days) else None
    d20 = closes[b + 20] / closes[b] - 1 if b + 20 < len(days) else None
    ratio = abs(move) / implied if implied else None
    return (t, d, days[a], days[b], ivb, iva, implied, abs(move), move, ratio, crush, d5, d20)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tickers", nargs="*")
    args = ap.parse_args()
    with connect_local() as conn:
        conn.execute(DDL)
        tk = [t.upper() for t in args.tickers] if args.tickers else None
        flt = "WHERE ticker = ANY(%s)" if tk else ""
        moves = defaultdict(list)
        for t, d, m in conn.execute(f"SELECT ticker, report_date, move_pct FROM lseg_research.earnings_moves {flt}",
                                    (tk,) if tk else ()).fetchall():
            moves[t].append((d, m))
        hist = defaultdict(list)
        for t, d, c, p, cl in conn.execute(
                f"""SELECT ticker, date, close, iv30_put, iv30_call FROM lseg_research.daily_history
                    WHERE close IS NOT NULL AND ticker = ANY(%s) ORDER BY ticker, date""", (list(moves),)).fetchall():
            hist[t].append((d, float(c), iv_of(p, cl)))
        rows, skipped = [], 0
        for t, evs in moves.items():
            h = hist.get(t)
            if not h:
                skipped += len(evs)
                continue
            days, closes, ivs = [x[0] for x in h], [x[1] for x in h], [x[2] for x in h]
            for d, m in evs:
                r = row_for(t, d, float(m), days, closes, ivs)
                if r is None:
                    skipped += 1
                else:
                    rows.append(r)
        with conn.cursor() as cur:
            cur.executemany(UPSERT, rows)
        conn.commit()
        n_imp = sum(1 for r in rows if r[6] is not None)
        print(f"earnings_implied: {len(rows)} rows ({n_imp} with implied) · {len({r[0] for r in rows})} names · skipped {skipped}")
        cal = conn.execute("""SELECT corr(e.implied, o.implied), percentile_cont(0.5) WITHIN GROUP (ORDER BY e.implied / o.implied),
              count(*) FROM lseg_research.earnings_implied e JOIN optlab.earnings_moves o USING (ticker, report_date)
              WHERE e.implied IS NOT NULL AND o.implied > 0""").fetchone()
        print(f"calibration vs real straddles: corr {cal[0] and round(cal[0], 2)} · median IV-crush ÷ straddle "
              f"{cal[1] and round(cal[1], 2)} · n {cal[2]}")


if __name__ == "__main__":
    main()
