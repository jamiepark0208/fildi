"""S051 — reverse-engineer the winners of a failed strategy (Jamie 10-19: "define the successful trades first, then find
the patterns"). Discovery on in-sample only, ONE confirmatory test of the best rule on the holdout.

Strategy here: S050 sector laggard. Success = signed 10-day catch-up ≥ +3 %. For each candidate feature (computed from
data ≤ event day), compare in-sample tercile means; keep features whose top-vs-bottom tercile gap has |t| ≥ 2.5 and the
same sign in both in-sample halves. Best rule = laggards in the best tercile of the top feature (cut fixed in-sample) →
holdout mean, bootstrap p, vs all laggards. Number of features scanned is reported (multiple testing).

    cd scripts/watchlist_sync && .venv/bin/python analysis/s051_winner_patterns.py
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
import s050_sector_laggard as L  # noqa: E402
from build_plan import connect  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S051.md"
WIN = 0.03
MID_IS = date(2021, 6, 1)


def features(conn, ev):
    """Per-laggard features from bars ≤ event day (LSEG daily_history)."""
    names = sorted({r["t"] for r in ev})
    h = defaultdict(dict)
    for t, d, c, v, iv in conn.execute("""SELECT ticker, date, close::float, volume::float, iv30_put::float
                                          FROM lseg_research.daily_history WHERE ticker = ANY(%s) AND close > 0 ORDER BY date""",
                                       (names,)).fetchall():
        h[t][d] = (c, v, iv)
    idx = {t: sorted(x) for t, x in h.items()}
    for r in ev:
        ds = idx[r["t"]]
        i = ds.index(r["d"]) if r["d"] in h[r["t"]] else None
        if i is None or i < 252:
            r["f"] = None
            continue
        c = np.array([h[r["t"]][x][0] for x in ds[i - 252:i + 1]])
        v = np.array([h[r["t"]][x][1] or np.nan for x in ds[i - 70:i + 1]])
        iv = [h[r["t"]][x][2] for x in (ds[i - 5], ds[i])]
        r5 = c[-1] / c[-6] - 1
        r["f"] = {
            "gap_sigma": abs(r["gap"]),                                   # how far behind (σ units)
            "group_z": abs(r["z"]),                                       # how big the group move
            "own_5d_signed": r["sign"] * r5,                              # moved with group (+) or against it (−)
            "mom_12_1": r["sign"] * (c[-22] / c[0] - 1),                  # longer trend, in group's direction
            "dist_52w_high": c[-1] / c.max() - 1,
            "vol_spike_5d": np.nanmean(v[-5:]) / np.nanmean(v[-70:-5]),   # volume while lagging vs normal
            "iv_change_5d": (iv[1] - iv[0]) if iv[0] and iv[1] else np.nan,  # did options price stock-specific fear
            "rel_20d_prior": r["sign"] * ((c[-6] / c[-26] - 1)),          # already lagging/leading before the event
            "earnings_in_window": float(r["earn"]),
            "spy_above_200d": float(r["spy_up"]),
            "rally": float(r["sign"] > 0),
        }
    return [r for r in ev if r.get("f")]


def t_gap(a, b):
    if len(a) < 10 or len(b) < 10:
        return np.nan
    return (np.mean(a) - np.mean(b)) / np.sqrt(np.var(a, ddof=1) / len(a) + np.var(b, ddof=1) / len(b))


def main():
    conn = connect()
    ev = [r for r in L.run(*L.load(conn)) if r["lag"]]
    ev = features(conn, ev)
    ins = [r for r in ev if r["d"] < L.HOLDOUT]
    ho = [r for r in ev if r["d"] >= L.HOLDOUT]
    y = lambda rs: np.array([r["fwd"][10] for r in rs])
    win = lambda rs: np.mean(y(rs) >= WIN) if rs else np.nan
    feats = list(ins[0]["f"])
    rows, keep = [], []
    for f in feats:
        x = np.array([r["f"][f] for r in ins], dtype=float)
        ok = ~np.isnan(x)
        if len(set(x[ok])) <= 2:  # binary → split on value
            lo_cut = hi_cut = 0.5
        else:
            lo_cut, hi_cut = np.nanquantile(x, [1 / 3, 2 / 3])
        lo = [r for r, v in zip(ins, x) if v <= lo_cut] if lo_cut != hi_cut else [r for r, v in zip(ins, x) if v < 0.5]
        hi = [r for r, v in zip(ins, x) if v > hi_cut] if lo_cut != hi_cut else [r for r, v in zip(ins, x) if v >= 0.5]
        t = t_gap(y(hi), y(lo))
        halves = [np.sign(np.mean(y([r for r in hi if c(r)])) - np.mean(y([r for r in lo if c(r)])))
                  for c in (lambda r: r["d"] < MID_IS, lambda r: r["d"] >= MID_IS)]
        stable = halves[0] == halves[1]
        rows.append((f, len(lo), np.mean(y(lo)), win(lo), len(hi), np.mean(y(hi)), win(hi), t, stable))
        if abs(t) >= 2.5 and stable:
            keep.append((abs(t), f, hi_cut if t > 0 else lo_cut, t > 0))
    Lines = ["# S051 — what separates sector-laggard winners from losers (reverse-engineered from S050)", "",
             f"Success = signed 10-day catch-up ≥ {WIN:.0%}. In-sample laggards {len(ins)} (win rate {win(ins):.0%}), holdout "
             f"{len(ho)} ({win(ho):.0%}). Features scanned: {len(feats)} (expect ~{len(feats) * 0.012:.1f} false |t| ≥ 2.5).", "",
             "| feature | low tercile n | mean 10d | win % | high tercile n | mean 10d | win % | t (high−low) | same sign both halves |",
             "|---|---|---|---|---|---|---|---|---|"]
    for f, nl, ml, wl, nh, mh, wh, t, st in sorted(rows, key=lambda r: -abs(r[7])):
        Lines.append(f"| {f} | {nl} | {ml:+.2%} | {wl:.0%} | {nh} | {mh:+.2%} | {wh:.0%} | {t:+.2f} | {'yes' if st else 'no'} |")
    if keep:
        _, f, cut, high = max(keep)
        sel = lambda rs: [r for r in rs if not np.isnan(r["f"][f]) and ((r["f"][f] > cut) if high else (r["f"][f] <= cut))]
        s_in, s_ho = sel(ins), sel(ho)
        m, p = L.boot(s_ho)
        Lines += ["", f"**Confirmatory (one test): rule = {f} {'>' if high else '≤'} {cut:.3g} (cut fixed in-sample).**",
                  f"- In-sample: n {len(s_in)}, mean {np.mean(y(s_in)):+.2%}, win {win(s_in):.0%} (all laggards "
                  f"{np.mean(y(ins)):+.2%}).",
                  f"- Holdout: n {len(s_ho)}, mean {m:+.2%}, win {win(s_ho):.0%}, p {p:.3f} (all laggards {np.mean(y(ho)):+.2%}).",
                  f"- **{'PASS' if m >= 0.005 and p < 0.05 else 'FAIL'}** (bar: holdout ≥ +0.5 %, p < 0.05)."]
    else:
        Lines += ["", "**No feature cleared |t| ≥ 2.5 with a stable sign → nothing to confirm.**"]
    OUT.write_text("\n".join(Lines))
    print("\n".join(Lines[2:]))


if __name__ == "__main__":
    main()
