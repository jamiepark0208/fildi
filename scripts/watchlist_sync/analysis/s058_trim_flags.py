"""S058 — Trim rule R3 (Claude 10-19; Jamie: "the model sells low"). Pre-registered in research/studies/INDEX.md.

Month-end (last trading day with a StarMine obs), point-in-time, LSEG lseg_research.daily_history + starmine_history:
  fk     falling knife, same rule as technicals-math.ts: (close − MA50)/ATR14 < −2 and (close − MA200)/ATR14 < −2 and MACD
         histogram falling (hist today < hist 5 days ago)
  weak   combined_alpha_rank ≤ 10 (StarMine, latest obs on/before the month-end)
Outcome: next-21-trading-day log return minus the equal-weight universe mean that month (excess).
Pass to KEEP a flag as a trim reason: mean excess < 0, month-block 90 % CI high < 0, both halves (by month) < 0.

    .venv/bin/python analysis/s058_trim_flags.py
"""
from __future__ import annotations

import math
import random
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from build_plan import connect, rows  # noqa: E402

H = 21


def ema(xs, n):
    k, out, e = 2 / (n + 1), [], None
    for x in xs:
        e = x if e is None else e + k * (x - e)
        out.append(e)
    return out


def main():
    with connect() as conn:
        px = defaultdict(list)
        for r in rows(conn, """SELECT ticker, date, close::float8 c, high::float8 h, low::float8 l FROM lseg_research.daily_history
                               WHERE close > 0 AND ticker NOT IN ('SPY','QQQ','IWM','DIA') ORDER BY ticker, date"""):
            px[r["ticker"]].append(r)
        sm = defaultdict(list)
        for r in rows(conn, """SELECT ticker, obs_date, value::float8 v FROM lseg_research.starmine_history
                               WHERE metric = 'combined_alpha_rank' ORDER BY ticker, obs_date"""):
            sm[r["ticker"]].append((r["obs_date"], r["v"]))
    obs = []   # (month, ticker, fk, weak, ret)
    for t, b in px.items():
        if len(b) < 260:
            continue
        c = [x["c"] for x in b]
        tr = [max(x["h"] or x["c"], c[i - 1]) - min(x["l"] or x["c"], c[i - 1]) if i else 0 for i, x in enumerate(b)]
        macd = [a - s for a, s in zip(ema(c, 12), ema(c, 26))]
        hist = [m - s for m, s in zip(macd, ema(macd, 9))]
        hist_ = sm.get(t, [])
        for i in range(200, len(b) - H):
            d = b[i]["date"]
            if b[i + 1]["date"].month == d.month:   # month-end only
                continue
            atr = sum(tr[i - 13:i + 1]) / 14
            if atr <= 0:
                continue
            ma50, ma200 = sum(c[i - 49:i + 1]) / 50, sum(c[i - 199:i + 1]) / 200
            fk = (c[i] - ma50) / atr < -2 and (c[i] - ma200) / atr < -2 and hist[i] < hist[i - 5]
            prior = [v for od, v in hist_ if od <= d and (d - od).days <= 45]
            weak = (prior[-1] <= 10) if prior else None
            obs.append((d.strftime("%Y-%m"), t, fk, weak, math.log(c[i + H] / c[i])))
    mean_m = defaultdict(list)
    for m, _, _, _, r in obs:
        mean_m[m].append(r)
    mean_m = {m: sum(v) / len(v) for m, v in mean_m.items()}
    obs = [(m, t, fk, wk, r - mean_m[m]) for m, t, fk, wk, r in obs]
    months = sorted(mean_m)
    print(f"S058 · {len(obs)} name-months, {len(months)} months {months[0]}→{months[-1]}, {len({o[1] for o in obs})} names")

    def test(name, sel):
        by = defaultdict(list)
        for o in obs:
            if sel(o):
                by[o[0]].append(o[4])
        ms = sorted(by)
        flat = [x for m in ms for x in by[m]]
        if len(flat) < 30:
            print(f"  {name}: n {len(flat)} too few"); return
        mean = sum(flat) / len(flat)
        rnd = random.Random(58)
        boots = []
        for _ in range(2000):
            s = [x for _ in ms for x in by[rnd.choice(ms)]]
            boots.append(sum(s) / len(s))
        boots.sort()
        h = len(ms) // 2
        a = [x for m in ms[:h] for x in by[m]]; z = [x for m in ms[h:] for x in by[m]]
        ha, hz = sum(a) / len(a), sum(z) / len(z)
        keep = mean < 0 and boots[1899] < 0 and ha < 0 and hz < 0
        print(f"  {name:38s} n {len(flat):5d} · excess 21d {100 * mean:+.2f} % (90% CI {100 * boots[100]:+.2f}..{100 * boots[1899]:+.2f}) "
              f"halves {100 * ha:+.2f} / {100 * hz:+.2f} → {'KEEP as trim reason' if keep else 'not a trim reason'}")

    test("falling knife (all names)", lambda o: o[2])
    test("weak StarMine alpha ≤ 10", lambda o: o[3])
    test("weak alpha + falling knife", lambda o: o[3] and o[2])
    test("weak alpha, no falling knife", lambda o: o[3] is True and not o[2])
    # contrast inside weak names: does adding the knife make it worse?
    w_fk = [o[4] for o in obs if o[3] and o[2]]; w_no = [o[4] for o in obs if o[3] is True and not o[2]]
    if w_fk and w_no:
        print(f"  inside weak names: knife − no knife = {100 * (sum(w_fk) / len(w_fk) - sum(w_no) / len(w_no)):+.2f} pp")


if __name__ == "__main__":
    main()
