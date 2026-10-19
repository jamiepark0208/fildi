"""Conditions grid (A178/A188; Jamie 10-19: "ensure certain conditions only trigger a trade … test per sector … further
categories"). Slices any study's simulated trades (watchlist_sync.study_trades) by point-in-time conditions and asks, per
cell: does the strategy beat its own baseline there, in BOTH periods?

Conditions (all known on the entry day):
  market   SPY (LSEG) on the prior close: decline = drawdown from 252d high ≤ −5 % and 20d return < 0; rebound = drawdown
           ≤ −5 % and 20d ≥ 0; uptrend = drawdown > −5 % and above the 200d; chop = everything else
  vol      SPY iv30_put vs fixed 2018–2024 terciles (calm / normal / stressed)
  sector   ticker_registry peer group prefix
  iv_band  the stock's own iv30 at entry (≤ 35, 35–49, 49–70, > 70)
  peer_move stock's 5d return minus its peer group's (alone ≤ −5 pp / with-sector otherwise)
  sector_trend peer group's equal-weight 20d return (falling ≤ −5 % / rising ≥ +5 % / flat) — sector selloffs SPY can't see
A cell is "robust" when n ≥ 10 per arm in each period, event − base has the same sign in both, and the pooled t clears
Holm across all cells tested. Everything else is shown but labelled exploratory.

    cd scripts/watchlist_sync && .venv/bin/python analysis/conditions_grid.py S049 [--periods 2026,2025]
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

MIN_N = 10


def market_tags(conn):
    spy = conn.execute("SELECT date, close::float, iv30_put::float FROM lseg_research.daily_history WHERE ticker = 'SPY' "
                       "AND close > 0 ORDER BY date").fetchall()
    d = [x[0] for x in spy]
    c = np.array([x[1] for x in spy])
    ivs = [x[2] for x in spy if x[0] < date(2025, 1, 1) and x[2]]
    lo, hi = np.quantile(ivs, [1 / 3, 2 / 3])
    tags = {}
    for i in range(252, len(d)):
        dd = c[i] / c[i - 251:i + 1].max() - 1
        r20 = c[i] / c[i - 20] - 1
        above = c[i] > c[i - 199:i + 1].mean()
        mk = ("decline" if dd <= -0.05 and r20 < 0 else "rebound" if dd <= -0.05 else "uptrend" if above else "chop")
        iv = spy[i][2]
        vol = None if not iv else "calm" if iv <= lo else "normal" if iv <= hi else "stressed"
        tags[d[i]] = (mk, vol)
    return tags, (lo, hi)


def peer_moves(conn, rows):
    grp = dict(conn.execute("SELECT ticker, primary_peer_group_id FROM ticker_registry "
                            "WHERE primary_peer_group_id IS NOT NULL").fetchall())
    members = defaultdict(list)
    for t, g in grp.items():
        members[g].append(t)
    need = {t for r in rows for t in [r["t"]] + members.get(grp.get(r["t"]), [])}
    lo = min(r["d"] for r in rows) - timedelta(days=45)
    px = defaultdict(dict)
    for t, d, c in conn.execute("SELECT ticker, date, close::float FROM lseg_research.daily_history WHERE ticker = ANY(%s) "
                                "AND date >= %s AND close > 0", (list(need), lo)).fetchall():
        px[t][d] = c

    def r5(t, d, n=5):
        ds = sorted(x for x in px[t] if x < d)
        return px[t][ds[-1]] / px[t][ds[-1 - n]] - 1 if len(ds) > n else None

    out = {}
    for r in rows:
        own = r5(r["t"], r["d"])
        peers = [v for p in members.get(grp.get(r["t"]), []) if p != r["t"] for v in [r5(p, r["d"])] if v is not None]
        p20 = [v for p in members.get(grp.get(r["t"]), []) if p != r["t"] for v in [r5(p, r["d"], 20)] if v is not None]
        out[(r["t"], r["d"])] = (None if own is None or len(peers) < 3 else
                                 "alone" if own - np.mean(peers) <= -0.05 else "with-sector",
                                 None if len(p20) < 3 else "sector falling" if np.mean(p20) <= -0.05 else
                                 "sector rising" if np.mean(p20) >= 0.05 else "sector flat")
    return {t: (g.split(".")[0] if g else "unknown") for t, g in grp.items()}, out


def iv_band(iv):
    return None if iv is None else "≤35" if iv <= 35 else "35–49" if iv <= 49 else "49–70" if iv <= 70 else ">70"


def main():
    study = sys.argv[1]
    periods = next((a.split("=")[1].split(",") for a in sys.argv if a.startswith("--periods=")), None)
    conn = connect()
    q = "SELECT period, arm, ticker, entry_d, ret, loss, feats FROM watchlist_sync.study_trades WHERE study = %s"
    rows = [dict(p=p, arm=a, t=t, d=d, ret=r, loss=l, f=f or {}) for p, a, t, d, r, l, f in conn.execute(q, (study,)).fetchall()]
    if periods:
        rows = [r for r in rows if r["p"] in periods]
    per = sorted({r["p"] for r in rows})
    mkt, (lo, hi) = market_tags(conn)
    sector, peer = peer_moves(conn, rows)
    for r in rows:
        prev = max((x for x in mkt if x < r["d"]), default=None)
        r["market"], r["vol"] = mkt.get(prev, (None, None))
        r["sector"] = sector.get(r["t"], "unknown")
        r["iv_band"] = iv_band(r["f"].get("iv"))
        r["peer_move"], r["sector_trend"] = peer.get((r["t"], r["d"]), (None, None))
    dims = ["market", "vol", "sector_trend", "sector", "iv_band", "peer_move"]
    cells = []
    for dim in dims:
        for val in sorted({r[dim] for r in rows if r[dim]}):
            stats = {}
            for p in per:
                e = [r["ret"] for r in rows if r["p"] == p and r["arm"] == "event" and r[dim] == val]
                b = [r["ret"] for r in rows if r["p"] == p and r["arm"] == "base" and r[dim] == val]
                el = [r["loss"] for r in rows if r["p"] == p and r["arm"] == "event" and r[dim] == val]
                stats[p] = (e, b, el)
            cells.append((dim, val, stats))
    # pooled test per cell: event − base, t from per-period differences pooled
    tested = []
    for dim, val, st in cells:
        ok = all(len(st[p][0]) >= MIN_N and len(st[p][1]) >= MIN_N for p in per)
        diffs = {p: (np.mean(st[p][0]) - np.mean(st[p][1])) if st[p][0] and st[p][1] else np.nan for p in per}
        e = [x for p in per for x in st[p][0]]
        b = [x for p in per for x in st[p][1]]
        t = ((np.mean(e) - np.mean(b)) / math.sqrt(np.var(e, ddof=1) / len(e) + np.var(b, ddof=1) / len(b))
             if len(e) > 2 and len(b) > 2 else np.nan)
        same = ok and len({np.sign(v) for v in diffs.values()}) == 1
        tested.append((dim, val, st, diffs, t, ok, same))
    n_tests = sum(1 for x in tested if x[5])
    # Holm: sort eligible by p
    pv = {(d, v): 2 * (1 - 0.5 * (1 + math.erf(abs(t) / math.sqrt(2)))) for d, v, _, _, t, ok, _ in tested if ok and not np.isnan(t)}
    robust = set()
    for k, (key, p) in enumerate(sorted(pv.items(), key=lambda x: x[1])):
        if p <= 0.05 / (len(pv) - k):
            robust.add(key)
        else:
            break
    L = [f"# Conditions grid — {study} (periods {', '.join(per)})", "",
         f"SPY vol terciles (iv30_put, 2018–24): calm ≤ {lo:.1f} < normal ≤ {hi:.1f} < stressed. {n_tests} cells eligible "
         f"(n ≥ {MIN_N} per arm in every period); Holm at 5 %. **robust** = same sign every period + Holm pass.", "",
         "| dimension | condition | " + " | ".join(f"{p} event n · mean · loss% | {p} base mean | {p} diff" for p in per) +
         " | pooled t | verdict |", "|---|---|" + "---|---|---|" * len(per) + "---|---|"]
    for dim, val, st, diffs, t, ok, same in tested:
        cols = []
        for p in per:
            e, b, el = st[p]
            cols.append(f"{len(e)} · {np.mean(e):+.2%} · {np.mean(el):.0%}" if e else "0")
            cols.append(f"{np.mean(b):+.2%}" if b else "—")
            cols.append(f"{diffs[p]:+.2%}" if not np.isnan(diffs[p]) else "—")
        verdict = ("**robust**" if (dim, val) in robust and same else "same sign, not sig" if same else
                   "too few" if not ok else "flips")
        L.append(f"| {dim} | {val} | " + " | ".join(cols) + f" | {t:+.2f} | {verdict} |")
    out = HERE.parent / "out" / "opt" / f"{study}_grid.md"
    out.write_text("\n".join(L))
    print("\n".join(L))


if __name__ == "__main__":
    main()
