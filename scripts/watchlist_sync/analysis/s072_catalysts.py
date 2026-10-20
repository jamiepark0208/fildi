"""S072 — catalysts besides earnings for weekly short puts (Jamie 10-20: "are there other catalysts we should take advantage of?").
Same harness as S069/S070 (weekly ~1σ puts at the stock's own IV30, net of fills, 2020 →). History we can rebuild for free:
  post_earnings  entry in the week right after a report (IV crush done, the news is out) — lseg_research.earnings_moves
  lockup         IPO lockup expiry (first bar + 180 days) inside the hold; names whose first LSEG bar is after the history start
  upgrade        analyst upgrade / PT raise in the 5 days before entry (public.analyst_events, 2025-07 → only)
  downgrade      analyst downgrade / PT cut in the 5 days before entry (same)
(FOMC: S070. CIQ key developments — investor days, FDA, index adds — permission denied on our WRDS account, 10-20.)

Pre-registered: catalyst puts vs all other puts in the SAME weeks (week-paired diff, week-cluster t). Use = diff > 0 with t ≥ 2 in
both halves (split 2024-07) and worst 1 % no worse than −50 bp vs the rest → candidate flag; diff < 0 with t ≤ −2 → avoid flag.
Analyst events only cover 2025-07 → (one period) → at most "watch".

    cd scripts/watchlist_sync && .venv/bin/python analysis/s072_catalysts.py
"""
from __future__ import annotations

import math
import sys
from bisect import bisect_left
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import s059_option_factors as S  # noqa: E402
from build_plan import connect  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S072.md"
SPLIT = date(2024, 7, 1)


def paired(ev, flag):
    """mean diff (bp) catalyst − rest within the same entry week, week-cluster t, n catalyst, worst 1 % both."""
    byw = defaultdict(lambda: ([], []))
    for e in ev:
        byw[e["d"]][0 if flag(e) else 1].append(e["pnl"])
    diffs = [np.mean(a) - np.mean(b) for a, b in byw.values() if a and b]
    a = [e["pnl"] for e in ev if flag(e)]
    b = [e["pnl"] for e in ev if not flag(e)]
    if len(diffs) < 5 or len(a) < 30:
        return None
    d = np.array(diffs)
    t = d.mean() / (d.std(ddof=1) / math.sqrt(len(d))) if len(d) > 1 and d.std(ddof=1) > 0 else float("nan")
    return dict(n=len(a), weeks=len(d), diff=1e4 * d.mean(), t=t, pnl=1e4 * np.mean(a), rest=1e4 * np.mean(b),
                br=np.mean([e["breach"] > 0 for e in ev if flag(e)]), br_rest=np.mean([e["breach"] > 0 for e in ev if not flag(e)]),
                w1=1e4 * np.percentile(a, 1), w1_rest=1e4 * np.percentile(b, 1))


def main():
    conn = connect()
    ev = S.aligned_events(conn)
    rep = defaultdict(list)
    for t, d in conn.execute("SELECT ticker, report_date FROM lseg_research.earnings_moves ORDER BY report_date").fetchall():
        rep[t].append(d)
    hist0 = conn.execute("SELECT MIN(date) FROM lseg_research.daily_history").fetchone()[0]
    first = dict(conn.execute("SELECT ticker, MIN(date) FROM lseg_research.daily_history WHERE close > 0 GROUP BY 1").fetchall())
    lock = {t: d + timedelta(days=180) for t, d in first.items() if d > hist0 + timedelta(days=30)}
    up, dn = defaultdict(list), defaultdict(list)
    for t, act, pa, d in conn.execute("""SELECT UPPER(ticker), lower(coalesce(action, '')), lower(coalesce(price_target_action, '')), event_date
                                         FROM analyst_events WHERE event_date IS NOT NULL""").fetchall():
        if act.startswith("up") or pa.startswith("rais"):
            up[t].append(d)
        elif act.startswith("down") or pa.startswith(("low", "cut")):
            dn[t].append(d)
    for v in list(up.values()) + list(dn.values()) + list(rep.values()):
        v.sort()
    ana0 = conn.execute("SELECT MIN(event_date) FROM analyst_events").fetchone()[0]

    def recent(xs, d, days):
        i = bisect_left(xs, d - timedelta(days=days))
        return i < len(xs) and xs[i] < d

    for e in ev:
        r = rep.get(e["t"], [])
        e["post_earn"] = recent(r, e["d"], 7) and not e["earn"]
        e["lockup"] = e["t"] in lock and e["d"] < lock[e["t"]] <= e["expiry"]
        e["upgrade"] = recent(up.get(e["t"], []), e["d"], 5)
        e["downgrade"] = recent(dn.get(e["t"], []), e["d"], 5)
    L = ["# S072 — catalysts beyond earnings for weekly short puts (same-week paired, net of fills, 2020 →)", "",
         f"{len(ev)} puts. diff = catalyst − other puts in the same entry week (bp/wk), week-cluster t. Lockup names: {len(lock)}. "
         f"Analyst events from {ana0} only.", "",
         "| catalyst | period | n | weeks | catalyst bp | rest bp | diff (t) | breach vs rest | worst 1 % vs rest | read |", "|---|---|---|---|---|---|---|---|---|---|"]
    for name in ("post_earn", "lockup", "upgrade", "downgrade"):
        periods = (("all ≥ 2025-07", lambda e: e["d"] >= ana0),) if name in ("upgrade", "downgrade") else \
                  (("< 2024-07", lambda e: e["d"] < SPLIT), ("≥ 2024-07", lambda e: e["d"] >= SPLIT))
        for lab, f in periods:
            s = paired([e for e in ev if f(e)], lambda e, k=name: e[k])
            if not s:
                L.append(f"| {name} | {lab} | <30 | | | | | | | too few |")
                continue
            read = "helps" if s["diff"] > 0 and s["t"] >= 2 else "hurts" if s["diff"] < 0 and s["t"] <= -2 else "no effect"
            L.append(f"| {name} | {lab} | {s['n']} | {s['weeks']} | {s['pnl']:+.1f} | {s['rest']:+.1f} | {s['diff']:+.1f} ({s['t']:.1f}) | "
                     f"{s['br']:.1%} vs {s['br_rest']:.1%} | {s['w1']:+.0f} vs {s['w1_rest']:+.0f} | {read} |")
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
