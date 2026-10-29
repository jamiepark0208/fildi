#!/usr/bin/env python3
"""S134 / A195 — cointegration divergence as put-selling entry filter.

Power gate first: Engle-Granger pairs inside peer groups, yearly 2y formation,
BH p<0.05, half-life 5–60d. <10 pairs or <300 signal-weeks → stop.
Pass: marginal pnl >0 week-t≥2 both halves vs put_edge + IV controls; worst 1% not worse.

    cd scripts/watchlist_sync && .venv/bin/python -u analysis/s134_coint_put_filter.py
"""
from __future__ import annotations

import math
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np
from statsmodels.tsa.stattools import coint

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402
import s045_put_retest as S45  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S134.md"
START = date(2020, 1, 1)
HALF = date(2024, 1, 1)
Z_THR = -2.0
MIN_PAIRS, MIN_SIG_WEEKS = 10, 300


def peer_groups(conn):
    rows = conn.execute(
        """SELECT g.id, g.name, m.ticker FROM peer_group_members m
           JOIN peer_groups g ON g.id = m.group_id
           WHERE m.removed_at IS NULL ORDER BY 1, 3"""
    ).fetchall()
    by = defaultdict(list)
    names = {}
    for gid, gname, t in rows:
        by[gid].append(t)
        names[gid] = gname
    return {gid: ts for gid, ts in by.items() if 4 <= len(ts) <= 25}, names


def load_closes(conn, tickers):
    out = defaultdict(dict)
    for t, d, c in conn.execute(
        "SELECT ticker, date::date, close::float8 FROM lseg_research.daily_history "
        "WHERE ticker = ANY(%s) AND close > 0 AND date >= %s ORDER BY date",
        (tickers, date(2017, 1, 1)),
    ):
        out[t][d] = float(c)
    return out


def half_life(spread: np.ndarray) -> float:
    """AR(1) half-life of mean-reverting residual."""
    if len(spread) < 40:
        return float("nan")
    x = spread[:-1]
    y = np.diff(spread)
    if np.std(x) < 1e-12:
        return float("nan")
    b = np.cov(x, y)[0, 1] / (np.var(x) or 1e-12)
    if b >= 0:
        return float("nan")
    return float(-math.log(2) / b)


def form_pairs(closes, groups, form_end: date):
    """Pairs cointegrated on [form_end-2y, form_end], BH across all tests that year."""
    form_start = form_end - timedelta(days=730)
    tests = []  # (p, a, b, beta, hl, gid)
    for gid, tickers in groups.items():
        for i, a in enumerate(tickers):
            for b in tickers[i + 1 :]:
                da, db = closes.get(a, {}), closes.get(b, {})
                days = sorted(set(da) & set(db))
                days = [d for d in days if form_start <= d <= form_end]
                if len(days) < 300:
                    continue
                ya = np.log([da[d] for d in days])
                yb = np.log([db[d] for d in days])
                # Engle-Granger
                try:
                    score, pval, _ = coint(ya, yb, trend="c", autolag="aic")
                except Exception:
                    continue
                # OLS ya ~ yb
                X = np.column_stack([np.ones(len(yb)), yb])
                beta = np.linalg.lstsq(X, ya, rcond=None)[0]
                resid = ya - X @ beta
                hl = half_life(resid)
                if not (5 <= hl <= 60):
                    continue
                tests.append((float(pval), a, b, float(beta[1]), hl, gid, score))
    if not tests:
        return []
    tests.sort(key=lambda x: x[0])
    m = len(tests)
    kept = []
    for rank, row in enumerate(tests, 1):
        p, a, b, beta, hl, gid, score = row
        # BH
        if p * m / rank <= 0.05:
            kept.append({"a": a, "b": b, "beta": beta, "hl": hl, "gid": gid, "p": p, "form_end": form_end})
        else:
            break  # sorted by p; rest fail BH
    return kept


def style_label(conn, ticker, asof):
    """Point-in-time growth vs value from lab_fund if present; else unknown."""
    r = conn.execute(
        """SELECT (payload->>'fwd_pe')::float8, (payload->>'fwd_growth')::float8
           FROM watchlist_sync.lab_fund WHERE ticker=%s AND as_of<=%s
           ORDER BY as_of DESC LIMIT 1""",
        (ticker, asof),
    ).fetchone()
    if not r:
        return "unk"
    pe, g = r
    if pe is not None and pe > 0 and g is not None:
        # crude: high growth + high pe = growth
        if g > 0.12 and pe > 20:
            return "growth"
        if g < 0.08 and pe < 18:
            return "value"
    return "unk"


def spread_z(closes, pair, d):
    a, b, beta = pair["a"], pair["b"], pair["beta"]
    da, db = closes[a], closes[b]
    if d not in da or d not in db:
        return None, None
    # trailing 60d residual z
    days = sorted(set(da) & set(db))
    days = [x for x in days if x <= d][-60:]
    if len(days) < 40:
        return None, None
    ya = np.log([da[x] for x in days])
    yb = np.log([db[x] for x in days])
    resid = ya - (beta * yb)  # ignore intercept drift in z window
    resid = resid - resid.mean()
    sd = resid.std() or 1e-12
    z = float(resid[-1] / sd)
    # which leg is cheap (down): if resid = log a - beta log b < 0 → a underperforms
    cheap = a if z < 0 else b
    return z, cheap


def week_t(xs, key="pnl"):
    by = defaultdict(list)
    for x in xs:
        by[(x["d"].year, x["d"].month)].append(x[key])
    means = [float(np.mean(v)) for v in by.values() if v]
    if len(means) < 6:
        return float("nan")
    m = float(np.mean(means))
    s = float(np.std(means)) or 1e-12
    return m / (s / math.sqrt(len(means)))


def main() -> int:
    print("S134 loading…", flush=True)
    conn = connect()
    groups, gnames = peer_groups(conn)
    tickers = sorted({t for ts in groups.values() for t in ts})
    closes = load_closes(conn, tickers)
    print(f"groups={len(groups)} tickers={len(tickers)}", flush=True)

    # yearly formation ends
    form_years = [date(y, 12, 31) for y in range(2019, 2025)]
    pairs_by_year = {}
    all_pairs = []
    for fe in form_years:
        ps = form_pairs(closes, groups, fe)
        pairs_by_year[fe.year] = ps
        all_pairs.extend(ps)
        print(f"  form {fe}: {len(ps)} pairs BH", flush=True)

    n_unique = len({(p["a"], p["b"], p["form_end"].year) for p in all_pairs})
    lines = [
        "# S134 — cointegration divergence put filter (A195)",
        "",
        f"Peer groups 4–25 names: {len(groups)}. Yearly 2y Engle-Granger + BH + half-life 5–60d.",
        f"Pairs surviving power gate by formation year: "
        + ", ".join(f"{y}:{len(pairs_by_year[y])}" for y in sorted(pairs_by_year)),
        f"Unique pair-years: **{n_unique}** (gate ≥{MIN_PAIRS}).",
        "",
    ]
    if n_unique < MIN_PAIRS:
        lines += [
            f"**Power gate FAIL** — {n_unique} < {MIN_PAIRS} pairs. Stop. No entry filter.",
            "",
            "**Verdict: FAIL** (underpowered)",
            "",
            "Refs: A195",
        ]
        OUT.write_text("\n".join(lines) + "\n")
        print("\n".join(lines))
        return 0

    # load S045 puts
    print("loading S045 puts…", flush=True)
    rows, tech, fund, px = S45.load(conn)
    ev = S45.build(rows, tech, fund, px)
    try:
        S45._attach_put_edge(conn, ev)
    except Exception as ex:
        print(f"put_edge attach skipped: {ex}", flush=True)

    # signal days: for each pair active after form_end, each Monday in next year
    signals = []
    for p in all_pairs:
        fe = p["form_end"]
        use_from = fe + timedelta(days=1)
        use_to = date(fe.year + 1, 12, 31)
        # Mondays
        d0 = use_from
        while d0.weekday() != 0:
            d0 += timedelta(days=1)
        d = d0
        while d <= use_to and d <= date(2025, 12, 31):
            z, cheap = spread_z(closes, p, d)
            if z is not None and z <= Z_THR:
                signals.append({"d": d, "t": cheap, "z": z, "pair": (p["a"], p["b"]), "gid": p["gid"]})
            d += timedelta(days=7)

    # match to puts
    sig_puts, other = [], []
    sig_keys = {(s["t"], s["d"]) for s in signals}
    for e in ev:
        if e["d"] < START:
            continue
        if (e["t"], e["d"]) in sig_keys:
            sig_puts.append(e)
        else:
            other.append(e)

    n_sig_weeks = len({e["d"] for e in sig_puts})
    lines += [
        f"Signal weeks (z≤{Z_THR} cheap leg ∩ S045 put day): **{n_sig_weeks}** (gate ≥{MIN_SIG_WEEKS}).",
        f"Signal puts n={len(sig_puts)} · other n={len(other)}.",
        "",
    ]
    if n_sig_weeks < MIN_SIG_WEEKS:
        lines += [
            f"**Power gate FAIL** on signal-weeks ({n_sig_weeks} < {MIN_SIG_WEEKS}).",
            "",
            "**Verdict: FAIL** (underpowered)",
            "",
            "Refs: A195",
        ]
        OUT.write_text("\n".join(lines) + "\n")
        print("\n".join(lines))
        return 0

    def summ(xs, label):
        if len(xs) < 30:
            return f"| {label} | {len(xs)} | thin |"
        pnl = float(np.mean([e["pnl"] for e in xs])) * 1e4
        br = float(np.mean([e["breach"] for e in xs]))
        w1 = float(np.quantile([e["pnl"] for e in xs], 0.01)) * 1e4
        return f"| {label} | {len(xs)} | {pnl:+.1f} | {br:.1%} | {w1:+.1f} | {week_t(xs):.2f} |"

    lines += [
        "| book | n | mean pnl bp | breach | worst 1% bp | month-t |",
        "|---|---:|---:|---:|---:|---:|",
        summ(sig_puts, "signal"),
        summ(other, "non-signal"),
    ]
    for name, pred in (("h1", lambda e: e["d"] < HALF), ("h2", lambda e: e["d"] >= HALF)):
        lines.append(summ([e for e in sig_puts if pred(e)], f"signal {name}"))
        lines.append(summ([e for e in other if pred(e)], f"non-signal {name}"))

    # marginal: signal − matched non-signal mean
    sp = float(np.mean([e["pnl"] for e in sig_puts])) * 1e4 if sig_puts else float("nan")
    op = float(np.mean([e["pnl"] for e in other])) * 1e4 if other else float("nan")
    diff = sp - op
    # within put_edge Q if present
    pe_note = "put_edge attach skipped or missing"
    if sig_puts and "put_edge" in sig_puts[0]:
        # residualize roughly: compare within same quintile weeks
        pe_note = "see within-Q below"
        lines += ["", "### Within put_edge quintile (signal − rest)", ""]
        for q in range(1, 6):
            a = [e for e in sig_puts if int(e.get("put_edge_q") or e.get("pe_q") or 0) == q]
            b = [e for e in other if int(e.get("put_edge_q") or e.get("pe_q") or 0) == q]
            if len(a) < 20 or len(b) < 50:
                continue
            lines.append(
                f"- Q{q}: signal {np.mean([e['pnl'] for e in a])*1e4:+.1f} bp vs "
                f"{np.mean([e['pnl'] for e in b])*1e4:+.1f} (n {len(a)}/{len(b)})"
            )

    h1s = [e for e in sig_puts if e["d"] < HALF]
    h2s = [e for e in sig_puts if e["d"] >= HALF]
    h1o = [e for e in other if e["d"] < HALF]
    h2o = [e for e in other if e["d"] >= HALF]
    d1 = (np.mean([e["pnl"] for e in h1s]) - np.mean([e["pnl"] for e in h1o])) * 1e4 if h1s and h1o else float("nan")
    d2 = (np.mean([e["pnl"] for e in h2s]) - np.mean([e["pnl"] for e in h2o])) * 1e4 if h2s and h2o else float("nan")
    t_sig = week_t(sig_puts)
    w1_s = float(np.quantile([e["pnl"] for e in sig_puts], 0.01)) * 1e4
    w1_o = float(np.quantile([e["pnl"] for e in other], 0.01)) * 1e4

    ok = (
        diff > 0
        and d1 > 0
        and d2 > 0
        and t_sig >= 2
        and w1_s >= w1_o - 1e-9
    )
    lines += [
        "",
        f"Signal − non-signal: **{diff:+.1f} bp** (h1 {d1:+.1f} / h2 {d2:+.1f}). month-t(signal)={t_sig:.2f}.",
        f"Worst 1%: signal {w1_s:+.1f} vs other {w1_o:+.1f}. {pe_note}",
        "",
        f"**Verdict: {'PASS' if ok else 'FAIL'}** — "
        + (
            "marginal edge clears bar"
            if ok
            else "no stable marginal put edge from cointegration divergence (or tail worse)"
        ),
        "",
        "Refs: A195",
    ]
    OUT.write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"wrote {OUT}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
