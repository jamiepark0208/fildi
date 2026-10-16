"""
S032 (A120 T6c) — post-earnings drift. Pre-registered in research/studies/INDEX.md (10-15) before running.

True report dates = lseg_research.earnings_moves (A114: LSEG first). Surprise = earnings_calendar.surprise_pct, matched to the first LSEG
report date in (calendar date − 3 d, calendar date + 75 d] (calendar dates are often fiscal period ends). Groups: positive ≥ +5 %,
negative ≤ −5 %, in-line. Drift = close on trading day 30 ÷ close on trading day 2 after the report − 1, minus the stock's mean 28-day
return in that half. Puts: S003 reconstructed puts (out/step4/trades.csv; premiums ~25 % low per S021) entered 2–30 trading days after a
positive / negative report vs no report in the prior 30 trading days. 7 tests, Holm, week-cluster bootstrap. Pass: Holm p < 0.05, same
sign both halves, |drift| ≥ 1 pp / |kept| ≥ 3 pp (no magnitude bar was declared for ret_ra). Trader puts descriptive only.
"""
from __future__ import annotations

import csv
import sys
from bisect import bisect_left, bisect_right
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402
from s025_reversals import series  # noqa: E402
from s030_streaks import boot_diff, boot_mean, holm_pass, upsert  # noqa: E402


def main():
    conn = connect()
    px = series(conn)
    lseg = defaultdict(list)
    for t, d in conn.execute("SELECT DISTINCT ticker, report_date FROM lseg_research.earnings_moves").fetchall(): lseg[t].append(d)
    for t in lseg: lseg[t].sort()
    rep = {}  # (ticker, lseg date) → (surprise, |cal − lseg| days)
    for t, cd, s in conn.execute("""SELECT UPPER(ticker), report_date::date, surprise_pct::float8 FROM earnings_calendar
                                    WHERE surprise_pct IS NOT NULL AND eps_actual IS NOT NULL""").fetchall():
        L = lseg.get(t, []); j = bisect_right(L, cd - timedelta(days=3))
        if j < len(L) and L[j] <= cd + timedelta(days=75):
            gap = abs((L[j] - cd).days)
            if (t, L[j]) not in rep or gap < rep[(t, L[j])][1]: rep[(t, L[j])] = (s, gap)
    grp = lambda s: "pos" if s >= 5 else "neg" if s <= -5 else "inline"
    # drift events
    ev, mean28 = [], {}
    for (t, R), (s, _) in rep.items():
        if t not in px: continue
        d, c, _ = px[t]; p = bisect_left(d, R)
        if p + 30 >= len(c): continue
        ev.append({"t": t, "d": R, "g": grp(s), "f": c[p + 30] / c[p + 2] - 1, "wk": R.isocalendar()[:2]})
    dates = sorted(e["d"] for e in ev); mid = dates[len(dates) // 2]
    for e in ev:
        key = (e["t"], e["d"] >= mid)
        if key not in mean28:
            d, c, _ = px[e["t"]]; n = len(c); f = c[28:] / c[: n - 28] - 1
            m = np.array([(x >= mid) == key[1] for x in d[: n - 28]]); mean28[key] = f[m].mean()
        e["x"] = e["f"] - mean28[key]; e["half"] = int(e["d"] >= mid)

    # puts: classify by the latest LSEG report 2..30 trading days before entry
    def tag(t, entry):
        if t not in px or t not in lseg: return None
        d = px[t][0]; i = bisect_left(d, entry)
        if i >= len(d) or i < 31: return None
        L = lseg[t]
        if bisect_right(L, d[i]) > bisect_right(L, d[i - 2]): return "skip"  # report 0–1 trading days before entry
        k = bisect_right(L, d[i - 2]) - 1  # latest report on/before trading day −2
        if k >= 0 and L[k] > d[i - 30]:
            s = rep.get((t, L[k]))
            return grp(s[0]) if s else "unknown"
        return "none"
    puts = []
    with open(HERE.parent / "out/step4/trades.csv") as fh:
        for r in csv.DictReader(fh):
            ed = date.fromisoformat(r["entry"][:10]); g = tag(r["ticker"], ed)
            if g in ("pos", "neg", "none"):
                puts.append({"g": g, "d": ed, "wk": ed.isocalendar()[:2], "kept": float(r["assigned"] != "True"), "ra": float(r["ret_ra"])})
    pmid = sorted(p["d"] for p in puts)[len(puts) // 2]
    for p in puts: p["half"] = int(p["d"] >= pmid)

    tests = []
    for g, lab in (("pos", "positive surprise · drift d2→d30"), ("neg", "negative surprise · drift d2→d30")):
        rows = [e for e in ev if e["g"] == g]; est, p = boot_mean(rows, "x")
        tests.append({"name": lab, "est": est, "p": p, "thr": 0.01, "n": len(rows),
                      "halves": [boot_mean([r for r in rows if r["half"] == h], "x")[0] for h in (0, 1)]})
    P, Ng = [e for e in ev if e["g"] == "pos"], [e for e in ev if e["g"] == "neg"]
    r = boot_diff(P, Ng, "x")
    tests.append({"name": "positive − negative · drift", "est": r[0], "p": r[1], "thr": 0.01,
                  "halves": [(boot_diff([x for x in P if x["half"] == h], [x for x in Ng if x["half"] == h], "x", 10) or (np.nan,))[0] for h in (0, 1)]})
    none = [p for p in puts if p["g"] == "none"]
    for g in ("pos", "neg"):
        a = [p for p in puts if p["g"] == g]
        for key, thr, lab in (("kept", 0.03, "kept rate"), ("ra", 0.0, "risk-adj return")):
            r = boot_diff(a, none, key)
            tests.append({"name": f"puts after {g} surprise − no recent report · {lab}", "est": r[0] if r else np.nan, "p": r[1] if r else 1.0,
                          "thr": thr, "n": (len(a), len(none)),
                          "halves": [(boot_diff([x for x in a if x["half"] == h], [x for x in none if x["half"] == h], key, 10) or (np.nan,))[0] for h in (0, 1)]})
    passed = holm_pass(tests)

    # trader puts (descriptive)
    tr = defaultdict(list)
    mp = HERE.parent / "out/mistakes/trades.csv"
    if mp.exists():
        with open(mp) as fh:
            for r in csv.DictReader(fh):
                g = tag(r["ticker"], date.fromisoformat(r["d0"][:10]))
                if g in ("pos", "neg", "none", "inline"): tr[g].append((r["breach"] == "True", float(r["pnl"] or 0)))

    out = [f"# S032 — post-earnings drift ({date.today()})\n",
           f"{len(rep)} reports with a surprise matched to a true LSEG date; {len(ev)} with 30 trading days after "
           f"({dates[0]} → {dates[-1]}, halves split at {mid}).\n",
           "| Surprise | n | raw d2→d30 | own mean 28d | excess |", "|---|---|---|---|---|"]
    for g in ("pos", "inline", "neg"):
        rows = [e for e in ev if e["g"] == g]
        out.append(f"| {g} | {len(rows)} | {np.mean([r['f'] for r in rows])*100:+.2f}% | {np.mean([r['f']-r['x'] for r in rows])*100:+.2f}% | "
                   f"{np.mean([r['x'] for r in rows])*100:+.2f} pp |")
    out += ["\n**S003 puts** (reconstructed; premiums ~25 % too cheap per S021 → levels conservative, differences still comparable)\n",
            "| Entered… | n | kept | risk-adj return |", "|---|---|---|---|"]
    for g, lab in (("pos", "2–30 d after positive surprise"), ("neg", "2–30 d after negative surprise"), ("none", "no report in prior 30 d")):
        rows = [p for p in puts if p["g"] == g]
        out.append(f"| {lab} | {len(rows)} | {np.mean([p['kept'] for p in rows]):.1%} | {np.mean([p['ra'] for p in rows]):+.3f} |")
    out += ["\n## Pre-registered tests (7, Holm, week-cluster bootstrap)", "| Test | Effect | halves | Holm p | pass |", "|---|---|---|---|---|"]
    for t_ in tests:
        u = 1 if "risk-adj" in t_["name"] else 100; sfx = "" if u == 1 else " pp"
        out.append(f"| {t_['name']} | {t_['est']*u:+.3g}{sfx} | {t_['halves'][0]*u:+.3g} / {t_['halves'][1]*u:+.3g} | {t_['holm']:.3f} | "
                   f"{'**PASS**' if t_['pass'] else 'no'} |")
    out += ["\n**Your puts** (descriptive, no test)\n", "| Opened… | n | breached | mean P&L |", "|---|---|---|---|"]
    for g in ("pos", "inline", "neg", "none"):
        x = tr.get(g, [])
        if x: out.append(f"| {g} | {len(x)} | {np.mean([b for b, _ in x]):.0%} | {np.mean([p for _, p in x]):+.3f} |")
    out.append("\nDrift starts at the close of trading day 2 after the LSEG report date, so the report-day jump and next-day "
               "follow-through are excluded. Surprise = EPS vs consensus from earnings_calendar (coverage mostly large caps). "
               "Puts tagged by the latest true report 2–30 trading days before entry; reports with no matched surprise are left out.")
    (HERE.parent / "out/opt/S032.md").write_text("\n".join(out) + "\n")
    head = (f"After a positive EPS surprise, days 2→30 run {tests[0]['est']*100:+.2f} pp vs the stock's normal; after a negative "
            f"{tests[1]['est']*100:+.2f} pp. " + (("Passing: " + "; ".join(t_["name"] for t_ in passed) + ".") if passed
                                                 else "Nothing passes: no tradable drift, and puts after beats did no better."))
    upsert(conn, "S032", "Drift after earnings surprises?", passed, head, tests)
    print("\n".join(out)); print("→", head)


if __name__ == "__main__":
    main()
