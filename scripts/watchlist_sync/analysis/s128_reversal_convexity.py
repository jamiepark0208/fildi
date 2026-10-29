#!/usr/bin/env python3
"""S128 / A297 — reversal convexity after a big SPY intraday drop (far-OTM 0DTE calls, uncapped).

INDEX remap: A297 asked for S124, but S124 is Gao intraday (A276). This study is S128.

    cd scripts/watchlist_sync && .venv/bin/python analysis/s128_reversal_convexity.py [--smoke-only] [--write]
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
START_REAL = date(2024, 10, 1)


def spy_session(conn, d: date):
    bars = Z.minute_bars(conn, "SPY", d, d)
    if not bars:
        return None
    open_px = float(bars[0][1])
    by_t = [(ts, float(c)) for ts, o, h, l, c, v in bars]
    return open_px, by_t


def first_trigger(open_px, by_t, d_drop: float):
    for cp in CHECKPOINTS:
        hits = [c for ts, c in by_t if (ts.astimezone(NY).time() if ts.tzinfo else ts.time()) >= cp]
        if not hits:
            continue
        px = hits[0]
        if px <= open_px * (1 - d_drop):
            return cp, px
    return None, None


def trigger_ts(by_t, cp: time):
    for ts, c in by_t:
        t = ts.astimezone(NY).time() if ts.tzinfo else ts.time()
        if t >= cp:
            return ts, c
    return None, None


def round_strike(px: float) -> float:
    # SPY strikes typically $1
    return round(px)


def leg_pnl(conn, d: date, t0: datetime, strike: float, close: float):
    """Entry = highest print in next 5m; exit = close intrinsic (uncapped). Returns (entry, exit, mult) or None."""
    occ = Z.occ(d, "C", strike)
    try:
        ob = Z.minute_bars(conn, occ, d, d)
    except Exception as e:
        print(f"  fetch fail {occ}: {e}", flush=True)
        return None
    if not ob:
        return None
    win = [x for x in ob if t0 < x[0] <= t0 + timedelta(minutes=5)]
    if not win:
        # fallback: first print after t0
        win = [x for x in ob if x[0] > t0][:5]
    if not win:
        return None
    entry = max(float(x[2]) for x in win)  # high
    if entry <= 0:
        return None
    exit_px = max(0.0, close - strike)
    mult = exit_px / entry if entry > 0 else 0.0
    return entry, exit_px, mult


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
    rows = conn.execute(
        """SELECT date::date, open::float8, low::float8, close::float8
           FROM lseg_research.daily_history
           WHERE ticker='SPY' AND open>0 AND low>0 AND date >= '2018-10-01' AND date < '2024-10-01'
           ORDER BY date"""
    ).fetchall()
    lines = ["", "## MODEL frequency (daily OHLC proxy 2018-10→2024-09)", "",
             "Proxy: open→low drop ≥ d; ITM = close ≥ drop_pt×(1+k).",
             "", "| d | k | n days | P(close ≥ strike) |", "|---|---|---:|---:|"]
    for dd in DS:
        for k in KS:
            n = hit = 0
            for d, o, lo, c in rows:
                if lo > o * (1 - dd):
                    continue
                n += 1
                drop_pt = o * (1 - dd)
                if c >= drop_pt * (1 + k):
                    hit += 1
            lines.append(f"| {dd:.1%} | {k:.0%} | {n} | {100*hit/max(n,1):.1f}% |")
    lines += ["", "_MODEL only — never the pass verdict._"]
    return lines


def real_prints(conn) -> tuple[list[str], dict]:
    days = [r[0] for r in conn.execute(
        """SELECT DISTINCT (ts AT TIME ZONE 'America/New_York')::date d
           FROM optlab.minute_bars WHERE ticker='SPY'
             AND (ts AT TIME ZONE 'America/New_York')::date >= %s
           ORDER BY 1""",
        (START_REAL,),
    ).fetchall()]
    # collect first trigger per day (smallest d that fires, first checkpoint)
    cells = defaultdict(list)  # (dd,k) -> list of multiples
    day_best = []  # per day max mult across ks for best-day-removed
    n_trig = 0
    for d in days:
        sess = spy_session(conn, d)
        if not sess:
            continue
        open_px, by_t = sess
        close = by_t[-1][1]
        fired = False
        for dd in DS:
            cp, trig = first_trigger(open_px, by_t, dd)
            if not cp:
                continue
            ts0, _ = trigger_ts(by_t, cp)
            if not ts0:
                continue
            fired = True
            n_trig += 1
            day_mults = []
            for k in KS:
                strike = round_strike(trig * (1 + k))
                if strike <= trig:
                    strike = round_strike(trig) + 1
                print(f"{d} d={dd:.1%} @{cp} trig={trig:.2f} k={k:.0%} K={strike}", flush=True)
                r = leg_pnl(conn, d, ts0, strike, close)
                if not r:
                    cells[(dd, k)].append(None)
                    continue
                entry, exit_px, mult = r
                cells[(dd, k)].append(mult)
                day_mults.append(mult)
                print(f"  entry={entry:.3f} exit={exit_px:.3f} mult={mult:.2f}x", flush=True)
            # ~0.05Δ approx: ~3% OTM for 0DTE is already very far; also try trig+1
            strike05 = round_strike(trig) + max(1, round(trig * 0.05))
            r = leg_pnl(conn, d, ts0, float(strike05), close)
            if r:
                cells[(dd, "0.05Δ")].append(r[2])
            if day_mults:
                day_best.append(max(day_mults))
            break  # first d only
        if not fired:
            continue

    lines = ["", "## Real prints (2024-10→, first trigger/day)", "",
             f"Trigger days with SPY minutes: **{n_trig}**.",
             "", "| d | k | n | mean mult | median | p90 | max | % worthless | profit/$ |",
             "|---|---|---:|---:|---:|---:|---:|---:|---:|"]
    summary = {}
    for dd in DS:
        for k in list(KS) + ["0.05Δ"]:
            xs = [m for m in cells.get((dd, k), []) if m is not None]
            if not xs:
                lines.append(f"| {dd if isinstance(dd,float) else dd} | {k if isinstance(k,str) else f'{k:.0%}'} | 0 | — | | | | | |")
                continue
            arr = np.array(xs, float)
            # profit per $ = mean(exit/entry - 1) = mean(mult - 1)
            pnl = float(arr.mean() - 1)
            worthless = 100.0 * float((arr <= 0).mean())
            key = (dd, k)
            summary[key] = {"n": len(xs), "pnl": pnl, "mult": float(arr.mean()), "max": float(arr.max()),
                            "worthless": worthless, "xs": xs}
            klab = k if isinstance(k, str) else f"{k:.0%}"
            lines.append(
                f"| {dd:.1%} | {klab} | {len(xs)} | {arr.mean():.2f}x | {np.median(arr):.2f}x | "
                f"{np.quantile(arr,0.9):.2f}x | {arr.max():.2f}x | {worthless:.0f}% | {pnl:+.2f} |"
            )

    # best cell + best-day-removed
    ranked = sorted(
        ((k, v) for k, v in summary.items() if v["n"] >= 3),
        key=lambda kv: kv[1]["pnl"],
        reverse=True,
    )
    lines += ["", "### Best-day-removed (top cell by profit/$)"]
    if not ranked:
        lines.append("No cell with n≥3.")
        verdict = "FAIL (thin real-print sample)"
    else:
        (dd, k), best = ranked[0]
        xs = best["xs"][:]
        # remove day with max mult
        if xs:
            i = int(np.argmax(xs))
            xs2 = xs[:i] + xs[i + 1 :]
            pnl2 = float(np.mean(xs2) - 1) if xs2 else float("nan")
        else:
            pnl2 = float("nan")
        klab = k if isinstance(k, str) else f"{k:.0%}"
        lines.append(f"Best: d={dd:.1%} k={klab} n={best['n']} profit/$={best['pnl']:+.2f} max={best['max']:.1f}x")
        lines.append(f"After dropping best day: profit/$={pnl2:+.2f} (n={len(xs2)})")
        # Pass bar
        ok = (
            best["pnl"] > 0
            and best["n"] >= 8
            and pnl2 > 0
        )
        # CI lower > -20%: crude bootstrap
        rng = np.random.default_rng(128)
        boots = [float(np.mean(rng.choice(best["xs"], size=len(best["xs"]), replace=True)) - 1) for _ in range(400)]
        lo = float(np.quantile(boots, 0.05))
        lines.append(f"Bootstrap 5% CI lower on profit/$: {lo:+.2f}")
        ok = ok and lo > -0.20
        verdict = "PASS" if ok else "FAIL"
        lines.append(f"**Real-print verdict: {verdict}** (bar: profit/$>0, CI_lo>−20%, n≥8, still >0 drop best day)")

    return lines, {"n_trig": n_trig, "verdict": verdict if ranked else "FAIL"}


def main() -> int:
    conn = connect()
    Z.ensure(conn)
    lines = [
        "# S128 — reversal convexity (A297; INDEX remap from S124)",
        "",
        "Far-OTM uncapped 0DTE calls after SPY intraday drop.",
        "",
    ]
    lines += smoke(conn)
    lines += model_freq(conn)
    if "--smoke-only" in sys.argv:
        lines += ["", "## Verdict", "**SMOKE ONLY**", "", "Refs: A297"]
    else:
        real_lines, meta = real_prints(conn)
        lines += real_lines
        lines += ["", "## Verdict", f"**{meta.get('verdict','INCOMPLETE')}**", "", "Refs: A297"]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
