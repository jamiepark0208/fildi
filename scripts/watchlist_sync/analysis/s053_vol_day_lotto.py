"""S053 — does the S052 'volatile day' lotto make MONEY on real 0DTE prints? Pre-registered 2026-10-19 (asks/A177.md).

Signal day = first S052 checkpoint where the composite vol_day score > its fixed in-sample cut. At that checkpoint buy BOTH
the ~1 %-OTM 0DTE SPY call and put (1 each). Entry = highest trade print in the next 5 min (no quotes → pessimistic).
Exit each leg: 10× entry if it trades there (filled at 10×), else intrinsic at the 16:00 close (minute close, not h/l).
Baseline: an equal number of random NON-signal days (seeded), at 10:30, same trade.
Test period = 2024-10 → 2025-12 (S052's untouched 2nd holdout). 2026 reported separately (in-sample for the score).
Pass: signal pnl per $ risked > 0, > baseline, day-bootstrap p < 0.05.

    cd scripts/watchlist_sync && .venv/bin/python analysis/s053_vol_day_lotto.py [--write]
"""
from __future__ import annotations

import sys
from datetime import date, datetime, time, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import s048_0dte as Z  # noqa: E402  (cached minute bars, occ, shared Polygon gate)
import s052_0dte_winners as W  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S053.md"
Y26 = date(2026, 1, 1)
rng = np.random.default_rng(53)


def leg(conn, d, t0, cp, strike, close):
    ob = Z.minute_bars(conn, Z.occ(d, cp, strike), d, d)
    win = [x for x in ob if t0 < x[0] <= t0 + timedelta(minutes=5)]
    if not win:
        return None
    entry = max(x[2] for x in win)
    if entry <= 0:
        return None
    tgt = next((x for x in ob if x[0] > win[-1][0] and x[2] >= Z.TARGET * entry), None)
    intr = max(0.0, strike - close) if cp == "P" else max(0.0, close - strike)
    ex = Z.TARGET * entry if tgt else intr
    return dict(cp=cp, strike=strike, entry=entry, exit=ex, pnl=(ex - entry) * 100, risk=entry * 100, hit=bool(tgt),
                entry_ts=win[-1][0])


def trade(conn, d, cp_time, bars):
    b = bars[d]
    i = next((j for j, x in enumerate(b) if x[0] >= cp_time), None)
    if i is None:
        return None
    P, close = b[i][3], b[-1][3]
    t0 = datetime.combine(d, b[i][0], Z.NY)
    legs = [leg(conn, d, t0, "C", round(P * (1 + Z.OTM)), close), leg(conn, d, t0, "P", round(P * (1 - Z.OTM)), close)]
    legs = [x for x in legs if x]
    return dict(d=d, cp=cp_time, spot=P, close=close, legs=legs) if legs else None


def agg(tr):
    pnl = sum(x["pnl"] for t in tr for x in t["legs"])
    risk = sum(x["risk"] for t in tr for x in t["legs"])
    return pnl, risk, (pnl / risk if risk else float("nan"))


def boot(sig, base, n=4000):
    a = np.array([agg([t])[0] for t in sig]); ra = np.array([agg([t])[1] for t in sig])
    b = np.array([agg([t])[0] for t in base]); rb = np.array([agg([t])[1] for t in base])
    worse = 0
    for _ in range(n):
        i, j = rng.integers(0, len(a), len(a)), rng.integers(0, len(b), len(b))
        if a[i].sum() / ra[i].sum() <= max(0.0, b[j].sum() / rb[j].sum()):
            worse += 1
    return worse / n


def main(write=False):
    conn = Z.connect()
    Z.ensure(conn)
    bars, iv = W.load(conn)
    rows = W.build(bars, iv, W.macro_days())
    ins = [r for r in rows if Y26 <= r["d"] < W.HOLDOUT]
    comp = ["gap_open_sigma", "rv_today_over_iv", "iv_level", "prev_day_abs_ret", "minutes_left"]
    mu = {f: np.mean([r["f"][f] for r in ins]) for f in comp}
    sd = {f: np.std([r["f"][f] for r in ins]) for f in comp}
    for r in rows:
        r["vol_day"] = np.mean([(r["f"][f] - mu[f]) / sd[f] for f in comp])
    cut = np.quantile([r["vol_day"] for r in ins], 2 / 3)
    first = {}
    for r in sorted(rows, key=lambda r: (r["d"], r["cp"])):
        if r["vol_day"] > cut and r["d"] not in first:
            first[r["d"]] = r["cp"]
    days = sorted({r["d"] for r in rows})
    out = {}
    for lab, lo, hi in (("test 2024-10→2025-12", date(2024, 1, 1), Y26), ("2026 (score in-sample Jan–Jun)", Y26, date(2099, 1, 1))):
        sig_d = [d for d in days if lo <= d < hi and d in first]
        non = [d for d in days if lo <= d < hi and d not in first]
        base_d = list(rng.choice(non, size=min(len(sig_d), len(non)), replace=False)) if non else []
        sig = [t for t in (trade(conn, d, first[d], bars) for d in sig_d) if t]
        base = [t for t in (trade(conn, d, time(10, 30), bars) for d in base_d) if t]
        out[lab] = (sig, base)
        print(f"{lab}: {len(sig)} signal / {len(base)} baseline days priced", flush=True)
    import option_history as OH
    OH.flush_usage(conn)
    L = ["# S053 — volatile-day 0DTE lotto on real prints (A177)", "",
         "Buy 1 call + 1 put ~1 % OTM at the first 'volatile day' checkpoint; entry = highest print in 5 min; exit 10× or close.", ""]
    for lab, (sig, base) in out.items():
        ps, rs, rr = agg(sig)
        pb, rb, rrb = agg(base)
        hits = sum(x["hit"] for t in sig for x in t["legs"])
        p = boot(sig, base) if sig and base else 1.0
        L += [f"## {lab}",
              f"- Signal: {len(sig)} days, pnl ${ps:+,.0f} on ${rs:,.0f} risked ({rr:+.0%}), 10× hits {hits}",
              f"- Baseline (random non-signal days, 10:30): {len(base)} days, pnl ${pb:+,.0f} on ${rb:,.0f} ({rrb:+.0%})",
              f"- p (signal ≤ max(0, baseline)) = {p:.3f}" + (f" → **{'PASS' if rr > 0 and rr > rrb and p < 0.05 else 'FAIL'}**"
                                                               if lab.startswith("test") else " (descriptive)"), ""]
        top = sorted(sig, key=lambda t: -agg([t])[0])[:5]
        L.append("Top signal days: " + "; ".join(f"{t['d']} {t['cp']:%H:%M} ${agg([t])[0]:+,.0f}" for t in top))
        L.append("")
    OUT.write_text("\n".join(L))
    print("\n".join(L[3:]))


if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parents[3] / ".env.local")
    main("--write" in sys.argv)
