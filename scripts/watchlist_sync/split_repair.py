"""Detect and repair stock splits (forward or reverse) that Fildi's prices_historical never back-adjusted.

Why: the app's Yahoo backfill appends new bars but never rewrites history, so after a split the older closes stay on the
old share basis. That leaves a fake jump that corrupts technicals, realized vol, falling-knife flags and backtests.
Found 2026-10-05: GOSS 80:1 reverse split (ASKS A16).

Detection, two independent sources (LSEG `lseg_research.daily_history` is re-based by sync_daily_history's overlap check):
  1. ratio r = LSEG close / Fildi close on shared dates is ~1 normally; a basis change shows as a step at split date D:
     before D, r holds steady at R (median deviation < 1%); from D on, r ≈ 1 (within 1.5%).
  2. R is a split-like fraction p/q (q ≤ 20, within 1.5%: 2, 3/2, 10, 1/80 …).
  3. Fildi's own close jumps by ≈ R at D (the fake move), confirming the step is in Fildi, not LSEG.
Tickers without LSEG history get a jump-only scan; those are reported as "suspect" and never auto-repaired.

Repair (with --apply): rows before D get open/high/low/close × R and volume ÷ R. Originals go to
watchlist_sync.prices_historical_backup first, and every repair is logged in watchlist_sync.price_repairs (reversible).
Then technicals are recomputed through Cursor's own script (backfill-stale-prices.ts --tickers=…).

Usage: .venv/bin/python split_repair.py [--apply] [--tickers A,B]
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
from collections import defaultdict
from fractions import Fraction
from pathlib import Path
from statistics import median

from build_plan import connect, rows

ROOT = Path(__file__).resolve().parents[2]
STEP = 0.20          # ratio change between consecutive shared days that marks a basis change
STEADY = 0.01        # pre-split ratio dispersion
POST_TOL = 0.015     # post-split ratio must be ~1
FRACTION_TOL = 0.015
DDL = """
CREATE TABLE IF NOT EXISTS watchlist_sync.price_repairs (
  id bigserial PRIMARY KEY, ticker text NOT NULL, split_date date NOT NULL, factor double precision NOT NULL,
  fraction text NOT NULL, rows_changed integer NOT NULL, evidence jsonb NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticker, split_date));
CREATE TABLE IF NOT EXISTS watchlist_sync.prices_historical_backup (
  repair_id bigint NOT NULL, ticker text NOT NULL, date date NOT NULL, open numeric, high numeric, low numeric, close numeric,
  volume bigint, PRIMARY KEY (repair_id, ticker, date));
"""


def split_fraction(r: float) -> Fraction | None:
    f = Fraction(r).limit_denominator(20)
    if f.numerator == f.denominator or f.numerator > 400:
        return None
    return f if abs(r / float(f) - 1) <= FRACTION_TOL else None


def detect(fildi: list[tuple], lseg: dict) -> list[dict]:
    shared = [(d, lseg[d] / c) for d, c in fildi if d in lseg and c and lseg[d]]
    found = []
    for k in range(1, len(shared)):
        (d0, r0), (d1, r1) = shared[k - 1], shared[k]
        if abs(r1 / r0 - 1) < STEP:
            continue
        pre = [r for _, r in shared[max(0, k - 60):k]]
        post = [r for _, r in shared[k:k + 20]]
        if len(pre) < 5 or len(post) < 3:
            continue
        R = median(pre)
        steady = median(abs(r / R - 1) for r in pre)
        post_ok = abs(median(post) - 1) <= POST_TOL
        frac = split_fraction(R)
        fd = {d: c for d, c in fildi}
        fdates = [d for d, _ in fildi]
        i = fdates.index(d1)
        own_jump = fd[d1] / fd[fdates[i - 1]] if i > 0 and fd[fdates[i - 1]] else None
        jump_ok = own_jump is not None and abs(math.log(own_jump / R)) < 0.3
        if steady <= STEADY and post_ok and frac and jump_ok:
            found.append({"split_date": d1, "factor": float(frac), "fraction": f"{frac.numerator}:{frac.denominator}",
                          "observed_ratio": R, "pre_dispersion": steady, "post_ratio": median(post), "fildi_jump": own_jump,
                          "pre_days": len(pre), "post_days": len(post)})
    return found


def suspects(fildi: list[tuple]) -> list[dict]:
    """Jump-only scan for names with no second source: a split-like one-day move that then holds."""
    out = []
    for k in range(5, len(fildi) - 5):
        (_, p), (d, c) = fildi[k - 1], fildi[k]
        if not p or not c:
            continue
        j = c / p
        if 0.45 < j < 2.2:
            continue
        frac = split_fraction(1 / j)
        after = [x for _, x in fildi[k:k + 5]]
        if frac and max(after) / min(after) < 1.3:
            out.append({"date": d, "jump": j, "implied_fraction": f"{frac.numerator}:{frac.denominator}"})
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--tickers", default="")
    a = ap.parse_args()
    with connect() as conn:
        conn.execute(DDL)
        want = [t for t in a.tickers.split(",") if t]
        fil = defaultdict(list)
        for r in rows(conn, "SELECT ticker, date, close::float8 c FROM prices_historical" + (" WHERE ticker = ANY(%s)" if want else "") + " ORDER BY ticker, date",
                      (want,) if want else ()):
            fil[r["ticker"]].append((r["date"], r["c"]))
        ls = defaultdict(dict)
        for r in rows(conn, "SELECT ticker, date, close::float8 c FROM lseg_research.daily_history WHERE close IS NOT NULL" + (" AND ticker = ANY(%s)" if want else ""),
                      (want,) if want else ()):
            ls[r["ticker"]][r["date"]] = r["c"]
        done = {(r["ticker"], r["split_date"]) for r in rows(conn, "SELECT ticker, split_date FROM watchlist_sync.price_repairs")}
        repairs, flagged = [], {}
        for t, series in fil.items():
            if t in ls:
                for f in detect(series, ls[t]):
                    if (t, f["split_date"]) not in done:
                        repairs.append((t, f))
            else:
                s = suspects(series)
                if s:
                    flagged[t] = s
        print(f"checked {len(fil)} tickers ({sum(t in ls for t in fil)} with an LSEG second source)")
        for t, f in repairs:
            print(f"  SPLIT {t} {f['split_date']} {f['fraction']} (observed {f['observed_ratio']:.3f}, Fildi jump {f['fildi_jump']:.2f}×, "
                  f"pre-dispersion {100 * f['pre_dispersion']:.2f}%, post ratio {f['post_ratio']:.4f})")
        for t, s in flagged.items():
            print(f"  suspect (no second source, not repaired) {t}: " + ", ".join(f"{x['date']} {x['jump']:.2f}× ~{x['implied_fraction']}" for x in s))
        if not a.apply or not repairs:
            print("dry run" if not a.apply else "nothing to repair")
            return
        fixed = []
        for t, f in sorted(repairs, key=lambda x: x[1]["split_date"], reverse=True):  # latest split first
            rid = rows(conn, """INSERT INTO watchlist_sync.price_repairs (ticker, split_date, factor, fraction, rows_changed, evidence)
                               VALUES (%s, %s, %s, %s, 0, %s) RETURNING id""",
                       (t, f["split_date"], f["factor"], f["fraction"], json.dumps(f, default=str)))[0]["id"]
            conn.execute("""INSERT INTO watchlist_sync.prices_historical_backup (repair_id, ticker, date, open, high, low, close, volume)
                            SELECT %s, ticker, date, open, high, low, close, volume FROM prices_historical WHERE ticker = %s AND date < %s""",
                         (rid, t, f["split_date"]))
            n = conn.execute("""UPDATE prices_historical SET open = open * %s, high = high * %s, low = low * %s, close = close * %s,
                                volume = ROUND(volume / %s) WHERE ticker = %s AND date < %s""",
                             (f["factor"],) * 5 + (t, f["split_date"])).rowcount
            conn.execute("UPDATE watchlist_sync.price_repairs SET rows_changed = %s WHERE id = %s", (n, rid))
            fixed.append(t)
            print(f"  repaired {t}: {n} rows × {f['fraction']} (backup + log id {rid})")
        conn.commit()
    if fixed:
        cmd = ["pnpm", "exec", "tsx", "src/scripts/backfill-stale-prices.ts", f"--tickers={','.join(sorted(set(fixed)))}"]
        print("recomputing technicals via Cursor's script:", " ".join(cmd))
        r = subprocess.run(cmd, cwd=ROOT / "artifacts" / "api-server", capture_output=True, text=True, timeout=600)
        print((r.stdout or r.stderr)[-600:])


if __name__ == "__main__":
    main()
