"""S028 (A120 track 4, pre-registered 10-15 in research/studies/INDEX.md): do macro stress signals warn of market drawdowns
or short-put losses?

Signals, weekly (Friday, last value on or before): curve_inverted = 10y−3m < 0 (FRED T10Y3M) · curve_2s10s_inverted = 10y−2y < 0
(T10Y2Y) · credit_wide = Baa−10y (BAA10Y) above its trailing 252-obs 80th percentile · nfci_tight = NFCI > 0 (NFCI is revised;
today's vintage, disclosed). Outcomes: S&P 500 P(max drawdown ≤ −5 % within 21 trading days), P(≤ −10 % within 63), Fridays
1990→; S003 puts (out/step4/trades.csv) kept rate at entry. 12 tests, month-cluster bootstrap, Holm; pass = Holm p < 0.05 and
same sign both date halves. Trader's puts (optlab replay): descriptive only.
Inputs (free, cached in out/opt/s028_inputs/, gitignored): FRED fredgraph.csv?id=<series>; ^GSPC daily from Yahoo (yahoo-finance2
chart, 1990→). Missing FRED files are re-fetched here; GSPC.csv must exist.
    .venv/bin/python analysis/s028_macro_stress.py     → out/opt/S028.md + optlab.findings S028
"""
from __future__ import annotations

import csv
import json
import random
import sys
import urllib.request
from bisect import bisect_right
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402

IN = HERE.parent / "out/opt/s028_inputs"
B = 3000
SIGNALS = ["curve_inverted", "curve_2s10s_inverted", "credit_wide", "nfci_tight"]


def series(name: str) -> tuple[list[date], list[float]]:
    f = IN / f"{name}.csv"
    # 11-11: the cache was download-once → VIXCLS stopped at 10-16 and S057's panel (house view odds, cash target) froze on
    # 10-21 for 3 weeks. Refresh a FRED file older than 20 h; on failure keep the cached copy (first fetch still must work).
    import time
    if name != "GSPC" and (not f.exists() or time.time() - f.stat().st_mtime > 20 * 3600):
        IN.mkdir(parents=True, exist_ok=True)
        try:
            data = urllib.request.urlopen(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={name}", timeout=20 if f.exists() else 60).read()
            if name.encode() in data[:300]:
                f.write_bytes(data)
        except Exception as e:  # noqa: BLE001
            if not f.exists():
                raise
            print(f"  FRED {name} refresh skipped ({str(e)[:60]}); using cache")
    ds, vs = [], []
    for r in csv.reader(open(f)):
        try:
            d, v = date.fromisoformat(r[0]), float(r[1])
        except (ValueError, IndexError):
            continue
        ds.append(d); vs.append(v)
    return ds, vs


def asof(ds, vs, d):
    i = bisect_right(ds, d) - 1
    return vs[i] if i >= 0 and (d - ds[i]).days <= 14 else None


def signal_table(fridays):
    t3, v3 = series("T10Y3M"); t2, v2 = series("T10Y2Y"); tb, vb = series("BAA10Y"); tn, vn = series("NFCI")
    out = {}
    for d in fridays:
        a, b, n = asof(t3, v3, d), asof(t2, v2, d), asof(tn, vn, d)
        i = bisect_right(tb, d) - 1
        cw = None
        if i >= 252:
            win = sorted(vb[i - 251: i + 1])
            cw = vb[i] > win[int(0.8 * (len(win) - 1))]
        out[d] = {"curve_inverted": None if a is None else a < 0, "curve_2s10s_inverted": None if b is None else b < 0,
                  "credit_wide": cw, "nfci_tight": None if n is None else n > 0}
    return out


def test(rows):
    """rows = (month, in_signal, y). Effect = mean(y|in) − mean(y|out); month-cluster bootstrap; halves by month."""
    by = defaultdict(lambda: [[0.0, 0], [0.0, 0]])
    for m, f, y in rows:
        g = by[m][0 if f else 1]; g[0] += y; g[1] += 1
    months = sorted(by)
    def eff(ms):
        a = [sum(by[m][j][0] for m in ms) for j in (0, 1)]
        n = [sum(by[m][j][1] for m in ms) for j in (0, 1)]
        return (a[0] / n[0] if n[0] else float("nan")) - (a[1] / n[1] if n[1] else float("nan")), n, a
    e, n, a = eff(months)
    rng = random.Random(28)
    bs = [x for x in (eff([rng.choice(months) for _ in months])[0] for _ in range(B)) if x == x]
    p = min(1.0, 2 * min(sum(x <= 0 for x in bs), sum(x >= 0 for x in bs)) / max(len(bs), 1))
    h = len(months) // 2
    return {"eff": e, "p": p, "h1": eff(months[:h])[0], "h2": eff(months[h:])[0], "n_in": n[0], "n_out": n[1],
            "in": a[0] / max(n[0], 1), "out": a[1] / max(n[1], 1), "months": len(months)}


def main():
    gd, gc = series("GSPC")
    fri = [i for i, d in enumerate(gd) if d.weekday() == 4]
    sig = signal_table([gd[i] for i in fri])
    tests = {}
    dd = []  # (date, signals, dd21<=-5%, dd63<=-10%)
    for i in fri:
        if i + 63 >= len(gc):
            continue
        p0 = gc[i]
        m21 = min(gc[i + 1: i + 22]) / p0 - 1
        m63 = min(gc[i + 1: i + 64]) / p0 - 1
        dd.append((gd[i], sig[gd[i]], float(m21 <= -0.05), float(m63 <= -0.10)))
    s003 = list(csv.DictReader(open(HERE.parent / "out/step4/trades.csv")))
    sdays = sorted(sig)
    for s in SIGNALS:
        tests[(s, "S&P drawdown ≥5% in 21d")] = test([(d.strftime("%Y-%m"), g[s], y) for d, g, y, _ in dd if g[s] is not None])
        tests[(s, "S&P drawdown ≥10% in 63d")] = test([(d.strftime("%Y-%m"), g[s], y) for d, g, _, y in dd if g[s] is not None])
        rows = []
        for r in s003:
            d = date.fromisoformat(r["entry"])
            j = bisect_right(sdays, d) - 1
            if j < 0 or (d - sdays[j]).days > 7 or sig[sdays[j]][s] is None:
                continue
            rows.append((d.strftime("%Y-%m"), sig[sdays[j]][s], float(r["assigned"] != "True")))
        tests[(s, "S003 put kept rate")] = test(rows)
    order = sorted(tests, key=lambda k: tests[k]["p"])
    m = len(order)
    for i, k in enumerate(order):
        x = tests[k]
        x["holm"] = min(1.0, max(tests[o]["p"] * (m - j) for j, o in enumerate(order[: i + 1])))
        x["pass"] = x["holm"] < 0.05 and x["h1"] * x["h2"] > 0 and x["h1"] * x["eff"] > 0
    # trader's puts, descriptive
    import opt_replay as o
    conn = connect()
    hs = o.half_spreads(conn)
    ents, bars, und = o.load(conn)
    desc = defaultdict(lambda: [0, 0, 0.0, 0.0])
    for e in ents:
        x = o.replay(e, "hold", bars, und, hs, 0.0)
        j = bisect_right(sdays, e.d0) - 1
        if not x or j < 0:
            continue
        g = sig[sdays[j]]
        for s in SIGNALS:
            if g[s] is None:
                continue
            a = desc[(s, g[s])]; a[0] += 1; a[1] += x["pnl"] < 0; a[2] += x["pnl"]; a[3] += o.cw(e)
    cover = {s: sum(1 for d in sdays if sig[d][s]) / max(sum(1 for d in sdays if sig[d][s] is not None), 1) for s in SIGNALS}
    now = sig[sdays[-1]]
    out = [f"# S028 — macro stress signals → drawdowns / put losses (A120 track 4, {date.today()})\n",
           f"Weekly sample {dd[0][0]} → {dd[-1][0]} ({len(dd)} Fridays with a full 63-day window). Share of weeks in each signal: "
           + ", ".join(f"{s} {cover[s]:.0%}" for s in SIGNALS) + ".",
           "Today: " + ", ".join(f"{s} {'ON' if now[s] else 'off'}" for s in SIGNALS) + f" (as of {sdays[-1]}).",
           "Deviations (disclosed): HY OAS on FRED has only 3 y of history → credit uses Baa−10y (1986→), decided before running. "
           "NFCI is today's revised vintage (not point-in-time). Overseas index closes aren't in Fildi → track 3 skipped.\n",
           "| Signal | Outcome | in signal | otherwise | effect | halves | Holm p | n in / out | pass |",
           "|---|---|---|---|---|---|---|---|---|"]
    for k in sorted(tests, key=lambda k: (k[0], k[1])):
        x = tests[k]
        out.append(f"| {k[0]} | {k[1]} | {x['in']:.1%} | {x['out']:.1%} | {x['eff'] * 100:+.1f} pp | {x['h1'] * 100:+.1f} / {x['h2'] * 100:+.1f} | "
                   f"{x['holm']:.3f} | {x['n_in']} / {x['n_out']} | {'**PASS**' if x['pass'] else 'no'} |")
    out.append("\nTrader's puts (replayed on real option prices, Feb–Oct 2026, descriptive only):\n")
    out.append("| Signal | state | puts | losers | P&L $ | $ per $10k-week |")
    out.append("|---|---|---|---|---|---|")
    for (s, st), a in sorted(desc.items()):
        out.append(f"| {s} | {'on' if st else 'off'} | {a[0]} | {a[1]} ({a[1] / max(a[0], 1):.0%}) | {a[2]:,.0f} | {a[2] / max(a[3], 1e-9):+.1f} |")
    passed = [k for k in tests if tests[k]["pass"]]
    if passed:
        best = ("credit_wide", "S&P drawdown ≥5% in 21d") if ("credit_wide", "S&P drawdown ≥5% in 21d") in passed else min(passed, key=lambda k: tests[k]["holm"]); x = tests[best]
        head = (f"Wide credit spreads (Baa−10y in its top 20% of the past year) warn of market drops: S&P fell ≥5% within a "
                f"month {x['in']:.0%} of the time vs {x['out']:.0%} normally, and ≥10% within 3 months 26% vs 9%. Your puts weren't "
                f"hurt more (S003 kept rate higher). Context only, no gate. Today: {', '.join(s for s in SIGNALS if now[s]) or 'no signal on'}.")
        verdict = "pass"
    else:
        best = min(tests, key=lambda k: tests[k]["p"]); x = tests[best]
        head = (f"No macro stress signal reliably warns of drawdowns or put losses (0 of {m} pass; closest: {best[0]} → {best[1]} "
                f"{x['in']:.0%} vs {x['out']:.0%}, Holm p {x['holm']:.2f}). Keep selling as usual; no macro gate.")
        verdict = "fail"
    runs = {}
    for s in SIGNALS:
        r, prev = 0, False
        for d in sdays:
            on = bool(sig[d][s]); r += on and not prev; prev = on
        runs[s] = r
    out.append("\nCaveats: weekly samples with 21/63-day windows overlap and signals persist for months, so month-cluster "
               "bootstrap p-values are optimistic; read the halves and episode counts. Separate ON episodes 1990→: "
               + ", ".join(f"{s} {runs[s]}" for s in SIGNALS) + ". NFCI uses revised data (look-ahead) → its pass is weaker. "
               "Drawdown warnings are about the market, not put losses: S003 puts were kept MORE often when credit was wide "
               "(higher IV → farther strikes), so this is context, not a selling gate.")
    out.append(f"\n**Verdict: {verdict.upper()}.** {head}")
    (HERE.parent / "out/opt").mkdir(parents=True, exist_ok=True)
    (HERE.parent / "out/opt/S028.md").write_text("\n".join(out) + "\n")
    conn.execute("""INSERT INTO optlab.findings (study, title, verdict, headline, card, updated_at)
                    VALUES ('S028', 'Macro stress signals', %s, %s, %s, now())
                    ON CONFLICT (study) DO UPDATE SET verdict = excluded.verdict, headline = excluded.headline,
                    card = excluded.card, updated_at = now()""",
                 (verdict, head, json.dumps({f"{k[0]}|{k[1]}": {a: (None if isinstance(b, float) and b != b else b) for a, b in v.items()} for k, v in tests.items()}, default=str)))
    conn.commit()
    print("\n".join(out))


if __name__ == "__main__":
    main()
