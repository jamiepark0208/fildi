"""S026 (Claude, pre-registered 2026-10-15 in research/studies/INDEX.md; A120 track 2): calendar & macro-event weeks.

Weeks = Mon–Fri calendar weeks. Flags: FOMC decision week (static Fed calendar below), CPI week (approx: week containing the
12th; BLS releases fall on the 10th–15th), jobs week (approx: first Friday of the month), monthly opex (3rd Friday), month-end
(week holding the month's last trading day), quarter-end (same, Mar/Jun/Sep/Dec). Entry weekday: next-5-day return from that
day's close, paired within week (that weekday vs the week's other entry days).
Outcomes: excess = return − the stock's own mean (same horizon); tail = 1 if return ≤ −1.5·σ_60·√5. Week-level cross-sectional
means; effect = mean(flag weeks) − mean(other weeks); week bootstrap (B=3000). 22 tests, Holm. Pass: Holm p < 0.05, same sign
both halves (median week), |excess| ≥ 0.3 pp or |tail| ≥ 2 pp.
Trader check (descriptive): optlab.trades replayed to expiry (opt_replay "hold") — breach rate and $/10k collateral-week when an
event day falls inside (d0, expiry] vs not.
    .venv/bin/python analysis/s026_calendar.py     # → out/opt/S026.md (+ optlab.findings S026)
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402

FOMC = """2017-02-01 2017-03-15 2017-05-03 2017-06-14 2017-07-26 2017-09-20 2017-11-01 2017-12-13
2018-01-31 2018-03-21 2018-05-02 2018-06-13 2018-08-01 2018-09-26 2018-11-08 2018-12-19
2019-01-30 2019-03-20 2019-05-01 2019-06-19 2019-07-31 2019-09-18 2019-10-30 2019-12-11
2020-01-29 2020-03-03 2020-03-16 2020-04-29 2020-06-10 2020-07-29 2020-09-16 2020-11-05 2020-12-16
2021-01-27 2021-03-17 2021-04-28 2021-06-16 2021-07-28 2021-09-22 2021-11-03 2021-12-15
2022-01-26 2022-03-16 2022-05-04 2022-06-15 2022-07-27 2022-09-21 2022-11-02 2022-12-14
2023-02-01 2023-03-22 2023-05-03 2023-06-14 2023-07-26 2023-09-20 2023-11-01 2023-12-13
2024-01-31 2024-03-20 2024-05-01 2024-06-12 2024-07-31 2024-09-18 2024-11-07 2024-12-18
2025-01-29 2025-03-19 2025-05-07 2025-06-18 2025-07-30 2025-09-17 2025-10-29 2025-12-10
2026-01-28 2026-03-18 2026-04-29 2026-06-17 2026-07-29 2026-09-16 2026-10-28 2026-12-09""".split()
FOMC = {date.fromisoformat(d) for d in FOMC}
B = 3000
rng = np.random.default_rng(26)
DOW = ["Mon", "Tue", "Wed", "Thu", "Fri"]


def monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def week_flags(days: list[date]) -> dict[date, set[str]]:
    """Flags per week (keyed by Monday) from the trading-day calendar."""
    by_wk = defaultdict(list)
    for d in days:
        by_wk[monday(d)].append(d)
    last_td = {}
    for d in days:
        last_td[(d.year, d.month)] = max(last_td.get((d.year, d.month), d), d)
    flags = defaultdict(set)
    for wk, ds in by_wk.items():
        span = [wk + timedelta(days=i) for i in range(5)]
        if any(x in FOMC for x in span): flags[wk].add("FOMC")
        if any(x.day == 12 for x in span): flags[wk].add("CPI")
        if any(x.weekday() == 4 and x.day <= 7 for x in span): flags[wk].add("jobs")
        if any(x.weekday() == 4 and 15 <= x.day <= 21 for x in span): flags[wk].add("opex")
        if any(last_td.get((x.year, x.month)) == x for x in ds):
            flags[wk].add("month-end")
            if any(last_td.get((x.year, x.month)) == x and x.month in (3, 6, 9, 12) for x in ds): flags[wk].add("quarter-end")
    return flags


def boot_diff(a: np.ndarray, b: np.ndarray) -> tuple[float, float]:
    """Week-level means a (flag weeks) vs b (others): diff and two-sided bootstrap p."""
    d = a.mean() - b.mean()
    bs = np.array([rng.choice(a, a.size).mean() - rng.choice(b, b.size).mean() for _ in range(B)])
    p = 2 * min((bs <= 0).mean(), (bs >= 0).mean())
    return float(d), float(min(p, 1.0))


def boot_mean(x: np.ndarray) -> tuple[float, float]:
    bs = np.array([rng.choice(x, x.size).mean() for _ in range(B)])
    return float(x.mean()), float(min(1.0, 2 * min((bs <= 0).mean(), (bs >= 0).mean())))


def main():
    conn = connect()
    px = defaultdict(lambda: ([], []))
    for t, d, c in conn.execute("SELECT ticker, date, close FROM lseg_research.daily_history WHERE close > 0 AND date >= '2016-10-01' ORDER BY ticker, date").fetchall():
        px[t][0].append(d); px[t][1].append(float(c))
    funds = {"SPY", "QQQ", "IWM", "SMH", "XLB", "XLC", "XLE", "XLF", "XLI", "XLK", "XLP", "XLRE", "XLU", "XLV", "XLY"}
    all_days = sorted({d for t, (ds, _) in px.items() for d in ds if d >= date(2017, 1, 1)})
    flags = week_flags(all_days)
    # per-stock weekly + daily-entry rows → week-level cross-sectional means
    wk_ex, wk_tail = defaultdict(list), defaultdict(list)          # week → per-stock values (week return)
    dow_ex = defaultdict(lambda: defaultdict(list))                # week → weekday → values (next-5-day from that close)
    dow_tail = defaultdict(lambda: defaultdict(list))
    for t, (ds, cs) in px.items():
        if t in funds or len(cs) < 120:
            continue
        c = np.array(cs); lr = np.diff(np.log(c))
        r5 = c[5:] / c[:-5] - 1
        mean5 = np.nanmean(r5)
        sig = np.array([np.std(lr[max(0, i - 60):i]) if i >= 60 else np.nan for i in range(len(lr) + 1)])
        for i in range(60, len(c) - 5):
            d = ds[i]
            if d < date(2017, 1, 1): continue
            ret = c[i + 5] / c[i] - 1
            tail = float(ret <= -1.5 * sig[i] * np.sqrt(5)) if sig[i] == sig[i] and sig[i] > 0 else np.nan
            wk = monday(d)
            dow_ex[wk][d.weekday()].append(ret - mean5)
            if tail == tail: dow_tail[wk][d.weekday()].append(tail)
            # week return: entry = last close of the previous week (Friday), exit = this week's Friday close
            if d.weekday() == 4 and i >= 5:
                prev = i - 1
                while prev > 0 and monday(ds[prev]) == wk: prev -= 1
                wr = c[i] / c[prev] - 1
                n = i - prev
                wk_ex[wk].append(wr - mean5 * n / 5)
                s = sig[prev]
                if s == s and s > 0: wk_tail[wk].append(float(wr <= -1.5 * s * np.sqrt(n)))
    weeks = sorted(w for w in wk_ex if len(wk_ex[w]) >= 20)
    mid = weeks[len(weeks) // 2]
    WE = {w: np.mean(wk_ex[w]) for w in weeks}
    WT = {w: np.mean(wk_tail[w]) for w in weeks if wk_tail[w]}
    base_tail = float(np.mean([WT[w] for w in WT]))
    tests = []
    for f in ["FOMC", "CPI", "jobs", "opex", "month-end", "quarter-end"]:
        for out, M, unit in (("excess", WE, 100), ("tail", WT, 100)):
            on = np.array([M[w] for w in M if f in flags[w]]); off = np.array([M[w] for w in M if f not in flags[w]])
            d, p = boot_diff(on, off)
            h = [np.mean([M[w] for w in M if f in flags[w] and (w < mid) == k]) - np.mean([M[w] for w in M if f not in flags[w] and (w < mid) == k]) for k in (True, False)]
            tests.append({"cond": f + " week", "out": out, "eff": d * unit, "p": p, "halves": [h[0] * unit, h[1] * unit], "n": int(on.size),
                          "base": float(np.mean(list(M.values()))) * unit, "on": float(on.mean()) * unit})
    for k in range(5):
        for out, D in (("excess", dow_ex), ("tail", dow_tail)):
            pairs = []
            for w in weeks:
                g = D.get(w, {})
                if k in g and len(g) >= 3:
                    others = [np.mean(v) for j, v in g.items() if j != k]
                    pairs.append((w, np.mean(g[k]) - np.mean(others)))
            x = np.array([v for _, v in pairs])
            d, p = boot_mean(x)
            h = [np.mean([v for w, v in pairs if (w < mid) == kk]) for kk in (True, False)]
            tests.append({"cond": f"enter {DOW[k]}", "out": out, "eff": d * 100, "p": p, "halves": [h[0] * 100, h[1] * 100], "n": int(x.size), "base": None, "on": None})
    order = sorted(range(len(tests)), key=lambda i: tests[i]["p"])
    m = len(tests); run = 0.0
    for r, i in enumerate(order):
        run = max(run, min(1.0, tests[i]["p"] * (m - r))); tests[i]["holm"] = run
    for t in tests:
        big = abs(t["eff"]) >= (0.3 if t["out"] == "excess" else 2.0)
        t["pass"] = bool(t["holm"] < 0.05 and t["halves"][0] * t["halves"][1] > 0 and (t["halves"][0] > 0) == (t["eff"] > 0) and big)

    # trader check (descriptive)
    import opt_replay as o
    hs = o.half_spreads(conn); ents, bars, und = o.load(conn)
    ev_days = set(FOMC) | {d for d in all_days if d.day == 12 or (d.weekday() == 4 and d.day <= 7)}
    tr = []
    for e in ents:
        x = o.replay(e, "hold", bars, und, hs, 0.0)
        if not x: continue
        has = any(e.d0 < e.d0 + timedelta(days=k) <= e.exp and (e.d0 + timedelta(days=k)) in ev_days for k in range(1, (e.exp - e.d0).days + 1))
        breach = und[e.ticker].get(x["exit"], 1e9) < e.k
        tr.append((e, has, x["pnl"], breach))
    def summ(rows):
        if not rows: return (0, 0.0, 0.0, 0)
        cw = sum(o.cw(e) for e, *_ in rows)
        return (len(rows), sum(b for *_, b in rows) / len(rows), sum(p for _, _, p, _ in rows) / max(cw, 1e-9), len({e.exp for e, *_ in rows}))
    on_t, off_t = summ([r for r in tr if r[1]]), summ([r for r in tr if not r[1]])

    passed = [t for t in tests if t["pass"]]
    out = [f"# S026 — calendar & macro-event weeks ({date.today()})\n",
           f"{len(weeks)} weeks (2017→2026-10), ~{int(np.median([len(wk_ex[w]) for w in weeks]))} stocks/week (lseg_research.daily_history, ETFs excluded). "
           f"Base: weekly tail (≤ −1.5σ) {base_tail * 100:.1f}% of stock-weeks; excess return is vs each stock's own mean.\n",
           "| Condition | Outcome | Flag weeks | Effect (pp) | halves | p | Holm | pass |", "|---|---|---|---|---|---|---|---|"]
    for t in sorted(tests, key=lambda t: t["holm"]):
        on = f" (flag {t['on']:.2f} vs all {t['base']:.2f})" if t["on"] is not None else ""
        out.append(f"| {t['cond']} | {t['out']} | {t['n']} | {t['eff']:+.2f}{on} | {t['halves'][0]:+.2f} / {t['halves'][1]:+.2f} | {t['p']:.3f} | {t['holm']:.3f} | {'**PASS**' if t['pass'] else '—'} |")
    out += ["", "Trader's puts held to expiry (descriptive; 36 expiries can't power this, see A51):",
            f"- event (FOMC / CPI≈12th / jobs≈1st Fri) inside the put's life: n {on_t[0]}, {on_t[3]} expiries, breach {on_t[1] * 100:.0f}%, {on_t[2]:+.1f} $/10k-week",
            f"- no event: n {off_t[0]}, {off_t[3]} expiries, breach {off_t[1] * 100:.0f}%, {off_t[2]:+.1f} $/10k-week",
            "", "Approximations (pre-declared): CPI week = week containing the 12th; jobs = first Friday. FOMC = official decision dates (2020 emergency cuts included)."]
    OUT = HERE.parent / "out/opt"; OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "S026.md").write_text("\n".join(out) + "\n")
    if passed:
        verdict = "pass"
        head = "; ".join(f"{t['cond']} {t['out']} {t['eff']:+.2f} pp" for t in passed) + " (Holm-passed, both halves)."
    else:
        verdict = "fail"
        best = min(tests, key=lambda t: t["p"])
        head = (f"No calendar or macro-event week changes weekly put risk reliably ({len(weeks)} weeks, 22 tests). "
                f"Closest: {best['cond']} {best['out']} {best['eff']:+.2f} pp (raw p {best['p']:.2f}, Holm {best['holm']:.2f}). Sell through FOMC/CPI/jobs weeks as usual.")
    conn.execute("""INSERT INTO optlab.findings (study, title, verdict, headline, card, updated_at) VALUES ('S026','Calendar & event weeks',%s,%s,%s,now())
                    ON CONFLICT (study) DO UPDATE SET verdict = excluded.verdict, headline = excluded.headline, card = excluded.card, updated_at = now()""",
                 (verdict, head, json.dumps({"tests": tests, "trader": {"event": on_t, "none": off_t}, "base_tail": base_tail}, default=float)))
    conn.commit()
    print("\n".join(out)); print("→", verdict, head)


if __name__ == "__main__":
    main()
