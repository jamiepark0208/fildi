#!/usr/bin/env python3
"""Put benchmark — every new factor / regime / engine tweak must beat the live engine here before it ships (Jamie 10-28).

Same pool as A310: S088 1-week put candidates (~/.fildi/cache/s101_rows.pkl, real-fill haircut `hc`), one pick per
name-week, band table fit on < 2023, graded on 2023 → (holdout). Book metrics count no-trade weeks as 0.
Reference rows: live Fildi engine (the bar), Alpaca wheel score (public baseline, A310), fixed 0.11Δ.

Verdict per variant vs the live engine on the holdout (week-clustered t of the weekly difference):
  BETTER  book bp/wk higher with t ≥ 2, or within ±1 bp (|t| < 2) and worst-5 % week ≥ 10 bp better
  WORSE   book bp/wk lower with t ≤ −2, or within ±1 bp and worst-5 % week ≥ 10 bp worse
  SAME    otherwise (no ship)
  …and a BETTER is downgraded to "BETTER (holdout only)" if the same variant is worse than the live engine before 2023
  (Δ bp < −1 or worst-5 % week ≥ 10 bp worse). 10-28 case: filling the engine's skipped weeks looked +1.2 bp (t 3.6) on
  2023 → but those trades were crashed names in bear grinds — ~0 bp with a −404 bp tail in 2019–22. A holdout without a
  bear market can't validate a rule that only matters in one.
Add a variant: write `rule(row) -> band | None` (optionally refit the table with a custom market state) and register it
in VARIANTS. Run: cd scripts/watchlist_sync && .venv/bin/python analysis/put_benchmark.py [long_daily.json]
"""
from __future__ import annotations

import json
import pickle
import sys
from bisect import bisect_left
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import band_engine as BE  # noqa: E402
from build_plan import connect  # noqa: E402
from a310_wheel_baseline import pick_alpaca, pick_custom, pick_fixed  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "put_benchmark.md"
FLOOR = BE.FLOORS["standard"]


# ---------- market regime inputs (S130 v2 2-flag score, S136 jump model) keyed by the last close before each entry ----------
def market_inputs(src: str | None) -> dict:
    if not src:
        return {}
    from s130_daily_regime import features, load
    from s136_public_regime_models import features as jm_feats, jm_states
    D = load(src)
    spy = D["SPY"]
    F = features(spy, D["^VIX"].close, {})
    flags = ((F.atr_pct > .8).astype(int) + (F.er20 < .4).astype(int)).where(F.atr_pct.notna() & F.er20.notna())
    ret = spy.close.pct_change().dropna()
    jm = jm_states(jm_feats(ret), ret)            # walk-forward, online; 0 bull / 1 bear
    return {"flags": flags.dropna(), "jm": jm}


def asof(series: pd.Series, d: date):
    idx = series.index
    i = bisect_left(idx, pd.Timestamp(d)) - 1      # strictly before the entry date
    return None if i < 0 else series.iloc[i]


def shifted(band: str | None, k: int) -> str | None:
    """k = −1 → one band farther OTM (lower Δ), +1 → closer."""
    if band is None:
        return None
    i = BE.BANDS.index(band) + k
    return BE.BANDS[i] if 0 <= i < len(BE.BANDS) else band


def engine_rule(table):
    def rule(row):
        m = BE.market_state(row)
        return None if m == "panic" else BE.choose(table, m, BE.name_state(row), FLOOR)
    return rule


def refit_with(rows_tr, extra):
    """Refit the band table with market state split by `extra(row)` (e.g. risk flags); returns rule using the same split."""
    orig = BE.market_state
    def ms(f):
        m = orig(f)
        return m if m == "panic" else f"{m}+{extra(f)}"
    BE.market_state = ms
    try:
        table = BE.fit(rows_tr)
    finally:
        BE.market_state = orig
    def rule(row):
        m = orig(row)
        if m == "panic":
            return None
        mm = f"{m}+{extra(row)}"
        b = BE.choose(table, mm, BE.name_state(row), FLOOR)
        return b
    return rule


def verdict(d_bp: float, t: float, d_w5: float) -> str:
    if (d_bp > 1 and t >= 2) or (abs(d_bp) <= 1 and abs(t) < 2 and d_w5 >= 10):
        return "BETTER"
    if (d_bp < -1 and t <= -2) or (abs(d_bp) <= 1 and abs(t) < 2 and d_w5 <= -10):
        return "WORSE"
    return "SAME"


def main() -> int:
    rows = [r for r in pickle.loads(BE.CACHE.read_bytes()) if r["h"] == 1 and r.get("vix_ratio") == r.get("vix_ratio")]
    with connect() as c:
        BE.add_sector(c, rows)
        BE.add_breadth(c, rows)
    mk = market_inputs(sys.argv[1] if len(sys.argv) > 1 else None)
    cache = {}
    for r in rows:
        d = r["d"]
        if d not in cache:
            cache[d] = {k: asof(v, d) for k, v in mk.items()}
        r.update({f"mk_{k}": v for k, v in cache[d].items()})
    tr = [r for r in rows if r["d"] < BE.SPLIT]
    table = BE.fit(tr)
    live = engine_rule(table)

    V = {"(live) Fildi engine": lambda rs: None}
    def overlay(fn):
        return lambda row: fn(row, live(row))
    variants = {}
    if mk:
        variants["risk 2 flags → 1 band farther"] = overlay(lambda r, b: shifted(b, -1) if r.get("mk_flags") == 2 else b)
        variants["risk 2 → farther, 0 → closer"] = overlay(lambda r, b: shifted(b, -1) if r.get("mk_flags") == 2 else shifted(b, +1) if r.get("mk_flags") == 0 else b)
        variants["risk 2 flags → skip week"] = overlay(lambda r, b: None if r.get("mk_flags") == 2 else b)
        variants["jump model bear → 1 band farther"] = overlay(lambda r, b: shifted(b, -1) if r.get("mk_jm") == 1 else b)
        variants["refit: market state × risk flags"] = refit_with(tr, lambda f: int(f.get("mk_flags") or 0))
        variants["refit: market state × jump model"] = refit_with(tr, lambda f: "bear" if f.get("mk_jm") == 1 else "bull")

    # Coverage: the engine sits out ~60 % of name-weeks (no band clears the floor in that state). Fill them instead?
    base_b = BE.base_band(table, FLOOR)
    variants["fill skipped weeks with the base band"] = lambda row: live(row) or (None if BE.market_state(row) == "panic" else base_b)
    variants["fill skipped weeks one band farther than base"] = lambda row: live(row) or (None if BE.market_state(row) == "panic" else shifted(base_b, -1))

    weeks = sorted({r["d"] for r in rows if r["d"] >= BE.SPLIT})
    te = [r for r in rows if r["d"] >= BE.SPLIT]
    tr_weeks = sorted({r["d"] for r in tr})
    def book(picks):
        return BE.summary([r for r in picks if r["d"] >= BE.SPLIT], weeks)
    def book_tr(rule):
        return BE.summary(BE.pick_rows(tr, rule), tr_weeks)
    base = book(BE.pick_rows(te, live))
    base_tr = book_tr(live)
    refs = {"(ref) Alpaca wheel score": book(pick_custom(te, pick_alpaca)), "(ref) fixed 0.11Δ": book(pick_custom(te, pick_fixed))}

    L = ["# Put benchmark — live engine vs variants (holdout 2023 →, S088 1-week puts, real fills)", "",
         f"{len(te):,} candidates, {len(weeks)} weeks. Book = per collateral-week incl. no-trade weeks. Verdict vs live engine (see docstring).", "",
         "| strategy | trades | book bp/wk | Δ vs live | t | worst-5 % wk | Δ | Sharpe | max DD % | breach % | pre-2023 Δ bp / Δ w5 | verdict |",
         "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    def line(name, s, v=None, rule=None):
        br = 100 * (1 - s["kept"]) if s["n"] else float("nan")
        if v is None:
            L.append(f"| {name} | {s['n']:,} | {s['book_bp']:+.1f} | | | {s['book_w5']:+.0f} | | {s['sharpe']:.2f} | {s['mdd']:.1f} | {br:.1f} | | |")
            return
        diff = np.array([s["series"][w] - base["series"][w] for w in weeks])
        t = diff.mean() / (diff.std(ddof=1) / np.sqrt(len(diff))) if diff.std() > 0 else 0.0
        dbp, dw5 = s["book_bp"] - base["book_bp"], s["book_w5"] - base["book_w5"]
        v = verdict(dbp, t, dw5)
        pre = ""
        if rule is not None:
            st = book_tr(rule)
            pbp, pw5 = st["book_bp"] - base_tr["book_bp"], st["book_w5"] - base_tr["book_w5"]
            pre = f"{pbp:+.1f} / {pw5:+.0f}"
            if v == "BETTER" and (pbp < -1 or pw5 <= -10):
                v = "BETTER (holdout only)"
        L.append(f"| {name} | {s['n']:,} | {s['book_bp']:+.1f} | {dbp:+.1f} | {t:+.1f} | {s['book_w5']:+.0f} | {dw5:+.0f} | {s['sharpe']:.2f} | {s['mdd']:.1f} | {br:.1f} | {pre} | **{v}** |")
    line("(live) Fildi engine", base)
    for k, s in refs.items():
        line(k, s, True)
    for k, rule in variants.items():
        line(k, book(BE.pick_rows(te, rule)), True, rule)
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))
    return 0


if __name__ == "__main__":
    sys.exit(main())
