#!/usr/bin/env python3
"""A357 step 4 — re-grade A352 champion edge on LSE traded entry premiums.

Run after `a357_lse_option_backfill.py` (full or --sample). Model entry uses BS at the snapped strike.
Pre-registered pass/fail: research/common/asks/A357.md.
"""
from __future__ import annotations

import argparse
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
from a357_lse_option_backfill import (  # noqa: E402
    collect_contracts,
    load_or_collect_sample_contracts,
    strike_for_event,
)
from a357_sample import SAMPLE_PATH, SampleEvent, load_sample_plan  # noqa: E402
from build_plan import connect  # noqa: E402

REPORT = ROOT / "research" / "studies" / "a357-real-price-regrade.md"
WEEK_FLOOR = date(2025, 10, 20)
HAIRCUTS = (0.0, 0.05, 0.10)


def edge_verdict(edge_t: float, edge_m: float, cov: float, ci_spans_zero: bool) -> str:
    """Coverage is a gate. The word holds/weakens/fails comes from the 5% haircut edge."""
    if cov < 0.60:
        return f"coverage {cov:.1%} < 60% (pre-registered bar)"
    if ci_spans_zero or not np.isfinite(edge_t) or not np.isfinite(edge_m) or edge_m == 0:
        return "underpowered"
    if (edge_t > 0) != (edge_m > 0):
        return "fails"
    if abs(edge_t) + 1e-12 >= 0.5 * abs(edge_m):
        return "holds"
    return "weakens"


def ci_spans_zero(champ: list[float], rnd: list[float]) -> bool:
    if len(champ) < 2 or len(champ) != len(rnd):
        return True
    d = np.asarray(champ, dtype=float) - np.asarray(rnd, dtype=float)
    se = float(d.std(ddof=1) / np.sqrt(len(d)))
    return abs(float(d.mean())) <= 1.96 * se


def _entry_close(conn, occ: str, entry: date) -> float | None:
    # entry+1 is the next session — using it as the entry premium looks ahead.
    for d in (entry, entry - timedelta(days=1)):
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


def _events_by_week_full(conn) -> tuple[dict[date, list[dict]], int, int]:
    """Legacy full-universe path (re-ranks via _tercile_book)."""
    contracts = [c for c in collect_contracts(conn) if c.source == "s059" and c.entry >= WEEK_FLOOR]
    rows_scored = A352.rebuild_book(conn)
    by_occ_entry: dict[tuple[str, date], dict] = {}
    for e in rows_scored:
        if e["d"] < WEEK_FLOOR:
            continue
        model = strike_for_event(conn, e)
        if model is None:
            continue
        cands = [c for c in contracts if c.ticker == e["t"] and c.entry == e["d"] and c.expiry == e["expiry"]]
        if not cands:
            continue
        c = cands[0]
        by_occ_entry[(c.occ, e["d"])] = {**e, "contract": c, "model_strike": model, "snapped": c.strike}

    out: dict[date, list[dict]] = defaultdict(list)
    for e in by_occ_entry.values():
        out[e["d"]].append(e)
    n_plan = sum(len(v) for v in out.values())
    return out, n_plan, len(out)


def _events_by_week_sample(conn, plan: list[SampleEvent]) -> tuple[dict[date, list[dict]], int, int]:
    contracts = load_or_collect_sample_contracts(conn, plan)
    aligned = {(e["t"], e["d"], e["expiry"]): e for e in S59.aligned_events(conn)}
    out: dict[date, list[dict]] = defaultdict(list)
    for se in plan:
        if se.entry() < WEEK_FLOOR:
            continue
        key = (se.t, se.entry(), se.expiry_date())
        e = aligned.get(key)
        if not e:
            continue
        cands = [c for c in contracts if c.ticker == se.t and c.entry == se.entry() and c.expiry == se.expiry_date()]
        if not cands:
            continue
        c = cands[0]
        model = strike_for_event(conn, e)
        row = {
            **e,
            "contract": c,
            "model_strike": model,
            "snapped": c.strike,
            "score": se.score,
            "book": se.book,
        }
        out[se.entry()].append(row)
    n_plan = len(plan)
    n_days = len({se.d for se in plan})
    return out, n_plan, n_days


def _attach_traded(conn, events: list[dict]) -> tuple[list[dict], dict[str, int]]:
    ready: list[dict] = []
    drops: dict[str, int] = {"no_entry_close": 0, "no_spot_settle": 0}
    for e in events:
        c = e["contract"]
        traded = _entry_close(conn, c.occ, c.entry)
        if traded is None:
            drops["no_entry_close"] += 1
            continue
        spot, settle = _spot_settle(conn, c.ticker, e["d"], e["expiry"])
        if not spot or not settle:
            drops["no_spot_settle"] += 1
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
    return ready, drops


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


def _tagged_tercile_book(by: dict[date, list[dict]], key: str, h: float) -> tuple[list[float], list[float], int]:
    """Grade champion/random from pre-registered `book` tags (no re-rank on traded subset)."""
    champ, rnd = [], []
    n_weeks = 0
    for d in sorted(by):
        g = by[d]
        ch = [x for x in g if x.get("book") in ("champion", "both")]
        rn = [x for x in g if x.get("book") in ("random", "both")]
        if not ch or not rn:
            continue
        champ.append(float(np.mean([x[key][h] for x in ch])))
        rnd.append(float(np.mean([x[key][h] for x in rn])))
        n_weeks += 1
    return champ, rnd, n_weeks


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--interim", action="store_true", help="Mark report INTERIM (partial sample backfill)")
    args = ap.parse_args()

    sample_loaded = load_sample_plan()
    use_tags = sample_loaded is not None

    with connect() as conn:
        n_occ = conn.execute("SELECT COUNT(DISTINCT occ)::int FROM lse_option_daily").fetchone()[0]
        if use_tags:
            plan_events, meta = sample_loaded
            by_week, n_plan, n_days_plan = _events_by_week_sample(conn, plan_events)
            flat = [e for g in by_week.values() for e in g]
            with_traded, drops = _attach_traded(conn, flat)
            n_eligible = len(flat)
            no_snap = n_plan - n_eligible
            cov_gate = len(with_traded) / n_eligible if n_eligible else 0.0
            cov_plan = len(with_traded) / n_plan if n_plan else 0.0
            grade = _tagged_tercile_book
        else:
            by_week, n_plan, n_days_plan = _events_by_week_full(conn)
            flat = [e for g in by_week.values() for e in g]
            with_traded, drops = _attach_traded(conn, flat)
            n_eligible = n_plan
            no_snap = 0
            cov_gate = len(with_traded) / n_eligible if n_eligible else 0.0
            cov_plan = cov_gate
            grade = _tercile_book

        by: dict[date, list[dict]] = defaultdict(list)
        for e in with_traded:
            by[e["d"]].append(e)

        header = "# A357 — real-price re-grade (LSE traded entry)"
        cov_events = cov_gate
        if args.interim or (use_tags and cov_gate < 0.60):
            header += " · **INTERIM**"

        lines = [
            header,
            "",
            f"LSE daily OCCs: {n_occ} · sample plan: {n_plan} events / {n_days_plan} entry days"
            if use_tags
            else f"Contracts with S059 entry ≥ {WEEK_FLOOR}: {n_plan}",
            f"Snapped contracts (eligible): {n_eligible} · with traded entry: {len(with_traded)} ({cov_gate:.1%} of eligible; {cov_plan:.1%} of plan)",
            "",
        ]
        if use_tags and (no_snap or any(drops.values())):
            lines += [
                "## Coverage drops",
                f"- no_listed_strike / unsnapped: {no_snap}",
                f"- no LSE entry close (±1d, entry day only): {drops['no_entry_close']}",
                f"- missing spot/settle: {drops['no_spot_settle']}",
                "",
            ]
        if use_tags:
            lines.append(f"Selection: `{SAMPLE_PATH}` (tagged champion/random; no re-rank on traded subset).")
            lines.append("")

        edge_at_5: tuple[float, float, bool] | None = None
        for h in HAIRCUTS:
            if use_tags:
                ct, rt, nw = grade(by, "pnl_traded", h)
                cm, rm, _ = grade(by, "pnl_model", h)
            else:
                ct, rt = grade(by, "pnl_traded", h)
                cm, rm = grade(by, "pnl_model", h)
                nw = len(ct)
            if len(ct) < 1:
                lines.append(f"## Haircut {h:.0%}: no graded weeks yet")
                continue
            edge_t = (np.mean(ct) - np.mean(rt)) * 1e4
            edge_m = (np.mean(cm) - np.mean(rm)) * 1e4
            sign_match = (edge_t > 0) == (edge_m > 0)
            spans = ci_spans_zero(ct, rt)
            if abs(h - 0.05) < 1e-9:
                edge_at_5 = (edge_t, edge_m, spans)
            lines += [
                f"## Haircut {h:.0%} ({nw} weeks)",
                f"- Champion − random (traded): **{edge_t:+.1f} bp/wk** · modelled side-by-side: **{edge_m:+.1f} bp/wk**",
                f"- Same sign: {sign_match} · size ratio: {(abs(edge_t / edge_m) if edge_m else float('nan')):.2f}",
                f"- Week-difference CI spans 0: {spans}",
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

        if edge_at_5 is None:
            verdict = "underpowered"
            if cov_gate < 0.60:
                verdict = f"coverage {cov_gate:.1%} < 60% (pre-registered bar, eligible contracts)"
        else:
            verdict = edge_verdict(edge_at_5[0], edge_at_5[1], cov_gate, edge_at_5[2])
        if args.interim and verdict == "holds":
            verdict = "holds (interim)"
        lines += [f"**5% haircut edge (pre-registered):** **{verdict}**.", ""]

        REPORT.parent.mkdir(parents=True, exist_ok=True)
        REPORT.write_text("\n".join(lines))
        print("\n".join(lines[:14]), flush=True)
        print(f"Wrote {REPORT}", flush=True)


if __name__ == "__main__":
    main()
