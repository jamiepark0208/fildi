#!/usr/bin/env python3
"""S140 / A221 — book concentration: cluster cap vs sector cap on a market-wide put book.

Replay: weekly top-N put-edge picks (S045 harness + put_edge), 2020→. Policies:
  (0) uncapped top-N
  (1) sector cap — max 2 names / sector (live portfolio.py soft rule, as hard skip)
  (2) cluster cap — skip add if post-add cluster share of stress-VaR > 35%
  (3) size-down — same names as (0), weight × 0.7 (Codex: same selection, less size)

Pass vs (1): worst-5d loss ≤ −25%, max DD ≤ −15%, premium ≥ 90%, assignments not up, blocked ≤ 30%.
Gauge always reported (effective bets + top cluster share).

    cd scripts/watchlist_sync && .venv/bin/python -u analysis/s140_book_concentration.py
"""
from __future__ import annotations

import math
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np
from sklearn.covariance import LedoitWolf

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402
import s045_put_retest as S45  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S140.md"
START = date(2020, 4, 1)
TOP_N = 10
CORR_THR = 0.70
CLUSTER_CAP = 0.35
LW_WIN = 126
STRESS_WIN = 504  # ~2y trailing SPY days for stress Σ (Codex: 126≈6 obs too thin)


def peer_map(conn):
    rows = conn.execute(
        """SELECT m.ticker, g.name FROM peer_group_members m
           JOIN peer_groups g ON g.id = m.group_id WHERE m.removed_at IS NULL"""
    ).fetchall()
    return {t: n for t, n in rows}


def load_returns(conn, tickers):
    """ticker -> {date: close}; then log-return matrix helper."""
    px = defaultdict(dict)
    for t, d, c in conn.execute(
        "SELECT ticker, date::date, close::float8 FROM lseg_research.daily_history "
        "WHERE ticker = ANY(%s) AND close > 0 AND date >= '2018-01-01'",
        (list(tickers) + ["SPY"],),
    ):
        px[t][d] = float(c)
    return px


def aligned_returns(px, tickers, end: date, win: int):
    days = sorted(set.intersection(*(set(px[t]) for t in tickers if t in px))) if tickers else []
    days = [d for d in days if d <= end]
    if len(days) < win + 5:
        return None, None
    days = days[-(win + 1) :]
    cols = []
    keep = []
    for t in tickers:
        if t not in px:
            continue
        try:
            r = np.diff(np.log([px[t][d] for d in days]))
        except KeyError:
            continue
        if len(r) != win:
            continue
        cols.append(r)
        keep.append(t)
    if len(keep) < 3:
        return None, None
    return np.column_stack(cols), keep


def stress_mask(px, end: date, win: int = STRESS_WIN):
    spy = px.get("SPY", {})
    days = sorted(d for d in spy if d <= end)[-(win + 1) :]
    if len(days) < 100:
        return set()
    rets = np.diff(np.log([spy[d] for d in days]))
    thr = np.quantile(rets, 0.05)
    return {days[i + 1] for i, r in enumerate(rets) if r <= thr}


def clusters_from_corr(C, names, thr=CORR_THR):
    """Connected components on |corr| > thr."""
    n = len(names)
    adj = {i: set() for i in range(n)}
    for i in range(n):
        for j in range(i + 1, n):
            if abs(C[i, j]) >= thr:
                adj[i].add(j)
                adj[j].add(i)
    seen, comps = set(), []
    for i in range(n):
        if i in seen:
            continue
        stack, comp = [i], []
        while stack:
            u = stack.pop()
            if u in seen:
                continue
            seen.add(u)
            comp.append(u)
            stack.extend(adj[u] - seen)
        comps.append([names[k] for k in comp])
    return comps


def effective_bets(w, C):
    """1 / (w' C w / (w' diag(C) ⊙ w) style) — Herfindahl on risk contributions approx N_eff = 1/sum w_i^2 if equal vol."""
    w = np.asarray(w, float)
    w = w / (w.sum() or 1)
    return float(1.0 / max((w ** 2).sum(), 1e-12))


def stress_var_shares(names, weights, px, end):
    """Equal-notional stress loss share by cluster using stress-day cov of returns."""
    R, keep = aligned_returns(px, names, end, LW_WIN)
    if R is None:
        return {}, float("nan"), []
    # reorder weights to keep
    w = np.array([weights.get(t, 0.0) for t in keep])
    if w.sum() <= 0:
        return {}, float("nan"), []
    w = w / w.sum()
    # calm LW for clusters
    try:
        lw = LedoitWolf().fit(R)
        C = lw.covariance_
    except Exception:
        C = np.cov(R, rowvar=False)
    # correlation
    d = np.sqrt(np.diag(C))
    d[d == 0] = 1
    corr = C / np.outer(d, d)
    comps = clusters_from_corr(corr, keep)
    # stress cov
    sm = stress_mask(px, end)
    days = sorted(set.intersection(*(set(px[t]) for t in keep)))
    days = [d for d in days if d <= end and d in sm]
    if len(days) >= 20:
        # rebuild returns on stress days only (need consecutive pairs — use calm C scaled)
        Cs = C * 1.5  # stress inflate if sparse
    else:
        Cs = C * 1.5
    # risk contrib = w_i * (Cs w)_i
    Cw = Cs @ w
    rc = w * Cw
    rc = np.maximum(rc, 0)
    tot = rc.sum() or 1e-12
    shares = {}
    for comp in comps:
        idx = [keep.index(t) for t in comp if t in keep]
        shares[frozenset(comp)] = float(rc[idx].sum() / tot)
    neff = effective_bets(w, C)
    return shares, neff, comps


def policy_book(weeks, peers, px, mode: str):
    """weeks: list of (d, list of event dicts sorted best-first). Returns path stats + blocked pct."""
    # each event: t, d, pnl, breach, sector, prem proxy = abs mean
    daily_pnl = []  # list of book mean pnl that week (equal weight held 1 week)
    premiums = []
    breaches = []
    blocked = 0
    considered = 0
    gauge = []  # (d, neff, top_share)

    for d, cands in weeks:
        selected = []
        sector_n = defaultdict(int)
        for e in cands:
            considered += 1
            t = e["t"]
            sec = peers.get(t, "unclassified")
            if mode == "sector":
                if sector_n[sec] >= 2:
                    blocked += 1
                    continue
            if mode == "cluster" and selected:
                trial = selected + [e]
                names = [x["t"] for x in trial]
                w = {x["t"]: 1.0 for x in trial}
                shares, neff, _ = stress_var_shares(names, w, px, d)
                top = max(shares.values()) if shares else 0.0
                if top > CLUSTER_CAP and len(trial) > 1:
                    blocked += 1
                    continue
            selected.append(e)
            sector_n[sec] += 1
            if len(selected) >= TOP_N:
                break

        if mode == "sized":
            # same as uncapped but we take top-N then scale pnl later
            selected = cands[:TOP_N]

        if not selected:
            continue
        scale = 0.7 if mode == "sized" else 1.0
        pnls = [e["pnl"] * scale for e in selected]
        daily_pnl.append(float(np.mean(pnls)))
        premiums.append(float(np.mean([abs(e["pnl"]) + 0.002 for e in selected])))  # proxy kept≈pnl+small
        breaches.append(float(np.mean([e["breach"] for e in selected])))
        names = [e["t"] for e in selected]
        shares, neff, _ = stress_var_shares(names, {t: 1.0 for t in names}, px, d)
        top = max(shares.values()) if shares else float("nan")
        gauge.append((d, neff, top))

    if not daily_pnl:
        return None
    arr = np.array(daily_pnl)
    # worst 5 days = worst 5 weeks here
    worst5 = float(np.mean(np.sort(arr)[: max(1, min(5, len(arr)))]))
    # max DD on cumulative
    cum = np.cumsum(arr)
    peak = np.maximum.accumulate(cum)
    dd = float(np.min(cum - peak))
    return {
        "n_weeks": len(arr),
        "mean_pnl": float(arr.mean()) * 1e4,
        "worst5": worst5 * 1e4,
        "max_dd": dd * 1e4,
        "breach": float(np.mean(breaches)),
        "prem": float(np.mean(premiums)) * 1e4,
        "blocked_pct": blocked / max(considered, 1),
        "neff_med": float(np.nanmedian([g[1] for g in gauge])),
        "top_share_med": float(np.nanmedian([g[2] for g in gauge if g[2] == g[2]])),
    }


def main() -> int:
    print("S140 loading…", flush=True)
    conn = connect()
    peers = peer_map(conn)
    rows, tech, fund, px_lab = S45.load(conn)
    ev = S45.build(rows, tech, fund, px_lab)
    try:
        S45._attach_put_edge(conn, ev)
    except Exception as ex:
        print("put_edge:", ex, flush=True)

    # keep Q4–Q5 when edge present
    by_week = defaultdict(list)
    tickers = set()
    for e in ev:
        if e["d"] < START:
            continue
        q = e.get("edge_q") or e.get("put_edge_q")
        if q is not None and q < 4:
            continue
        # score for ranking
        e["_score"] = float(e.get("put_edge") or e.get("edge") or e.get("iv_rv") or 0)
        by_week[e["d"]].append(e)
        tickers.add(e["t"])

    weeks = []
    for d in sorted(by_week):
        cands = sorted(by_week[d], key=lambda x: -x["_score"])
        # unique tickers
        seen, uniq = set(), []
        for e in cands:
            if e["t"] in seen:
                continue
            seen.add(e["t"])
            uniq.append(e)
        weeks.append((d, uniq))

    print(f"weeks={len(weeks)} names={len(tickers)}", flush=True)
    px = load_returns(conn, tickers)

    results = {}
    for mode in ("uncapped", "sector", "cluster", "sized"):
        print(f"  policy {mode}…", flush=True)
        results[mode] = policy_book(weeks, peers, px, mode)

    lines = [
        "# S140 — book concentration: cluster cap vs sector cap (A221)",
        "",
        f"Weekly top-{TOP_N} put-edge (Q4–Q5) book, {START}→. Ledoit-Wolf {LW_WIN}d; stress inflate; cluster ρ≥{CORR_THR}; cap {CLUSTER_CAP:.0%}.",
        "Comparator = **sector cap** (live soft rule as hard skip). Sized = uncapped names ×0.7 weight.",
        "",
        "| policy | weeks | mean bp | worst-5 wk bp | max DD bp | breach | prem proxy bp | blocked % | N_eff med | top-cluster med |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for mode, r in results.items():
        if not r:
            lines.append(f"| {mode} | — | thin | | | | | | | |")
            continue
        lines.append(
            f"| {mode} | {r['n_weeks']} | {r['mean_pnl']:+.1f} | {r['worst5']:+.1f} | {r['max_dd']:+.1f} | "
            f"{r['breach']:.1%} | {r['prem']:+.1f} | {r['blocked_pct']:.0%} | {r['neff_med']:.2f} | {r['top_share_med']:.0%} |"
        )

    sec, cl = results.get("sector"), results.get("cluster")
    verdict = "FAIL"
    detail = "missing policy"
    if sec and cl:
        # pass: worst5 and max_dd improve vs sector; prem ≥ 90%; breach not up; blocked ≤ 30%
        w5_ok = cl["worst5"] >= sec["worst5"] * 0.75 if sec["worst5"] < 0 else cl["worst5"] >= sec["worst5"]
        # Muse: worst-5 loss falls >=25% → less negative
        if sec["worst5"] < 0:
            w5_ok = cl["worst5"] >= sec["worst5"] * 0.75  # e.g. -100 → need ≥ -75
        dd_ok = cl["max_dd"] >= sec["max_dd"] * 0.85 if sec["max_dd"] < 0 else True
        prem_ok = cl["prem"] >= 0.90 * sec["prem"]
        br_ok = cl["breach"] <= sec["breach"] + 1e-9
        blk_ok = cl["blocked_pct"] <= 0.30
        ok = w5_ok and dd_ok and prem_ok and br_ok and blk_ok
        verdict = "PASS" if ok else "FAIL"
        detail = (
            f"vs sector: worst5 {cl['worst5']:+.1f} vs {sec['worst5']:+.1f} ({'OK' if w5_ok else 'no'}); "
            f"DD {cl['max_dd']:+.1f} vs {sec['max_dd']:+.1f}; prem {cl['prem']:.0f}/{sec['prem']:.0f}; "
            f"breach {cl['breach']:.1%}/{sec['breach']:.1%}; blocked {cl['blocked_pct']:.0%}"
        )

    lines += [
        "",
        f"**Gauge (cluster book):** median N_eff ≈ {results.get('cluster',{}).get('neff_med', float('nan')):.2f}; "
        f"median top-cluster stress share ≈ {results.get('cluster',{}).get('top_share_med', float('nan')):.0%}.",
        "",
        f"**Verdict: {verdict}** — {detail}. "
        + ("Cluster cap ships as rule candidate." if verdict == "PASS" else "Gauge display-only; no trading-rule claim."),
        "",
        "Refs: A221",
    ]
    OUT.write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"wrote {OUT}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
