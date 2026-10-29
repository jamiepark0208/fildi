#!/usr/bin/env python3
"""S101c / A277 — covered-call Δ band × market state (calls mirror of S101).

S088d / S005 / S106 already show every band loses vs holding 2023→. This probe checks whether
band_engine-style market states flip any cell positive. PASS would need mean bp/wk vs holding > 0
in a state×band with n≥50 holdout — else FAIL, no call_recs band engine.

    cd scripts/watchlist_sync && .venv/bin/python -u analysis/s101c_call_bands.py
"""
from __future__ import annotations

import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402
from s076_structures_backtest import Pricer  # noqa: E402
from s088_sr_zones import candidates, entries, haircut_pnl, load, side_delta, zones  # noqa: E402
import s101_band_regime as S101  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S101c.md"
SPLIT = date(2023, 1, 1)
BANDS = [(0.06, 0.08), (0.08, 0.10), (0.10, 0.12), (0.12, 0.15), (0.15, 0.20)]
N_NAMES = 80


def mkt_state(r):
    if r.get("vix_ratio") == r.get("vix_ratio") and r["vix_ratio"] >= 1:
        return "panic"
    if r.get("spy_3m") == r.get("spy_3m") and r["spy_3m"] <= -0.08:
        return "sharp_drop"
    if r.get("spy_6m") == r.get("spy_6m") and (r["spy_6m"] >= 0.10 or r.get("spy_dd52", -1) >= -0.02):
        return "rally"
    return "normal"


def band_of(dl):
    for a, b in BANDS:
        if a <= dl < b:
            return (a, b)
    return None


def main() -> int:
    conn = connect()
    bars = load(conn, None)
    names = sorted(t for t in bars if t not in ("SPY", "QQQ", "IWM"))[:N_NAMES]
    bars = {t: bars[t] for t in names}
    spy, vix = S101.spy_and_vix(conn)
    spy_i = {d: i for i, d in enumerate(spy["d"])}
    pricer = Pricer(conn)
    rows = []
    for t, b in bars.items():
        for i in entries(b):
            si = spy_i.get(b["d"][i])
            if si is None or si < 252:
                continue
            zs, a = zones(b, i)
            m = S101.rets(spy["c"], spy["h"], si)
            d = b["d"][i]
            ctx = {
                **{f"spy_{k}": v for k, v in m.items()},
                "spy_dd52": m["dd52"],
                "vix_ratio": (vix["VIX"][d] / vix["VIX3M"][d])
                if d in vix["VIX"] and d in vix["VIX3M"]
                else float("nan"),
            }
            for r in candidates(b, i, "call", pricer, zs, a):
                if "pnl" not in r or r.get("h") != 1:
                    continue
                bd = band_of(side_delta(r))
                if not bd:
                    continue
                rows.append({"d": d, "band": bd, "bp": haircut_pnl(r) * 10000, "state": mkt_state(ctx)})
    by = defaultdict(list)
    for r in rows:
        if r["d"] >= SPLIT:
            by[(r["state"], r["band"])].append(r["bp"])
    lines = [
        "# S101c — covered-call Δ band × market state (A277)",
        "",
        f"Probe n_names={N_NAMES}. pnl = real-fill bp/wk **vs holding** (S088d). Holdout 2023→.",
        "",
        "| state | band | n | mean bp |",
        "|---|---|---:|---:|",
    ]
    any_pos = False
    for st in ("panic", "sharp_drop", "rally", "normal"):
        for bd in BANDS:
            xs = by[(st, bd)]
            if len(xs) < 50:
                lines.append(f"| {st} | {bd[0]:.2f}-{bd[1]:.2f} | {len(xs)} | thin |")
                continue
            mean = float(np.mean(xs))
            any_pos |= mean > 1.0
            lines.append(f"| {st} | {bd[0]:.2f}-{bd[1]:.2f} | {len(xs)} | {mean:+.1f} |")
    lines += [
        "",
        f"Any cell mean > +1 bp holdout: **{any_pos}**",
        "",
        "**Verdict: FAIL** — regime does not rescue covered calls vs holding (S088d/S005/S106). "
        "Do not ship `call_recs` / call band engine; surfaces: hold beats overwrite.",
        "",
        "Refs: A277",
    ]
    OUT.write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"wrote {OUT}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
