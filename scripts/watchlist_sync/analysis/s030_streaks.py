"""
S030 (A120 T6a) — streak base rates. Pre-registered in research/studies/INDEX.md (10-15) before running.

Event = the day a run of consecutive down (or up) closes first reaches N: down3 / down4 / down5+ and up3 / up4 / up5+ (5+ counted once,
at 5). Data lseg_research.daily_history (2016-09→2026-10, funds excluded). Outcomes: 5-day excess return vs the stock's mean 5-day return
in that half; next-day P(up) minus the stock's own P(up) in that half. 12 tests, Holm, week-cluster bootstrap. Pass: Holm p < 0.05,
same sign in both halves (median event date), |5d excess| ≥ 0.5 pp or |ΔP(up)| ≥ 3 pp. The helpers below are reused by S031/S032.
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402
from s025_reversals import FUNDS, clean, series  # noqa: E402

B = 3000
rng = np.random.default_rng(30)


def boot_mean(rows, key):
    """Week-cluster bootstrap of the mean of rows[key]; two-sided p vs 0."""
    wk = defaultdict(list)
    for r in rows: wk[r["wk"]].append(r[key])
    if not wk: return float("nan"), 1.0
    ks = list(wk); sums = np.array([sum(wk[k]) for k in ks]); cnt = np.array([len(wk[k]) for k in ks])
    idx = rng.integers(0, len(ks), (B, len(ks)))
    bs = sums[idx].sum(1) / cnt[idx].sum(1)
    return sums.sum() / cnt.sum(), 2 * min((bs <= 0).mean(), (bs >= 0).mean())


def boot_diff(a, b, key, min_n=30):
    """Week-cluster bootstrap of mean(a[key]) − mean(b[key]); None when either side < min_n."""
    if len(a) < min_n or len(b) < min_n: return None
    wk = defaultdict(lambda: [0.0, 0, 0.0, 0])
    for r in a: w = wk[r["wk"]]; w[0] += r[key]; w[1] += 1
    for r in b: w = wk[r["wk"]]; w[2] += r[key]; w[3] += 1
    M = np.array(list(wk.values()))
    est = M[:, 0].sum() / M[:, 1].sum() - M[:, 2].sum() / M[:, 3].sum()
    S = M[rng.integers(0, len(M), (B, len(M)))].sum(1)
    bs = S[:, 0] / np.maximum(S[:, 1], 1) - S[:, 2] / np.maximum(S[:, 3], 1)
    return est, 2 * min((bs <= 0).mean(), (bs >= 0).mean()), len(a), len(b)


def holm_pass(tests):
    order = sorted(range(len(tests)), key=lambda i: tests[i]["p"]); m = len(tests); run = 0.0
    for k, i in enumerate(order):
        run = max(run, min(1.0, tests[i]["p"] * (m - k))); tests[i]["holm"] = run
    for t_ in tests:
        same = all(np.sign(h) == np.sign(t_["est"]) for h in t_["halves"] if not np.isnan(h)) and not np.isnan(t_["est"])
        t_["pass"] = bool(t_["holm"] < 0.05 and same and abs(t_["est"]) >= t_["thr"])
    return [t_ for t_ in tests if t_["pass"]]


def upsert(conn, study, title, passed, head, tests):
    conn.execute("""INSERT INTO optlab.findings (study, title, verdict, headline, card, updated_at) VALUES (%s,%s,%s,%s,%s,now())
                    ON CONFLICT (study) DO UPDATE SET title=excluded.title, verdict=excluded.verdict, headline=excluded.headline,
                    card=excluded.card, updated_at=now()""",
                 (study, title, "pass" if passed else "fail", head, json.dumps(clean(tests), default=str)))
    conn.commit()


def main():
    conn = connect()
    px = series(conn)
    ev, per_t = [], {}
    for t, (d, c, _) in px.items():
        if t in FUNDS or len(c) < 300: continue
        n = len(c)
        r1 = np.full(n, np.nan); r1[1:] = c[1:] / c[:-1] - 1
        f5 = np.full(n, np.nan); f5[: n - 5] = c[5:] / c[: n - 5] - 1
        up1 = np.full(n, np.nan); up1[: n - 1] = (r1[1:] > 0).astype(float)
        per_t[t] = (d, f5, up1)
        dn = upn = 0
        for i in range(1, n - 5):
            dn = dn + 1 if r1[i] < 0 else 0
            upn = upn + 1 if r1[i] > 0 else 0
            for side, k in (("down", dn), ("up", upn)):
                if k in (3, 4, 5):
                    ev.append({"t": t, "d": d[i], "g": f"{side}{k if k < 5 else '5+'}", "f5": f5[i], "u": up1[i]})
    dates = sorted(e["d"] for e in ev); mid = dates[len(dates) // 2]
    base = {}
    for t, (d, f5, up1) in per_t.items():
        h = np.array([x >= mid for x in d])
        for hh in (0, 1):
            m = h == bool(hh)
            base[(t, hh)] = (np.nanmean(f5[m]) if m.any() else np.nan, np.nanmean(up1[m]) if m.any() else np.nan)
    for e in ev:
        e["half"] = int(e["d"] >= mid); b5, bu = base[(e["t"], e["half"])]
        e["x5"] = e["f5"] - b5; e["xu"] = e["u"] - bu; e["wk"] = e["d"].isocalendar()[:2]
    groups = ["down3", "down4", "down5+", "up3", "up4", "up5+"]
    tests = []
    for g in groups:
        rows = [e for e in ev if e["g"] == g]
        for key, thr, lab in (("x5", 0.005, "5-day excess"), ("xu", 0.03, "next-day P(up) vs own base")):
            est, p = boot_mean(rows, key)
            hv = [boot_mean([r for r in rows if r["half"] == h], key)[0] for h in (0, 1)]
            tests.append({"name": f"{g} · {lab}", "est": est, "p": p, "halves": hv, "thr": thr, "n": len(rows)})
    passed = holm_pass(tests)
    out = [f"# S030 — streak base rates ({date.today()})\n",
           f"{len(ev):,} streak events, {len(per_t)} stocks, {dates[0]} → {dates[-1]} (halves split at {mid}).\n",
           "| Streak | n | next-day P(up) | own base P(up) | 5-day return | own mean 5-day |", "|---|---|---|---|---|---|"]
    for g in groups:
        rows = [e for e in ev if e["g"] == g]
        out.append(f"| {g} | {len(rows):,} | {np.mean([r['u'] for r in rows]):.1%} | {np.mean([r['u'] - r['xu'] for r in rows]):.1%} | "
                   f"{np.mean([r['f5'] for r in rows])*100:+.2f}% | {np.mean([r['f5'] - r['x5'] for r in rows])*100:+.2f}% |")
    out += ["\n## Pre-registered tests (12, Holm, week-cluster bootstrap)", "| Test | Effect | halves | Holm p | pass |", "|---|---|---|---|---|"]
    for t_ in tests:
        out.append(f"| {t_['name']} | {t_['est']*100:+.2f} pp | {t_['halves'][0]*100:+.2f} / {t_['halves'][1]*100:+.2f} | {t_['holm']:.3f} | "
                   f"{'**PASS**' if t_['pass'] else 'no'} |")
    out.append("\nExcess = outcome minus the same stock's average over all its days in that half (5-day return; share of up days). "
               "A down5+ event is counted once, on the 5th down day. Overlapping 5-day windows within a week are handled by the week-cluster bootstrap.")
    (HERE.parent / "out/opt").mkdir(parents=True, exist_ok=True)
    (HERE.parent / "out/opt/S030.md").write_text("\n".join(out) + "\n")
    d5 = next(t_ for t_ in tests if t_["name"].startswith("down5+ · 5"))
    head = (f"After 5+ down days in a row the next 5 days are {d5['est']*100:+.2f} pp vs the stock's normal. "
            + (("Passing: " + "; ".join(f"{t_['name']} {t_['est']*100:+.2f} pp" for t_ in passed) + ".") if passed
               else "Nothing passes: streaks don't change the odds."))
    upsert(conn, "S030", "Losing streaks: due for a bounce?", passed, head, tests)
    print("\n".join(out)); print("→", head)


if __name__ == "__main__":
    main()
