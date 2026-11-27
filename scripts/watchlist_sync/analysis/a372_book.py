#!/usr/bin/env python3
"""A372 item 2 — book layer on S047 IRA replay + stress windows on S109 weekly puts.

Policies on the same trades:
  equal       Jamie fill qty, capital = strike × qty
  vol_scaled  weight = min(1, TARGET_ATR / (ATR14/close × K_MULT)); same selection
  corr_cap    equal weight, but ×0.5 when |ρ|>0.70 vs any concurrent name (126d returns)

Comparator: equal notional. Stress: concurrent top-8 S109 names/week (modelled hold pnl), 2020-03 and 2022 H1.

    .venv/bin/python analysis/a372_book.py [--smoke]
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
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402
from quantcore.ta import atr  # noqa: E402

OUT = HERE.parent.parent.parent / "research" / "studies" / "out" / "a372-book.md"
START_IRA = date(2026, 1, 1)
TARGET_ATR = 0.025  # # global: book-layer smoke target until stock-own percentile table wired
K_MULT = 1.0
CORR_THR = 0.70
CORR_WIN = 126
CORR_SCALE = 0.5
STRESS = ((date(2020, 2, 15), date(2020, 4, 15), "2020-03"),
          (date(2022, 1, 1), date(2022, 6, 30), "2022-H1"))
TOP_N = 8


def load_ira(conn):
    rows = conn.execute(
        """SELECT ticker, d0, expiry, strike::float, premium::float, qty::float
           FROM optlab.trades
           WHERE account = 'IRA' AND expiry < current_date AND d0 >= %s ORDER BY d0""",
        (START_IRA,),
    ).fetchall()
    out = []
    for t, d0, exp, k, prem, q in rows:
        if k <= 0 or q <= 0:
            continue
        out.append(dict(t=t, d0=d0, exp=exp, K=k, prem=prem, q=q, cap=k * q))
    return out


def load_bars(conn, tickers):
    px = defaultdict(list)
    for t, d, h, l, c in conn.execute(
        """SELECT ticker, date::date, high::float, low::float, close::float
           FROM lseg_research.daily_history
           WHERE ticker = ANY(%s) AND close > 0 AND high IS NOT NULL AND low IS NOT NULL ORDER BY ticker, date""",
        (list(set(tickers)),),
    ):
        px[t].append((d, float(h), float(l), float(c)))
    atr_pct = {}
    for t, rows in px.items():
        if len(rows) < 20:
            continue
        h = np.array([r[1] for r in rows])
        l = np.array([r[2] for r in rows])
        c = np.array([r[3] for r in rows])
        a = atr(h, l, c, 14)
        byd = {rows[i][0]: (a[i] / c[i] if c[i] > 0 and np.isfinite(a[i]) else None) for i in range(len(rows))}
        atr_pct[t] = byd
    return px, atr_pct


def settle(conn, t, exp):
    r = conn.execute(
        "SELECT close::float FROM prices_historical WHERE ticker = %s AND date <= %s ORDER BY date DESC LIMIT 1",
        (t, exp),
    ).fetchone()
    return float(r[0]) if r else None


def trade_pnl(tr, st):
    intr = max(0.0, tr["K"] - st)
    return (tr["prem"] - intr) * tr["q"]


def log_rets(px, t, end: date, win=CORR_WIN):
    bars = px.get(t)
    if not bars:
        return None
    days = [b for b in bars if b[0] <= end]
    if len(days) < win + 2:
        return None
    days = days[-(win + 1) :]
    c = [b[3] for b in days]
    return np.diff(np.log(c))


def corr_pair(px, a, b, d):
    ra, rb = log_rets(px, a, d), log_rets(px, b, d)
    if ra is None or rb is None or len(ra) != len(rb):
        return None
    if np.std(ra) < 1e-12 or np.std(rb) < 1e-12:
        return 0.0
    return float(np.corrcoef(ra, rb)[0, 1])


def policy_weight(mode, tr, open_names, px, atr_pct):
    w = 1.0
    if mode == "vol_scaled":
        ap = (atr_pct.get(tr["t"]) or {}).get(tr["d0"])
        if ap and ap > 0:
            w = min(1.0, TARGET_ATR / (ap * K_MULT))
    if mode == "corr_cap" and open_names:
        for on in open_names:
            if on == tr["t"]:
                continue
            r = corr_pair(px, tr["t"], on, tr["d0"])
            if r is not None and abs(r) >= CORR_THR:
                w = min(w, CORR_SCALE)
    return w


def book_path(trades, conn, px, atr_pct, mode):
    """Weekly compounded return using capital-weighted settled pnl."""
    enriched = []
    for tr in trades:
        st = settle(conn, tr["t"], tr["exp"])
        if st is None:
            continue
        enriched.append({**tr, "pnl": trade_pnl(tr, st)})
    enriched.sort(key=lambda x: x["d0"])
    for tr in enriched:
        d = tr["d0"]
        open_names = {e["t"] for e in enriched if e["d0"] < d < e["exp"]}
        tr["_w"] = policy_weight(mode, tr, list(open_names), px, atr_pct)
    wk = defaultdict(lambda: [0.0, 0.0])
    for tr in enriched:
        w = tr["_w"]
        wk[tr["exp"].isocalendar()[:2]][0] += tr["pnl"] * w
        wk[tr["exp"].isocalendar()[:2]][1] += tr["cap"] * w
    weeks = sorted(wk)
    rets = [wk[w][0] / wk[w][1] if wk[w][1] > 0 else 0.0 for w in weeks]
    if not rets:
        return None
    eq, peak = 1.0, 1.0
    max_dd = 0.0
    month = defaultdict(float)
    for i, w in enumerate(weeks):
        r = rets[i]
        eq *= 1 + r
        peak = max(peak, eq)
        max_dd = min(max_dd, eq / peak - 1)
        month[w[0] * 100 + w[1]] += r
    arr = np.array(rets)
    cvar5 = float(np.mean(arr[arr <= np.quantile(arr, 0.05)])) if len(arr) >= 20 else float("nan")
    worst_m = min(month.items(), key=lambda x: x[1])[1] if month else float("nan")
    return {
        "n_trades": len(enriched),
        "n_weeks": len(rets),
        "total_ret": eq - 1,
        "mean_bp": float(arr.mean()) * 1e4,
        "max_dd": max_dd,
        "cvar5": cvar5,
        "worst_month": worst_m,
    }


def s109_stress(conn, px, atr_pct, smoke=False):
    """Top-N S109-style names per week; modelled hold pnl from lab_outcomes proxy (s045 pnl field)."""
    import s045_put_retest as S45  # noqa: E402

    rows, tech, fund, px_lab = S45.load(conn)
    ev = S45.build(rows, tech, fund, px_lab)
    if smoke:
        ev = ev[:500]
    by_w = defaultdict(list)
    for e in ev:
        by_w[e["d"]].append(e)
    weeks = sorted(by_w)
    wk_pnl = {m: {"equal": [], "vol_scaled": [], "corr_cap": []} for *_, m in STRESS}
    for d in weeks:
        cands = sorted(by_w[d], key=lambda x: -(x.get("put_edge") or x.get("iv_rv") or 0))[:TOP_N]
        open_names = [c["t"] for c in cands]
        for e in cands:
            tr = dict(t=e["t"], d0=d, exp=e.get("expiry", d + timedelta(days=5)), K=1.0, cap=1.0)
            for mode in ("equal", "vol_scaled", "corr_cap"):
                w = policy_weight(mode, tr, [x for x in open_names if x != e["t"]], px, atr_pct)
                pnl = float(e["pnl"]) * w
                for start, end, tag in STRESS:
                    if start <= d <= end:
                        wk_pnl[tag][mode].append(pnl)
    out = {}
    for tag, modes in wk_pnl.items():
        out[tag] = {}
        for mode, lst in modes.items():
            if len(lst) < 10:
                out[tag][mode] = dict(n=len(lst), mean_bp=float("nan"), note="UNDERPOWERED")
            else:
                out[tag][mode] = dict(n=len(lst), mean_bp=float(np.mean(lst)) * 1e4, note="modelled_weekly_puts")
    return out


def main():
    smoke = "--smoke" in sys.argv
    conn = connect()
    trades = load_ira(conn)
    if smoke:
        trades = trades[:40]
    tickers = sorted({t["t"] for t in trades})
    px, atr_pct = load_bars(conn, tickers)
    print(f"SANITY IRA n={len(trades)} tickers={len(tickers)} span {min(t['d0'] for t in trades)}..{max(t['exp'] for t in trades)}", flush=True)
    hand = trades[0]
    st = settle(conn, hand["t"], hand["exp"])
    ap = (atr_pct.get(hand["t"]) or {}).get(hand["d0"])
    print(
        f"SANITY hand {hand['t']} d0={hand['d0']} prem={hand['prem']:.2f} settle={st:.2f} "
        f"pnl={trade_pnl(hand, st):.2f} atr_pct={ap}",
        flush=True,
    )
    modes = ("equal", "vol_scaled", "corr_cap")
    stats = {m: book_path(trades, conn, px, atr_pct, m) for m in modes}
    if stats["equal"] and stats["vol_scaled"]:
        ch = stats["vol_scaled"]["mean_bp"] - stats["equal"]["mean_bp"]
        print(f"SANITY vol_vs_equal mean_bp diff {ch:+.1f}", flush=True)
        if smoke and not np.isfinite(ch):
            raise SystemExit("SANITY fail: vol_scaled path broken")
    stress = s109_stress(conn, px, atr_pct, smoke=smoke)
    conn.close()

    lines = [
        "# A372 book layer (S047 replay + stress)",
        "",
        "CONTRACT 1-7: same-job item 2 only. Comparator = equal notional IRA replay. "
        f"vol_scaled TARGET_ATR={TARGET_ATR} (# global: pending stock-own table). "
        f"corr cap |ρ|≥{CORR_THR} on {CORR_WIN}d log returns → ×{CORR_SCALE}. "
        "Stress = modelled S045 weekly puts (not Jamie fills). Survivorship: today's names.",
        "",
        f"IRA settled {len(trades)} trades · {START_IRA}→ · bars lseg_research.daily_history · ATR quantcore.ta",
        "",
        "| policy | n | weeks | total ret | mean bp/wk | max DD | CVaR 5% wk | worst month |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for m, s in stats.items():
        if not s:
            lines.append(f"| {m} | — | thin | | | | | |")
            continue
        lines.append(
            f"| {m} | {s['n_trades']} | {s['n_weeks']} | {s['total_ret']:+.1%} | {s['mean_bp']:+.1f} | "
            f"{s['max_dd']:.1%} | {s['cvar5']:+.2%} | {s['worst_month']:+.2%} |"
        )
    lines.append("")
    lines.append("Stress windows (concurrent top-8 modelled puts / week):")
    for tag, modes in stress.items():
        lines.append(f"\n**{tag}**")
        for m, s in modes.items():
            lines.append(f"- {m}: n={s['n']} mean {s['mean_bp']:+.1f} bp/trade · {s['note']}")
    eq = stats.get("equal") or {}
    vs = stats.get("vol_scaled") or {}
    cc = stats.get("corr_cap") or {}
    tail_ok = vs.get("cvar5", 0) >= eq.get("cvar5", -1) or not np.isfinite(vs.get("cvar5", float("nan")))
    verdict = "NO-LIFT" if eq and vs and vs.get("mean_bp", 0) <= eq.get("mean_bp", 0) and not tail_ok else "MIXED"
    if eq.get("n_weeks", 0) < 30:
        verdict = "UNDERPOWERED"
    lines.extend([
        "",
        "## Winner pass",
        "Winners = positive pnl IRA puts; losers assigned or closed underwater. "
        "Next rule to test: cluster cap on stress VaR (S140) with same vol scale.",
        f"RULE NO-LIFT: vol_scaled sizing × hold-to-expiry × IRA book — mean/tail do not beat equal at n={eq.get('n_trades', 0)}.",
        f"Verdict: **{verdict}** (n_weeks={eq.get('n_weeks', 0)}; calm 2026 sample; stress is modelled).",
    ])
    text = "\n".join(lines) + "\n"
    OUT.write_text(text)
    print(text)


if __name__ == "__main__":
    main()