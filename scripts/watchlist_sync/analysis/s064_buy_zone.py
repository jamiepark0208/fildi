"""S064 — buy-zone puts: sell a put at a price we'd want to own (PLAN-buy-zone-puts.md v2 §3–4, pre-registered).

Entries: first lab Monday of each month, 2021-01 → (63 sessions of outcome needed). LSEG names with lab features.
Gate (point-in-time; OWN/FV have no history): IBES fwd EPS growth ≥ peer-group median that week (peer group ≥ 5 names,
else sector, else all), IBES breadth (net revisions) ≥ 0, StarMine combined alpha rank ≥ 50, StarMine predicted
surprise > −2 %. The ungated arm is reported too (does the gate carry the edge?).
Anchors (target buy price, adjusted basis): A1 vol = S·exp(−σ√T) · A2 support = max(52-week low, nearest top-4 60-day
volume node below S) · A3 trend = 200-day MA when S > MA · A5 analyst = StarMine PT mean × 0.70. A4 (fair value) has
no history before 2026-10 → only a live cap, not tested.
Contract: monthly put, expiry nearest 37 DTE in 28–50; strike = highest listed strike ≤ target with BS Δ (iv30_put)
in −0.40…−0.10 (v2.1 smoke amendment: a 1σ strike sits at ~0.14Δ), else no trade. Fill = bid + 23 % of the spread (A206 convention); needs a real LSEG bid/ask that day.
Outcome per $ collateral K, day 63 (sessions after entry): premium/K, plus (S63 − K)/K if S_expiry < K (assigned, hold).
Comparators on the same entries: buy now (S63/S − 1); limit order at K until expiry (filled if any low ≤ K → S63/K − 1,
else 0). Cash earns 0 everywhere.
Pass (holdout ≥ 2024-07): best anchor's Sharpe-like (mean/sd) beats buy-now, month-cluster bootstrap t ≥ 2 and same
sign in both in-sample halves, Holm over 4 anchors; worst decile not worse than buy-now's.

    cd research/lseg && .venv/bin/python ../../scripts/watchlist_sync/analysis/s064_buy_zone.py --tickers=CAVA,SHOP,TMO,MU,CRWV
    cd research/lseg && .venv/bin/python ../../scripts/watchlist_sync/analysis/s064_buy_zone.py   # full
"""
from __future__ import annotations

import math
import random
from contextlib import nullcontext
import sys
from bisect import bisect_right
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402
from s045_put_retest import bs_put, volume_nodes  # noqa: E402
from s049_panic_puts import FUNDS, put_delta, split_factor, third_friday  # noqa: E402

LSEG = HERE.parents[2] / "research" / "lseg"
sys.path.insert(0, str(LSEG))
import option_prices as OP  # noqa: E402
from _session import lseg_session  # noqa: E402

START, HOLDOUT, MID = date(2021, 1, 4), date(2024, 7, 1), date(2022, 10, 1)  # MID splits in-sample into halves
BS_MODE = any(a.startswith("--bs") for a in sys.argv)
BS_RATIO = ((0.20, 1.20), (0.30, 1.02), (1.0, 0.98))  # real fill ÷ BS(iv30_put) by |Δ|: skew; smoke 10-20, 152 LSEG fills
REQ_CAP = 3000  # ≤ 30 % of LSEG's 10k/day; the start-of-run guard alone let backfills starve the 07:00 sync (10-19)
OUT = HERE.parent / "out" / "opt" / ("S064_bs.md" if BS_MODE else "S064.md")
ANCHORS = ("A1_vol", "A2_support", "A3_trend", "A5_analyst")
rng = random.Random(64)


def asof(series, d):
    """Latest value with date ≤ d from a sorted [(date, value)] list."""
    i = bisect_right(series, (d, float("inf"))) - 1
    return series[i][1] if i >= 0 else None


def load(conn, only):
    bars = defaultdict(list)
    for t, d, c, h, lo, v, iv in conn.execute(
            """SELECT ticker, date, close::float, high::float, low::float, volume::float, iv30_put::float
               FROM lseg_research.daily_history WHERE close > 0 AND date >= %s ORDER BY ticker, date""",
            (START - timedelta(days=400),)).fetchall():
        if t not in FUNDS and (not only or t in only):
            h, lo = h or c, lo or c  # a few LSEG bars have low > high → volume_nodes divides by zero
            bars[t].append((d, c, max(h, lo, c), min(h, lo, c), v or 0.0, iv))
    fund = {(t, d): f for t, d, f in conn.execute("SELECT ticker, as_of, features FROM watchlist_sync.lab_fund WHERE as_of >= %s",
                                                    (START,)).fetchall()}
    sm = defaultdict(list)
    for t, m, d, v in conn.execute("SELECT ticker, metric, obs_date, value::float FROM lseg_research.starmine_history "
                                   "WHERE value IS NOT NULL ORDER BY obs_date").fetchall():
        sm[(t, m)].append((d, v))
    peer = {t: g for t, g in conn.execute("SELECT ticker, primary_peer_group_id FROM ticker_registry "
                                          "WHERE primary_peer_group_id IS NOT NULL").fetchall()}
    mondays = sorted({d for (d,) in conn.execute("SELECT DISTINCT as_of FROM watchlist_sync.lab_outcomes WHERE as_of >= %s",
                                                 (START,)).fetchall()})
    firsts, seen = [], set()
    for d in mondays:
        if (d.year, d.month) not in seen:
            seen.add((d.year, d.month))
            firsts.append(d)
    return bars, fund, sm, peer, firsts


def gate_table(fund, peer, sm, firsts):
    """{(t, d): (pass, why)} — fwd growth vs peer median that Monday, breadth, StarMine alpha + predicted surprise."""
    out = {}
    for d in firsts:
        g = {t: f.get("ibes_fwd_growth") for (t, dd), f in fund.items() if dd == d and f.get("ibes_fwd_growth") is not None}
        groups = defaultdict(list)
        for t, x in g.items():
            p = peer.get(t)
            groups[("p", p)].append(x)
            groups[("s", p.split(".")[0] if p else None)].append(x)
        allmed = sorted(g.values())[len(g) // 2] if g else None
        for t, x in g.items():
            p = peer.get(t)
            pool = groups[("p", p)] if p and len(groups[("p", p)]) >= 5 else groups[("s", p.split(".")[0] if p else None)]
            med = sorted(pool)[len(pool) // 2] if len(pool) >= 5 else allmed
            br = fund[(t, d)].get("ibes_breadth")
            al, ps = asof(sm[(t, "combined_alpha_rank")], d), asof(sm[(t, "pred_surprise_pct_fq1")], d)
            fails = [n for n, ok in (("growth<peer", x >= med), ("breadth<0", br is not None and br >= 0),
                                     ("alpha<50", al is not None and al >= 50), ("pred_miss", ps is None or ps > -2)) if not ok]
            out[(t, d)] = (not fails, ",".join(fails) or "pass")
    return out


def anchors(rows, i, sm, t, d, T):
    d0, S, _, _, _, iv = rows[i]
    a = {}
    if iv:
        a["A1_vol"] = S * math.exp(-iv / 100 * math.sqrt(T))
    lo52 = min(r[3] for r in rows[max(0, i - 251):i + 1])
    try:
        nodes = [z for z in volume_nodes([r[2] for r in rows], [r[3] for r in rows], [r[4] for r in rows], i) if z < S]
    except ZeroDivisionError:  # s045 helper: a flat bar exactly at the window high falls outside the last bin
        nodes = []
    a["A2_support"] = max([lo52] + nodes)
    if i >= 199:
        ma = sum(r[1] for r in rows[i - 199:i + 1]) / 200
        if S > ma:
            a["A3_trend"] = ma
    pt = asof(sm[(t, "pt_mean")], d)
    if pt:
        a["A5_analyst"] = pt * 0.70
    return a


def pick_expiry(d):
    exps = [third_friday(d.year + (d.month - 1 + k) // 12, (d.month - 1 + k) % 12 + 1) for k in range(3)]
    exps = [e for e in exps if 28 <= (e - d).days <= 50]
    return min(exps, key=lambda e: abs((e - d).days - 37)) if exps else None


def sell_put(ld, conn, t, d, S_tr, iv, target_tr, e):
    """Highest listed strike ≤ target with Δ in −0.40…−0.10 and a real bid/ask on d → (K, fill, hist) or None.
    --bs mode (ld None, 0 LSEG requests): first ladder strike in the band, fill = BS at iv30_put × skew ratio by |Δ|."""
    v, T = iv / 100, (e - d).days / 365
    step = 0.5 if target_tr < 25 else 1.0 if target_tr < 200 else 5.0
    k = math.floor(target_tr / step) * step
    for _ in range(8):  # walk down the ladder until a listed contract appears (each miss = 1 LSEG request)
        if k <= 0:
            return None
        dl = put_delta(S_tr, k, v, T)
        if dl > -0.10:
            return None  # too far OTM: the anchor is not a tradable buy zone this month
        if dl >= -0.40 and ld is None:
            return k, next(r for lim, r in BS_RATIO if -dl < lim) * bs_put(S_tr, k, v, T), None
        if dl >= -0.40:
            for K in (k, math.floor(k / 2.5) * 2.5) if step == 1.0 and k % 2.5 else (k,):
                hist = OP.history(ld, conn, t, e, "P", K)
                if hist:
                    day = next((r for r in hist if r[0] == d), None)
                    if day and day[1] and day[2] and day[2] >= day[1] > 0:
                        return K, day[1] + 0.23 * (day[2] - day[1]), hist
                    return None  # listed but no two-sided quote that day
        k -= step
    return None


def trade(ld, conn, t, rows, i, gate, sm):
    d, S, _, _, _, iv = rows[i]
    e = pick_expiry(d)
    if not e or not iv or i + 63 >= len(rows):
        return []
    fd = split_factor(conn, t, d)
    if split_factor(conn, t, rows[i + 63][0]) != fd:
        return []  # split inside the window: contract terms change
    iE = max(j for j in range(i, i + 64) if rows[j][0] <= e)
    S63 = rows[i + 63][1]
    buy_now = S63 / S - 1
    out = []
    for name, tgt in anchors(rows, i, sm, t, d, (e - d).days / 365).items():
        if tgt >= S:
            continue
        got = sell_put(ld, conn, t, d, S * fd, iv, tgt * fd, e)
        if not got:
            continue
        K_tr, fill, _ = got
        K = K_tr / fd  # adjusted basis
        assigned = rows[iE][1] < K
        put = fill / K_tr + ((S63 - K) / K if assigned else 0.0)
        hit = any(r[3] <= K for r in rows[i + 1:iE + 1])
        out.append(dict(t=t, d=d, e=e, anchor=name, gate=gate[0], why=gate[1], S=S * fd, tgt=tgt * fd, K=K_tr, iv=iv,
                        prem=fill, prem_pct=fill / K_tr, bs=bs_put(S * fd, K_tr, iv / 100, (e - d).days / 365), assigned=assigned, put=put, buy_now=buy_now,
                        limit=(S63 / K - 1) if hit else 0.0, S63=S63 * fd, Se=rows[iE][1] * fd))
    return out


def stats(xs, key):
    r = sorted(x[key] for x in xs)
    if len(r) < 2:
        return dict(n=len(r), mean=float("nan"), sd=float("nan"), sh=float("nan"), worst=float("nan"))
    m = sum(r) / len(r)
    sd = (sum((y - m) ** 2 for y in r) / (len(r) - 1)) ** 0.5
    w = r[: max(1, len(r) // 10)]
    return dict(n=len(r), mean=m, sd=sd, sh=m / sd if sd else float("nan"), worst=sum(w) / len(w))


def boot_t(xs, a="put", b="buy_now", n=2000):
    """Sharpe(a) − Sharpe(b), t from resampling entry months (puts on one date share the market move)."""
    by = defaultdict(list)
    for x in xs:
        by[x["d"]].append(x)
    keys = list(by)
    if len(keys) < 3:
        return float("nan"), float("nan")
    obs = stats(xs, a)["sh"] - stats(xs, b)["sh"]
    bs = []
    for _ in range(n):
        s = [x for k in (rng.choice(keys) for _ in keys) for x in by[k]]
        bs.append(stats(s, a)["sh"] - stats(s, b)["sh"])
    m = sum(bs) / n
    sd = (sum((y - m) ** 2 for y in bs) / (n - 1)) ** 0.5
    return obs, obs / sd if sd else float("nan")


def main():
    only = next((a.split("=", 1)[1].split(",") for a in sys.argv if a.startswith("--tickers=")), None)
    conn = connect()
    OP.ensure(conn)
    bars, fund, sm, peer, firsts = load(conn, only)
    gate = gate_table(fund, peer, sm, firsts)
    fset = set(firsts)
    tr = []
    with (nullcontext() if BS_MODE else lseg_session()) as ld:
        for t in sorted(bars):
            if ld is not None and ld.requests > REQ_CAP:
                print(f"stopped at {t}: {ld.requests} LSEG requests (cap {REQ_CAP}); re-run tomorrow continues from cache")
                break
            rows = bars[t]
            for i, r in enumerate(rows):
                if r[0] in fset and i >= 60:
                    tr += trade(ld, conn, t, rows, i, gate.get((t, r[0]), (False, "no_fwd_growth")), sm)
            print(f"{t}: running {len(tr)} trades", flush=True)
    import json  # every simulated trade, for follow-ups (winners vs losers, BS calibration) without re-fetching LSEG
    OUT.with_name(OUT.stem + ("_smoke" if only else "") + ".json").write_text(json.dumps(tr, default=str))
    if only:
        for x in tr:
            print(f"{x['t']} {x['d']} {x['anchor']:<10} gate={x['why']:<18} S {x['S']:.2f} tgt {x['tgt']:.2f} K {x['K']:g} "
                  f"exp {x['e']} fill {x['prem']:.2f} ({x['prem_pct']:.1%}) Se {x['Se']:.2f} asg {int(x['assigned'])} "
                  f"S63 {x['S63']:.2f} put {x['put']:+.1%} now {x['buy_now']:+.1%} lim {x['limit']:+.1%}")
    report(tr, smoke=bool(only))


def report(tr, smoke):
    L = ["# S064 — buy-zone puts vs buy-now vs limit order (63-day total return per $)", "",
         f"{'SMOKE ' if smoke else ''}{len(tr)} trades. Fill = bid + 23 % of spread; cash 0 %. Sharpe = mean/sd per trade.", "",
         "| arm | anchor | slice | n | assigned | put mean | put Sharpe | now mean | now Sharpe | limit mean | worst10 put / now | ΔSharpe t |",
         "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    sl = [("H1", lambda x: x["d"] < MID), ("H2", lambda x: MID <= x["d"] < HOLDOUT), ("holdout", lambda x: x["d"] >= HOLDOUT)]
    res = {}
    for arm, af in (("gated", lambda x: x["gate"]), ("all", lambda x: True)):
        for a in ANCHORS:
            for s, f in sl:
                xs = [x for x in tr if x["anchor"] == a and af(x) and f(x)]
                if not xs:
                    continue
                p, b, lm = stats(xs, "put"), stats(xs, "buy_now"), stats(xs, "limit")
                diff, t = boot_t(xs)
                res[(arm, a, s)] = (diff, t, p["worst"] >= b["worst"])
                L.append(f"| {arm} | {a} | {s} | {p['n']} | {sum(x['assigned'] for x in xs) / len(xs):.0%} | {p['mean']:+.2%} | "
                         f"{p['sh']:.2f} | {b['mean']:+.2%} | {b['sh']:.2f} | {lm['mean']:+.2%} | {p['worst']:+.1%} / {b['worst']:+.1%} | "
                         f"{diff:+.2f} ({t:.1f}) |")
    if not smoke:  # Holm over the 4 gated anchors on the holdout t (one-sided normal p)
        ps = sorted((0.5 * (1 - math.erf(res[k][1] / math.sqrt(2))), k[1]) for k in res
                    if k[0] == "gated" and k[2] == "holdout" and not math.isnan(res[k][1]))
        passed = []
        for j, (p, a) in enumerate(ps):
            if p > 0.05 / (len(ps) - j):
                break
            if all(res.get(("gated", a, h), (0, 0, 0))[0] > 0 for h in ("H1", "H2")) and res[("gated", a, "holdout")][2]:
                passed.append(a)
        L += ["", f"**Verdict: {'PASS — ' + ', '.join(passed) if passed else 'FAIL'}** (Holm over {len(ps)} anchors, "
                  f"both halves same sign, worst decile ≤ buy-now's)"]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(L))
    print("\n".join(L[2:]))


if __name__ == "__main__":
    main()
