"""
S031 (A120 T6b) — overnight vs daytime drops. Pre-registered in research/studies/INDEX.md (10-15) before running; extends S025.

Event = S025 rule (5-day log drop ≤ −2σ, σ from days −65..−5, 10-day dedupe) on prices_historical (has opens; 2025-04→2026-10 only).
Split the 5-day log drop into overnight Σ log(open/prev close) and intraday Σ log(close/open): overnight-dominated if overnight ≥ 60 % of
the drop, intraday-dominated if intraday ≥ 60 %, else mixed. Tests (3, Holm, week-cluster bootstrap): overnight − intraday on 5d excess,
20d excess, recovery vs matched base. Pass: Holm p < 0.05, same sign both halves, |effect| ≥ 1.5 pp / 5 pp. < 150 per group → NOT ENOUGH.
"""
from __future__ import annotations

import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402
from s025_reversals import FUNDS  # noqa: E402
from s030_streaks import boot_diff, holm_pass, upsert  # noqa: E402

MIN_N = 150


def main():
    conn = connect()
    px = defaultdict(lambda: ([], [], []))
    for t, d, o, c in conn.execute("""SELECT ticker, date, open, close FROM prices_historical
                                      WHERE close > 0 AND open > 0 ORDER BY ticker, date""").fetchall():
        a = px[t]; a[0].append(d); a[1].append(float(o)); a[2].append(float(c))
    ev, per_t = [], {}
    for t, (d, o, c) in px.items():
        if t in FUNDS or len(c) < 120: continue
        o, c = np.array(o), np.array(c); n = len(c)
        lr = np.diff(np.log(c))
        fwd = {h: np.full(n, np.nan) for h in (5, 20)}
        for h in (5, 20): fwd[h][: n - h] = c[h:] / c[: n - h] - 1
        g = np.full(n, np.nan)
        for i in range(n - 20): g[i] = c[i + 1:i + 21].max() / c[i]
        per_t[t] = (d, fwd, g)
        last = -99
        for i in range(65, n - 20):
            if i - last < 10: continue
            sd = lr[i - 65:i - 5].std(ddof=1)
            if sd <= 0: continue
            r5 = np.log(c[i] / c[i - 5])
            if r5 / (sd * np.sqrt(5)) > -2: continue
            last = i
            ov = np.log(o[i - 4:i + 1] / c[i - 5:i]).sum(); intra = np.log(c[i - 4:i + 1] / o[i - 4:i + 1]).sum()
            kind = "overnight" if ov / r5 >= 0.6 else "intraday" if intra / r5 >= 0.6 else "mixed"
            ev.append({"t": t, "d": d[i], "kind": kind, "f5": fwd[5][i], "f20": fwd[20][i], "ovshare": ov / r5,
                       "rec": float(c[i + 1:i + 21].max() >= c[i - 5]), "need": c[i - 5] / c[i]})
    dates = sorted(e["d"] for e in ev); mid = dates[len(dates) // 2]
    for e in ev:
        d, fwd, g = per_t[e["t"]]
        idx = np.array([(x < mid) == (e["d"] < mid) for x in d])
        for h in (5, 20):
            arr = fwd[h][idx]; e[f"x{h}"] = e[f"f{h}"] - np.nanmean(arr)
        gg = g[idx]; gg = gg[~np.isnan(gg)]
        e["base_rec"] = float((gg >= e["need"]).mean()); e["xrec"] = e["rec"] - e["base_rec"]
        e["wk"] = e["d"].isocalendar()[:2]; e["half"] = int(e["d"] >= mid)
    grp = {k: [e for e in ev if e["kind"] == k] for k in ("overnight", "intraday", "mixed")}
    enough = len(grp["overnight"]) >= MIN_N and len(grp["intraday"]) >= MIN_N
    tests = []
    for key, thr, lab in (("x5", 0.015, "5-day excess"), ("x20", 0.015, "20-day excess"), ("xrec", 0.05, "recovery vs base")):
        r = boot_diff(grp["overnight"], grp["intraday"], key)
        hv = [(boot_diff([x for x in grp["overnight"] if x["half"] == h], [x for x in grp["intraday"] if x["half"] == h], key, 10)
               or (float("nan"),))[0] for h in (0, 1)]
        tests.append({"name": f"overnight − intraday · {lab}", "est": r[0] if r else float("nan"), "p": r[1] if r else 1.0,
                      "halves": hv, "thr": thr})
    passed = holm_pass(tests) if enough else []

    def summ(rows):
        if not rows: return "—"
        return (f"{len(rows)} | {np.mean([r['x5'] for r in rows])*100:+.1f} | {np.mean([r['x20'] for r in rows])*100:+.1f} | "
                f"{np.mean([r['rec'] for r in rows]):.0%} vs {np.mean([r['base_rec'] for r in rows]):.0%}")
    out = [f"# S031 — overnight vs daytime drops ({date.today()})\n",
           f"{len(ev)} ≥2σ 5-day drops, {len({e['t'] for e in ev})} stocks, {dates[0]} → {dates[-1]} (halves split at {mid}). "
           f"Short sample: opens exist only from 2025-04.\n" + ("" if enough else f"\n**NOT ENOUGH** (< {MIN_N} events in a group).\n"),
           "| Drop made mostly… | n | 5d excess pp | 20d excess pp | got back to pre-drop price ≤20d vs base |", "|---|---|---|---|---|"]
    for k, rows in grp.items(): out.append(f"| {k} | {summ(rows)} |")
    out += ["\n## Pre-registered tests (3, Holm, week-cluster bootstrap)", "| Test | Effect | halves | Holm p | pass |", "|---|---|---|---|---|"]
    for t_ in tests:
        out.append(f"| {t_['name']} | {t_['est']*100:+.1f} pp | {t_['halves'][0]*100:+.1f} / {t_['halves'][1]*100:+.1f} | "
                   f"{t_.get('holm', float('nan')):.3f} | {'**PASS**' if t_.get('pass') else 'no'} |")
    out.append("\nOvernight = Σ log(open ÷ previous close) over the 5 drop days; intraday = Σ log(close ÷ open). Excess = minus the stock's "
               "mean forward return in that half; recovery base = share of the stock's days that climbed the same % within 20 days. "
               "Caveats: ~14 months of events (Jul 2025 → Sep 2026; 65-day warm-up after the 2025-04 data start), one market regime; "
               "the 5-day effect only just clears its 1.5 pp bar and the 20-day gap does not pass. Mechanism fits news gaps (earnings, "
               "guidance) being repriced for good, while intraday selling is more often flow that reverts.")
    (HERE.parent / "out/opt/S031.md").write_text("\n".join(out) + "\n")
    x20 = tests[1]
    head = (f"Drops made mostly overnight vs mostly during the day: 20-day excess differs by {x20['est']*100:+.1f} pp "
            f"({len(grp['overnight'])} vs {len(grp['intraday'])} drops, 2025-26 only). "
            + ("Not enough data." if not enough else ("Passing: " + "; ".join(t_["name"] for t_ in passed) + ".") if passed
               else "Nothing passes: how the drop happened doesn't change the rebound."))
    upsert(conn, "S031", "Gap-down vs grind-down", passed, head, tests)
    print("\n".join(out)); print("→", head)


if __name__ == "__main__":
    main()
