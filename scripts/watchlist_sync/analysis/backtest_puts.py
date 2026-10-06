"""Step 4 v1: reconstructed put-selling backtest + factor research (read-only).

Trades: on the first trading day of each month (non-overlapping, so months are independent samples), for every ticker with
data, sell a ~0.20-delta put expiring ~30 calendar days out. Priced with Black-Scholes at that day's LSEG 30d ATM put IV
(`lseg_research.daily_history`), times a realistic-fill haircut. ATM IV understates OTM put skew, so premiums run low
(conservative). Graded at expiry on the real close: P&L = fill − max(0, K − S_T), as % of collateral K.

Features are computed only from data on or before the entry date (point-in-time). For each feature: monthly cross-sectional
Spearman IC vs the trade's return on collateral, t-stat across months, top-vs-bottom quintile spread, and tail-loss rates.

Usage: ../.venv/bin/python backtest_puts.py [--haircut 0.85] [--delta 0.20]   → out/step4/backtest_puts.md (+ trades.csv)
"""
from __future__ import annotations

import argparse
import csv
import math
import sys
from bisect import bisect_left, bisect_right
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from statistics import mean, median, pstdev

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_plan import connect, rows  # noqa: E402
from street_scenarios import spearman  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "out" / "step4"
RF = {2019: 0.02, 2020: 0.005, 2021: 0.001, 2022: 0.02, 2023: 0.05, 2024: 0.05, 2025: 0.043, 2026: 0.04}
DTE = 30
TAIL = -0.05  # a month losing > 5% of collateral = a "blow-up" for a premium seller


def ncdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def bs_put(S, K, T, r, s):
    if T <= 0 or s <= 0:
        return max(0.0, K - S)
    d1 = (math.log(S / K) + (r + s * s / 2) * T) / (s * math.sqrt(T))
    d2 = d1 - s * math.sqrt(T)
    return K * math.exp(-r * T) * ncdf(-d2) - S * ncdf(-d1)


def strike_for_delta(S, T, r, s, delta):
    """Put delta = −N(−d1) → d1 = −N⁻¹(delta)."""
    lo, hi = -6.0, 6.0
    for _ in range(60):  # inverse normal by bisection (no scipy dependency)
        mid = (lo + hi) / 2
        if ncdf(mid) < delta:
            lo = mid
        else:
            hi = mid
    d1 = -mid
    return S * math.exp(-(d1 * s * math.sqrt(T)) + (r + s * s / 2) * T)


def rsi(closes, n=14):
    if len(closes) <= n:
        return None
    gains = losses = 0.0
    for a, b in zip(closes[-n - 1:-1], closes[-n:]):
        d = b - a
        gains += max(d, 0)
        losses += max(-d, 0)
    if losses == 0:
        return 100.0
    rs = (gains / n) / (losses / n)
    return 100 - 100 / (1 + rs)


def pct_rank(v, hist, min_n=60):
    hist = [h for h in hist if h is not None]
    if v is None or len(hist) < min_n:
        return None
    return sum(h <= v for h in hist) / len(hist)


def load(conn):
    H = defaultdict(list)
    for r in rows(conn, """SELECT ticker, date, close, iv30_put FROM lseg_research.daily_history
                           WHERE close IS NOT NULL ORDER BY ticker, date"""):
        H[r["ticker"]].append((r["date"], r["close"], r["iv30_put"]))
    peer = {r["ticker"]: r["name"] for r in rows(conn, """
        SELECT t2.ticker, g.name FROM (SELECT ticker, group_id FROM peer_group_overrides UNION ALL
          SELECT DISTINCT ON (ticker) ticker, group_id FROM peer_group_members m WHERE removed_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM peer_group_overrides o WHERE o.ticker = m.ticker)) t2 JOIN peer_groups g ON g.id = t2.group_id""")}
    er = defaultdict(list)
    for r in rows(conn, "SELECT ticker, report_date FROM lseg_research.earnings_moves UNION SELECT ticker, event_date FROM lseg_research.events WHERE event_type = 'EarningsReleases'"):
        er[r["ticker"]].append(r["report_date"])
    sm = defaultdict(lambda: defaultdict(list))
    for r in rows(conn, "SELECT ticker, metric, obs_date, value::float8 v FROM lseg_research.starmine_history ORDER BY obs_date"):
        sm[r["ticker"]][r["metric"]].append((r["obs_date"], r["v"]))
    return H, peer, {t: sorted(set(v)) for t, v in er.items()}, sm


def month_starts(dates):
    seen, out = set(), []
    for d in dates:
        if (d.year, d.month) not in seen:
            seen.add((d.year, d.month))
            out.append(d)
    return out


def build_trades(H, peer, er, sm, haircut, target_delta):
    spy = {d: c for d, c, _ in H.get("SPY", [])}
    spy_dates = sorted(spy)
    all_dates = sorted({d for v in H.values() for d, _, _ in v})
    entries = [d for d in month_starts(all_dates) if d >= date(2020, 3, 1)]
    trades = []
    for t, series in H.items():
        if t == "SPY":
            continue
        ds = [d for d, _, _ in series]
        cl = [c for _, c, _ in series]
        iv = [v for _, _, v in series]
        for e in entries:
            i = bisect_left(ds, e)
            if i >= len(ds) or ds[i] != e or i < 60 or iv[i] is None or iv[i] <= 0:
                continue
            expiry = e + timedelta(days=DTE)
            j = bisect_right(ds, expiry) - 1  # last close on/before expiry
            if j <= i or ds[j] < expiry - timedelta(days=4):
                continue  # no exit price (end of data or a gap)
            S, s = cl[i], iv[i] / 100
            T = (ds[j] - e).days / 365
            r = RF.get(e.year, 0.03)
            K = strike_for_delta(S, T, r, s, target_delta)
            prem = bs_put(S, K, T, r, s) * haircut
            ST = cl[j]
            pnl = prem - max(0.0, K - ST)
            path = cl[i:j + 1]
            # point-in-time features
            lr = [math.log(cl[k] / cl[k - 1]) for k in range(max(1, i - 20), i + 1)]
            rv20 = pstdev(lr) * math.sqrt(252) if len(lr) >= 15 else None
            hist_iv = [x for x in iv[max(0, i - 252):i]]
            mom20 = S / cl[i - 20] - 1
            ma50 = mean(cl[i - 49:i + 1]) if i >= 49 else None
            rs = rsi(cl[max(0, i - 60):i + 1])
            rsi_hist = [rsi(cl[max(0, k - 60):k + 1]) for k in range(max(15, i - 252), i, 5)]
            k_spy = bisect_right(spy_dates, e) - 1
            spy_m20 = (spy[spy_dates[k_spy]] / spy[spy_dates[k_spy - 20]] - 1) if k_spy >= 20 else None
            ers = er.get(t, [])
            nxt = next((x for x in ers if e < x <= ds[j]), None)
            feats = {
                "iv30": iv[i], "iv_rank_1y": pct_rank(iv[i], hist_iv), "iv_rv": (s / rv20) if rv20 else None,
                "mom20": mom20, "mom_vs_spy": (mom20 - spy_m20) if spy_m20 is not None else None,
                "dist_ma50": (S / ma50 - 1) if ma50 else None, "rsi14": rs,
                "oversold_self": (1 - pct_rank(rs, rsi_hist, 30)) if rs is not None and pct_rank(rs, rsi_hist, 30) is not None else None,
                "fk_proxy": 1.0 if (mom20 < -0.15 and ma50 and S < ma50) else 0.0,
                "earnings_in_window": 1.0 if nxt else 0.0,
            }
            for metric in ("combined_alpha_rank", "pred_surprise_pct_fq1"):
                obs = [v for d, v in sm.get(t, {}).get(metric, []) if d <= e]
                feats[metric] = obs[-1] if obs else None
            trades.append({"ticker": t, "peer": peer.get(t), "entry": e, "exit": ds[j], "S": S, "K": K, "iv": iv[i], "prem": prem,
                           "ST": ST, "ret": pnl / K, "ret_ra": (pnl / K) / (s * math.sqrt(T)), "kept": pnl / prem if prem > 0 else None,
                           "fwd63": (cl[i + 63] / S - 1) if i + 63 < len(cl) else None, "tail_ra": (pnl / K) < -(s * math.sqrt(T)),
                           "assigned": ST < K, "mae": min(path) / S - 1, "spy_m20": spy_m20, **feats})
    # cross-sectional features need the whole month's cross-section
    by_month = defaultdict(list)
    for tr in trades:
        by_month[tr["entry"]].append(tr)
    for e, ts in by_month.items():
        for key, src in (("oversold_cs", "rsi14"), ("mom_rel_peer", "mom20")):
            if key == "oversold_cs":
                vals = sorted(x[src] for x in ts if x[src] is not None)
                for x in ts:
                    x[key] = (1 - bisect_right(vals, x[src]) / len(vals)) if x[src] is not None and vals else None
            else:
                g = defaultdict(list)
                for x in ts:
                    if x["peer"]:
                        g[x["peer"]].append(x["mom20"])
                for x in ts:
                    peers = g.get(x["peer"]) or []
                    x[key] = (x["mom20"] - median(peers)) if len(peers) >= 4 else None
        # market-adjusted oversold: oversold-ness after removing the month's cross-sectional median move
        med = median(x["mom20"] for x in ts)
        for x in ts:
            x["resid_mom20"] = x["mom20"] - med
    return trades


def resid_rank(vals, ctrl):
    """Rank-residual of vals after removing a linear fit on the ranks of ctrl (partial Spearman helper)."""
    idx = [i for i, (v, c) in enumerate(zip(vals, ctrl)) if v is not None and c is not None]
    if len(idx) < 20:
        return [None] * len(vals)
    def ranks(xs):
        o = sorted(range(len(xs)), key=lambda i: xs[i]); r = [0.0] * len(xs)
        for k, i in enumerate(o):
            r[i] = k
        return r
    rv, rc = ranks([vals[i] for i in idx]), ranks([ctrl[i] for i in idx])
    mv, mc = mean(rv), mean(rc)
    b = sum((a - mv) * (c - mc) for a, c in zip(rv, rc)) / (sum((c - mc) ** 2 for c in rc) or 1)
    out = [None] * len(vals)
    for k, i in enumerate(idx):
        out[i] = rv[k] - mv - b * (rc[k] - mc)
    return out


BINARY = {"fk_proxy", "earnings_in_window"}


def evaluate_binary(trades, f):
    """Monthly difference (flag=1 minus flag=0) in risk-adjusted return and tail rate, t-stat across months."""
    by_month = defaultdict(list)
    for t in trades:
        by_month[t["entry"]].append(t)
    d_ret, d_tail, n1 = [], [], 0
    for e, ts in by_month.items():
        a = [t for t in ts if t[f] == 1.0]
        b = [t for t in ts if t[f] == 0.0]
        if len(a) >= 3 and len(b) >= 10:
            d_ret.append(mean(t["ret_ra"] for t in a) - mean(t["ret_ra"] for t in b))
            d_tail.append(mean(t["tail_ra"] for t in a) - mean(t["tail_ra"] for t in b))
            n1 += len(a)
    if len(d_ret) < 12:
        return None
    tstat = lambda xs: mean(xs) / ((pstdev(xs) or 1e-9) / math.sqrt(len(xs)))
    return {"months": len(d_ret), "d_ret": mean(d_ret), "t_ret": tstat(d_ret), "d_tail": mean(d_tail), "t_tail": tstat(d_tail), "n_flag": n1}


def evaluate(trades, features, target="ret_ra"):
    by_month = defaultdict(list)
    for tr in trades:
        by_month[tr["entry"]].append(tr)
    res = {}
    for f in features:
        ics, pics = [], []
        for e, ts in sorted(by_month.items()):
            xs = [t[f] for t in ts]
            ys = [t[target] for t in ts]
            ic, n = spearman(xs, ys)
            if ic is not None and n >= 20:
                ics.append((e, ic))
            if f != "iv30":  # partial IC: does the feature add anything once IV level is held fixed?
                ivs = [t["iv30"] for t in ts]
                pic, pn = spearman(resid_rank(xs, ivs), resid_rank(ys, ivs))
                if pic is not None and pn >= 20:
                    pics.append(pic)
        valid = [t for t in trades if t[f] is not None]
        if not ics or len(valid) < 200:
            res[f] = None
            continue
        m = mean(i for _, i in ics)
        sd = pstdev([i for _, i in ics]) or 1e-9
        # quintiles within each month, then pooled
        q = defaultdict(list)
        for e, ts in by_month.items():
            v = sorted((t for t in ts if t[f] is not None), key=lambda t: t[f])
            if len(v) < 20:
                continue
            for k, t in enumerate(v):
                q[min(4, k * 5 // len(v))].append(t)
        qs = {k: {"ret": mean(t["ret"] for t in v), "ret_ra": mean(t["ret_ra"] for t in v), "tail": sum(t["tail_ra"] for t in v) / len(v),
                  "assign": sum(t["assigned"] for t in v) / len(v), "n": len(v)} for k, v in q.items()}
        by_year = defaultdict(list)
        for e, i in ics:
            by_year[e.year].append(i)
        pm = mean(pics) if pics else None
        pt = pm / ((pstdev(pics) or 1e-9) / math.sqrt(len(pics))) if pics else None
        res[f] = {"ic": m, "t": m / (sd / math.sqrt(len(ics))), "pic": pm, "pt": pt, "months": len(ics), "hit": sum(i > 0 for _, i in ics) / len(ics),
                  "q": qs, "years": {y: mean(v) for y, v in sorted(by_year.items())}, "n": len(valid)}
    return res


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--haircut", type=float, default=0.85)
    ap.add_argument("--delta", type=float, default=0.20)
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        H, peer, er, sm = load(conn)
    trades = build_trades(H, peer, er, sm, a.haircut, a.delta)
    if not trades:
        sys.exit("no trades: run research/lseg/sync_daily_history.py first")
    # sector-relative StarMine: does a name's alpha rank vs its own peer group add anything beyond the raw rank?
    by_m = defaultdict(list)
    for t in trades:
        by_m[t["entry"]].append(t)
    for ts in by_m.values():
        g = defaultdict(list)
        for x in ts:
            if x["peer"] and x["combined_alpha_rank"] is not None:
                g[x["peer"]].append(x["combined_alpha_rank"])
        for x in ts:
            v = g.get(x["peer"]) or []
            x["cam_rel_peer"] = (x["combined_alpha_rank"] - median(v)) if len(v) >= 4 and x["combined_alpha_rank"] is not None else None
    for ts in by_m.values():
        g = defaultdict(list)
        for x in ts:
            if x["peer"] and x["fwd63"] is not None:
                g[x["peer"]].append(x["fwd63"])
        for x in ts:
            v = g.get(x["peer"]) or []
            x["fwd63_rel"] = (x["fwd63"] - median(v)) if len(v) >= 4 and x["fwd63"] is not None else None
    cont = ["iv30", "iv_rank_1y", "iv_rv", "mom20", "mom_rel_peer", "dist_ma50", "rsi14", "oversold_self", "oversold_cs",
            "combined_alpha_rank", "cam_rel_peer", "pred_surprise_pct_fq1"]
    res = evaluate(trades, cont)
    tstat = lambda xs: mean(xs) / ((pstdev(xs) or 1e-9) / math.sqrt(len(xs))) if len(xs) > 2 else float("nan")
    rets = [t["ret"] for t in trades]
    L = [f"# Step 4 v2: reconstructed put-selling backtest ({date.today()})", "",
         f"{len(trades):,} monthly trades · {len({t['ticker'] for t in trades})} tickers · {min(t['entry'] for t in trades)} → {max(t['entry'] for t in trades)} · "
         f"~{a.delta:.2f}Δ put, {DTE}d, Black-Scholes at LSEG 30d ATM put IV × {a.haircut} fill haircut", "",
         f"**Baseline:** mean {100 * mean(rets):+.2f}% of collateral/month · median {100 * median(rets):+.2f}% · win {sum(r > 0 for r in rets) / len(rets):.0%} · "
         f"assigned {sum(t['assigned'] for t in trades) / len(trades):.0%} · loss beyond 1 implied σ {sum(t['tail_ra'] for t in trades) / len(trades):.1%} · worst {100 * min(rets):.1f}%", "",
         "**Scoring:** risk-adjusted return = return on collateral ÷ the option's own implied 1σ move. Raw return mechanically favors high-IV names "
         "(bigger premium) while hiding their blow-ups, so v1's raw-return table was misleading. *IC | IV* holds the IV level fixed: it shows whether a "
         "feature adds anything beyond 'sell the higher-IV name'.", "",
         "## Continuous features (IC > 0 → higher value, better risk-adjusted put outcome)", "",
         "| feature | IC | t | IC \\| IV | t | Q1 ra-ret | Q5 ra-ret | Q1 tail | Q5 tail | n |", "|---|---|---|---|---|---|---|---|---|---|"]
    for f in cont:
        r = res.get(f)
        if not r:
            L.append(f"| {f} | not enough data | | | | | | | | |")
            continue
        q1, q5 = r["q"].get(0, {}), r["q"].get(4, {})
        pic = f"{r['pic']:+.3f} | {r['pt']:+.1f}" if r.get("pic") is not None else "— | —"
        L.append(f"| {f} | {r['ic']:+.3f} | {r['t']:+.1f} | {pic} | {q1.get('ret_ra', 0):+.3f} | {q5.get('ret_ra', 0):+.3f} | "
                 f"{q1.get('tail', 0):.1%} | {q5.get('tail', 0):.1%} | {r['n']:,} |")
    kept = evaluate(trades, cont, "kept")
    own = evaluate(trades, cont, "fwd63_rel")
    kv = [t["kept"] for t in trades if t["kept"] is not None]
    L += ["", f"## Two cleaner targets: premium kept (mean {mean(kv):+.2f} of premium collected) and 3-month stock return vs sector peers", "",
          "*Premium kept* = P&L ÷ premium (1 = kept it all): what a put seller earns relative to what they were paid, with no built-in IV link. "
          "*3-month vs peers* is the right target for the green 'would happily own' verdict.", "",
          "| feature | kept: IC | t | kept: IC \\| IV | t | own (63d vs peers): IC | t | own: IC \\| IV | t |", "|---|---|---|---|---|---|---|---|---|"]
    fmt = lambda r, k, tk: f"{r[k]:+.3f} | {r[tk]:+.1f}" if r and r.get(k) is not None else "— | —"
    for f in cont:
        L.append(f"| {f} | {fmt(kept.get(f), 'ic', 't')} | {fmt(kept.get(f), 'pic', 'pt')} | {fmt(own.get(f), 'ic', 't')} | {fmt(own.get(f), 'pic', 'pt')} |")
    L += ["", "## Flags (monthly difference: flagged minus not flagged)", "", "| flag | months | Δ ra-ret | t | Δ tail rate | t | flagged trades |", "|---|---|---|---|---|---|---|"]
    for f in sorted(BINARY):
        b = evaluate_binary(trades, f)
        L.append(f"| {f} | {b['months']} | {b['d_ret']:+.3f} | {b['t_ret']:+.1f} | {100 * b['d_tail']:+.1f} pts | {b['t_tail']:+.1f} | {b['n_flag']:,} |" if b else f"| {f} | not enough data | | | | | |")
    # Q1 (technicals): self-relative vs cross-sectional oversold, by market regime (time-series view)
    L += ["", "## Oversold signals by market regime (SPY 20-day move at entry)", "",
          "| regime | months | IC oversold_self | IC oversold_cs | IC mom_rel_peer |", "|---|---|---|---|---|"]
    regimes = {"selloff (SPY 20d < −5%)": lambda m: m < -0.05, "normal": lambda m: -0.05 <= m <= 0.05, "rally (> +5%)": lambda m: m > 0.05}
    for name, cond in regimes.items():
        row = {}
        ms = 0
        for f in ("oversold_self", "oversold_cs", "mom_rel_peer"):
            ics = []
            for e, ts in by_m.items():
                sm = ts[0].get("spy_m20")
                if sm is None or not cond(sm):
                    continue
                ic, n = spearman([t[f] for t in ts], [t["ret_ra"] for t in ts])
                if ic is not None and n >= 20:
                    ics.append(ic)
            row[f] = f"{mean(ics):+.3f} (t {tstat(ics):+.1f})" if ics else "—"
            ms = max(ms, len(ics))
        L.append(f"| {name} | {ms} | {row['oversold_self']} | {row['oversold_cs']} | {row['mom_rel_peer']} |")
    L += ["", "## IC by year (stability, risk-adjusted)", "", "| feature | " + " | ".join(str(y) for y in range(2020, 2027)) + " |", "|---|" + "---|" * 7]
    for f in cont:
        r = res.get(f)
        if r:
            L.append(f"| {f} | " + " | ".join(f"{r['years'][y]:+.2f}" if y in r["years"] else "" for y in range(2020, 2027)) + " |")
    L += ["", "Notes: monthly entries don't overlap, so monthly ICs are ≈ independent; |t| < 2 is not reliable. No point-in-time history here for fundamentals, "
          "ARM (revisions) or credit, so those can't be tested yet. ATM IV understates OTM skew, so absolute returns are conservative; rankings are what matter."]
    (OUT / "backtest_puts.md").write_text("\n".join(L) + "\n")
    with open(OUT / "trades.csv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(trades[0].keys()))
        w.writeheader()
        w.writerows(trades)
    print("\n".join(L))


if __name__ == "__main__":
    main()
