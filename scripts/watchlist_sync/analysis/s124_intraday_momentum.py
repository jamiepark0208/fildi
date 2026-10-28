"""S124 / A184 #2 — intraday momentum (Gao, Han, Li & Zhou 2018).

Pre-registered (asks/A276 Claude plan 2026-10-26): SPY/QQQ optlab.minute_bars Jan→Oct 2026.
Sign of first 30-min return (prior close → 10:00) → trade last 30 min (15:30 → 15:59 close).
Works = mean last-30 in that direction > 1 bp/day after 1 bp cost, Newey-West t ≥ 2,
same sign Jan–May vs Jun–Oct, and beats always-long last-30. |t| < 1 → FAIL.
Minute CLOSES only (S052 bad-tick caveat on h/l).

    cd scripts/watchlist_sync && nice -n 15 .venv/bin/python analysis/s124_intraday_momentum.py [--smoke] [--fetch-qqq]
"""
from __future__ import annotations

import math
import sys
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402

NY = ZoneInfo("America/New_York")
START, MID, END = date(2026, 1, 2), date(2026, 6, 1), date(2026, 10, 16)
COST = 0.0001  # 1 bp
NAMES = ("SPY", "QQQ")
OUT = HERE.parent / "out" / "opt" / "S124.md"
PACKET = HERE.parent / "out" / "opt" / "A276-S124-packet.md"


def ensure_qqq(conn) -> None:
    """Pull QQQ 1-min bars into optlab.minute_bars if missing (Polygon, cached)."""
    import s048_0dte as S048

    S048.ensure(conn)
    n = conn.execute("SELECT COUNT(*) FROM optlab.minute_bars WHERE ticker = 'QQQ'").fetchone()[0]
    if n > 10_000:
        return
    print(f"fetching QQQ minute bars ({n} rows so far)…", flush=True)
    # chunk by month to keep Polygon payloads manageable
    d0 = START
    while d0 <= END:
        d1 = min(date(d0.year + (d0.month // 12), (d0.month % 12) + 1, 1) - timedelta(days=1), END)
        S048.minute_bars(conn, "QQQ", d0, d1)
        d0 = d1 + timedelta(days=1)


def load(conn, tickers=NAMES):
    out = {}
    for t in tickers:
        bars = defaultdict(list)
        for ts, c in conn.execute(
            """SELECT ts, c FROM optlab.minute_bars WHERE ticker = %s
               AND (ts AT TIME ZONE 'America/New_York')::date BETWEEN %s AND %s
               AND (ts AT TIME ZONE 'America/New_York')::time BETWEEN '09:30' AND '15:59'
               ORDER BY ts""",
            (t, START, END),
        ):
            tt = ts.astimezone(NY)
            bars[tt.date()].append((tt.time(), float(c)))
        out[t] = bars
    return out


def build(bars_by_t: dict) -> list[dict]:
    rows = []
    for t, bars in bars_by_t.items():
        days = sorted(bars)
        for i in range(1, len(days)):
            d, p = days[i], days[i - 1]
            b, pb = bars[d], bars[p]
            if len(b) < 300 or len(pb) < 100:
                continue
            prior_close = pb[-1][1]
            c1000 = next((x[1] for x in b if x[0] >= time(10, 0)), None)
            c1530 = next((x[1] for x in b if x[0] >= time(15, 30)), None)
            close = next((x[1] for x in reversed(b) if x[0] <= time(15, 59)), None)
            if not (c1000 and c1530 and close and prior_close > 0):
                continue
            first30 = c1000 / prior_close - 1
            last30 = close / c1530 - 1
            signed = math.copysign(1.0, first30) * last30 if first30 != 0 else 0.0
            rows.append(
                dict(
                    t=t,
                    d=d,
                    first30=first30,
                    last30=last30,
                    signed=signed,
                    always=last30,
                )
            )
    return rows


def nw_t(x: np.ndarray, lags: int = 5) -> float:
    """Newey-West t-stat for mean (HAC)."""
    n = len(x)
    if n < lags + 2:
        return float("nan")
    mu = x.mean()
    e = x - mu
    gamma0 = np.dot(e, e) / n
    s = gamma0
    for L in range(1, lags + 1):
        w = 1 - L / (lags + 1)
        g = np.dot(e[L:], e[:-L]) / n
        s += 2 * w * g
    if s <= 0:
        return float("nan")
    return float(mu / math.sqrt(s / n))


def summ(xs: list[dict], key="signed") -> tuple:
    if not xs:
        return 0, float("nan"), float("nan"), float("nan")
    v = np.array([r[key] for r in xs], dtype=float) - COST
    return len(v), float(v.mean()), nw_t(v), float(np.mean(v > 0))


def main() -> None:
    conn = connect()
    if "--fetch-qqq" in sys.argv or True:
        try:
            ensure_qqq(conn)
        except Exception as e:
            print(f"QQQ fetch skipped/failed: {e}", flush=True)
            conn.rollback()
    data = load(conn)
    for t, bars in data.items():
        print(f"{t}: {len(bars)} sessions", flush=True)
    rows = build(data)
    if "--smoke" in sys.argv:
        for r in rows[:8]:
            print(
                f"{r['t']} {r['d']} first30 {r['first30']:+.3%} last30 {r['last30']:+.3%} "
                f"signed {r['signed']:+.3%}"
            )
        return

    half1 = [r for r in rows if r["d"] < MID]
    half2 = [r for r in rows if r["d"] >= MID]
    L = [
        "# S124 — intraday momentum SPY/QQQ (Gao et al. 2018; A184 #2 / A276)",
        "",
        f"Window {START} → {END}; signal = sign(prior close→10:00); trade 15:30→close; cost {COST:.2%} (1 bp).",
        f"n={len(rows)} name-days (SPY {sum(1 for r in rows if r['t']=='SPY')}, "
        f"QQQ {sum(1 for r in rows if r['t']=='QQQ')}). Minute closes only.",
        "",
        "| slice | n | mean after cost | NW-t | win % |",
        "|---|---|---|---|---|",
    ]
    slices = [
        ("signed momentum (all)", rows, "signed"),
        ("always-long last-30", rows, "always"),
        ("signed · Jan–May", half1, "signed"),
        ("signed · Jun–Oct", half2, "signed"),
        ("SPY signed", [r for r in rows if r["t"] == "SPY"], "signed"),
        ("QQQ signed", [r for r in rows if r["t"] == "QQQ"], "signed"),
    ]
    stats = {}
    for lab, xs, key in slices:
        n, m, t, w = summ(xs, key)
        stats[lab] = (n, m, t, w)
        L.append(f"| {lab} | {n} | {m:+.4%} | {t:+.2f} | {w:.0%} |")

    n, m, t, _ = stats["signed momentum (all)"]
    h1, h2 = stats["signed · Jan–May"][1], stats["signed · Jun–Oct"][1]
    always_m = stats["always-long last-30"][1]
    beats = m > always_m if not math.isnan(m) and not math.isnan(always_m) else False
    same = (h1 > 0 and h2 > 0) or (h1 < 0 and h2 < 0)
    # Pre-registered: mean > 1 bp after cost, NW-t ≥ 2, same sign halves, beats always-long
    # |t| < 1 → FAIL hard
    if abs(t) < 1 or math.isnan(t):
        verdict = "FAIL"
        why = f"|t|={abs(t):.2f}<1 (underpowered / no edge)"
    elif m > COST and t >= 2 and same and beats:
        verdict = "PASS"
        why = f"mean {m:+.4%} NW-t {t:+.2f}, halves same sign, beats always-long {always_m:+.4%}"
    else:
        verdict = "FAIL"
        why = (
            f"mean {m:+.4%} (need >1bp net), NW-t {t:+.2f} (need ≥2), "
            f"halves {h1:+.4%}/{h2:+.4%} same={same}, beats always-long={beats}"
        )
    L += ["", f"**Verdict: {verdict}** — {why}.", ""]
    # hand-check row
    hc = next((r for r in rows if r["t"] == "SPY" and r["d"] == date(2026, 1, 14)), rows[10] if len(rows) > 10 else None)
    if hc:
        L += [
            "## Hand-check",
            f"- {hc['t']} {hc['d']}: prior→10:00 {hc['first30']:+.3%}, 15:30→close {hc['last30']:+.3%}, "
            f"signed {hc['signed']:+.3%} (after cost {hc['signed']-COST:+.3%})",
        ]
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L[2:]))

    # A238 packet (≤20 lines) — numbers only, no verdict wording for Claude
    pk = [
        "# A276 packet — S124 (A184 #2 intraday momentum)",
        f"- script: `analysis/s124_intraday_momentum.py` · window {START}→{END}",
        f"- n={n} name-days · signed mean after 1bp cost {m:+.4%} · NW-t {t:+.2f}",
        f"- halves Jan–May {h1:+.4%} / Jun–Oct {h2:+.4%} · always-long last-30 {always_m:+.4%}",
        f"- SPY n={stats['SPY signed'][0]} mean {stats['SPY signed'][1]:+.4%} · "
        f"QQQ n={stats['QQQ signed'][0]} mean {stats['QQQ signed'][1]:+.4%}",
        f"- bar: mean>1bp after cost, NW-t≥2, same-sign halves, beats always-long",
        f"- hand-check: {hc['t'] if hc else 'n/a'} {hc['d'] if hc else ''} "
        f"first30 {hc['first30']:+.3%} last30 {hc['last30']:+.3%} signed {hc['signed']:+.3%}"
        if hc
        else "- hand-check: none",
        f"- surprises: QQQ rows={sum(1 for r in rows if r['t']=='QQQ')}; minute closes only (no h/l)",
        f"- out: `out/opt/S124.md`",
        f"- cursor_verdict_hint (Claude owns wording): {verdict}",
    ]
    PACKET.write_text("\n".join(pk) + "\n")
    print("wrote", OUT, PACKET)


if __name__ == "__main__":
    for p in (Path(__file__).resolve().parents[3] / ".env.local",):
        if p.is_file():
            from dotenv import load_dotenv

            load_dotenv(p)
    main()
