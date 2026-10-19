"""S052 — reverse-engineer 0DTE lotto winners (follow-up to S048 FAIL; Jamie 10-19 "define the successful trades first").

Every 2026 SPY session × checkpoints 10:00, 10:30 … 15:00 (cached 1-min bars). Success (lotto pays) = SPY travels ≥ 1.25 %
from the checkpoint price in either direction before the close — a ~1 %-OTM 0DTE bought there ends ≥ 0.25 % ITM
(≈ 5–20× on the $0.05–0.50 prints seen in S048). Features at the checkpoint use bars ≤ t only. Discovery = Jan–Jun;
the best stable feature's cut is fixed there and tested ONCE on Jul→ (day-clustered bootstrap). t-stats are deflated by
√(checkpoints per day) because checkpoints within a day are correlated.

    cd scripts/watchlist_sync && .venv/bin/python analysis/s052_0dte_winners.py
"""
from __future__ import annotations

import math
import re
import sys
from collections import defaultdict
from datetime import date, time
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402

NY = ZoneInfo("America/New_York")
HOLDOUT = date(2026, 7, 1)
TRAVEL = 0.0125
CHECK = [time(10, 0), time(10, 30), time(11, 0), time(11, 30), time(12, 0), time(12, 30), time(13, 0), time(13, 30),
         time(14, 0), time(14, 30), time(15, 0)]
OUT = HERE.parent / "out" / "opt" / "S052.md"
STATIC = HERE.parents[2] / "artifacts" / "api-server" / "src" / "lib" / "macro-static.ts"
rng = np.random.default_rng(52)


def macro_days():
    out = set()
    for d, ev in re.findall(r'date: "(\d{4}-\d\d-\d\d)", event: "([^"]+)"', STATIC.read_text()):
        if re.search(r"CPI|FOMC Rate|Payroll|NFP|Jobs|PCE", ev):
            out.add(date.fromisoformat(d))
    return out


def load(conn):
    bars = defaultdict(list)
    for ts, h, l, c in conn.execute("""SELECT ts, h, l, c FROM optlab.minute_bars WHERE ticker = 'SPY' AND
                                       (ts AT TIME ZONE 'America/New_York')::time BETWEEN '09:30' AND '15:59' ORDER BY ts""").fetchall():
        t = ts.astimezone(NY)
        bars[t.date()].append((t.time(), h, l, c))
    iv = dict(conn.execute("SELECT date, iv30_put::float FROM lseg_research.daily_history WHERE ticker = 'SPY' "
                           "AND date >= '2024-09-01'").fetchall())
    return bars, iv


def build(bars, iv, macro):
    days = sorted(bars)
    rows = []
    for k, d in enumerate(days):
        if k == 0:
            continue
        b, prev = bars[d], bars[days[k - 1]]
        if len(b) < 300:
            continue
        pc, op = prev[-1][3], b[0][3]
        piv = iv.get(max(x for x in iv if x < d)) if any(x < d for x in iv) else None
        if not piv:
            continue
        sig_d = piv / 100 / math.sqrt(252)
        prev_ret = prev[-1][3] / prev[0][3] - 1
        for cp in CHECK:
            i = next((j for j, x in enumerate(b) if x[0] >= cp), None)
            if i is None or i < 15:
                continue
            P = b[i][3]
            after = b[i + 1:]
            # minute CLOSES, not h/l: Polygon h/l carry bad ticks (06-26 15:59 low 716.58 vs close 729.09)
            mfe = max(max(x[3] for x in after) / P - 1, 1 - min(x[3] for x in after) / P)
            r = np.diff(np.log([x[3] for x in b[:i + 1]]))
            rv_ann = np.std(r, ddof=1) * math.sqrt(390 * 252)
            mins_left = len(after)
            f = {
                "minutes_left": mins_left,
                "move_so_far_sigma": abs(P / op - 1) / sig_d,
                "gap_open_sigma": abs(op / pc - 1) / sig_d,
                "rv_today_over_iv": rv_ann / (piv / 100),              # today's realized vol vs what options priced
                "range_so_far_sigma": (max(x[3] for x in b[:i + 1]) / min(x[3] for x in b[:i + 1]) - 1) / sig_d,
                "iv_level": piv,
                "prev_day_abs_ret": abs(prev_ret),
                "macro_day": float(d in macro),
                "last_30m_trend_sigma": abs(P / b[max(0, i - 30)][3] - 1) / sig_d,
                "monday_or_friday": float(d.weekday() in (0, 4)),
            }
            rows.append(dict(d=d, cp=cp, y=float(mfe >= TRAVEL), mfe=mfe, f=f))
    return rows


def boot_day(rs, n=4000):
    by = defaultdict(list)
    for r in rs:
        by[r["d"]].append(r["y"])
    ks = list(by)
    sims = [np.mean([v for k in rng.choice(ks, len(ks)) for v in by[k]]) for _ in range(n)]
    return np.mean([v for k in ks for v in by[k]]), np.percentile(sims, [2.5, 97.5])


def main():
    conn = connect()
    bars, iv = load(conn)
    rows = build(bars, iv, macro_days())
    Y26 = date(2026, 1, 1)
    ins = [r for r in rows if Y26 <= r["d"] < HOLDOUT]
    ho2 = [r for r in rows if r["d"] < Y26]  # 2nd untouched holdout (fetched 10-19 after step 2 was fixed)
    ho = [r for r in rows if r["d"] >= HOLDOUT]
    mid = date(2026, 4, 1)
    deflate = math.sqrt(len(CHECK))
    base_in, base_ho = np.mean([r["y"] for r in ins]), np.mean([r["y"] for r in ho])
    L = ["# S052 — when do 0DTE lottos pay? (reverse-engineered from S048)", "",
         f"Success = SPY travels ≥ {TRAVEL:.2%} from the checkpoint before the close. Checkpoints: in-sample {len(ins)} "
         f"({len({r['d'] for r in ins})} days, base win {base_in:.1%}), holdout {len(ho)} (base {base_ho:.1%}). "
         f"Features scanned: {len(rows[0]['f'])}.", "",
         "| feature | low tercile win % | high tercile win % | t (deflated) | same sign Jan–Mar / Apr–Jun |", "|---|---|---|---|---|"]
    cand = []
    for f in rows[0]["f"]:
        x = np.array([r["f"][f] for r in ins])
        binary = len(set(x)) <= 2
        lo_c, hi_c = (0.5, 0.5) if binary else np.quantile(x, [1 / 3, 2 / 3])
        lo = [r for r in ins if (r["f"][f] < 0.5 if binary else r["f"][f] <= lo_c)]
        hi = [r for r in ins if (r["f"][f] >= 0.5 if binary else r["f"][f] > hi_c)]
        a, b = np.array([r["y"] for r in lo]), np.array([r["y"] for r in hi])
        t = (b.mean() - a.mean()) / math.sqrt(a.var(ddof=1) / len(a) + b.var(ddof=1) / len(b) + 1e-12) / deflate
        sg = [np.sign(np.mean([r["y"] for r in hi if c(r)]) - np.mean([r["y"] for r in lo if c(r)]))
              for c in (lambda r: r["d"] < mid, lambda r: r["d"] >= mid)]
        L.append(f"| {f} | {a.mean():.1%} | {b.mean():.1%} | {t:+.2f} | {'yes' if sg[0] == sg[1] else 'no'} |")
        if abs(t) >= 2.5 and sg[0] == sg[1]:
            cand.append((abs(t), f, hi_c if t > 0 else lo_c, t > 0, binary))
    if cand:
        _, f, cut, high, binary = max(cand)
        sel = lambda rs: [r for r in rs if ((r["f"][f] >= 0.5) if binary else (r["f"][f] > cut)) == high]
        m_in, _ = boot_day(sel(ins))
        m_ho, ci = boot_day(sel(ho))
        ok = ci[0] > base_ho
        L += ["", f"**Confirmatory (one test): {f} {'high' if high else 'low'} (cut {cut:.3g}, fixed in-sample).**",
              f"- In-sample win {m_in:.1%} vs base {base_in:.1%}; holdout win {m_ho:.1%} (95 % CI {ci[0]:.1%}–{ci[1]:.1%}) "
              f"vs base {base_ho:.1%} → **{'PASS' if ok else 'FAIL'}** (CI must clear the holdout base).",
              "- Next if PASS: price the selected checkpoints with real 0DTE prints (S048 cache) to turn win rate into $."]
    else:
        L += ["", "**No feature cleared |t| ≥ 2.5 (deflated) with a stable sign.**"]
    # Step 2 (declared after reading the in-sample table above; holdout untouched until here): the stable features are
    # one factor — "today is a volatile day". Composite = mean in-sample z of the 5 stable-sign features; cut = in-sample
    # top tercile; one holdout test.
    comp = ["gap_open_sigma", "rv_today_over_iv", "iv_level", "prev_day_abs_ret", "minutes_left"]
    mu = {f: np.mean([r["f"][f] for r in ins]) for f in comp}
    sd = {f: np.std([r["f"][f] for r in ins]) for f in comp}
    for r in rows:
        r["vol_day"] = np.mean([(r["f"][f] - mu[f]) / sd[f] for f in comp])
    cut = np.quantile([r["vol_day"] for r in ins], 2 / 3)
    s_in = [r for r in ins if r["vol_day"] > cut]
    s_ho = [r for r in ho if r["vol_day"] > cut]
    m_in, _ = boot_day(s_in)
    m_ho, ci = boot_day(s_ho) if s_ho else (float("nan"), [float("nan")] * 2)
    L += ["", "## Step 2: composite 'volatile day' score (gap + RV/IV + IV + prior-day move + time left)",
          f"- In-sample top tercile: {len(s_in)} checkpoints / {len({r['d'] for r in s_in})} days, win {m_in:.1%} vs base {base_in:.1%}.",
          f"- Holdout: {len(s_ho)} checkpoints / {len({r['d'] for r in s_ho})} days, win {m_ho:.1%} (95 % CI {ci[0]:.1%}–{ci[1]:.1%}) "
          f"vs base {base_ho:.1%} → **{'PASS' if ci[0] > base_ho else 'FAIL'}** (CI must clear base).",
          "- Holdout signal days: " + ", ".join(sorted({f"{r['d']:%m-%d}" for r in s_ho}))]
    # Step 3: same composite, same in-sample mean/sd/cut, on 2024-10 → 2025-12 (incl. the Apr-2025 crash). One test.
    base2 = np.mean([r["y"] for r in ho2]) if ho2 else float("nan")
    s2 = [r for r in ho2 if r["vol_day"] > cut]
    m2, ci2 = boot_day(s2) if s2 else (float("nan"), [float("nan")] * 2)
    L += ["", "## Step 3: second holdout 2024-10 → 2025-12 (composite unchanged)",
          f"- {len(ho2)} checkpoints / {len({r['d'] for r in ho2})} days, base win {base2:.1%}.",
          f"- Composite top: {len(s2)} checkpoints / {len({r['d'] for r in s2})} days, win {m2:.1%} (95 % CI {ci2[0]:.1%}–"
          f"{ci2[1]:.1%}) → **{'PASS' if ci2[0] > base2 else 'FAIL'}**."]
    OUT.write_text("\n".join(L))
    print("\n".join(L[2:]))
    return rows, cut


if __name__ == "__main__":
    main()
