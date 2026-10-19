"""S054 — what separated panic-put winners from falling knives? (S049 follow-up; Jamie 10-19 "dig").

Input = S049 event trades (watchlist_sync.strategy_trades, strategy 'panic-puts'). Outcome = pnl ÷ collateral (ret_pct)
and breach (finished ITM). Features at the event day, from LSEG daily data ≤ that day only. Discovery = entries < 07-01
(where panic puts lagged normal weeks); best stable feature's cut fixed there; ONE test on Jul→ (and on 2025 later, A178).

    cd scripts/watchlist_sync && .venv/bin/python analysis/s054_panic_put_patterns.py
"""
from __future__ import annotations

import math
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402

HOLDOUT, MID = date(2026, 7, 1), date(2026, 3, 15)
OUT = HERE.parent / "out" / "opt" / "S054.md"
rng = np.random.default_rng(54)


def load(conn):
    tr = conn.execute("""SELECT ticker, entry_ts::date, expiry, strike, ret_pct, capital FROM watchlist_sync.strategy_trades
                         WHERE strategy_id = 'panic-puts'""").fetchall()
    names = sorted({t[0] for t in tr})
    grp = dict(conn.execute("SELECT ticker, primary_peer_group_id FROM ticker_registry WHERE primary_peer_group_id IS NOT NULL").fetchall())
    peers = defaultdict(list)
    for t, g in grp.items():
        peers[g].append(t)
    need = set(names) | {p for t in names for p in peers.get(grp.get(t), [])} | {"SPY"}
    h = defaultdict(dict)
    for t, d, c, v, iv, ivc in conn.execute("""SELECT ticker, date, close::float, volume::float, iv30_put::float, iv30_call::float
                                               FROM lseg_research.daily_history WHERE ticker = ANY(%s) AND close > 0
                                               AND date >= '2025-01-01' ORDER BY date""", (list(need),)).fetchall():
        h[t][d] = (c, v, iv, ivc)
    earn = defaultdict(list)
    for t, d in conn.execute("SELECT ticker, report_date FROM lseg_research.earnings_moves").fetchall():
        earn[t].append(d)
    return tr, grp, peers, h, earn


def feats(t, entry, K, grp, peers, h, earn):
    ds = sorted(d for d in h[t] if d < entry)  # event day = last close before entry (entry = next day)
    if len(ds) < 260:
        return None
    d0 = ds[-1]
    c = np.array([h[t][d][0] for d in ds[-253:]])
    lr = np.diff(np.log(c))
    iv_now, iv_5 = h[t][d0][2], h[t][ds[-6]][2]
    rv20 = np.std(lr[-20:], ddof=1) * math.sqrt(252) * 100
    vol = np.array([h[t][d][1] or np.nan for d in ds[-70:]])
    r5 = c[-1] / c[-6] - 1
    pr = [h[p][d0][0] / h[p][ds[-6]][0] - 1 for p in peers.get(grp.get(t), []) if p != t and d0 in h[p] and ds[-6] in h[p]]
    spy = h["SPY"]
    worst1 = min(lr[-5:])
    return {
        "drop_5d": r5,
        "peer_group_5d": float(np.mean(pr)) if len(pr) >= 3 else np.nan,      # sector-wide (−) vs single-name (≈0)
        "own_minus_peers": r5 - float(np.mean(pr)) if len(pr) >= 3 else np.nan,
        "spy_5d": spy[d0][0] / spy[ds[-6]][0] - 1 if d0 in spy and ds[-6] in spy else np.nan,
        "iv_jump_5d": (iv_now - iv_5) if iv_now and iv_5 else np.nan,
        "iv_level": iv_now or np.nan,
        "iv_over_rv20": (iv_now / rv20) if iv_now and rv20 else np.nan,       # is the put rich vs recent moves
        "put_call_skew": (iv_now - h[t][d0][3]) if iv_now and h[t][d0][3] else np.nan,
        "gap_share": worst1 / np.sum(lr[-5:]) if np.sum(lr[-5:]) < 0 else np.nan,  # one-day shock vs grind
        "vol_spike": np.nanmean(vol[-5:]) / np.nanmean(vol[:-5]),
        "dist_52w_high": c[-1] / c.max() - 1,
        "mom_12_1": c[-22] / c[0] - 1,
        "earnings_in_drop": float(any(ds[-6] < e <= d0 for e in earn.get(t, ()))),
        "earnings_before_expiry": np.nan,  # filled by caller (needs expiry)
        "strike_otm": np.nan,
    }


def main():
    conn = connect()
    tr, grp, peers, h, earn = load(conn)
    rows = []
    for t, entry, exp, K, ret, cap in tr:
        f = feats(t, entry, K, grp, peers, h, earn)
        if not f:
            continue
        f["earnings_before_expiry"] = float(any(entry < e <= exp for e in earn.get(t, ())))
        S = h[t][max(d for d in h[t] if d < entry)][0]
        f["strike_otm"] = 1 - K / S
        rows.append(dict(t=t, d=entry, ret=ret, itm=ret < 0, f=f))
    ins = [r for r in rows if r["d"] < HOLDOUT]
    ho = [r for r in rows if r["d"] >= HOLDOUT]
    y = lambda rs: np.array([r["ret"] for r in rs])
    L = ["# S054 — panic-put winners vs falling knives (S049 events)", "",
         f"In-sample {len(ins)} trades (mean {y(ins).mean():+.2%}, ITM {np.mean([r['itm'] for r in ins]):.0%}), holdout "
         f"{len(ho)} ({y(ho).mean():+.2%}). Features: {len(rows[0]['f'])}.", "",
         "| feature | low tercile n | mean | ITM | high tercile n | mean | ITM | t | same sign both IS halves |", "|---|---|---|---|---|---|---|---|---|"]
    cand = []
    for f in rows[0]["f"]:
        x = np.array([r["f"][f] for r in ins], dtype=float)
        ok = ~np.isnan(x)
        if ok.sum() < 30:
            continue
        binary = len(set(x[ok])) <= 2
        lo_c, hi_c = (0.5, 0.5) if binary else np.nanquantile(x, [1 / 3, 2 / 3])
        lo = [r for r, v in zip(ins, x) if not np.isnan(v) and (v < 0.5 if binary else v <= lo_c)]
        hi = [r for r, v in zip(ins, x) if not np.isnan(v) and (v >= 0.5 if binary else v > hi_c)]
        if len(lo) < 8 or len(hi) < 8:
            continue
        a, b = y(lo), y(hi)
        t = (b.mean() - a.mean()) / math.sqrt(a.var(ddof=1) / len(a) + b.var(ddof=1) / len(b))
        sg = [np.sign(np.mean([r["ret"] for r in hi if c(r)] or [0]) - np.mean([r["ret"] for r in lo if c(r)] or [0]))
              for c in (lambda r: r["d"] < MID, lambda r: r["d"] >= MID)]
        st = sg[0] == sg[1] != 0
        L.append(f"| {f} | {len(lo)} | {a.mean():+.2%} | {np.mean([r['itm'] for r in lo]):.0%} | {len(hi)} | {b.mean():+.2%} | "
                 f"{np.mean([r['itm'] for r in hi]):.0%} | {t:+.2f} | {'yes' if st else 'no'} |")
        if abs(t) >= 2.5 and st:
            # keep the better side: avoid the bad tercile
            cand.append((abs(t), f, (lo_c if t > 0 else hi_c), t > 0, binary))
    if cand:
        _, f, cut, keep_high, binary = max(cand)
        keep = (lambda r: (r["f"][f] >= 0.5) == keep_high) if binary else \
               (lambda r: not np.isnan(r["f"][f]) and ((r["f"][f] > cut) if keep_high else (r["f"][f] <= cut)))
        k_in, k_ho = [r for r in ins if keep(r)], [r for r in ho if keep(r)]
        d_ho = [r for r in ho if not keep(r)]
        L += ["", f"**Confirmatory (one test): skip trades in the bad tercile of {f} (cut {cut:.3g}, fixed in-sample).**",
              f"- In-sample: kept {len(k_in)} → mean {y(k_in).mean():+.2%}, ITM {np.mean([r['itm'] for r in k_in]):.0%} "
              f"(all {y(ins).mean():+.2%}).",
              f"- Holdout: kept {len(k_ho)} → mean {y(k_ho).mean():+.2%} vs skipped {len(d_ho)} → "
              f"{(y(d_ho).mean() if d_ho else float('nan')):+.2%}. "
              f"**{'PASS' if d_ho and y(k_ho).mean() > y(d_ho).mean() else 'FAIL'}** (kept must beat skipped)."]
    else:
        L += ["", "**No feature cleared |t| ≥ 2.5 with a stable sign in-sample.**"]
    OUT.write_text("\n".join(L))
    print("\n".join(L[2:]))


if __name__ == "__main__":
    main()
