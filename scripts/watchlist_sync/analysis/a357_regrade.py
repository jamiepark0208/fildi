#!/usr/bin/env python3
"""A357 step 4 — re-grade A352 champion edge on LSE traded entry premiums.

Run after full `a357_lse_option_backfill.py`. Model entry uses BS at the snapped strike (like S059).
Pre-registered pass/fail: research/common/asks/A357.md.
"""
from __future__ import annotations

import math
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
SYNC = HERE.parent
ROOT = SYNC.parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(SYNC))

import a352_score_rank as A352  # noqa: E402
import s045_put_retest as S045  # noqa: E402
import s059_option_factors as S59  # noqa: E402
from a357_lse_option_backfill import ENTRY_CUT, collect_contracts, strike_for_event  # noqa: E402
from build_plan import connect  # noqa: E402
from grade_weeks import iso_week  # noqa: E402
from lse_client import snap_put_strike  # noqa: E402

REPORT = ROOT / "research" / "studies" / "a357-real-price-regrade.md"
WEEK_FLOOR = date(2025, 10, 20)
HAIRCUTS = (0.0, 0.05, 0.10)
MIN_BACKFILL_OCC = 500


def _entry_close(conn, occ: str, entry: date) -> float | None:
    for d in (entry, entry - timedelta(days=1), entry + timedelta(days=1)):
        row = conn.execute(
            """SELECT close::float8 FROM lse_option_daily
               WHERE occ = %s AND date = %s AND close IS NOT NULL AND close > 0""",
            (occ, d),
        ).fetchone()
        if row:
            return float(row[0])
    return None


def _spot_settle(conn, ticker: str, d0: date, exp: date) -> tuple[float | None, float | None]:
    px = A352._closes(conn, [ticker], [d0, exp])
    return px.get((ticker, d0)), px.get((ticker, exp))


def _model_prem_snap(spot: float, strike: float, iv_pct: float, hold_sessions: int) -> float:
    iv = iv_pct / 100.0 if iv_pct > 3 else iv_pct
    t = hold_sessions / 252.0
    return S045.bs_put(spot, strike, iv, t)


def _short_pnl(entry_prem: float, strike: float, settle: float) -> float:
    intrinsic = max(0.0, strike - settle)
    return (entry_prem - intrinsic) / strike


def _events_by_week(conn) -> dict[date, list[dict]]:
    """S059 entries ≥ cut with snapped strikes + scores (weeks ≥ WEEK_FLOOR only)."""
    contracts = {c.occ: c for c in collect_contracts(conn) if c.source == "s059" and c.entry >= WEEK_FLOOR}
    rows_scored = A352.rebuild_book(conn)
    by_occ_entry: dict[tuple[str, date], dict] = {}
    for e in rows_scored:
        if e["d"] < WEEK_FLOOR:
            continue
        model = strike_for_event(conn, e)
        if model is None:
            continue
        cands = [c for c in contracts.values() if c.ticker == e["t"] and c.entry == e["d"] and c.expiry == e["expiry"]]
        if not cands:
            continue
        c = cands[0]
        by_occ_entry[(c.occ, e["d"])] = {**e, "contract": c, "model_strike": model, "snapped": c.strike}

    out: dict[date, list[dict]] = defaultdict(list)
    for e in by_occ_entry.values():
        out[e["d"]].append(e)
    return out


def _attach_traded(conn, events: list[dict]) -> list[dict]:
    ready = []
    for e in events:
        c = e["contract"]
        traded = _entry_close(conn, c.occ, c.entry)
        if traded is None:
            continue
        spot, settle = _spot_settle(conn, c.ticker, e["d"], e["expiry"])
        if not spot or not settle:
            continue
        model_prem = _model_prem_snap(spot, c.strike, float(e["iv30"]), int(e["hold_sessions"]))
        row = {
            **e,
            "traded_prem": traded,
            "model_prem": model_prem,
            "spot": spot,
            "settle": settle,
            "strike": c.strike,
            "delta": A352.put_delta(spot, c.strike, float(e["iv30"]) / 100.0, e["hold_sessions"] / 252.0),
        }
        row["pnl_traded"] = {h: _short_pnl(traded * (1.0 - h), c.strike, settle) for h in HAIRCUTS}
        row["pnl_model"] = {h: _short_pnl(model_prem * (1.0 - h), c.strike, settle) for h in HAIRCUTS}
        ready.append(row)
    return ready


def _tercile_book(by: dict[date, list[dict]], key: str, h: float) -> tuple[list[float], list[float]]:
    champ, rnd = [], []
    for d in sorted(by):
        g = by[d]
        if len(g) < 20:
            continue
        ranked = sorted(g, key=lambda x: (-x["score"], x["t"]))
        n = max(1, len(g) // 3)
        top = ranked[:n]
        rng = np.random.default_rng(int(d.strftime("%Y%m%d")))
        pick = rng.choice(len(g), size=n, replace=False)
        rand = [g[i] for i in pick]
        champ.append(float(np.mean([x[key][h] for x in top])))
        rnd.append(float(np.mean([x[key][h] for x in rand])))
    return champ, rnd


def main() -> None:
    with connect() as conn:
        n_occ = conn.execute("SELECT COUNT(DISTINCT occ)::int FROM lse_option_daily").fetchone()[0]
        if n_occ < MIN_BACKFILL_OCC:
            raise SystemExit(
                f"A357 regrade blocked: lse_option_daily has {n_occ} OCC(s) (need ≥ {MIN_BACKFILL_OCC}). "
                "Wait for backfill to finish."
            )
        by_week = _events_by_week(conn)
        flat = [e for g in by_week.values() for e in g]
        n_total = len(flat)
        with_traded = _attach_traded(conn, flat)
        cov = len(with_traded) / n_total if n_total else 0.0

        by: dict[date, list[dict]] = defaultdict(list)
        for e in with_traded:
            by[e["d"]].append(e)

        lines = [
            "# A357 — real-price re-grade (LSE traded entry)",
            "",
            f"Contracts with S059 entry ≥ {WEEK_FLOOR}: {n_total} · traded entry found: {len(with_traded)} ({cov:.1%} coverage)",
            "",
        ]
        for h in HAIRCUTS:
            ct, rt = _tercile_book(by, "pnl_traded", h)
            cm, rm = _tercile_book(by, "pnl_model", h)
            if len(ct) < 4:
                lines.append(f"## Haircut {h:.0%}: too few weeks")
                continue
            edge_t = (np.mean(ct) - np.mean(rt)) * 1e4
            edge_m = (np.mean(cm) - np.mean(rm)) * 1e4
            sign_match = (edge_t > 0) == (edge_m > 0)
            lines += [
                f"## Haircut {h:.0%}",
                f"- Champion − random (traded): **{edge_t:+.1f} bp/wk** · modelled side-by-side: **{edge_m:+.1f} bp/wk**",
                f"- Same sign: {sign_match} · size ratio: {abs(edge_t / edge_m) if edge_m else float('nan'):.2f}",
                "",
            ]

        ratios = [
            e["traded_prem"] / e["model_prem"]
            for e in with_traded
            if e["model_prem"] and e["model_prem"] > 0
        ]
        if ratios:
            arr = np.asarray(ratios)
            lines += [
                "## Modelled vs traded entry (snapped strike)",
                f"- Median ratio: {float(np.median(arr)):.3f} · IQR [{float(np.quantile(arr, 0.25)):.3f}, {float(np.quantile(arr, 0.75)):.3f}]",
                "",
            ]

        verdict = "holds" if cov >= 0.60 and lines[-1] != "" else "underpowered"
        if cov < 0.60:
            verdict = "blocked (coverage < 60%)"
        lines += [f"**Pre-registered coverage:** {cov:.1%} → **{verdict}** (detail pass/fail after full backfill).", ""]

        REPORT.parent.mkdir(parents=True, exist_ok=True)
        REPORT.write_text("\n".join(lines))
        print("\n".join(lines[:12]), flush=True)
        print(f"Wrote {REPORT}", flush=True)


if __name__ == "__main__":
    main()
