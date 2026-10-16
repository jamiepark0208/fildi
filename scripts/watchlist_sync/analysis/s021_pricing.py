"""S021 (Claude, pre-registered 10-14): were S003's model-priced puts close to real option prices?
S003 priced 30-day puts with Black-Scholes at LSEG 30d ATM IV × a fill haircut, at a delta-chosen (unlisted) strike. For a
stratified sample of S003 entries in Polygon's window (2024-11 → 2026-10), map to the nearest listed put (strike nearest K,
expiry = listed Friday nearest entry + 30 d), reprice the model at that exact contract, compare with the real close on entry day.
Pass: median |model − real| / real ≤ 20 % and no bias by moneyness bucket. Polygon closes run ~3 % above mid (S019): reported.
    .venv/bin/python analysis/s021_pricing.py      # ~2 Polygon calls per uncached contract (5/min); resumable via optlab caches
"""
from __future__ import annotations

import csv
import json
import random
import statistics as st
import sys
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402
import option_history as oh  # noqa: E402
from backtest_puts import RF, bs_put  # noqa: E402

PER_BUCKET = 30
BUCKETS = [(0.00, 0.05), (0.05, 0.10), (0.10, 0.20), (0.20, 1.0)]


def main() -> None:
    conn = connect()
    rows = []
    with open(HERE.parent / "out/step4/trades.csv") as fh:
        for r in csv.DictReader(fh):
            d = date.fromisoformat(r["entry"])
            if date(2024, 11, 1) <= d <= date(2026, 9, 10) and float(r["prem"]) > 0.05:
                rows.append(r)
    rng = random.Random(21)
    rng.shuffle(rows)
    pick = {b: [] for b in BUCKETS}
    for r in rows:
        otm = 1 - float(r["K"]) / float(r["S"])
        for b in BUCKETS:
            if b[0] <= otm < b[1] and len(pick[b]) < PER_BUCKET:
                pick[b].append(r)
    out, missing = [], 0
    for b, rs in pick.items():
        for r in rs:
            t, d0, S, K, iv, prem = r["ticker"], date.fromisoformat(r["entry"]), float(r["S"]), float(r["K"]), float(r["iv"]) / 100, float(r["prem"])
            rate = RF.get(d0.year, 0.03)
            haircut = prem / bs_put(S, K, 30 / 365, rate, iv)
            target = d0 + timedelta(days=30)
            fri = [target + timedelta(days=k) for k in range(-6, 7) if (target + timedelta(days=k)).weekday() == 4]
            best = None
            for exp in sorted(fri, key=lambda x: abs((x - target).days)):
                cs = [c for c in oh.chain(conn, t, exp, S) if c["type"] == "put"]
                if cs:
                    best = (exp, min(cs, key=lambda c: abs(c["strike"] - K)))
                    break
            if not best:
                missing += 1
                continue
            exp, c = best
            oh.fetch_bars(conn, c["occ"], exp)
            bar = conn.execute("SELECT c FROM optlab.bars WHERE occ = %s AND date = %s", (c["occ"], d0)).fetchone()
            if not bar or not bar[0]:
                missing += 1
                continue
            model = bs_put(S, c["strike"], (exp - d0).days / 365, rate, iv) * haircut
            out.append({"t": t, "d0": str(d0), "otm": 1 - c["strike"] / S, "bucket": f"{b[0]:.0%}–{b[1]:.0%}" if b[1] < 1 else f"> {b[0]:.0%}",
                        "model": model, "real": float(bar[0]), "haircut": haircut})
        oh.flush_usage(conn)
    report(conn, out, missing)


def report(conn, out, missing) -> None:
    err = [abs(x["model"] / x["real"] - 1) for x in out]
    bias = [x["model"] / x["real"] - 1 for x in out]
    lines = [f"# S021 — were S003's model premiums close to real prices? ({date.today()})\n",
             f"Sample: {len(out)} S003 entries matched to a listed put with a traded close on entry day ({missing} had no listed match or no trade). "
             f"Model = S003's Black-Scholes at LSEG 30d ATM IV × its fill haircut (median {st.median(x['haircut'] for x in out):.2f}), repriced at the listed strike/expiry.\n",
             f"Overall: median |error| **{st.median(err):.0%}**, median bias (model vs real) **{st.median(bias):+.0%}** (negative = model too cheap).\n",
             "| Moneyness (OTM) | n | median abs error | median bias |", "|---|---|---|---|"]
    by = {}
    for x in out:
        by.setdefault(x["bucket"], []).append(x)
    for k in sorted(by):
        xs = by[k]
        lines.append(f"| {k} | {len(xs)} | {st.median(abs(x['model'] / x['real'] - 1) for x in xs):.0%} | {st.median(x['model'] / x['real'] - 1 for x in xs):+.0%} |")
    passed = st.median(err) <= 0.20 and all(abs(st.median(x["model"] / x["real"] - 1 for x in xs)) <= 0.20 for xs in by.values())
    lines.append(f"\nVerdict: **{'PASS' if passed else 'FAIL'}** (pre-registered: median abs error ≤ 20 % and no bucket biased > 20 %). "
                 "Real closes are last trades, ~3 % above mid (S019), so true bias toward 'model too cheap' is ~3 pts smaller than shown.")
    (HERE.parent / "out/opt").mkdir(parents=True, exist_ok=True)
    (HERE.parent / "out/opt/S021.md").write_text("\n".join(lines) + "\n")
    worst = max(by.items(), key=lambda kv: abs(st.median(x["model"] / x["real"] - 1 for x in kv[1])))
    head = (f"S003's model premiums were {'close to' if passed else 'off from'} real prices: median error {st.median(err):.0%}, "
            f"model {'cheaper' if st.median(bias) < 0 else 'richer'} than real by {abs(st.median(bias)):.0%}; worst bucket {worst[0]} OTM "
            f"{st.median(x['model'] / x['real'] - 1 for x in worst[1]):+.0%}.")
    conn.execute("""INSERT INTO optlab.findings (study,title,verdict,headline,card,updated_at) VALUES ('S021','Old backtest check',%s,%s,%s,now())
                    ON CONFLICT (study) DO UPDATE SET verdict=excluded.verdict, headline=excluded.headline, card=excluded.card, updated_at=now()""",
                 ("pass" if passed else "fail", head, json.dumps({"n": len(out), "mae": st.median(err), "bias": st.median(bias)})))
    conn.commit()
    print("\n".join(lines)); print("→", head)


if __name__ == "__main__":
    main()
