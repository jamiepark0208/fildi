#!/usr/bin/env python3
"""A371 task 2–3 — S088 top-10/wk holdout replay on LSEG quotes + regime split."""
from __future__ import annotations

import math
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import s088_sr_zones as S88  # noqa: E402
import s109_real_quote_rule as S109  # noqa: E402
from a371_lib import HOLDOUT, half_bits, quote_pnl, week_stats  # noqa: E402
from build_plan import connect  # noqa: E402
from s076_structures_backtest import Pricer  # noqa: E402
from s088_sr_zones import candidates, entries, horizon_expiry, load  # noqa: E402

TOPN = 10


def build_rows(conn, only=None):
    bars = load(conn, only)
    pricer = Pricer(conn)
    rows, today_rows = [], []
    for t, b in sorted(bars.items()):
        es = entries(b)
        last_i = len(b["c"]) - 1
        for i in es + ([last_i] if last_i not in es else []):
            zs, a = S88.zones(b, i)
            for side in ("put",):
                for r in candidates(b, i, side, pricer, zs, a):
                    r["t"] = t
                    (today_rows if i == last_i else rows).append(r)
    years = sorted({r["d"].year for r in rows})
    feats = S88.BASE_FEATS + S88.ZONE_FEATS
    for lab, fset in (("zones", feats),):
        for y in years:
            if y < S88.FIRST_FIT_YEAR:
                continue
            o = S88.fit_predict([r for r in rows if r["side"] == "put"], fset, y)
            if not o:
                continue
            p, e, te = o
            for r, pp, ee in zip(te, p, e):
                r["p_zones"], r["e_zones"] = float(pp), float(ee)
    return rows


def top_picks(rows, h=1, topn=TOPN, pmin=0.90):
    best = {}
    for r in rows:
        if r.get("side") != "put" or r.get("h") != h or "pnl" not in r or r["d"] < HOLDOUT:
            continue
        if r.get("p_zones", 0) < pmin:
            continue
        k = (r["t"], r["d"], r["h"])
        if k not in best or r["e_zones"] > best[k]["e_zones"]:
            best[k] = r
    byw = defaultdict(list)
    for r in best.values():
        byw[(r["d"], r["h"])].append(r)
    return [r for v in byw.values() for r in sorted(v, key=lambda z: -z["e_zones"])[:topn]]


def replay_picks(conn, picks, px):
    model, real, miss = [], [], 0
    for r in picks:
        exp = horizon_expiry(r["d"], r["h"])
        model.append({"d": r["d"], "r": r["pnl_wk"], "t": r["t"], "K": r["K"]})
        pxc = {d: (v[0], v[1]) for d, v in px.get(r["t"], {}).items()}
        q = quote_pnl(conn, r["t"], r["d"], r["K"], exp, pxc)
        if q:
            real.append({"d": q["d"], "r": q["r"], "t": r["t"]})
        else:
            miss += 1
    return model, real, miss


def regime_report(trades, attach):
    out = []
    tagged = [{**t, **attach(t["d"])} for t in trades]
    defs = [
        ("SPY>200d", lambda r: r.get("spy_up") is True),
        ("SPY≤200d", lambda r: r.get("spy_up") is False),
        ("br<40%", lambda r: r.get("br") is not None and r["br"] < 0.40),
        ("br≥40%", lambda r: r.get("br") is not None and r["br"] >= 0.40),
    ]
    for name, pred in defs:
        sub = [r for r in tagged if pred(r)]
        out.append((name, week_stats(sub)))
    return out


def run(smoke: bool = False):
    only = {"CAVA", "SHOP", "TMO"} if smoke else None
    with connect() as conn:
        rows = build_rows(conn, only)
        picks = top_picks(rows, h=1, topn=TOPN)
        q, px = S109.load(conn)
        model, real, miss = replay_picks(conn, picks, px)
        sm, sr = week_stats(model), week_stats(real) if real else {"n": 0, "weeks": 0, "wk_bp": float("nan"), "t": float("nan")}
        from a371_lib import build_regime

        attach, _ = build_regime(px, None)
        reg_m = regime_report(model, attach)
        reg_r = regime_report(real, attach)
        ratio = (sr["wk_bp"] / sm["wk_bp"]) if sm and sm.get("wk_bp") and abs(sm["wk_bp"]) > 1e-6 else float("nan")
        h1m, h2m = half_bits(model)
        h1r, h2r = half_bits(real)
        pass_replay = (
            math.isfinite(ratio)
            and ratio >= 0.8
            and sm
            and sr
            and sm["wk_bp"] * sr["wk_bp"] > 0
            and "−" not in h1r
            and "−" not in h2r
        )
        return {
            "picks": len(picks),
            "quote_miss": miss,
            "coverage": 1 - miss / max(1, len(picks)),
            "model": sm,
            "real": sr,
            "ratio": ratio,
            "half_model": (h1m, h2m),
            "half_real": (h1r, h2r),
            "pass_replay": pass_replay,
            "regime_model": reg_m,
            "regime_real": reg_r,
        }


if __name__ == "__main__":
    smoke = "--smoke" in sys.argv
    r = run(smoke=smoke)
    print(
        f"SANITY S088 replay: picks={r['picks']} cov={r['coverage']:.0%} "
        f"model={r['model']['wk_bp']:+.1f} real={r['real']['wk_bp']:+.1f} ratio={r['ratio']:.2f}",
        flush=True,
    )