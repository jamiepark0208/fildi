#!/usr/bin/env python3
"""S123 / A295 smoke — earnings-cycle breadth B(t) on 20 names × ~2y; hand-check 3 months.

Full study (structures × bands × geo) waits on this smoke clearing. Pre-reg in asks/A295.md.

  cd scripts/watchlist_sync && .venv/bin/python analysis/s123_earnings_geo_smoke.py

Writes: out/opt/S123-smoke.md
"""
from __future__ import annotations

import math
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S123-smoke.md"
SMOKE_TICKERS = [
    "AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "AVGO", "AMD",
    "JPM", "XOM", "CVX", "UNH", "JNJ", "WMT", "COST", "CAT", "BA", "GE", "TSLA", "NFLX",
]
START = date(2024, 1, 1)
HAND_CHECK_YMS = ("2025-06", "2025-09", "2025-12")


def ym(d: date) -> str:
    return f"{d.year}-{d.month:02d}"


def load_eps_panel(conn, tickers: list[str]):
    """Month-end EPS FY1 meanest by ticker (oftic≈ticker)."""
    cur = conn.execute(
        """
        SELECT UPPER(oftic) AS t, statpers::date AS d, meanest::float8 AS m
        FROM wrds_research.ibes_statsum
        WHERE measure = 'EPS' AND fiscalp = 'ANN' AND fpi = '1'
          AND meanest IS NOT NULL AND ABS(meanest) > 0.01
          AND statpers >= %s
          AND UPPER(oftic) = ANY(%s)
        ORDER BY oftic, statpers
        """,
        (START, tickers),
    )
    by: dict[str, dict[str, float]] = defaultdict(dict)
    for t, d, m in cur.fetchall():
        k = ym(d)
        # keep last print in month
        by[str(t)][k] = float(m)
    return by


def breadth_series(by_ticker: dict[str, dict[str, float]]) -> list[tuple[str, float, float, int]]:
    """Return (ym, B, dB_3m, n) where B = pct up>1% − pct down>1% over 3m on FY1 EPS."""
    months = sorted({m for series in by_ticker.values() for m in series})
    out = []
    for i, m in enumerate(months):
        if i < 3:
            continue
        m3 = months[i - 3]
        up = dn = n = 0
        for series in by_ticker.values():
            a, b = series.get(m3), series.get(m)
            if a is None or b is None or a == 0:
                continue
            chg = b / a - 1.0
            n += 1
            if chg > 0.01:
                up += 1
            elif chg < -0.01:
                dn += 1
        if n < 8:
            continue
        B = 100.0 * (up - dn) / n
        # ΔB vs prior available with lag 3 months in series
        dB = float("nan")
        if len(out) >= 3:
            dB = B - out[-3][1]
        out.append((m, B, dB, n))
    return out


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
    return "near_" + ("pos" if B > 0 else "neg")


def hand_check(conn, by_ticker: dict[str, dict[str, float]], yms: tuple[str, ...]) -> list[str]:
    lines = []
    for m in yms:
        # pick NVDA/AAPL/JPM if present
        for t in ("NVDA", "AAPL", "JPM"):
            series = by_ticker.get(t) or {}
            if m not in series:
                lines.append(f"- {t} {m}: missing meanest")
                continue
            # prior 3m key
            y, mo = int(m[:4]), int(m[5:7])
            mo -= 3
            while mo <= 0:
                mo += 12
                y -= 1
            m3 = f"{y}-{mo:02d}"
            a, b = series.get(m3), series[m]
            if a is None:
                lines.append(f"- {t} {m}: have {b:.3f} but no {m3}")
                continue
            chg = b / a - 1
            # raw row count near month-end
            cur = conn.execute(
                """
                SELECT statpers::date, meanest::float8, numest
                FROM wrds_research.ibes_statsum
                WHERE UPPER(oftic) = %s AND measure = 'EPS' AND fiscalp = 'ANN' AND fpi = '1'
                  AND statpers >= %s::date - 5 AND statpers <= %s::date + 5
                ORDER BY statpers DESC LIMIT 3
                """,
                (t, f"{m}-28", f"{m}-28"),
            )
            rows = cur.fetchall()
            lines.append(
                f"- {t} {m}: FY1 {a:.3f}→{b:.3f} ({chg:+.1%}) vs {m3}; raw near month-end: {rows}"
            )
    return lines


def main() -> int:
    conn = connect()
    by = load_eps_panel(conn, SMOKE_TICKERS)
    n_tickers = sum(1 for t in SMOKE_TICKERS if by.get(t))
    series = breadth_series(by)
    checks = hand_check(conn, by, HAND_CHECK_YMS)

    # geo stress peek
    geo = conn.execute(
        """
        SELECT date::date, value::float8 FROM watchlist_sync.macro_daily
        WHERE series = 'gprd_ma30' AND date >= %s ORDER BY date
        """,
        (START,),
    ).fetchall()
    geo_n = len(geo)
    geo_last = geo[-1] if geo else None

    lines = [
        "# S123 / A295 smoke — earnings breadth B(t)",
        "",
        f"Tickers with IBES EPS FY1 since {START}: **{n_tickers}/{len(SMOKE_TICKERS)}**",
        f"Breadth months computed: **{len(series)}**",
        f"GPRD_MA30 rows since {START}: **{geo_n}**" + (f" (last {geo_last[0]} = {geo_last[1]:.2f})" if geo_last else ""),
        "",
        "## Recent B(t)",
        "",
        "| ym | B | ΔB 3m | n | state |",
        "|---|---:|---:|---:|---|",
    ]
    for m, B, dB, n in series[-18:]:
        st = cycle_state(B, dB)
        dBs = "—" if math.isnan(dB) else f"{dB:+.1f}"
        lines.append(f"| {m} | {B:+.1f} | {dBs} | {n} | {st} |")

    lines += ["", "## Hand-check (3 months × NVDA/AAPL/JPM)", ""] + checks
    lines += [
        "",
        "## Smoke verdict",
        "",
        "- PASS smoke if: ≥15/20 tickers have EPS, ≥12 months of B, hand-check Δ matches raw IBES within rounding,",
        "  and gprd_ma30 has rows.",
        f"- Result: tickers={n_tickers}/20 · months={len(series)} · geo_rows={geo_n} · "
        + ("**continue to full S123**" if n_tickers >= 15 and len(series) >= 12 and geo_n > 10 else "**blocked — fix data**"),
        "",
        "Refs: A295 · next: full script on 949-name universe + S076/S101 join (fit ≤2022, grade 2023→).",
    ]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines) + "\n")
    print(OUT.read_text())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
