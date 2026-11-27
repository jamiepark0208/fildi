#!/usr/bin/env python3
"""A371 task 1 — S109 with delisted / inactive names (S076 when no LSEG quote)."""
from __future__ import annotations

import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from build_plan import connect  # noqa: E402
import s109_real_quote_rule as S109  # noqa: E402
from a371_lib import synth_s109_put, week_stats  # noqa: E402
from s076_structures_backtest import Pricer  # noqa: E402


def load_inactive_bars(conn):
    tickers = [r[0] for r in conn.execute("SELECT ticker FROM ticker_registry WHERE NOT COALESCE(is_active, TRUE)").fetchall()]
    bars = {}
    for t in tickers:
        rows = conn.execute(
            "SELECT date, close::float8, iv30_put::float8 FROM lseg_research.daily_history "
            "WHERE ticker=%s AND close>0 AND date>='2020-12-01' ORDER BY date",
            (t,),
        ).fetchall()
        if len(rows) < 320:
            continue
        ds, c, ivp = [], [], []
        for d, cl, iv in rows:
            ds.append(d if isinstance(d, date) else date.fromisoformat(str(d)[:10]))
            c.append(float(cl))
            ivp.append(float(iv) / 100 if iv and iv > 3 else (float(iv) if iv else None))
        bars[t] = {"d": ds, "c": np.asarray(c), "ivp": ivp}
    return tickers, bars


def synth_trades(conn, pricer, bars):
    out = []
    priced = defaultdict(int)
    for t, b in bars.items():
        es = [i for i, d in enumerate(b["d"]) if i >= 300 and d.weekday() == 0]
        for i in es:
            hit = synth_s109_put(pricer, t, b, i)
            if hit:
                hit["priced_by"] = hit.get("priced_by", "s076_model")
                priced[hit["priced_by"]] += 1
                # try real quote same week
                from a371_lib import quote_pnl  # noqa: WPS433

                px = {b["d"][j]: (float(b["c"][j]), float(b["c"][j])) for j in range(len(b["d"]))}
                real = quote_pnl(conn, t, hit["d"], hit["K"], hit["exp"], px)
                if real:
                    hit["r"] = real["r"]
                    hit["priced_by"] = "real_quote"
                    priced["real_quote"] += 1
                out.append(hit)
    return out, priced


def run(smoke: bool = False):
    with connect() as conn:
        pricer = Pricer(conn)
        q, px = S109.load(conn)
        base = S109.trades(q, px)
        rule = lambda r: r["inc"] >= 0.009 and r["otm"] >= 0.10 and r["dd52"] <= -0.25  # noqa: E731
        live = [r for r in base if rule(r)]
        tickers, bars = load_inactive_bars(conn)
        if smoke:
            keys = sorted(bars, key=lambda k: -len(bars[k]["d"]))[:5]
            bars = {k: bars[k] for k in keys}
        synth, priced_by = synth_trades(conn, pricer, bars)
        synth = [r for r in synth if r["d"] >= date(2020, 12, 1)]
        combined = live + [{"d": r["d"], "r": r["r"], "t": r["t"], "priced_by": r.get("priced_by")} for r in synth]
        s0, s1 = week_stats(live), week_stats(combined)
        cov = len(synth) / max(1, len(tickers))
        return {
            "inactive_tickers": len(tickers),
            "bars_names": len(bars),
            "synth_puts": len(synth),
            "coverage_share": cov,
            "priced_by": dict(priced_by),
            "without": s0,
            "with": s1,
            "names_added": len({r["t"] for r in synth}),
        }


if __name__ == "__main__":
    smoke = "--smoke" in sys.argv
    r = run(smoke=smoke)
    print(
        f"SANITY survivorship: synth={r['synth_puts']} inactive={r['inactive_tickers']} "
        f"bp_without={r['without']['wk_bp']:+.1f} bp_with={r['with']['wk_bp']:+.1f} "
        f"priced {r['priced_by']}",
        flush=True,
    )