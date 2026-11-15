"""S045 — re-test the "don't ship" features on the put seller's own outcome (Jamie 10-18).

Prices: lseg_research.daily_history (split-adjusted OHLCV, 2016→). Earlier studies (S025, S030, S041, S042) scored features on stock direction/return; Jamie earns by
selling weekly puts, so the outcome that matters is the put, not the stock.

Trade per (ticker, Monday as_of in lab_outcomes): sell a 5-trading-day put at the close,
strike K = S·exp(−1.0·IV·√(5/252)) (≈ 1σ IV-implied, ~0.16 delta), hold to expiry.
  breach = S_T < K           pnl = (BS put(K, IV) − max(0, K − S_T)) / K   (per $ collateral)
Strike distance scales with IV, so IV level is already priced in; we also residualize on iv_rv,
iv30 rank, earnings_21 inside each week.

Features (all known at the as_of close):
  tech_total / comps   — lab_tech v2 (S042: failed on 21d return)
  sr_cushion           — a 60d volume-profile node sits between K and S (S041/S040 reframed: strike placement)
  har_iv               — HAR RV forecast ÷ IV (S033 reframed: premium cheap/rich vs forecast)
  drop2s               — 5d drop ≤ −2σ (S025: bounce failed; here: sell after the drop?)
  down_streak          — consecutive down closes (S030)
  sue                  — latest IBES SUE (S032 PEAD; S024 fundamentals)
Time-series features (one value per week): spy_dd_52w, mkt_med_dd, spy_vrp (S027 regimes).

Evaluation: weekly cross-sectional Spearman (Fama-MacBeth mean, t over weeks, halves), quintile
spreads in breach % and pnl bp per week. Pre-declared bar: |t| ≥ 3 on pnl after controls and same
sign in both halves → candidate (still needs a before/after on the Model List before shipping).

Signal: .venv/bin/python analysis/s045_put_retest.py signal --module path.py:func | --expr "E['iv_rv']"
func(E) returns one value per cached put. Prints Q5−Q1 pnl/breach, marginal vs put_edge, halves, placebo.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import time
from bisect import bisect_right
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402

OUT = HERE / "out" / "opt" / "S045.md"
HOLD = 5
Z = 1.0
LOOKBACK, BINS = 60, 24


def ncdf(x: float) -> float:
    from quantcore.bs import norm_cdf  # quantcore.bs — one home (Jamie 11-15)
    return float(norm_cdf(x))


def bs_put(S, K, vol, t):
    from quantcore.bs import bs_put as _p  # quantcore.bs — one home (Jamie 11-15)
    return _p(spot=S, strike=K, iv=vol, years=t)


def volume_nodes(h, l, v, end_i):
    """Top-4 volume-at-price nodes from bars [end_i-LOOKBACK, end_i] (inclusive: as_of close is known)."""
    a = max(0, end_i - LOOKBACK + 1)
    lo, hi = min(l[a:end_i + 1]), max(h[a:end_i + 1])
    if hi <= lo:
        return []
    edges = np.linspace(lo, hi, BINS + 1)
    vac = np.zeros(BINS)
    for j in range(a, end_i + 1):
        i0 = max(0, int(np.searchsorted(edges, l[j], side="right") - 1))
        i1 = min(BINS - 1, max(i0, int(np.searchsorted(edges, h[j], side="right") - 1)))
        vac[i0:i1 + 1] += v[j] / (i1 - i0 + 1)
    if vac.sum() <= 0:
        return []
    med = float(np.median(vac[vac > 0]))
    peaks = [(0.5 * (edges[i] + edges[i + 1]), vac[i]) for i in range(1, BINS - 1)
             if vac[i] >= vac[i - 1] and vac[i] >= vac[i + 1] and vac[i] >= med]
    peaks.sort(key=lambda p: -p[1])
    return [p[0] for p in peaks[:4]]


def rank(x):
    """Average ranks (ties share a rank — binary features/outcomes need this), scaled 0..1."""
    x = np.asarray(x, float)
    order = np.argsort(x, kind="mergesort")
    r = np.empty(len(x))
    xs = x[order]
    i = 0
    while i < len(x):
        j = i
        while j + 1 < len(x) and xs[j + 1] == xs[i]:
            j += 1
        r[order[i:j + 1]] = 0.5 * (i + j)
        i = j + 1
    return r / max(1, len(x) - 1)


def load(conn):
    cur = conn.cursor()
    cur.execute("SELECT ticker, as_of, features FROM watchlist_sync.lab_outcomes")
    rows = cur.fetchall()
    cur.execute("SELECT ticker, as_of, v2 FROM watchlist_sync.lab_tech")
    tech = {(t, d): v for t, d, v in cur.fetchall()}
    cur.execute("SELECT ticker, as_of, features FROM watchlist_sync.lab_fund")
    fund = {(t, d): f for t, d, f in cur.fetchall()}
    tickers = sorted({r[0] for r in rows})
    cur.execute(
        """SELECT ticker, date, high::float8, low::float8, close::float8, coalesce(volume,0)::float8
           FROM lseg_research.daily_history
           WHERE ticker = ANY(%s) AND close > 0 AND high > 0 AND low > 0 ORDER BY ticker, date""",
        (tickers,),
    )
    px = defaultdict(list)
    for t, d, h, l, c, v in cur.fetchall():
        px[t].append((d, h, l, c, v))
    return rows, tech, fund, px


def build(rows, tech, fund, px, weekly_window=None):
    idx = {}
    for t, bars in px.items():
        idx[t] = ({d: i for i, (d, *_rest) in enumerate(bars)}, bars)
    ev = []
    for t, d, f in rows:
        if t not in idx or not f or not f.get("iv30"):
            continue
        pos, bars = idx[t]
        i = pos.get(d)
        if i is None or i < LOOKBACK + 22:
            continue
        hold, expiry_i = HOLD, i + HOLD
        if weekly_window is not None:
            sessions = weekly_window(d)
            if len(sessions) < 2 or d != sessions[0] or any(day not in pos for day in sessions):
                continue
            hold, expiry_i = len(sessions) - 1, pos[sessions[-1]]
        if expiry_i >= len(bars):
            continue
        c = [b[3] for b in bars]
        S, ST = c[i], c[expiry_i]
        iv = float(f["iv30"]) / 100.0
        if not (0.05 < iv < 3.0):
            continue
        tt = hold / 252
        K = S * math.exp(-Z * iv * math.sqrt(tt))
        prem = bs_put(S, K, iv, tt)
        loss = max(0.0, K - ST)
        r = np.diff(np.log(c[i - 22:i + 1]))  # 22 returns ending at as_of
        rv_d = abs(r[-1]) * math.sqrt(252)
        rv_w = float(np.sqrt(np.mean(r[-5:] ** 2) * 252))
        rv_m = float(np.sqrt(np.mean(r ** 2) * 252))
        har = 0.2 * rv_d + 0.4 * rv_w + 0.4 * rv_m  # Corsi-style weights (fixed, not fitted)
        sd_d = float(np.std(r[:-5])) if len(r) > 6 else float(np.std(r))
        ret5 = c[i] / c[i - 5] - 1
        streak = 0
        for k in range(i, i - 15, -1):
            if c[k] < c[k - 1]:
                streak += 1
            else:
                break
        h_, l_, v_ = [b[1] for b in bars], [b[2] for b in bars], [b[4] for b in bars]
        nodes = volume_nodes(h_, l_, v_, i)
        cushion = 1.0 if any(K < z < S for z in nodes) else 0.0
        tv = tech.get((t, d)) or {}
        comps = (tv.get("comps") or {}) if isinstance(tv, dict) else {}
        fd = fund.get((t, d)) or {}
        ev.append({
            "t": t, "d": d, "expiry": bars[expiry_i][0], "hold_sessions": hold, "breach": 1.0 if ST < K else 0.0, "pnl": (prem - loss) / K,
            "iv_rv": f.get("iv_rv"), "iv30": iv, "earn": f.get("earnings_21") or 0.0,
            "tech_total": tv.get("total") if isinstance(tv, dict) else None,
            **{f"tech_{k}": v for k, v in comps.items() if k != "optionsFlow"},
            "sr_cushion": cushion,
            "har_iv": har / iv,
            "drop2s": 1.0 if sd_d > 0 and ret5 <= -2 * sd_d * math.sqrt(5) else 0.0,
            "ret5": ret5,
            "down_streak": float(streak),
            "sue": fd.get("ibes_sue"),
            "spy_dd_52w": f.get("spy_dd_52w"), "mkt_med_dd": f.get("mkt_med_dd"), "spy_vrp": f.get("spy_vrp"),
        })
    return ev


def fm(ev, feat, target, controls=True):
    """Weekly cross-sectional Spearman → mean, t, halves. Controls residualize ranks on iv_rv, iv30, earn."""
    by = defaultdict(list)
    for e in ev:
        if e.get(feat) is None or e.get("iv_rv") is None:
            continue
        by[e["d"]].append(e)
    weeks = sorted(by)
    ics = []
    for w in weeks:
        g = by[w]
        if len(g) < 30:
            continue
        x = rank([e[feat] for e in g])
        y = rank([e[target] for e in g])
        if np.std(x) == 0 or np.std(y) == 0:
            continue
        if controls:
            X = np.c_[np.ones(len(g)), rank([e["iv_rv"] for e in g]), rank([e["iv30"] for e in g]),
                      [e["earn"] for e in g]]
            beta = np.linalg.lstsq(X, x, rcond=None)[0]
            x = x - X @ beta
            y = y - X @ np.linalg.lstsq(X, y, rcond=None)[0]
            if np.std(x) == 0:
                continue
        ics.append((w, float(np.corrcoef(x, y)[0, 1])))
    if len(ics) < 20:
        return None
    v = np.array([i for _, i in ics])
    h = len(v) // 2
    t = lambda a: a.mean() / (a.std(ddof=1) / math.sqrt(len(a)))
    return {"n_weeks": len(v), "ic": v.mean(), "t": t(v), "ic_a": v[:h].mean(), "ic_b": v[h:].mean()}


def quint(ev, feat):
    """Top vs bottom quintile within each week: breach % and pnl bp/week."""
    by = defaultdict(list)
    for e in ev:
        if e.get(feat) is not None:
            by[e["d"]].append(e)
    top, bot = [], []
    binary = all(e[feat] in (0.0, 1.0) for g in by.values() for e in g)
    for g in by.values():
        if len(g) < 30:
            continue
        if binary:
            top += [e for e in g if e[feat] == 1.0]
            bot += [e for e in g if e[feat] == 0.0]
        else:
            g = sorted(g, key=lambda e: e[feat])
            q = len(g) // 5
            bot += g[:q]
            top += g[-q:]
    m = lambda s, k: float(np.mean([e[k] for e in s])) if s else float("nan")
    return {"n_top": len(top), "n_bot": len(bot), "breach_top": m(top, "breach"), "breach_bot": m(bot, "breach"),
            "pnl_top": m(top, "pnl") * 1e4, "pnl_bot": m(bot, "pnl") * 1e4}


def ts_test(ev, feat):
    """Time-series feature: weekly mean pnl/breach in feature's top vs bottom tercile of weeks."""
    wk = defaultdict(list)
    for e in ev:
        if e.get(feat) is not None:
            wk[e["d"]].append(e)
    rows = sorted(((float(np.mean([e[feat] for e in g])), float(np.mean([e["pnl"] for e in g])),
                   float(np.mean([e["breach"] for e in g]))) for g in wk.values() if len(g) >= 30))
    if len(rows) < 30:
        return None
    q = len(rows) // 3
    lo, hi = rows[:q], rows[-q:]
    m = lambda s, k: float(np.mean([r[k] for r in s]))
    sd = lambda s, k: float(np.std([r[k] for r in s], ddof=1))
    tval = (m(hi, 1) - m(lo, 1)) / math.sqrt(sd(hi, 1) ** 2 / len(hi) + sd(lo, 1) ** 2 / len(lo))
    return {"weeks": len(rows), "pnl_hi": m(hi, 1) * 1e4, "pnl_lo": m(lo, 1) * 1e4,
            "breach_hi": m(hi, 2), "breach_lo": m(lo, 2), "t": tval,
            "pnl_sd_hi": sd(hi, 1) * 1e4, "pnl_sd_lo": sd(lo, 1) * 1e4}


SIGNAL_VERSION = "1"


def _attach_put_edge(conn, ev) -> None:
    """vol-of-vol from the prior 61 IV prints, put tech = trend − volumeConfirm, put_edge = rank blend."""
    tick = sorted({e["t"] for e in ev})
    days, vals = defaultdict(list), defaultdict(list)
    for t, d, p30 in conn.execute(
            """SELECT ticker, date, iv30_put::float8 FROM lseg_research.daily_history
               WHERE ticker = ANY(%s) AND iv30_put > 0 ORDER BY ticker, date""", (tick,)):
        days[t].append(d)
        vals[t].append(float(p30))
    for e in ev:
        ds, vs = days.get(e["t"]), vals.get(e["t"])
        if ds:
            j = bisect_right(ds, e["d"])
            p = [v for v in vs[max(0, j - 61):j] if v > 0]
            if len(p) >= 40:
                e["vol_of_vol"] = float(np.std(np.diff(np.log(np.asarray(p, float)))))
        tc = e.get("tech_trendContext"), e.get("tech_volumeConfirm")
        if None not in tc:
            e["put_tech"] = float(tc[0]) - float(tc[1])
    by = defaultdict(list)
    for e in ev:
        iv_rv = e.get("iv_rv")
        if iv_rv is None or e.get("vol_of_vol") is None or e.get("put_tech") is None:
            continue
        if not (0.3 <= float(iv_rv) <= 5):
            continue
        by[e["d"]].append(e)
    for g in by.values():
        if len(g) < 30:
            continue
        acc = np.zeros(len(g))
        for k in ("iv_rv", "vol_of_vol", "put_tech"):
            acc += rank([e[k] for e in g])
        pct = rank(list(acc / 3.0))
        for e, p in zip(g, pct):
            e["put_edge"] = float(p)
            e["put_edge_q"] = float(min(5, int(float(p) * 5) + 1))


def events_to_panel(ev) -> dict:
    E = {"ticker": np.array([e["t"] for e in ev]),
         "as_of": np.array([e["d"].isoformat() if hasattr(e["d"], "isoformat") else str(e["d"])[:10] for e in ev])}
    skip = {"t", "d", "expiry"}
    keys = sorted({k for e in ev for k, v in e.items()
                   if k not in skip and isinstance(v, (int, float)) and not isinstance(v, bool)})
    for k in keys:
        E[k] = np.array([np.nan if e.get(k) is None else float(e[k]) for e in ev], float)
    return E


def load_signal_panel() -> dict:
    cache_dir = HERE / "out" / "opt"
    cache_dir.mkdir(parents=True, exist_ok=True)
    conn = connect()
    try:
        stamp = conn.execute("""SELECT concat_ws('|',
            (SELECT max(computed_at)::text FROM watchlist_sync.lab_outcomes),
            (SELECT max(computed_at)::text FROM watchlist_sync.lab_tech),
            (SELECT max(date)::text FROM lseg_research.daily_history))""").fetchone()[0]
        key = hashlib.sha1((stamp + "|" + SIGNAL_VERSION).encode()).hexdigest()[:10]
        path = cache_dir / f"s045_signal_{key}.npz"
        if path.exists():
            z = np.load(path, allow_pickle=True)
            return {k: z[k] for k in z.files}
        ev_rows, tech, fund, px = load(conn)
        ev = build(ev_rows, tech, fund, px)
        _attach_put_edge(conn, ev)
        E = events_to_panel(ev)
        for old in cache_dir.glob("s045_signal_*.npz"):
            old.unlink()
        np.savez(path, **E)
        print(f"put signal cache: {len(E['as_of']):,} events → {path.name}")
        return E
    finally:
        conn.close()


def put_signal_report(E, score, holdout="2023-01-01", lag=3, seed=7) -> str:
    """Q5−Q1 pnl/breach, marginal vs put_edge quintile, halves, placebo. Verdict PASS / duplicate / FAIL."""
    import lab
    score = np.asarray(score, float).reshape(-1)
    pnl = np.asarray(E["pnl"], float)
    breach = np.asarray(E["breach"], float)
    edge_q = np.asarray(E["put_edge_q"], float) if "put_edge_q" in E else np.full(len(score), np.nan)
    dates = sorted({str(s)[:10] for s in np.asarray(E["as_of"]).tolist()})
    use = [s for s in dates if s >= holdout and date.fromisoformat(s).weekday() == 0]
    if not use:
        use = [s for s in dates if s >= holdout]
    mid = use[len(use) // 2] if use else holdout
    groups = defaultdict(list)
    want = set(use)
    for i, s in enumerate(E["as_of"]):
        if str(s)[:10] in want:
            groups[str(s)[:10]].append(i)
    spread, br, marg, packed = [], [], [], []
    for d in use:
        idx = np.array(groups.get(d, []), int)
        if len(idx) < 30:
            continue
        m = np.isfinite(score[idx]) & np.isfinite(pnl[idx]) & np.isfinite(breach[idx])
        if int(m.sum()) < 30:
            continue
        sc, py, bv = score[idx][m], pnl[idx][m], breach[idx][m]
        k = len(sc) // 5
        if k < 1 or np.std(sc) == 0:
            continue
        order = np.argsort(sc, kind="mergesort")
        spread.append((d, 1e4 * float(py[order[-k:]].mean() - py[order[:k]].mean())))
        br.append((d, 100.0 * float(bv[order[-k:]].mean() - bv[order[:k]].mean())))
        packed.append((d, sc, py))
        qq = edge_q[idx][m]
        gaps = []
        for q in range(1, 6):
            sel = qq == q
            if int(sel.sum()) < 4 or np.std(sc[sel]) == 0:
                continue
            med = float(np.median(sc[sel]))
            hi, lo = py[sel & (sc >= med)], py[sel & (sc < med)]
            if len(hi) and len(lo):
                gaps.append(1e4 * float(hi.mean() - lo.mean()))
        if len(gaps) >= 3:
            marg.append((d, float(np.mean(gaps))))
    sp, bp, mq = lab.pack_weeks(spread, mid, lag), lab.pack_weeks(br, mid, lag), lab.pack_weeks(marg, mid, lag)
    rng = np.random.default_rng(seed)
    placebo = []
    for d, sc, py in packed:
        sh = np.array(sc, copy=True)
        rng.shuffle(sh)
        k = len(sh) // 5
        if k < 1 or np.std(sh) == 0:
            continue
        order = np.argsort(sh, kind="mergesort")
        placebo.append((d, 1e4 * float(py[order[-k:]].mean() - py[order[:k]].mean())))
    pl = lab.pack_weeks(placebo, mid, lag)
    if lab.clears(sp) and lab.clears(mq):
        verdict = "PASS"
    elif lab.clears(sp):
        verdict = "duplicate"
    else:
        verdict = "FAIL"

    def row(name, p):
        if not p or not math.isfinite(p.get("mean", math.nan)):
            return f"| {name} | — | — | — | — | {p.get('n', 0) if p else 0} |"
        return f"| {name} | {p['mean']:+.2f} | {p['t']:+.2f} | {p['a']:+.2f} | {p['b']:+.2f} | {p['n']} |"

    lines = [
        f"holdout {holdout}  weeks {len(use)}  scored {sp.get('n', 0)}  NW lag {lag}  midpoint {mid}  seed {seed}",
        "| piece | mean | t | half A | half B | weeks |",
        "|---|---|---|---|---|---|",
        row("Q5−Q1 pnl bp", sp),
        row("Q5−Q1 breach pp", bp),
        row("within put_edge q pnl bp", mq),
        row("placebo Q5−Q1 pnl bp", pl),
        f"verdict {verdict}",
    ]
    return "\n".join(lines)


def run_signal(a) -> None:
    import lab
    t0 = time.time()
    E = load_signal_panel()
    t_load = time.time() - t0
    sig = lab.call_signal(E, a.module, a.expr)
    t1 = time.time()
    print(put_signal_report(E, sig, a.holdout, seed=a.seed))
    print(f"timing load {t_load:.2f}s eval {time.time() - t1:.2f}s")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("what", nargs="?", default="report", choices=["report", "signal"])
    ap.add_argument("--module", default="")
    ap.add_argument("--expr", default="")
    ap.add_argument("--holdout", default="2023-01-01")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()
    if a.what == "signal":
        run_signal(a)
        return
    conn = connect()
    rows, tech, fund, px = load(conn)
    ev = build(rows, tech, fund, px)
    conn.close()
    base_b = np.mean([e["breach"] for e in ev])
    base_p = np.mean([e["pnl"] for e in ev]) * 1e4
    xs = ["tech_total"] + sorted({k for e in ev for k in e if k.startswith("tech_") and k != "tech_total"}) + \
         ["sr_cushion", "har_iv", "drop2s", "ret5", "down_streak", "sue"]
    L = [f"# S045 — rejected features re-tested on the put seller's outcome\n",
         f"**Date:** {date.today()} · n {len(ev):,} weekly puts · {len({e['t'] for e in ev})} tickers · "
         f"{min(e['d'] for e in ev)} → {max(e['d'] for e in ev)}",
         f"1σ IV strike, 5 sessions, hold to expiry. Base breach {base_b * 100:.1f} % · base pnl {base_p:+.1f} bp of collateral/week\n",
         "## Cross-sectional (within week; IC on pnl after iv_rv/iv30/earnings controls)\n",
         "| feature | weeks | IC pnl | t | half A / B | IC breach (t) | top-q breach / pnl bp | bottom-q breach / pnl bp |",
         "|---|---|---|---|---|---|---|---|"]
    res = {}
    for f in xs:
        a = fm(ev, f, "pnl")
        b = fm(ev, f, "breach")
        if not a:
            continue
        q = quint(ev, f)
        res[f] = (a, b, q)
        L.append(f"| {f} | {a['n_weeks']} | {a['ic']:+.3f} | {a['t']:+.1f} | {a['ic_a']:+.3f} / {a['ic_b']:+.3f} | "
                 f"{b['ic']:+.3f} ({b['t']:+.1f}) | {q['breach_top'] * 100:.1f} % / {q['pnl_top']:+.1f} (n {q['n_top']}) | "
                 f"{q['breach_bot'] * 100:.1f} % / {q['pnl_bot']:+.1f} (n {q['n_bot']}) |")
    L += ["", "## Time-series (week-level regime features; top vs bottom third of weeks)\n",
          "| feature | weeks | pnl bp hi / lo | breach hi / lo | t (pnl) | pnl sd hi / lo |", "|---|---|---|---|---|---|"]
    for f in ["spy_dd_52w", "mkt_med_dd", "spy_vrp"]:
        r = ts_test(ev, f)
        if r:
            L.append(f"| {f} | {r['weeks']} | {r['pnl_hi']:+.1f} / {r['pnl_lo']:+.1f} | {r['breach_hi'] * 100:.1f} % / "
                     f"{r['breach_lo'] * 100:.1f} % | {r['t']:+.1f} | {r['pnl_sd_hi']:.0f} / {r['pnl_sd_lo']:.0f} |")
    cands = [f for f, (a, b, q) in res.items() if abs(a["t"]) >= 3 and np.sign(a["ic_a"]) == np.sign(a["ic_b"])]
    L += ["", f"**Candidates (|t| ≥ 3 on pnl, same sign both halves):** {', '.join(cands) or 'none'}"]
    text = "\n".join(L) + "\n"
    print(text)
    if "--write" in sys.argv:
        OUT.write_text(text)
    with open(HERE / "out" / "opt" / "S045_events.json", "w") as fh:
        json.dump([{k: (str(v) if k == "d" else v) for k, v in e.items()} for e in ev], fh)


if __name__ == "__main__":
    main()
