"""S027 (A120 track 6, pre-registered 10-15 in research/studies/INDEX.md): does the market regime shift short-put outcomes or
20-day stock returns?

Regimes (point-in-time, from lseg_research.daily_history): trend_down = SPY < its 200-day SMA · iv_high = SPY 30-day put IV ≥ 20
· term_inverted = SPY iv30_put > iv90_put · breadth_weak = < 40 % of the universe above its own 50-day SMA.
Outcomes: S003 puts (out/step4/trades.csv) kept rate + risk-adjusted return (ret_ra), tagged at entry; universe 20-day forward
return + P(≤ −10 %), sampled weekly (Fridays). 16 tests, month-cluster bootstrap, Holm; pass = Holm p < 0.05 and same sign in
both date halves. Trader's puts (optlab replay, 36 weeks): descriptive table only.
    .venv/bin/python analysis/s027_regimes.py     → out/opt/S027.md + optlab.findings S027
"""
from __future__ import annotations

import csv
import json
import random
import sys
from bisect import bisect_right
from collections import defaultdict
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402

B = 3000
REGIMES = ["trend_down", "iv_high", "breadth_weak"]  # term_inverted dropped: SPY iv90_put has 0 rows in daily_history


def load_px(conn):
    px = defaultdict(lambda: ([], [], [], []))
    for t, d, c, i30, i90 in conn.execute("""SELECT ticker, date, close, iv30_put, iv90_put FROM lseg_research.daily_history
                                             WHERE close > 0 ORDER BY ticker, date"""):
        a = px[t]; a[0].append(d); a[1].append(float(c)); a[2].append(float(i30) if i30 else None); a[3].append(float(i90) if i90 else None)
    return px


def regime_table(px):
    sd, sc, si30, si90 = px["SPY"]
    reg = {}
    # breadth: share of names above own 50d SMA on each date
    above = defaultdict(lambda: [0, 0])
    for t, (ds, cs, _, _) in px.items():
        if t == "SPY":
            continue
        run = 0.0
        for i, (d, c) in enumerate(zip(ds, cs)):
            run += c
            if i >= 50:
                run -= cs[i - 50]
            if i >= 49:
                a = above[d]; a[1] += 1; a[0] += c > run / 50
    run = 0.0
    for i, (d, c) in enumerate(zip(sd, sc)):
        run += c
        if i >= 200:
            run -= sc[i - 200]
        if i < 199:
            continue
        iv30, iv90 = si30[i], si90[i]
        iv30 = iv30 * 100 if iv30 is not None and iv30 < 3 else iv30  # stored as fraction or %
        iv90 = iv90 * 100 if iv90 is not None and iv90 < 3 else iv90
        b = above.get(d)
        reg[d] = {"trend_down": c < run / 200,
                  "iv_high": None if iv30 is None else iv30 >= 20,
                  "term_inverted": None if iv30 is None or iv90 is None else iv30 > iv90,
                  "breadth_weak": None if not b or b[1] < 50 else b[0] / b[1] < 0.40}
    return reg


def tag(reg, days, d):
    i = bisect_right(days, d) - 1
    return reg[days[i]] if i >= 0 and (d - days[i]).days <= 5 else None


def test(rows):
    """rows = (cluster month, date, in_regime, y). Effect = mean(y | in) − mean(y | out); month-cluster bootstrap; halves."""
    by = defaultdict(lambda: [[0.0, 0], [0.0, 0]])
    for m, _, f, y in rows:
        g = by[m][0 if f else 1]; g[0] += y; g[1] += 1
    months = sorted(by)
    def eff(ms):
        a = [sum(by[m][j][0] for m in ms) for j in (0, 1)]
        n = [sum(by[m][j][1] for m in ms) for j in (0, 1)]
        return (a[0] / n[0] if n[0] else float("nan")) - (a[1] / n[1] if n[1] else float("nan")), n
    e, n = eff(months)
    rng = random.Random(27)
    bs = [eff([rng.choice(months) for _ in months])[0] for _ in range(B)]
    bs = [x for x in bs if x == x]
    p = min(1.0, 2 * min(sum(x <= 0 for x in bs), sum(x >= 0 for x in bs)) / max(len(bs), 1))
    h = len(months) // 2
    h1, h2 = eff(months[:h])[0], eff(months[h:])[0]
    base_in = sum(by[m][0][0] for m in months) / max(n[0], 1)
    base_out = sum(by[m][1][0] for m in months) / max(n[1], 1)
    return {"eff": e, "p": p, "h1": h1, "h2": h2, "n_in": n[0], "n_out": n[1], "in": base_in, "out": base_out, "months": len(months)}


def main():
    conn = connect()
    px = load_px(conn)
    reg = regime_table(px)
    days = sorted(reg)
    tests = {}
    # S003 puts
    s003 = list(csv.DictReader(open(HERE.parent / "out/step4/trades.csv")))
    for rname in REGIMES:
        for oname, f in (("S003 kept rate", lambda r: float(r["assigned"] != "True")), ("S003 risk-adj return", lambda r: float(r["ret_ra"]))):
            rows = []
            for r in s003:
                d = date.fromisoformat(r["entry"]); g = tag(reg, days, d)
                if not g or g[rname] is None or r["ret_ra"] in ("", "nan"):
                    continue
                rows.append((d.strftime("%Y-%m"), d, g[rname], f(r)))
            tests[(rname, oname)] = test(rows)
    # universe 20d forward returns, weekly (Fridays)
    fwd = []
    for t, (ds, cs, _, _) in px.items():
        if t == "SPY":
            continue
        for i in range(0, len(ds) - 20):
            if ds[i].weekday() != 4:
                continue
            g = reg.get(ds[i])
            if g:
                fwd.append((ds[i], g, cs[i + 20] / cs[i] - 1))
    for rname in REGIMES:
        rows = [(d.strftime("%Y-%m"), d, g[rname], y) for d, g, y in fwd if g[rname] is not None]
        tests[(rname, "20d return")] = test(rows)
        rows = [(d.strftime("%Y-%m"), d, g[rname], float(y <= -0.10)) for d, g, y in fwd if g[rname] is not None]
        tests[(rname, "P(20d ≤ −10%)")] = test(rows)
    # Holm
    order = sorted(tests, key=lambda k: tests[k]["p"])
    m = len(order)
    for i, k in enumerate(order):
        tests[k]["holm"] = min(1.0, max(tests[o]["p"] * (m - j) for j, o in enumerate(order[: i + 1])))
        x = tests[k]
        x["pass"] = x["holm"] < 0.05 and x["h1"] * x["h2"] > 0 and x["h1"] * x["eff"] > 0
    # trader's puts, descriptive
    import opt_replay as o
    hs = o.half_spreads(conn)
    ents, bars, und = o.load(conn)
    desc = defaultdict(lambda: [0, 0, 0.0, 0.0])
    for e in ents:
        x = o.replay(e, "hold", bars, und, hs, 0.0)
        g = tag(reg, days, e.d0)
        if not x or not g:
            continue
        for rname in REGIMES:
            if g[rname] is None:
                continue
            a = desc[(rname, g[rname])]
            a[0] += 1; a[1] += x["pnl"] < 0; a[2] += x["pnl"]; a[3] += o.cw(e)
    cover = {r: sum(1 for d in days if reg[d][r]) / max(sum(1 for d in days if reg[d][r] is not None), 1) for r in REGIMES}
    fmt = lambda v, pct: f"{v * 100:+.1f} pp" if pct else f"{v * 100:+.2f} %"  # noqa: E731
    out = [f"# S027 — regime matching (A120 track 6, {date.today()})\n",
           f"Regime days {days[0]} → {days[-1]} (SPY data from 2018-10; 200-day needs 200 days). Share of days in each regime: "
           + ", ".join(f"{r} {cover[r]:.0%}" for r in REGIMES) + ".",
           "Deviations (disclosed, decided before reading effects): term_inverted untestable (SPY 90-day IV has no rows) → 12 tests, not 16; "
           "'kept rate' = share of S003 puts expiring worthless (the csv 'kept' column is P&L ÷ premium, tail-dominated).",
           f"S003 puts tagged: {len(s003)} rows (premiums ~25 % low per S021 → return levels conservative). Universe: {len({t for t in px}) - 1} names, weekly 20-day returns.\n",
           "| Regime | Outcome | In regime | Otherwise | Effect | Holm p | Halves | Pass |", "|---|---|---|---|---|---|---|---|"]
    for k in sorted(tests):
        x = tests[k]; pct = k[1] != "S003 risk-adj return" and k[1] != "20d return"
        show = (lambda v: f"{v:.1%}") if pct else (lambda v: f"{v:+.3f}" if k[1] == "S003 risk-adj return" else f"{v:+.2%}")
        effs = f"{x['eff'] * 100:+.1f} pp" if pct else (f"{x['eff']:+.3f}" if k[1] == "S003 risk-adj return" else f"{x['eff'] * 100:+.2f} pp")
        out.append(f"| {k[0]} | {k[1]} | {show(x['in'])} (n {x['n_in']}) | {show(x['out'])} (n {x['n_out']}) | {effs} | {x['holm']:.3f} | "
                   f"{x['h1']:+.3g} / {x['h2']:+.3g} | {'**PASS**' if x['pass'] else 'no'} |")
    out.append("\nYour puts by regime (descriptive; 36 expiry weeks):\n\n| Regime | State | Puts | Lost money | $ per $10k-week |\n|---|---|---|---|---|")
    for (r, st), a in sorted(desc.items()):
        out.append(f"| {r} | {'yes' if st else 'no'} | {a[0]} | {a[1] / a[0]:.0%} | {a[2] / max(a[3], 1e-9):+.0f} |")
    passed = [k for k in tests if tests[k]["pass"]]
    out.append("\nPassed: " + ("; ".join(f"{k[0]} → {k[1]}" for k in passed) if passed else "none") + ".")
    (HERE.parent / "out/opt").mkdir(parents=True, exist_ok=True)
    (HERE.parent / "out/opt/S027.md").write_text("\n".join(out) + "\n")
    print("\n".join(out))
    json.dump({f"{k[0]}|{k[1]}": v for k, v in tests.items()}, open(HERE.parent / "out/opt/S027.json", "w"), default=str, indent=1)


if __name__ == "__main__":
    main()
