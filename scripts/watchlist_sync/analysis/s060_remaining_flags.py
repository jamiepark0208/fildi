"""S060 — the remaining untested pieces (Claude 10-19). Pre-registered in research/studies/INDEX.md.

(a) Trim flags that still lacked evidence, on the S058 harness (month-end, next-21-trading-day log return minus the
    equal-weight universe mean; keep only if excess < 0, month-block 90 % CI high < 0, both halves < 0):
      down_revisions   IBES EPS FY1 (wrds_research.ibes_statsum, latest statpers ≤ month-end, ≤ 45 d old): numdown > numup
                       — proxy for StarMine ARM ≤ 20 (no ARM history in LSEG)
      predicted_miss   StarMine predicted surprise FQ1 ≤ −2 % (starmine_history) and a report within 30 days (earnings_moves/events)
      pt_cut           price-target mean (starmine_history pt_mean) down ≥ 5 % vs ~3 months earlier
(b) Analyst dispersion (IBES FY1 stdev ÷ |mean|, Zhan-Han-Cao-Tong 2022) on the S059 simulated puts: fm() with IV controls,
    |t| ≥ 3 and both halves same sign; if it passes, holdout 2024-07→ add-on test vs the S059 composite.

    .venv/bin/python analysis/s060_remaining_flags.py
"""
from __future__ import annotations

import math
import random
import sys
from bisect import bisect_right
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import s045_put_retest as S  # noqa: E402
import s059_option_factors as F  # noqa: E402
from build_plan import connect, rows  # noqa: E402

H = 21
OUT = HERE.parent / "out/opt/S060.md"


def asof(series, d, max_age):
    """series = sorted [(date, value)] → latest value on/before d within max_age days."""
    i = bisect_right([x[0] for x in series], d) - 1
    return series[i][1] if i >= 0 and (d - series[i][0]).days <= max_age else None


def load_signals(conn):
    ibes = defaultdict(list)
    for r in rows(conn, """SELECT ticker, statpers, numup, numdown, meanest::float8 m, stdev::float8 s FROM wrds_research.ibes_statsum
                           WHERE measure = 'EPS' AND fiscalp = 'ANN' AND fpi = '1' ORDER BY ticker, statpers"""):
        ibes[r["ticker"]].append((r["statpers"], r))
    sm = defaultdict(lambda: defaultdict(list))
    for r in rows(conn, """SELECT ticker, metric, obs_date, value::float8 v FROM lseg_research.starmine_history
                           WHERE metric IN ('pred_surprise_pct_fq1', 'pt_mean') ORDER BY ticker, metric, obs_date"""):
        sm[r["ticker"]][r["metric"]].append((r["obs_date"], r["v"]))
    er = defaultdict(list)
    for r in rows(conn, """SELECT ticker, report_date::date d FROM lseg_research.earnings_moves
                           UNION SELECT ticker, event_date FROM lseg_research.events WHERE event_type = 'EarningsReleases' ORDER BY 2"""):
        er[r["ticker"]].append(r["d"])
    return ibes, sm, er


def flags_on(t, d, ibes, sm, er):
    f = {}
    ib = asof(ibes.get(t, []), d, 45)
    if ib and ib["numup"] is not None and ib["numdown"] is not None:
        f["down_revisions"] = ib["numdown"] > ib["numup"]
        if ib["m"] and abs(ib["m"]) > 0.05 and ib["s"] is not None:
            f["dispersion"] = ib["s"] / abs(ib["m"])
    ps = asof(sm[t]["pred_surprise_pct_fq1"], d, 45) if t in sm else None
    if ps is not None:
        nxt = [x for x in er.get(t, []) if d < x <= d + timedelta(days=30)]
        f["predicted_miss"] = ps <= -2 and bool(nxt)
    if t in sm:
        now, then = asof(sm[t]["pt_mean"], d, 45), asof(sm[t]["pt_mean"], d - timedelta(days=91), 45)
        if now and then:
            f["pt_cut"] = now / then - 1 <= -0.05
    return f


def part_a(conn, ibes, sm, er, lines):
    px = defaultdict(list)
    for r in rows(conn, """SELECT ticker, date, close::float8 c FROM lseg_research.daily_history WHERE close > 0
                           AND ticker NOT IN ('SPY','QQQ','IWM','DIA') AND date >= '2019-06-01' ORDER BY ticker, date"""):
        px[r["ticker"]].append((r["date"], r["c"]))
    obs = []
    for t, b in px.items():
        for i in range(1, len(b) - H):
            d = b[i][0]
            if b[i + 1][0].month == d.month:
                continue
            obs.append((d.strftime("%Y-%m"), t, flags_on(t, d, ibes, sm, er), math.log(b[i + H][1] / b[i][1])))
    mm = defaultdict(list)
    for m, _, _, r in obs:
        mm[m].append(r)
    mm = {m: sum(v) / len(v) for m, v in mm.items()}
    obs = [(m, t, f, r - mm[m]) for m, t, f, r in obs]
    lines += [f"## (a) Trim flags — {len(obs)} name-months", "", "| flag | n | excess 21d | 90 % CI | halves | verdict |", "|---|---|---|---|---|---|"]
    verdicts = {}
    for flag in ("down_revisions", "predicted_miss", "pt_cut"):
        by = defaultdict(list)
        for m, _, f, r in obs:
            if f.get(flag) is True:
                by[m].append(r)
        ms = sorted(by)
        flat = [x for m in ms for x in by[m]]
        if len(flat) < 30:
            lines.append(f"| {flag} | {len(flat)} | too few | | | — |"); continue
        rnd = random.Random(60)
        boots = sorted(np.mean([x for _ in ms for x in by[rnd.choice(ms)]]) for _ in range(2000))
        h = len(ms) // 2
        a, z = np.mean([x for m in ms[:h] for x in by[m]]), np.mean([x for m in ms[h:] for x in by[m]])
        mean = float(np.mean(flat))
        keep = mean < 0 and boots[1899] < 0 and a < 0 and z < 0
        verdicts[flag] = keep
        lines.append(f"| {flag} | {len(flat)} | {100 * mean:+.2f} % | {100 * boots[100]:+.2f}..{100 * boots[1899]:+.2f} | "
                     f"{100 * a:+.2f} / {100 * z:+.2f} | {'KEEP' if keep else 'not a trim reason'} |")
    return verdicts


def part_b(conn, ibes, sm, er, lines):
    r_, tech, fund, px = S.load(conn)
    ev = S.build(r_, tech, fund, px)
    F.add_features(conn, ev)
    for e in ev:
        v = flags_on(e["t"], e["d"], ibes, sm, er).get("dispersion")
        if v is not None:
            e["dispersion"] = v
    lines += ["", f"## (b) Analyst dispersion on {len(ev)} simulated puts", ""]
    ok = False
    for tgt in ("pnl", "breach"):
        r = S.fm(ev, "dispersion", tgt)
        if r:
            p = abs(r["t"]) >= 3 and np.sign(r["ic_a"]) == np.sign(r["ic_b"]) == np.sign(r["ic"])
            ok = ok or (p and tgt == "pnl")
            lines.append(f"- {tgt}: IC {r['ic']:+.4f}, t {r['t']:+.1f}, halves {r['ic_a']:+.4f} / {r['ic_b']:+.4f} → {'PASS' if p else '—'} ({r['n_weeks']} weeks)")
    if ok:
        pre = [e for e in ev if e["d"] < F.SPLIT]
        sg = int(np.sign(S.fm(pre, "dispersion", "pnl")["ic"]))
        by = defaultdict(list)
        for e in ev:
            if e["d"] >= F.SPLIT and all(e.get(k) is not None for k in ("iv_rv", "vol_of_vol", "put_tech", "dispersion")):
                by[e["d"]].append(e)
        d = []
        for g in by.values():
            if len(g) < 30:
                continue
            base = sum(S.rank([e[k] for e in g]) for k in ("iv_rv", "vol_of_vol", "put_tech"))
            plus = base + sg * S.rank([e["dispersion"] for e in g])
            q = len(g) // 5
            top = lambda sc: np.mean([g[k]["pnl"] for k in np.argsort(sc)[-q:]])
            d.append(1e4 * (top(plus) - top(base)))
        d = np.array(d)
        lines.append(f"- holdout add-on to put edge: top quintile {d.mean():+.1f} bp/wk (t {d.mean() / (d.std(ddof=1) / math.sqrt(len(d))):+.2f}, "
                     f"{len(d)} weeks, halves {d[:len(d) // 2].mean():+.1f} / {d[len(d) // 2:].mean():+.1f})")
    return ok


def main():
    with connect() as conn:
        ibes, sm, er = load_signals(conn)
        lines = ["# S060 — remaining trim flags + analyst dispersion", ""]
        part_a(conn, ibes, sm, er, lines)
        part_b(conn, ibes, sm, er, lines)
    OUT.write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
