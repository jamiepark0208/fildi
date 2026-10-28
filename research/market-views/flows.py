"""AI supply-chain money-flow signpost: fiscal-period-matched IBES SAL revision by bucket (A293).

Revision at month-end statpers t = meanest(t) / meanest(t−3m) − 1 on the same fpedats (next FY ending
12–24 months after t). Reads wrds_research.ibes_statsum only.

Usage: research/wrds/.venv/bin/python research/market-views/flows.py
Writes: research/market-views/out/flows.md
"""
from __future__ import annotations

import json
import statistics
import sys
from datetime import date
from pathlib import Path

WRDS = Path(__file__).resolve().parents[1] / "wrds"
sys.path.insert(0, str(WRDS))
from db import connect_local  # noqa: E402

# one home for theme baskets: themes.json (Key Themes signposts read the same lists); labels kept from A293's report
LABELS = {"ai_spenders": "spenders", "chips": "chips", "memory": "memory/storage", "optics": "networking/optics",
          "power": "power/electrical", "neoclouds": "neoclouds/miners", "defense_tech": "defense tech",
          "rare_earths": "rare earths/materials"}
_BASKETS = json.loads((Path(__file__).with_name("themes.json")).read_text())["baskets"]
BUCKETS: dict[str, list[str]] = {label: _BASKETS[k] for k, label in LABELS.items()}
def min_names_for_bucket(tickers: list[str]) -> int:
    return min(3, len(tickers))


START_YM = "2025-01"
OUT = Path(__file__).with_name("out") / "flows.md"


def ym(d: date) -> str:
    return f"{d.year}-{d.month:02d}"


def ym_add(ym_s: str, delta: int) -> str:
    y, m = int(ym_s[:4]), int(ym_s[5:7])
    m += delta
    while m <= 0:
        m += 12
        y -= 1
    while m > 12:
        m -= 12
        y += 1
    return f"{y}-{m:02d}"


def ticker_oftics(conn) -> dict[str, str]:
    rows = conn.execute(
        """
        SELECT ticker, COALESCE(ibes_oftic, ticker) AS oftic
        FROM research_common.security_map
        """
    ).fetchall()
    return {str(t).upper(): str(o).upper() for t, o in rows}


def load_sal(conn) -> list[tuple[str, date, date, str, float]]:
    cur = conn.execute(
        """
        SELECT UPPER(oftic) AS oftic, statpers::date, fpedats::date, fpi::text, meanest::float
        FROM wrds_research.ibes_statsum
        WHERE measure = 'SAL' AND fiscalp = 'ANN' AND fpi IN ('1', '2', '3')
          AND statpers >= '2023-01-01' AND meanest IS NOT NULL AND meanest > 0
        """
    )
    return [(str(o), sp, fp, str(fpi), float(m)) for o, sp, fp, fpi, m in cur.fetchall()]


def month_end_statpers_by_o(rows: list[tuple[str, date, date, str, float]]) -> dict[str, dict[str, date]]:
    out: dict[str, dict[str, date]] = {}
    for o, sp, *_ in rows:
        k = ym(sp)
        out.setdefault(o, {})
        if k not in out[o] or sp > out[o][k]:
            out[o][k] = sp
    return out


def month_end_statpers(rows: list[tuple[str, date, date, str, float]]) -> dict[str, date]:
    out: dict[str, date] = {}
    for _, sp, *_ in rows:
        k = ym(sp)
        if k not in out or sp > out[k]:
            out[k] = sp
    return out


def pick_next_year(
    points: list[tuple[date, date, str, float]], t: date
) -> tuple[date, float] | None:
    cands: list[tuple[int, int, date, float]] = []
    for sp, fpe, fpi, mean in points:
        if sp != t:
            continue
        days = (fpe - t).days
        if 335 <= days <= 750:
            fpi_rank = {"1": 0, "2": 1, "3": 2}.get(fpi, 9)
            cands.append((fpi_rank, abs(days - 545), fpe, mean))
    if not cands:
        return None
    cands.sort(key=lambda x: (x[0], x[1]))
    return cands[0][2], cands[0][3]


def meanest_at_fpe(
    points: list[tuple[date, date, str, float]], sp: date, fpe: date
) -> float | None:
    """Same fpedats at an earlier statpers; fpi may differ after FY rollover."""
    vals = [mean for s, fp, _fpi, mean in points if s == sp and fp == fpe and mean > 0]
    return vals[0] if vals else None


def build_revision_index(
    rows: list[tuple[str, date, date, str, float]], statpers_by_ym: dict[str, date]
) -> dict[tuple[str, str], float]:
    by_o: dict[str, list[tuple[date, date, str, float]]] = {}
    per_o_ym = month_end_statpers_by_o(rows)
    for o, sp, fpe, fpi, mean in rows:
        by_o.setdefault(o, []).append((sp, fpe, fpi, mean))
    out: dict[tuple[str, str], float] = {}
    yms = sorted(statpers_by_ym)
    for o, ym_map in per_o_ym.items():
        pts = by_o[o]
        for ym_s in yms:
            if ym_s < START_YM or ym_s not in ym_map:
                continue
            ym3 = ym_add(ym_s, -3)
            if ym3 not in ym_map:
                continue
            t, t3 = ym_map[ym_s], ym_map[ym3]
            now = pick_next_year(pts, t)
            if now is None:
                continue
            fpe, mean_now = now
            prev_mean = meanest_at_fpe(pts, t3, fpe)
            if prev_mean is None or prev_mean <= 0:
                continue
            out[(o, ym_s)] = mean_now / prev_mean - 1
    return out


def aggregate_bucket(
    rev_idx: dict[tuple[str, str], float],
    oftics: list[str],
    statpers_by_ym: dict[str, date],
    min_n: int = 3,
) -> list[dict]:
    rows = []
    for ym_s in sorted(statpers_by_ym):
        if ym_s < START_YM or ym_add(ym_s, -3) not in statpers_by_ym:
            continue
        revs = [rev_idx[(o, ym_s)] for o in oftics if (o, ym_s) in rev_idx]
        if len(revs) < min_n:
            rows.append({"month": ym_s, "median_rev": None, "pct_up": None, "n_names": len(revs)})
        else:
            rows.append({
                "month": ym_s,
                "median_rev": statistics.median(revs),
                "pct_up": sum(1 for r in revs if r > 0) / len(revs),
                "n_names": len(revs),
            })
    return rows


def pct_fmt(x: float | None) -> str:
    return "—" if x is None else f"{x:+.1%}"


def format_table(bucket: str, df: list[dict]) -> list[str]:
    lines = [f"### {bucket}", "", "| month | median rev | % up | n |", "|---|---|---|---|"]
    for r in df:
        pup = "—" if r["pct_up"] is None else f"{r['pct_up']:.0%}"
        lines.append(
            f"| {r['month']} | {pct_fmt(r['median_rev'])} | {pup} | {r['n_names']} |"
        )
    valid = [r for r in df if r["median_rev"] is not None]
    if len(valid) >= 4:
        last3 = statistics.mean([r["median_rev"] for r in valid[-3:]])
        avg25 = statistics.mean([r["median_rev"] for r in valid])
        lines += ["", f"**Latest 3m avg median revision:** {last3:+.1%} · **2025 avg:** {avg25:+.1%}", ""]
    else:
        lines.append("")
    return lines


def main() -> int:
    with connect_local() as conn:
        ticker_map = ticker_oftics(conn)
        sal = load_sal(conn)
    if not sal:
        print("no SAL rows", file=sys.stderr)
        return 2
    statpers_by_ym = month_end_statpers(sal)
    rev_idx = build_revision_index(sal, statpers_by_ym)
    latest = max(sp for _, sp, *_ in sal)
    OUT.parent.mkdir(parents=True, exist_ok=True)

    out: list[str] = [
        "# IBES revenue revision flows (fiscal-period matched)",
        "",
        f"Data through statpers **{latest.isoformat()}**. Revision = FY matched meanest(t)/meanest(t−3m)−1.",
        "",
    ]
    results: dict[str, list[dict]] = {}
    for name, tickers in BUCKETS.items():
        oftics = [ticker_map.get(t, t) for t in tickers]
        df = aggregate_bucket(rev_idx, oftics, statpers_by_ym, min_names_for_bucket(tickers))
        results[name] = df
        out += format_table(name, df)

    all_o = sorted({o for o, *_ in sal})
    results["control (all SAL-covered)"] = aggregate_bucket(rev_idx, all_o, statpers_by_ym)
    out += format_table("control (all SAL-covered)", results["control (all SAL-covered)"])

    nvda = ticker_map.get("NVDA", "NVDA")
    feb = [(y, rev_idx[(nvda, y)]) for y in sorted(statpers_by_ym) if y.endswith("-02") and (nvda, y) in rev_idx]
    big = [x for x in feb if abs(x[1]) > 0.25]
    if big:
        print("WARN NVDA Feb |rev|>25%:", big, file=sys.stderr)

    OUT.write_text("\n".join(out), encoding="utf-8")
    print(f"wrote {OUT} ({len(rev_idx)} name-month revisions)")
    for name, df in results.items():
        if name.startswith("control"):
            continue
        if len(BUCKETS[name]) < 3:
            continue
        need = min_names_for_bucket(BUCKETS[name])
        bad = [r["month"] for r in df if r["n_names"] < need]
        if bad:
            print(f"FAIL {name}: n<{need} months {bad[:6]}{'…' if len(bad)>6 else ''}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
