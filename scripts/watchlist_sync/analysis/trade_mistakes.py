"""S015: Which of the trader's short puts were mistakes — and is "assigned" ever the mistake? (read-only)

An assignment is an outcome, not an error. A decision is a mistake only if something KNOWABLE AT THE TIME predicted a worse
result than the alternative, consistently (not one unlucky week). Four pre-registered questions, each with its own test:

  Q1 assignment   After a put ends in the money, does the stock keep falling or mean-revert? Forward 5/10/20-day return from the
                  expiry close minus the same ticker's average forward return (all 2026 days). Trader's puts + a broad check on
                  every ticker (simulated weekly 0.2-delta puts). If excess ≈ 0, taking assignment is neutral: the loss was
                  locked in at expiry and holding the stock afterwards is a fresh, separate decision.
  Q2 closing      Did the trader's buy-to-close orders save money vs holding to expiry? value = intrinsic at expiry − close price.
  Q3 entry        Nine features known the day before entry vs the trade's hold-to-expiry P&L (% of collateral). Spearman IC,
                  week-cluster bootstrap p (entries in one week share one market), Holm-adjusted across the nine.
  Q4 clustering   Do breaches cluster by expiry week (one bad week hits many puts at once)? Variance of the per-expiry breach
                  share vs shuffled outcomes. If clustered, the risk is the book's size, not any single pick.

Stop rule: a feature is "a pattern" only if Holm p < 0.05 AND the same sign shows in both halves of the sample. Everything else
is reported as noise in one line, not as an insight.

    .venv/bin/python analysis/trade_mistakes.py      # → out/mistakes/report.md (+ trades.csv)
"""
from __future__ import annotations

import csv
import math
import random
import sys
from bisect import bisect_left, bisect_right
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from statistics import mean, median, pstdev

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_plan import connect, rows  # noqa: E402
from analysis.street_scenarios import spearman  # noqa: E402
from analysis.timing_rh_trades import ET, ACCOUNTS, rsi  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "out" / "mistakes"
R = 0.04
B = 2000
random.seed(15)


# ── pricing ────────────────────────────────────────────────────────────────────────────────────────────────────────────
def ncdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def bs_put(s: float, k: float, t: float, v: float) -> float:
    if t <= 0 or v <= 0:
        return max(k - s, 0.0)
    d1 = (math.log(s / k) + (R + v * v / 2) * t) / (v * math.sqrt(t))
    return k * math.exp(-R * t) * ncdf(-(d1 - v * math.sqrt(t))) - s * ncdf(-d1)


def implied_vol(price: float, s: float, k: float, t: float) -> float | None:
    if t <= 0 or price <= max(k * math.exp(-R * t) - s, 0) + 1e-6:
        return None
    lo, hi = 0.01, 6.0
    if bs_put(s, k, t, hi) < price:
        return None
    for _ in range(60):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if bs_put(s, k, t, mid) < price else (lo, mid)
    return (lo + hi) / 2


def rv20(closes: list[float]) -> float | None:
    if len(closes) < 21:
        return None
    lr = [math.log(closes[i] / closes[i - 1]) for i in range(len(closes) - 20, len(closes))]
    return pstdev(lr) * math.sqrt(252)


# ── stats ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
def week(d: date) -> tuple[int, int]:
    return d.isocalendar()[:2]


def cluster_boot(items: list, cluster_of, stat) -> tuple[float, float]:
    """Point estimate + two-sided bootstrap p (resampling whole clusters)."""
    groups: dict = defaultdict(list)
    for it in items:
        groups[cluster_of(it)].append(it)
    keys = list(groups)
    est = stat(items)
    if est is None or len(keys) < 5:
        return est, float("nan")
    draws = []
    for _ in range(B):
        sample = [it for k in random.choices(keys, k=len(keys)) for it in groups[k]]
        v = stat(sample)
        if v is not None:
            draws.append(v)
    if not draws:
        return est, float("nan")
    above = sum(d > 0 for d in draws) / len(draws)
    return est, min(1.0, 2 * min(above, 1 - above))


def holm(ps: list[float]) -> list[float]:
    order = sorted(range(len(ps)), key=lambda i: (math.isnan(ps[i]), ps[i]))
    adj, run = [float("nan")] * len(ps), 0.0
    m = sum(not math.isnan(p) for p in ps)
    for rank, i in enumerate(order):
        if math.isnan(ps[i]):
            continue
        run = max(run, min(1.0, (m - rank) * ps[i]))
        adj[i] = run
    return adj


def ic(xs_ys: list[tuple[float, float]]) -> float | None:
    pts = [(x, y) for x, y in xs_ys if x is not None and y is not None]
    if len(pts) < 20:
        return None
    return spearman([p[0] for p in pts], [p[1] for p in pts])[0]


# ── data ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
def load(conn):
    opens = rows(conn, """SELECT DISTINCT ON (order_id) order_id, account, symbol, option_strike::float8 AS k, option_expiration AS exp,
                                 avg_fill_price::float8 AS fill, quantity::float8 AS qty, created_at
                          FROM portfolio_orders
                          WHERE is_option AND option_side = 'put' AND leg_effect = 'open' AND leg_side = 'sell' AND state = 'filled'
                            AND avg_fill_price > 0 AND option_strike > 0
                          ORDER BY order_id, snapshot_id DESC""")
    closes = rows(conn, """SELECT DISTINCT ON (order_id) order_id, account, symbol, option_strike::float8 AS k, option_expiration AS exp,
                                  avg_fill_price::float8 AS fill, quantity::float8 AS qty, created_at
                           FROM portfolio_orders
                           WHERE is_option AND option_side = 'put' AND leg_effect = 'close' AND leg_side = 'buy' AND state = 'filled'
                             AND avg_fill_price IS NOT NULL
                           ORDER BY order_id, snapshot_id DESC""")
    earn: dict[str, list[date]] = defaultdict(list)
    for r in rows(conn, """SELECT UPPER(ticker) AS t, report_date::date AS d FROM lseg_research.earnings_moves
                           UNION SELECT UPPER(ticker), report_date::date FROM earnings_calendar"""):
        earn[r["t"]].append(r["d"])
    for v in earn.values():
        v.sort()
    tickers = sorted({o["symbol"] for o in opens} | {"SPY"})
    px: dict[str, tuple[list[date], list[float]]] = {}
    tmp: dict[str, list] = defaultdict(list)
    for r in rows(conn, """SELECT ticker, date, close::float8 AS c FROM prices_historical
                           WHERE ticker = ANY(%s) AND date >= '2025-01-01' AND close > 0 ORDER BY ticker, date""", (tickers,)):
        tmp[r["ticker"]].append((r["date"], r["c"]))
    for t, s in tmp.items():
        px[t] = ([d for d, _ in s], [c for _, c in s])
    return opens, closes, earn, px


def close_at(px, t: str, d: date) -> float | None:
    s = px.get(t)
    if not s:
        return None
    i = bisect_left(s[0], d)
    return s[1][i] if i < len(s[0]) and s[0][i] == d else None


def build_trades(opens, closes, earn, px):
    by_contract = defaultdict(list)
    for c in closes:
        by_contract[(c["account"], c["symbol"], c["k"], c["exp"])].append(c)
    trades = []
    for o in opens:
        s = px.get(o["symbol"])
        if not s:
            continue
        dates, cl = s
        d0 = o["created_at"].astimezone(ET).date()
        i = bisect_left(dates, d0)          # entry day index (or next trading day)
        j = bisect_left(dates, o["exp"])
        if i < 200 or j >= len(dates) or dates[j] != o["exp"]:
            continue                        # need 200d history and an expiry close (excludes still-open trades)
        prev = cl[i - 1]
        k, fill = o["k"], o["fill"]
        t_years = max((o["exp"] - d0).days, 1) / 365
        iv = implied_vol(fill, prev, k, t_years)
        rv = rv20(cl[:i])
        st = cl[j]
        intrinsic = max(k - st, 0.0)
        cs = by_contract.get((o["account"], o["symbol"], k, o["exp"]), [])
        cs = [c for c in cs if c["created_at"] >= o["created_at"]]
        trades.append({
            "account": ACCOUNTS.get(o["account"], o["account"]), "ticker": o["symbol"], "d0": d0, "exp": o["exp"], "i": i, "j": j,
            "k": k, "fill": fill, "qty": o["qty"], "prev": prev, "st": st, "intrinsic": intrinsic,
            "breach": intrinsic > 0, "pnl": (fill - intrinsic) / k,
            "closed": bool(cs),
            # features (all from data on or before the day before entry)
            "ivrv": (iv / rv) if iv and rv else None,
            "earn_in": any(d0 < d <= o["exp"] for d in earn.get(o["symbol"].upper(), [])),
            "ret5": prev / cl[i - 6] - 1,
            "rsi": rsi(cl[:i]),
            "trend200": prev / mean(cl[i - 200:i]) - 1,
            "z_dist": (math.log(prev / k) / (rv * math.sqrt(t_years))) if rv else None,
        })
    # SPY trend, concentration, book load, repeat-after-breach — need the whole trade list
    spy_d, spy_c = px["SPY"]
    open_at = sorted(trades, key=lambda t: t["d0"])
    acct_loads: dict[str, list[float]] = defaultdict(list)
    for t in trades:
        si = bisect_left(spy_d, t["d0"])
        t["spy50"] = spy_c[si - 1] / mean(spy_c[si - 50:si]) - 1 if si >= 50 else None
        live = [u for u in open_at if u["d0"] <= t["d0"] < u["exp"] or u is t]
        tot = sum(u["k"] * 100 * u["qty"] for u in live)
        same = sum(u["k"] * 100 * u["qty"] for u in live if u["ticker"] == t["ticker"])
        t["name_conc"] = same / tot if tot else None
        t["_load"] = sum(u["k"] * 100 * u["qty"] for u in live if u["account"] == t["account"])
        acct_loads[t["account"]].append(t["_load"])
        prior_breach = [u for u in trades if u["ticker"] == t["ticker"] and u["breach"] and t["d0"] - timedelta(days=14) <= u["exp"] < t["d0"]]
        t["repeat_after_breach"] = bool(prior_breach)
    med = {a: median(v) for a, v in acct_loads.items()}
    for t in trades:
        t["book_load"] = t["_load"] / med[t["account"]] if med[t["account"]] else None
    return trades


FEATURES = [  # (key, label, expected sign of IC with P&L if it is a real risk/edge)
    ("ivrv", "IV ÷ realized vol (rich premium)", "+"),
    ("earn_in", "earnings before expiry", "−"),
    ("ret5", "5-day return before entry (dip = negative)", "?"),
    ("trend200", "price vs 200-day average", "+"),
    ("spy50", "SPY vs its 50-day average", "+"),
    ("z_dist", "strike distance in vol units (≈ lower delta)", "+"),
    ("name_conc", "share of open put notional in this name", "−"),
    ("book_load", "account's open put notional vs its usual", "−"),
    ("repeat_after_breach", "re-selling a name that breached in last 2 weeks", "−"),
]


def q3(trades):
    out = []
    for key, label, sign in FEATURES:
        pairs = [(float(t[key]) if isinstance(t[key], bool) else t[key], t["pnl"], t) for t in trades if t[key] is not None]
        stat = lambda its: ic([(x, y) for x, y, _ in its])  # noqa: E731
        est, p = cluster_boot(pairs, lambda it: week(it[2]["d0"]), stat)
        half = sorted(pairs, key=lambda it: it[2]["d0"])
        h1, h2 = stat(half[: len(half) // 2]), stat(half[len(half) // 2:])
        isbool = isinstance(trades[0][key], bool)
        if isbool:
            yes = [y for x, y, _ in pairs if x]
            no = [y for x, y, _ in pairs if not x]
            br_y = mean(t["breach"] for _, _, t in pairs if t[key]) if yes else None
            br_n = mean(t["breach"] for _, _, t in pairs if not t[key]) if no else None
            desc = f"yes n={len(yes)} P&L {mean(yes)*100:+.2f}% ITM {br_y:.0%} · no n={len(no)} P&L {mean(no)*100:+.2f}% ITM {br_n:.0%}" if yes and no else "—"
        else:
            srt = sorted(pairs, key=lambda it: it[0])
            n3 = len(srt) // 3
            lo, hi = srt[:n3], srt[-n3:]
            desc = (f"low third P&L {mean(y for _, y, _ in lo)*100:+.2f}% ITM {mean(t['breach'] for *_, t in lo):.0%} · "
                    f"high third P&L {mean(y for _, y, _ in hi)*100:+.2f}% ITM {mean(t['breach'] for *_, t in hi):.0%}")
        out.append({"key": key, "label": label, "sign": sign, "n": len(pairs), "ic": est, "p": p, "h1": h1, "h2": h2, "desc": desc})
    for r, a in zip(out, holm([r["p"] for r in out])):
        r["p_holm"] = a
        r["pattern"] = (a < 0.05 and r["h1"] is not None and r["h2"] is not None and (r["h1"] > 0) == (r["h2"] > 0))
    return out


def fwd_excess(px, t: str, d: date, h: int, base: dict) -> float | None:
    dates, cl = px[t]
    i = bisect_left(dates, d)
    if i >= len(dates) or dates[i] != d or i + h >= len(dates):
        return None
    if (t, h) not in base:
        s = bisect_left(dates, date(2026, 1, 1))
        rs = [cl[x + h] / cl[x] - 1 for x in range(max(s, 1), len(cl) - h)]
        base[(t, h)] = mean(rs) if rs else 0.0
    return cl[i + h] / cl[i] - 1 - base[(t, h)]


def q1(trades, px):
    base: dict = {}
    res = {}
    breached = [t for t in trades if t["breach"]]
    seen = {}
    for t in breached:  # one event per ticker × expiry (several orders on one contract are one stock event)
        seen.setdefault((t["ticker"], t["exp"]), t)
    ev = list(seen.values())
    for h in (5, 10, 20):
        its = [(fwd_excess(px, t["ticker"], t["exp"], h, base), t) for t in ev]
        its = [(x, t) for x, t in its if x is not None]
        est, p = cluster_boot(its, lambda it: it[1]["exp"], lambda s: mean(x for x, _ in s) if s else None)
        under = [px[t["ticker"]][1][bisect_left(px[t["ticker"]][0], t["exp"]) + h] < t["k"] - t["fill"] for _, t in its]
        res[h] = {"n": len(its), "excess": est, "p": p, "still_under_basis": mean(under) if under else None}
    return res, len(ev)


def q1_broad(conn):
    """Every ticker, every Friday 2025-06..2026-09: simulated 5-day put at ~0.20 delta (strike from 20d realized vol)."""
    data = defaultdict(list)
    for r in rows(conn, """SELECT ticker, date, close::float8 AS c FROM prices_historical
                           WHERE date >= '2025-04-01' AND close >= 3
                             AND ticker IN (SELECT UPPER(ticker) FROM fmp_fundamentals) ORDER BY ticker, date"""):
        data[r["ticker"]].append((r["date"], r["c"]))
    ev = {5: [], 10: [], 20: []}
    for t, s in data.items():
        dates = [d for d, _ in s]
        cl = [c for _, c in s]
        base = {h: [cl[x + h] / cl[x] - 1 for x in range(21, len(cl) - h)] for h in ev}
        base = {h: mean(v) if v else 0.0 for h, v in base.items()}
        for i in range(21, len(cl) - 5):
            if dates[i].weekday() != 4 or dates[i] < date(2025, 6, 1):
                continue
            rv = rv20(cl[: i + 1])
            if not rv:
                continue
            k = cl[i] * math.exp(-0.84 * rv * math.sqrt(5 / 252))
            e = i + 5
            if cl[e] >= k:
                continue
            for h in ev:
                if e + h < len(cl):
                    ev[h].append((cl[e + h] / cl[e] - 1 - base[h], dates[e]))
    out = {}
    for h, its in ev.items():
        est, p = cluster_boot(its, lambda it: it[1], lambda s: mean(x for x, _ in s) if s else None)
        out[h] = {"n": len(its), "excess": est, "p": p}
    return out


def q2(trades, closes, px):
    vals = []
    for c in closes:
        st = close_at(px, c["symbol"], c["exp"])
        if st is None:
            continue
        intrinsic = max(c["k"] - st, 0.0)
        d = c["created_at"].astimezone(ET).date()
        spot = close_at(px, c["symbol"], d)
        itm_then = spot is not None and spot < c["k"]
        vals.append({"saved": (intrinsic - c["fill"]) * 100 * c["qty"], "per_share": intrinsic - c["fill"], "itm": itm_then, "d": d,
                     "ticker": c["symbol"]})
    out = {}
    for label, sub in (("all closes", vals), ("closed while ITM", [v for v in vals if v["itm"]]), ("closed while OTM", [v for v in vals if not v["itm"]])):
        est, p = cluster_boot(sub, lambda v: week(v["d"]), lambda s: mean(v["per_share"] for v in s) if s else None)
        out[label] = {"n": len(sub), "total": sum(v["saved"] for v in sub), "mean_ps": est, "p": p,
                      "helped": mean(v["saved"] > 0 for v in sub) if sub else None}
    return out


def q4(trades):
    grp = defaultdict(list)
    for t in trades:
        grp[t["exp"]].append(t["breach"])
    grp = {k: v for k, v in grp.items() if len(v) >= 3}
    flat = [b for v in grp.values() for b in v]
    sizes = [len(v) for v in grp.values()]

    def disp(groups):
        shares = [mean(g) for g in groups]
        return pstdev(shares)

    obs = disp(grp.values())
    null = []
    for _ in range(B):
        random.shuffle(flat)
        pos, gs = 0, []
        for n in sizes:
            gs.append(flat[pos:pos + n])
            pos += n
        null.append(disp(gs))
    p = mean(x >= obs for x in null)
    worst = sorted(((mean(v), len(v), k) for k, v in grp.items()), reverse=True)[:5]
    return {"weeks": len(grp), "obs_sd": obs, "null_sd": mean(null), "p": p, "worst": worst, "base_rate": mean(t["breach"] for t in trades)}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    conn = connect()
    opens, closes, earn, px = load(conn)
    trades = build_trades(opens, closes, earn, px)
    r3 = q3(trades)
    r1, n_ev = q1(trades, px)
    r1b = q1_broad(conn)
    r2 = q2(trades, closes, px)
    r4 = q4(trades)

    with open(OUT / "trades.csv", "w", newline="") as f:
        keys = ["account", "ticker", "d0", "exp", "k", "fill", "qty", "prev", "st", "breach", "pnl", "closed"] + [k for k, *_ in FEATURES]
        w = csv.DictWriter(f, fieldnames=keys, extrasaction="ignore")
        w.writeheader()
        w.writerows(trades)

    L = [f"# S015 — trade mistakes vs bad luck ({date.today()})", "",
         f"Trades: {len(trades)} filled sell-to-open puts with an expiry close ({min(t['d0'] for t in trades)} → {max(t['exp'] for t in trades)}), "
         f"{sum(t['breach'] for t in trades)} ended ITM ({mean(t['breach'] for t in trades):.0%}). "
         f"Hold-to-expiry P&L mean {mean(t['pnl'] for t in trades)*100:+.2f}% of collateral, worst {min(t['pnl'] for t in trades)*100:+.1f}%.", "",
         "## Q1 — after a put ends ITM, does the stock keep falling?", "",
         "Excess = forward return from the expiry close minus the same ticker's average forward return. Basis = strike − premium.", "",
         "| horizon | trader events | excess | p | still below basis | broad sim n | broad excess | broad p |", "|---|---|---|---|---|---|---|---|"]
    for h in (5, 10, 20):
        a, b = r1[h], r1b[h]
        L.append(f"| {h}d | {a['n']} | {a['excess']*100:+.2f}% | {a['p']:.3f} | {a['still_under_basis']:.0%} | {b['n']} | {b['excess']*100:+.2f}% | {b['p']:.3f} |")
    L += ["", f"({n_ev} distinct ticker × expiry breach events.)", "",
          "## Q2 — did buy-to-close orders beat holding to expiry?", "",
          "saved = (intrinsic at expiry − close price) × 100 × qty. Positive = closing was cheaper than holding.", "",
          "| group | n | total saved | mean / share | p | share that helped |", "|---|---|---|---|---|---|"]
    for k, v in r2.items():
        if v["n"]:
            L.append(f"| {k} | {v['n']} | ${v['total']:,.0f} | {v['mean_ps']:+.3f} | {v['p']:.3f} | {v['helped']:.0%} |")
    L += ["", "## Q3 — entry features known the day before (IC vs hold-to-expiry P&L)", "",
          "Pattern = Holm p < 0.05 and same sign in both halves. Week-cluster bootstrap.", "",
          "| feature | n | IC | p | Holm p | 1st half | 2nd half | pattern | detail |", "|---|---|---|---|---|---|---|---|---|"]
    for r in r3:
        f = lambda x: "—" if x is None else f"{x:+.3f}"  # noqa: E731
        L.append(f"| {r['label']} | {r['n']} | {f(r['ic'])} | {r['p']:.3f} | {r['p_holm']:.3f} | {f(r['h1'])} | {f(r['h2'])} | "
                 f"{'**yes**' if r['pattern'] else 'no'} | {r['desc']} |")
    L += ["", "## Q4 — do breaches cluster by expiry?", "",
          f"{r4['weeks']} expiries with ≥ 3 puts. Per-expiry breach share SD {r4['obs_sd']:.3f} vs {r4['null_sd']:.3f} if independent "
          f"(p = {r4['p']:.3f}). Base ITM rate {r4['base_rate']:.0%}.", "", "Worst expiries: " +
          "; ".join(f"{k} {s:.0%} of {n}" for s, n, k in r4["worst"]), ""]
    (OUT / "report.md").write_text("\n".join(L))
    print("\n".join(L))


if __name__ == "__main__":
    main()
