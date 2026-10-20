"""S049-crash — are panic puts worse after broad (SPY 20d < −5 %) or sector-clustered crashes? Card: research/studies/S049-crash-reaudit.md.

Reads S049 simulated trades (watchlist_sync.study_trades, periods 2022/2025/2026). Broad = SPY 20-day return < −5 % at entry.
Cluster = ≥ 3 other same-sector panic events within ±5 days (sector = primary_peer_group_id prefix). Bootstrap by expiry week.

    cd scripts/watchlist_sync && .venv/bin/python analysis/s049_crash_reaudit.py
"""
from __future__ import annotations

import random
import sys
from bisect import bisect_right
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S049_crash.md"
rng = random.Random(1)


def summ(x):
    r = sorted(y["ret"] for y in x)
    w = r[: max(1, len(r) // 10)]
    return len(r), sum(r) / len(r), sum(y["itm"] for y in x) / len(x), sum(w) / len(w)


def boot_p(a, b, n=3000):
    """One-sided p that mean(a) − mean(b) ≤ 0, resampling expiry weeks."""
    wk = defaultdict(lambda: ([], []))
    for x in a:
        wk[x["e"].isocalendar()[:2]][0].append(x["ret"])
    for x in b:
        wk[x["e"].isocalendar()[:2]][1].append(x["ret"])
    ks, bad = list(wk), 0
    for _ in range(n):
        s = [rng.choice(ks) for _ in ks]
        A, B = [r for k in s for r in wk[k][0]], [r for k in s for r in wk[k][1]]
        if A and B and sum(A) / len(A) - sum(B) / len(B) <= 0:
            bad += 1
    return bad / n


def main():
    conn = connect()
    spy = conn.execute("SELECT date, close::float FROM lseg_research.daily_history WHERE ticker = 'SPY' AND close > 0 ORDER BY date").fetchall()
    ds = [d for d, _ in spy]
    sec = {t: (g.split(".")[0] if g else None) for t, g in conn.execute("SELECT ticker, primary_peer_group_id FROM ticker_registry").fetchall()}
    tr = [dict(period=p, arm=a, t=t, d=d, e=e, ret=r, itm=bool(l), iv=iv) for p, a, t, d, e, r, l, iv in conn.execute(
        "SELECT period, arm, ticker, entry_d, exit_d, ret, loss, (feats->>'iv')::float FROM watchlist_sync.study_trades WHERE study = 'S049'").fetchall()]
    evs = [(x["t"], x["d"]) for x in tr if x["arm"] == "event"]
    for x in tr:
        i = bisect_right(ds, x["d"]) - 1
        x["broad"] = spy[i][1] / spy[i - 20][1] - 1 < -0.05
        s = sec.get(x["t"])
        x["cluster"] = None if not s else sum(1 for u, dd in evs if u != x["t"] and sec.get(u) == s and abs((dd - x["d"]).days) <= 5) >= 3
        x["hiv"] = x["arm"] == "event" and x["iv"] is not None and x["iv"] > 48.7
    L = ["# S049-crash — panic puts in broad vs sector-clustered crashes", "", "| slice | n | mean % coll | ITM | worst 10 % |", "|---|---|---|---|---|"]
    rows = [("panic, idiosyncratic", lambda x: x["arm"] == "event" and not x["broad"]),
            ("panic, broad crash", lambda x: x["arm"] == "event" and x["broad"]),
            ("panic + IV > 48.7, idiosyncratic", lambda x: x["hiv"] and not x["broad"]),
            ("panic + IV > 48.7, broad crash", lambda x: x["hiv"] and x["broad"]),
            ("baseline, idiosyncratic", lambda x: x["arm"] == "base" and not x["broad"]),
            ("baseline, broad crash", lambda x: x["arm"] == "base" and x["broad"]),
            ("panic + IV > 48.7, alone in sector", lambda x: x["hiv"] and x["cluster"] is False),
            ("panic + IV > 48.7, sector cluster", lambda x: x["hiv"] and x["cluster"] is True)]
    for lab, f in rows:
        n, m, itm, w = summ([x for x in tr if f(x)])
        L.append(f"| {lab} | {n} | {m:+.2%} | {itm:.0%} | {w:+.1%} |")
    L += ["", "p(event ≤ same-regime baseline), expiry-week bootstrap:"]
    for lab, ev in (("panic", lambda x: x["arm"] == "event"), ("panic + IV > 48.7", lambda x: x["hiv"])):
        for br in (False, True):
            p = boot_p([x for x in tr if ev(x) and x["broad"] == br], [x for x in tr if x["arm"] == "base" and x["broad"] == br])
            L.append(f"- {lab}, {'broad' if br else 'idiosyncratic'}: p = {p:.3f}")
    L += ["", "Worst decile by year, IV > 48.7, alone vs sector cluster:"]
    for yr in ("2022", "2025", "2026"):
        a = [x for x in tr if x["hiv"] and x["period"] == yr and x["cluster"] is False]
        c = [x for x in tr if x["hiv"] and x["period"] == yr and x["cluster"] is True]
        if a and c:
            L.append(f"- {yr}: alone {summ(a)[3]:+.1%} (n {len(a)}) · cluster {summ(c)[3]:+.1%} (n {len(c)})")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
