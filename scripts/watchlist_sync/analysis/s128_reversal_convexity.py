#!/usr/bin/env python3
"""S128 / A297 — reversal convexity after a big SPY intraday drop (far-OTM 0DTE calls, uncapped).

INDEX remap: A297 asked for S124, but S124 is Gao intraday (A276). This study is S128.

Smoke: 2025-04-03/04/07/08/09 against SPY minute closes.
MODEL path (2018-10→2024-09): BS at VIX × skew multipliers — frequency only, never the verdict.
Real prints: Polygon option minutes on trigger days 2024-10→ (one Polygon job; reuse s048 cache).

    cd scripts/watchlist_sync && .venv/bin/python analysis/s128_reversal_convexity.py [--smoke] [--write]
"""
from __future__ import annotations

import math
import sys
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402
import s048_0dte as Z  # noqa: E402

NY = ZoneInfo("America/New_York")
OUT = HERE.parent / "out" / "opt" / "S128.md"
SMOKE_DAYS = [date(2025, 4, d) for d in (3, 4, 7, 8, 9)]
DS = (0.015, 0.02, 0.03)
KS = (0.01, 0.02, 0.03)
CHECKPOINTS = (time(10, 30), time(12, 0), time(14, 0))


def spy_session(conn, d: date):
    bars = Z.minute_bars(conn, "SPY", d, d)
    if not bars:
        return None
    # use closes only (S052: h/l carry bad ticks)
    open_px = float(bars[0][1])  # o
    by_t = []
    for ts, o, h, l, c, v in bars:
        by_t.append((ts, float(c)))
    return open_px, by_t


def first_trigger(open_px, by_t, d_drop: float):
    """First checkpoint where last ≤ open×(1−d)."""
    for cp in CHECKPOINTS:
        # last close at/after cp
        hits = [c for ts, c in by_t if (ts.astimezone(NY).time() if ts.tzinfo else ts.time()) >= cp]
        if not hits:
            continue
        px = hits[0]
        if px <= open_px * (1 - d_drop):
            return cp, px
    return None, None


def smoke(conn) -> list[str]:
    lines = ["## Smoke (2025-04-03..09)", "", "| day | open | triggers (d@T → px) | close |", "|---|---:|---|---:|"]
    for d in SMOKE_DAYS:
        sess = spy_session(conn, d)
        if not sess:
            lines.append(f"| {d} | — | no SPY minutes | — |")
            continue
        open_px, by_t = sess
        close = by_t[-1][1]
        trigs = []
        for dd in DS:
            cp, px = first_trigger(open_px, by_t, dd)
            if cp:
                trigs.append(f"{dd:.1%}@{cp.strftime('%H:%M')}→{px:.2f}")
        lines.append(f"| {d} | {open_px:.2f} | {', '.join(trigs) or 'none'} | {close:.2f} |")
    return lines


def model_freq(conn) -> list[str]:
    """Count open→low style drops on daily bars 2018-10→2024-09 (MODEL frequency)."""
    rows = conn.execute(
        """SELECT date::date, open::float8, low::float8, close::float8
           FROM lseg_research.daily_history
           WHERE ticker='SPY' AND open>0 AND low>0 AND date >= '2018-10-01' AND date < '2024-10-01'
           ORDER BY date"""
    ).fetchall()
    lines = ["", "## MODEL frequency (daily OHLC proxy 2018-10→2024-09)", "",
             "Proxy: open→low drop ≥ d; 'ITM at close' = close ≥ open×(1−d)×(1+k).",
             "", "| d | k | n days | P(close ≥ strike) |", "|---|---|---:|---:|"]
    for dd in DS:
        for k in KS:
            n = hit = 0
            for d, o, lo, c in rows:
                if lo > o * (1 - dd):
                    continue
                n += 1
                strike = (o * (1 - dd)) * (1 + k)  # approx trigger≈low proxy
                # better: strike from open×(1-d) as drop point
                drop_pt = o * (1 - dd)
                strike = drop_pt * (1 + k)
                if c >= strike:
                    hit += 1
            lines.append(f"| {dd:.1%} | {k:.0%} | {n} | {100*hit/max(n,1):.1f}% |")
    lines += ["", "_MODEL only — never the pass verdict._"]
    return lines


def main() -> int:
    conn = connect()
    Z.ensure(conn)
    lines = [
        "# S128 — reversal convexity (A297; INDEX remap from S124)",
        "",
        "Far-OTM uncapped 0DTE calls after SPY intraday drop. Smoke + MODEL frequency this packet;",
        "real-print ladder (Polygon) = next job when no other Polygon fetch is running.",
        "",
    ]
    lines += smoke(conn)
    lines += model_freq(conn)
    lines += [
        "",
        "## Pass bar (real prints, pending)",
        "profit/$ > 0, CI lower > −20%, ≥8 trigger days, still >0 dropping best day; ≥3 fit rounds then holdout.",
        "",
        "## Verdict",
        "**INCOMPLETE** — smoke + MODEL shipped; real-print cell table not yet (Polygon queue).",
        "",
        "Refs: A297",
    ]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    if "--write" in sys.argv or True:
        OUT.write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
