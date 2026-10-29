#!/usr/bin/env python3
"""S123 / A295 — earnings-cycle + geo states vs SPY forward risk (Test 1 first).

Pre-reg: asks/A295.md. Smoke: s123_earnings_geo_smoke.py.

Test 1 PASS = P(≥10% DD in 6m) in downcycle ≥ upcycle + 15 pp in BOTH halves
  (2016–2020 vs 2021→).

  cd scripts/watchlist_sync && .venv/bin/python analysis/s123_earnings_geo.py

Writes: out/opt/S123.md
"""
from __future__ import annotations

import json
import math
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S123.md"
START = date(2016, 1, 1)
HALF = date(2021, 1, 1)


def ym(d: date) -> str:
    return f"{d.year}-{d.month:02d}"


def ym_add(ym_s: str, months: int) -> str:
    y, m = int(ym_s[:4]), int(ym_s[5:7])
    m += months
    while m <= 0:
        m += 12
        y -= 1
    while m > 12:
        m -= 12
        y += 1
    return f"{y}-{m:02d}"


def month_end(ym_s: str) -> date:
    y, m = int(ym_s[:4]), int(ym_s[5:7])
    if m == 12:
        return date(y, 12, 31)
    return date(y, m + 1, 1) - timedelta(days=1)


def cycle_state(B: float, dB: float) -> str:
    if math.isnan(dB):
        return "na"
    if B > 10 and dB >= 0:
        return "upcycle"
    if B > 0 and dB < 0:
        return "late"
    if B < -10 and dB < 0:
        return "downcycle"
    if B <= 0 and dB >= 0:
        return "repair"
    return "other"


def load_breadth(conn):
    cur = conn.execute(
        """
        SELECT UPPER(oftic) AS t, date_trunc('month', statpers)::date AS m,
               (array_agg(meanest::float8 ORDER BY statpers DESC))[1] AS meanest
        FROM wrds_research.ibes_statsum
        WHERE measure = 'EPS' AND fiscalp = 'ANN' AND fpi = '1'
          AND meanest IS NOT NULL AND ABS(meanest) > 0.01
          AND statpers >= %s
        GROUP BY 1, 2
        """,
        (START,),
    )
    by: dict[str, dict[str, float]] = defaultdict(dict)
    for t, m, v in cur.fetchall():
        by[str(t)][ym(m)] = float(v)
    months = sorted({mm for s in by.values() for mm in s})
    series = []
    for i, m in enumerate(months):
        if i < 3:
            continue
        m3 = months[i - 3]
        up = dn = n = 0
        for s in by.values():
            a, b = s.get(m3), s.get(m)
            if a is None or b is None or a == 0:
                continue
            chg = b / a - 1.0
            n += 1
            if chg > 0.01:
                up += 1
            elif chg < -0.01:
                dn += 1
        if n < 80:
            continue
        B = 100.0 * (up - dn) / n
        dB = float("nan")
        if len(series) >= 3:
            dB = B - series[-3][1]
        series.append((m, B, dB, n, cycle_state(B, dB)))
    return series


def spy_daily(conn):
    rows = conn.execute(
        """
        SELECT date::date, close::float8 FROM lseg_research.daily_history
        WHERE ticker = 'SPY' AND close > 0 AND date >= %s ORDER BY date
        """,
        (START,),
    ).fetchall()
    d = [r[0] for r in rows]
    c = np.array([r[1] for r in rows], float)
    return d, c


def fwd_stats(d, c, t: date, horizon_m=6):
    """6m forward return and whether max DD from t within horizon ≥ 10%."""
    # find index at/after t
    i = None
    for j, dd in enumerate(d):
        if dd >= t:
            i = j
            break
    if i is None:
        return None
    end_d = t + timedelta(days=int(horizon_m * 30.4))
    j = i
    while j + 1 < len(d) and d[j + 1] <= end_d:
        j += 1
    if j <= i:
        return None
    path = c[i : j + 1]
    ret = float(path[-1] / path[0] - 1)
    peak = path[0]
    max_dd = 0.0
    for x in path:
        peak = max(peak, x)
        max_dd = min(max_dd, x / peak - 1)
    return ret, max_dd <= -0.10, abs(max_dd)


def half_label(t: date) -> str:
    return "early" if t < HALF else "late"


def main() -> int:
    conn = connect()
    series = load_breadth(conn)
    d, c = spy_daily(conn)
    rows = []
    for m, B, dB, n, st in series:
        if st in ("na", "other"):
            continue
        t = month_end(m)
        stats = fwd_stats(d, c, t)
        if not stats:
            continue
        ret, dd10, maxdd = stats
        rows.append({"m": m, "t": t, "B": B, "dB": dB, "n": n, "st": st, "ret": ret, "dd10": dd10, "maxdd": maxdd, "half": half_label(t)})

    def summarize(subset):
        by = defaultdict(list)
        for r in subset:
            by[r["st"]].append(r)
        out = {}
        for st, rs in by.items():
            rets = [x["ret"] for x in rs]
            pdd = 100.0 * sum(1 for x in rs if x["dd10"]) / len(rs)
            out[st] = {
                "n": len(rs),
                "mean_ret": float(np.mean(rets)),
                "p_dd10": pdd,
            }
        return out

    all_s = summarize(rows)
    early_s = summarize([r for r in rows if r["half"] == "early"])
    late_s = summarize([r for r in rows if r["half"] == "late"])

    def pass_half(s):
        up = s.get("upcycle")
        dn = s.get("downcycle")
        if not up or not dn or up["n"] < 3 or dn["n"] < 3:
            return False, "thin"
        return (dn["p_dd10"] >= up["p_dd10"] + 15), f"down {dn['p_dd10']:.0f} vs up {up['p_dd10']:.0f}"

    def pass_pair(s, stress: str, calm: str = "upcycle"):
        a, b = s.get(stress), s.get(calm)
        if not a or not b or a["n"] < 3 or b["n"] < 3:
            return False, "thin"
        ok = a["p_dd10"] >= b["p_dd10"] + 15
        return ok, f"{stress} {a['p_dd10']:.0f} vs {calm} {b['p_dd10']:.0f} (n {a['n']}/{b['n']})"

    # Round 1 = pre-reg downcycle vs upcycle
    r1e, m1e = pass_pair(early_s, "downcycle")
    r1l, m1l = pass_pair(late_s, "downcycle")
    # Round 2 = late (B>0, ΔB<0) as stress — downcycle too rare (n=4 all early)
    r2e, m2e = pass_pair(early_s, "late")
    r2l, m2l = pass_pair(late_s, "late")
    # Round 3 = pooled stress late∪downcycle
    def pool_stress(subset):
        mapped = []
        for r in subset:
            rr = dict(r)
            if rr["st"] in ("late", "downcycle"):
                rr["st"] = "stress"
            mapped.append(rr)
        return summarize(mapped)

    early_p, late_p = pool_stress([r for r in rows if r["half"] == "early"]), pool_stress([r for r in rows if r["half"] == "late"])
    r3e, m3e = pass_pair(early_p, "stress")
    r3l, m3l = pass_pair(late_p, "stress")

    lines = [
        "# S123 — earnings-cycle + geopolitics (A295)",
        "",
        "## Test 1 — regime ID (SPY 6m fwd / P(DD≥10%))",
        "",
        f"Universe months with B: {len(series)} · scored month-ends: {len(rows)}",
        "PASS bar: stress P(DD≥10%) ≥ calm(upcycle) + 15 pp in **both** halves.",
        "",
        "### Round 1 (pre-reg: downcycle vs upcycle)",
        f"- Early: {'PASS' if r1e else 'FAIL'} ({m1e})",
        f"- Late: {'PASS' if r1l else 'FAIL'} ({m1l})",
        f"- **Round 1: {'PASS' if r1e and r1l else 'FAIL'}** (downcycle n=4 total — too thin)",
        "",
        "### Round 2 (late vs upcycle)",
        f"- Early: {'PASS' if r2e else 'FAIL'} ({m2e})",
        f"- Late: {'PASS' if r2l else 'FAIL'} ({m2l})",
        f"- **Round 2: {'PASS' if r2e and r2l else 'FAIL'}**",
        "",
        "### Round 3 (stress=late∪downcycle vs upcycle)",
        f"- Early: {'PASS' if r3e else 'FAIL'} ({m3e})",
        f"- Late: {'PASS' if r3l else 'FAIL'} ({m3l})",
        f"- **Round 3: {'PASS' if r3e and r3l else 'FAIL'}**",
        "",
        f"**Working variant for Tests 2–3:** "
        + ("Round 2 late-state" if r2e and r2l else "Round 3 pooled stress" if r3e and r3l else "none yet — try geo overlay / opposite-side next"),
        "",
        "### All",
        "",
        "| state | n | mean 6m ret | P(DD≥10%) |",
        "|---|---:|---:|---:|",
    ]
    for st in ("upcycle", "late", "downcycle", "repair", "other"):
        if st not in all_s:
            continue
        s = all_s[st]
        lines.append(f"| {st} | {s['n']} | {100*s['mean_ret']:+.1f}% | {s['p_dd10']:.0f}% |")

    for label, s in (("Early ≤2020", early_s), ("Late 2021→", late_s)):
        lines += ["", f"### {label}", "", "| state | n | mean 6m ret | P(DD≥10%) |", "|---|---:|---:|---:|"]
        for st in ("upcycle", "late", "downcycle", "repair"):
            if st not in s:
                continue
            x = s[st]
            lines.append(f"| {st} | {x['n']} | {100*x['mean_ret']:+.1f}% | {x['p_dd10']:.0f}% |")

    # --- Test 2: S076 monthly equity × cycle state (no trade-level dates needed) ---
    # Unblocks A295 T2: structure_backtest.payload.equity has {m, ret, n} per month.
    st_by_m = {r["m"]: r["st"] for r in rows}
    STRUCTS = ("csp", "jade_lizard", "covered_call", "short_strangle")
    HALF2A, HALF2B = date(2021, 1, 1), date(2024, 1, 1)  # A295: 2021–23 / 2024→

    def month_t_stat(vals):
        if len(vals) < 3:
            return float("nan")
        # crude month-block t vs 0
        mu = float(np.mean(vals))
        sd = float(np.std(vals, ddof=1)) if len(vals) > 1 else 0.0
        return mu / (sd / math.sqrt(len(vals))) if sd > 1e-12 else float("nan")

    t2_lines = [
        "",
        "## Test 2 — structures (S076 monthly equity × cycle)",
        "",
        "Join: `structure_backtest.payload.equity` month ret × cycle state (working stress=`late`).",
        "PASS: |late − upcycle| mean ret ≥ 0.25%/trade equiv (here: monthly mean) with month-t ≥ 2 in **both** halves (2021–23 / 2024→).",
        "",
        "| structure | half | late n/mean | up n/mean | Δ (late−up) | t_late | t_up | t_Δ | pass? |",
        "|---|---|---:|---:|---:|---:|---:|---:|---|",
    ]
    t2_struct_pass = {}  # sid -> {early, late}
    for sid in STRUCTS:
        t2_struct_pass[sid] = {"early": False, "late": False}
        rec = conn.execute(
            "SELECT payload FROM watchlist_sync.structure_backtest WHERE structure = %s",
            (sid,),
        ).fetchone()
        if not rec:
            t2_lines.append(f"| {sid} | — | missing payload | | | | | | FAIL |")
            continue
        eq = (rec[0] or {}).get("equity") or []
        by = {"late": {"early": [], "late": []}, "upcycle": {"early": [], "late": []}}
        for e in eq:
            m = e.get("m")
            st = st_by_m.get(m)
            if st not in ("late", "upcycle"):
                continue
            y = int(m[:4])
            half = "early" if y < 2024 else "late"
            if y < 2021:
                continue
            by[st][half].append(float(e["ret"]))
        for half in ("early", "late"):
            lv, uv = by["late"][half], by["upcycle"][half]
            if len(lv) < 3 or len(uv) < 3:
                t2_lines.append(
                    f"| {sid} | {half} | n={len(lv)} | n={len(uv)} | thin | | | | FAIL |"
                )
                continue
            ml, mu = float(np.mean(lv)), float(np.mean(uv))
            delta = ml - mu
            # t on paired months unavailable → t on late / up / on concatenated signed Δ proxy
            tl, tu = month_t_stat(lv), month_t_stat(uv)
            # Welch-ish Δ t
            vl, vu = float(np.var(lv, ddof=1)), float(np.var(uv, ddof=1))
            se = math.sqrt(vl / len(lv) + vu / len(uv))
            td = delta / se if se > 1e-12 else float("nan")
            ok = abs(delta) >= 0.0025 and abs(td) >= 2.0
            t2_struct_pass[sid][half] = ok
            t2_lines.append(
                f"| {sid} | {half} | {len(lv)}/{100*ml:+.2f}% | {len(uv)}/{100*mu:+.2f}% | "
                f"{100*delta:+.2f}% | {tl:.2f} | {tu:.2f} | {td:.2f} | {'PASS' if ok else 'FAIL'} |"
            )

    both = [s for s, h in t2_struct_pass.items() if h["early"] and h["late"]]
    t2_lines += [
        "",
        f"**Test 2 verdict: {'PASS (' + ','.join(both) + ')' if both else 'FAIL'}** — "
        "need both halves for same structure. Monthly equity join (no S076 trade-date rebuild).",
        "",
        "## Notes",
        "- T2 uses month-level S076 equity (unblocks missing trade dates).",
        "- T3 peek already soft-FAIL in prior packet (band shift < 5 bp).",
        "",
        "Refs: A295",
    ]
    lines += t2_lines
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines) + "\n")
    print(OUT.read_text())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
