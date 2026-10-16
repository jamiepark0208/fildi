"""S025 (Claude, pre-registered 2026-10-15 in research/studies/INDEX.md; A120 track 1): reversals after drops.

Event: 5-day log return z ≤ −2 (z = r5 ÷ (σ_60 · √5), σ_60 = stdev of the 60 daily log returns before the window); first crossing,
then no new event for that name for 10 trading days. Outcomes: forward 5/10/20-day return minus the stock's own mean forward
return over all days (excess; 20d primary); recovery = max close over the next 20 days ≥ the close 5 days before the event,
vs a matched base (same stock, same % climb needed, fraction of all its days that climbed that much within 20 days).
Family = pooled (2) + 7 conditions × 2 outcomes = 16 tests, Holm, week-cluster bootstrap. Pass: Holm p < 0.05, same sign in both
halves (median event date), |effect| ≥ 1.5 pp excess or ≥ 5 pp recovery.
    .venv/bin/python analysis/s025_reversals.py     # → out/opt/S025.md (+ optlab.findings S025)
"""
from __future__ import annotations

import json
import sys
from bisect import bisect_left
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402

ETF = {"technology": "XLK", "utilities": "XLU", "energy": "XLE", "real_estate": "XLRE", "fintech": "XLF", "financials": "XLF",
       "industrials": "XLI", "consumer_discretionary": "XLY", "healthcare": "XLV", "consumer_staples": "XLP", "materials": "XLB",
       "basic_materials": "XLB", "communication_services": "XLC", "communication": "XLC", "speculative_thematic": "IWM"}
FUNDS = {"SPY", "QQQ", "IWM", "SMH", "XLB", "XLC", "XLE", "XLF", "XLI", "XLK", "XLP", "XLRE", "XLU", "XLV", "XLY"}
B = 3000
rng = np.random.default_rng(25)


def series(conn):
    px = defaultdict(lambda: ([], [], []))
    for t, d, c, v in conn.execute("""SELECT ticker, date, close, volume FROM lseg_research.daily_history
                                      WHERE close > 0 ORDER BY ticker, date""").fetchall():
        a = px[t]; a[0].append(d); a[1].append(float(c)); a[2].append(float(v) if v else np.nan)
    return {t: (d, np.array(c), np.array(v)) for t, (d, c, v) in px.items()}


def clean(x):
    if isinstance(x, dict): return {k: clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)): return [clean(v) for v in x]
    if isinstance(x, (float, np.floating)): return None if np.isnan(x) else float(x)
    if isinstance(x, np.bool_): return bool(x)
    return x


def main():
    conn = connect()
    px = series(conn)
    sec = {t: g.split(".")[0] for t, g in conn.execute(
        "SELECT ticker, primary_peer_group_id FROM ticker_registry WHERE primary_peer_group_id IS NOT NULL").fetchall()}
    earn = defaultdict(list)
    for t, d in conn.execute("SELECT ticker, report_date FROM lseg_research.earnings_moves").fetchall():
        earn[t].append(d)
    for t in earn: earn[t].sort()
    spy_d, spy_c, _ = px["SPY"]
    spy_ma = {d: (spy_c[i] > spy_c[i - 199:i + 1].mean()) for i, d in enumerate(spy_d) if i >= 199}
    etf_r5 = {}
    for e in set(ETF.values()) | {"SPY"}:
        if e in px:
            d, c, _ = px[e]
            etf_r5[e] = {d[i]: c[i] / c[i - 5] - 1 for i in range(5, len(d))}
    ev = []          # one dict per event
    base_mean = {}   # (ticker, half) handled after median date known → keep per-ticker fwd arrays
    per_t = {}
    for t, (d, c, v) in px.items():
        if t in FUNDS or len(c) < 300:
            continue
        lr = np.diff(np.log(c))
        n = len(c)
        fwd = {h: np.full(n, np.nan) for h in (5, 10, 20)}
        for h in (5, 10, 20):
            fwd[h][: n - h] = c[h:] / c[: n - h] - 1
        g = np.full(n, np.nan)  # max close over next 20 days ÷ close (for matched recovery base)
        for i in range(n - 20):
            g[i] = c[i + 1:i + 21].max() / c[i]
        per_t[t] = (d, fwd, g)
        last = -99
        for i in range(65, n - 20):
            if i - last < 10:
                continue
            sd = lr[i - 65:i - 5].std(ddof=1)
            if sd <= 0:
                continue
            r5 = np.log(c[i] / c[i - 5])
            z = r5 / (sd * np.sqrt(5))
            if z > -2:
                continue
            last = i
            day = np.diff(np.log(c[i - 5:i + 1]))
            vol_ok = not np.isnan(v[i - 4:i + 1]).any() and i >= 55 and not np.isnan(v[i - 55:i - 5]).all()
            etf = ETF.get(sec.get(t, ""), "SPY")
            ref = c[i - 5]
            ev.append({
                "t": t, "d": d[i], "z": z, "f5": fwd[5][i], "f10": fwd[10][i], "f20": fwd[20][i],
                "rec": float(c[i + 1:i + 21].max() >= ref), "need": ref / c[i],
                "deep": z <= -3, "gap": day.min() <= 0.7 * r5,
                "volspike": (np.nanmean(v[i - 4:i + 1]) >= 2 * np.nanmean(v[i - 55:i - 5])) if vol_ok else None,
                "below200": (c[i] < c[i - 199:i + 1].mean()) if i >= 199 else None,
                "sector_down": (etf_r5.get(etf, {}).get(d[i], np.nan) <= -0.03) if d[i] in etf_r5.get(etf, {}) else None,
                "spy_below200": (not spy_ma[d[i]]) if d[i] in spy_ma else None,
                "earnings": any(d[i - 5] < x <= d[i] for x in earn.get(t, [])[max(0, bisect_left(earn.get(t, []), d[i - 5]) - 1):][:3]) if t in earn else None,
            })
    dates = sorted(e["d"] for e in ev)
    mid = dates[len(dates) // 2]
    # base rates per (ticker, half): unconditional mean forward return + matched recovery
    for e in ev:
        d, fwd, g = per_t[e["t"]]
        idx = np.array([(x < mid) == (e["d"] < mid) for x in d])
        for h in (5, 10, 20):
            arr = fwd[h][idx]; arr = arr[~np.isnan(arr)]
            e[f"x{h}"] = e[f"f{h}"] - arr.mean()
        gg = g[idx]; gg = gg[~np.isnan(gg)]
        e["base_rec"] = float((gg >= e["need"]).mean())
        e["xrec"] = e["rec"] - e["base_rec"]
        e["wk"] = e["d"].isocalendar()[:2]
        e["half"] = 0 if e["d"] < mid else 1

    def boot_mean(rows, key):
        wk = defaultdict(list)
        for r in rows: wk[r["wk"]].append(r[key])
        ks = list(wk); sums = np.array([sum(wk[k]) for k in ks]); cnt = np.array([len(wk[k]) for k in ks])
        est = sums.sum() / cnt.sum()
        idx = rng.integers(0, len(ks), (B, len(ks)))
        bs = sums[idx].sum(1) / cnt[idx].sum(1)
        p = 2 * min((bs <= 0).mean(), (bs >= 0).mean())
        return est, p

    def boot_diff(rows, cond, key):
        a = [r for r in rows if r[cond] is not None and bool(r[cond])]; b = [r for r in rows if r[cond] is not None and not bool(r[cond])]
        if len(a) < 30 or len(b) < 30:
            return None
        wk = defaultdict(lambda: [0.0, 0, 0.0, 0])
        for r in a: w = wk[r["wk"]]; w[0] += r[key]; w[1] += 1
        for r in b: w = wk[r["wk"]]; w[2] += r[key]; w[3] += 1
        ks = list(wk); M = np.array([wk[k] for k in ks])
        est = M[:, 0].sum() / M[:, 1].sum() - M[:, 2].sum() / M[:, 3].sum()
        idx = rng.integers(0, len(ks), (B, len(ks)))
        S = M[idx].sum(1)
        bs = S[:, 0] / np.maximum(S[:, 1], 1) - S[:, 2] / np.maximum(S[:, 3], 1)
        p = 2 * min((bs <= 0).mean(), (bs >= 0).mean())
        return est, p, len(a), len(b)

    tests = []
    for key, thr, lab in (("x20", 0.015, "20-day excess return"), ("xrec", 0.05, "recovery vs matched base")):
        est, p = boot_mean(ev, key)
        hv = [boot_mean([r for r in ev if r["half"] == h], key)[0] for h in (0, 1)]
        tests.append({"name": f"all drops · {lab}", "est": est, "p": p, "halves": hv, "thr": thr})
    for cond in ("deep", "gap", "volspike", "below200", "sector_down", "spy_below200", "earnings"):
        for key, thr, lab in (("x20", 0.015, "20-day excess"), ("xrec", 0.05, "recovery")):
            r = boot_diff(ev, cond, key)
            if not r:
                tests.append({"name": f"{cond} · {lab}", "est": float("nan"), "p": 1.0, "halves": [float("nan")] * 2, "thr": thr, "n": (0, 0)}); continue
            hv = [(boot_diff([x for x in ev if x["half"] == h], cond, key) or (float("nan"),))[0] for h in (0, 1)]
            tests.append({"name": f"{cond} · {lab}", "est": r[0], "p": r[1], "halves": hv, "thr": thr, "n": (r[2], r[3])})
    order = sorted(range(len(tests)), key=lambda i: tests[i]["p"])
    m = len(tests); run = 0.0
    for k, i in enumerate(order):
        run = max(run, min(1.0, tests[i]["p"] * (m - k))); tests[i]["holm"] = run
    for t_ in tests:
        same = all(np.sign(h) == np.sign(t_["est"]) for h in t_["halves"] if not np.isnan(h))
        t_["pass"] = t_["holm"] < 0.05 and same and abs(t_["est"]) >= t_["thr"]

    # descriptive table: conditional rates next to base rates
    def summ(rows):
        if not rows: return "—"
        return (f"n {len(rows)} · 5d {np.mean([r['x5'] for r in rows])*100:+.1f} · 10d {np.mean([r['x10'] for r in rows])*100:+.1f} · "
                f"20d {np.mean([r['x20'] for r in rows])*100:+.1f} pp excess · recovered {np.mean([r['rec'] for r in rows]):.0%} vs base "
                f"{np.mean([r['base_rec'] for r in rows]):.0%}")
    out = [f"# S025 — reversals after ≥ 2σ 5-day drops ({date.today()})\n",
           f"{len(ev)} events, {len({e['t'] for e in ev})} stocks, {dates[0]} → {dates[-1]} (halves split at {mid}).",
           f"\n**All drops:** {summ(ev)}\n", "| Condition | Yes | No |", "|---|---|---|"]
    for cond in ("deep", "gap", "volspike", "below200", "sector_down", "spy_below200", "earnings"):
        out.append(f"| {cond} | {summ([r for r in ev if r[cond] is not None and bool(r[cond])])} | {summ([r for r in ev if r[cond] is not None and not bool(r[cond])])} |")
    out += ["\n## Pre-registered tests (16, Holm, week-cluster bootstrap)", "| Test | Effect | halves | Holm p | pass |", "|---|---|---|---|---|"]
    for t_ in tests:
        unit = 100
        out.append(f"| {t_['name']} | {t_['est']*unit:+.1f} pp | {t_['halves'][0]*unit:+.1f} / {t_['halves'][1]*unit:+.1f} | {t_['holm']:.3f} | {'**PASS**' if t_['pass'] else 'no'} |")
    passed = [t_ for t_ in tests if t_["pass"]]
    out.append("\nExcess = forward return minus the same stock's mean forward return over all days in that half; recovery base = share of the "
               "stock's days that climbed the same % within 20 trading days. Events cluster in sell-off weeks, hence week-cluster bootstrap.")
    out.append("\nCaveats: the market-downtrend effect rests on few episodes (SPY below its 200-day: 2020, 2022, 2023, 2025, 2026 — "
               "same sign in both halves, but ~5 regimes, not 1,400 independent draws); part of it is broad market rebounds lifting every "
               "stock. SPY data start 2018-10, so pre-2019 drops have no market-regime tag. Bug fixed before reading results: numpy "
               "booleans were dropped from the condition splits (no design change).")
    (HERE.parent / "out/opt").mkdir(parents=True, exist_ok=True)
    (HERE.parent / "out/opt/S025.md").write_text("\n".join(out) + "\n")
    allx = tests[0]; allr = tests[1]
    head = (f"After a ≥2σ 5-day drop, the next 20 days are {allx['est']*100:+.1f} pp vs the stock's normal and recovery to the pre-drop level "
            f"is {allr['est']*100:+.0f} pp vs base ({len(ev)} drops). "
            + (("Passing: " + "; ".join(f"{t_['name']} {t_['est']*100:+.1f} pp" for t_ in passed) + ".") if passed else "Nothing passes: no reliable bounce signal."))
    conn.execute("""INSERT INTO optlab.findings (study, title, verdict, headline, card, updated_at) VALUES ('S025','Bounce after drops?',%s,%s,%s,now())
                    ON CONFLICT (study) DO UPDATE SET verdict=excluded.verdict, headline=excluded.headline, card=excluded.card, updated_at=now()""",
                 ("pass" if passed else "fail", head, json.dumps(clean(tests), default=str)))
    conn.commit()
    print("\n".join(out)); print("→", head)


if __name__ == "__main__":
    main()
