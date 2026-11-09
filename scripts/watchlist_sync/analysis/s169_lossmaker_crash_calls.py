#!/usr/bin/env python3
"""S169 / A244 — long calls after crash on loss-makers vs profitable names (skew-priced).

Reuses S167 / S076 Pricer, long_call_unreal, fills (bid+23%), tbill_at, Δ-stock same $debit.
Entries: E1 own 5d≤−20%, E2 SPY 5d≤−4%, E0 every 5th day. Train <2024-07-01, test ≥.

    cd scripts/watchlist_sync && .venv/bin/python analysis/s169_lossmaker_crash_calls.py --smoke
    cd scripts/watchlist_sync && .venv/bin/python analysis/s169_lossmaker_crash_calls.py
"""
from __future__ import annotations

import argparse
import math
import random
import statistics
import sys
import time
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

import structure_vec_engine as E  # noqa: E402
import study_leak as leak  # noqa: E402
from build_plan import connect  # noqa: E402
from s076_structures_backtest import Pricer, expiry_index, fill, load, strike_for  # noqa: E402
from s167_spreads_on_edge import (  # noqa: E402
    bar_index,
    collect_s046_entries,
    collect_s100_entries,
    long_call_unreal,
    tbill_at,
)

OUT = HERE.parent / "out" / "opt" / "S169.md"
TRAIN_END = date(2024, 6, 30)  # global: pre-registered cut; train < 2024-07-01
TEST_START = date(2024, 7, 1)  # global: pre-registered holdout
DTES = (30, 45)  # global: pre-registered grid
LONG_DS = (0.50, 0.30)  # global: pre-registered grid
EXITS = ("hold", "tp100")  # global: pre-registered exits; no stop
SMOKE_TICKERS = ("RGTI", "IONQ", "OKLO", "AAPL", "MSFT")
CRASH_OWN = -0.20  # global: pre-registered E1 threshold
CRASH_SPY = -0.04  # global: pre-registered E2 threshold
ENTRY_COOLDOWN = 10  # global: ≥1 entry / name / 10 trading days
E0_STRIDE = 5  # global: unconditional every 5th day
rng = random.Random(169)


def cell_key(dte: int, ld: float, ex: str) -> str:
    return f"d{dte}|ld{ld:.2f}|{ex}"


def exit_k_call(unreal: np.ndarray, debit: float, rule: str) -> int:
    H = len(unreal)
    if rule == "hold":
        return H - 1
    for h in range(1, H):
        # +100 % on premium → unreal (mark−debit) ≥ debit
        if rule == "tp100" and debit > 0 and unreal[h] >= debit:
            return h
    return H - 1


def load_groups(conn) -> tuple[dict[str, str], set[str]]:
    """Current source_fundamentals avg OM+NI → loss/prof; edgar always-loss FY set."""
    rows = conn.execute(
        """
        SELECT UPPER(ticker) AS t,
               AVG(CASE WHEN field = 'operatingMargin' THEN value END) AS om,
               AVG(CASE WHEN field = 'netIncome' THEN value END) AS ni
        FROM source_fundamentals
        WHERE field IN ('operatingMargin', 'netIncome')
        GROUP BY 1
        """
    ).fetchall()
    group: dict[str, str] = {}
    for t, om, ni in rows:
        if om is None or ni is None:
            continue
        omf, nif = float(om), float(ni)
        if omf < 0 and nif < 0:
            group[t] = "loss"
        elif omf > 0 and nif > 0:
            group[t] = "prof"
    edgar = conn.execute(
        """
        WITH ni AS (
          SELECT UPPER(ticker) AS t, fiscal_year, AVG(value) AS v
          FROM edgar_statement_history
          WHERE line_item = 'netIncome' AND (period IS NULL OR period = 'FY')
          GROUP BY 1, 2
        )
        SELECT t FROM ni GROUP BY t
        HAVING COUNT(*) >= 1
           AND SUM(CASE WHEN v < 0 THEN 1 ELSE 0 END) = COUNT(*)
        """
    ).fetchall()
    always_loss = {r[0] for r in edgar}
    return group, always_loss


def universe_tickers(conn, smoke: bool) -> list[str]:
    if smoke:
        return list(SMOKE_TICKERS)
    print("universe from S167 S100+S046 entries…", flush=True)
    ents = collect_s100_entries(conn) + collect_s046_entries(conn)
    tickers = sorted({e["t"] for e in ents})
    print(f"universe n={len(tickers)}", flush=True)
    return tickers


def ret_n(rows: list, i: int, n: int) -> float | None:
    if i < n:
        return None
    s0, s1 = rows[i - n][1], rows[i][1]
    if s0 <= 0:
        return None
    return s1 / s0 - 1.0


def rv20(rows: list, i: int) -> float | None:
    if i < 20:
        return None
    rets = []
    for k in range(i - 19, i + 1):
        a, b = rows[k - 1][1], rows[k][1]
        if a <= 0 or b <= 0:
            return None
        rets.append(math.log(b / a))
    if len(rets) < 20:
        return None
    return statistics.pstdev(rets) * math.sqrt(252)


def dist_from_high(rows: list, i: int) -> float | None:
    if i < 252:
        lo = 0
    else:
        lo = i - 251
    hi = max(r[1] for r in rows[lo : i + 1])
    if hi <= 0:
        return None
    return (hi - rows[i][1]) / hi


def collect_entries(
    bars: dict[str, list],
    spy: list,
    tickers: list[str],
    groups: dict[str, str],
    d0: date,
    d1: date,
) -> list[dict]:
    """Signal on day i; enter next close (i+1). One entry / name / 10 sessions."""
    spy_i = {r[0]: idx for idx, r in enumerate(spy)}
    out: list[dict] = []
    for t in tickers:
        g = groups.get(t)
        if not g:
            continue
        rows = bars.get(t)
        if not rows or len(rows) < 60:
            continue
        last_crash_i = -10_000
        for i in range(25, len(rows) - 2):
            d = rows[i][0]
            if d < d0 or d > d1:
                continue
            r5 = ret_n(rows, i, 5)
            si = spy_i.get(d)
            spy_r5 = ret_n(spy, si, 5) if si is not None else None
            j = i + 1
            if j >= len(rows):
                continue
            ed = rows[j][0]
            if ed < d0 or ed > d1:
                continue
            # IV optional at collect-time (OKLO has bars/crashes but iv30_call only from 2026-09);
            # pricing step drops entries without a usable vol.
            dd = dist_from_high(rows, i)
            rv = rv20(rows, i)
            base = {
                "t": t,
                "signal_d": d,
                "d": ed,
                "entry_i": j,
                "signal_i": i,
                "group": g,
                "dist_high": dd,
                "rv20": rv,
                "r5": r5,
                "spy_r5": spy_r5,
            }
            crash_kinds: list[str] = []
            if r5 is not None and r5 <= CRASH_OWN:
                crash_kinds.append("E1")
            if spy_r5 is not None and spy_r5 <= CRASH_SPY:
                crash_kinds.append("E2")
            if crash_kinds and i - last_crash_i >= ENTRY_COOLDOWN:
                for kind in crash_kinds:
                    out.append({**base, "kind": kind})
                last_crash_i = i
            # E0: every 5th trading bar (unconditional comparator; independent of crash cooldown)
            if i % E0_STRIDE == 0:
                out.append({**base, "kind": "E0"})
    return out


def assign_rv_tercile(entries: list[dict]) -> None:
    """Own-history expanding tercile of prior RV20 among same ticker's entries (stock-specific)."""
    by_t: dict[str, list[dict]] = defaultdict(list)
    for e in entries:
        by_t[e["t"]].append(e)
    for xs in by_t.values():
        xs.sort(key=lambda e: e["d"])
        hist: list[float] = []
        for e in xs:
            v = e.get("rv20")
            if v is None or not math.isfinite(v):
                e["rv_terc"] = "?"
                continue
            hist.append(v)
            if len(hist) < 9:
                e["rv_terc"] = "?"
                continue
            qs = statistics.quantiles(hist, n=3)
            if v <= qs[0]:
                e["rv_terc"] = "T1"
            elif v <= qs[1]:
                e["rv_terc"] = "T2"
            else:
                e["rv_terc"] = "T3"


def run_entry(
    ent: dict,
    rows: list,
    tb: list[tuple[date, float]],
    pricer: Pricer,
    dte_tgt: int,
    ld: float,
    ex: str,
) -> dict | None:
    i = ent["entry_i"]
    if i is None or i < 50 or i >= len(rows) - 1:
        return None
    d, S, ivp, ivc = rows[i]
    if S <= 0:
        return None
    priced_by = "skew_model"
    if not ivc:
        # last resort when lseg iv30_call missing (OKLO until 2026-09): own RV20
        rv = ent.get("rv20") or rv20(rows, i)
        if not rv or rv <= 0:
            return None
        ivc = rv
        priced_by = "rv20_fallback"
        # patch a copy of the path so long_call_unreal sees ivc
        rows = list(rows)
        row = list(rows[i])
        row[3] = ivc
        rows[i] = tuple(row)
        for h in range(i + 1, min(len(rows), i + 80)):
            if not rows[h][3]:
                rr = list(rows[h])
                rr[3] = ivc
                rows[h] = tuple(rr)
    j = expiry_index(rows, i, dte_tgt)
    if j is None or j <= i:
        return None
    dte0 = max((rows[j][0] - d).days, 1)
    cdeb, K, cunreal = long_call_unreal(pricer, rows, i, j, ld)
    if cdeb <= 0 or not math.isfinite(cdeb):
        return None
    ck = exit_k_call(cunreal, cdeb, ex)
    if ck < 1:
        return None
    call_pnl = float(cunreal[ck])
    mark_day = rows[i + ck][0]
    # assert no look-ahead into entry bar
    first_pnl_day = rows[i + 1][0]
    if not (d < first_pnl_day):
        return None
    cdays = max((mark_day - d).days, 1)
    r_tb = tbill_at(tb, d)
    S_exit = rows[i + ck][1]
    # Δ-stock same $debit (S167): pnl = Δ × ΔS; capital = debit
    delta0 = ld  # strike_for targets flat-IV Δ = ld
    stock_pnl = delta0 * (S_exit - S)
    exc_ca = call_pnl / cdeb - r_tb * cdays / 365.0
    xpd_ca = exc_ca / cdays
    exc_sd = stock_pnl / cdeb - r_tb * cdays / 365.0
    xpd_sd = exc_sd / cdays
    hit100 = 1 if call_pnl >= cdeb - 1e-9 else 0
    return {
        **ent,
        "d": d,
        "cell": cell_key(dte_tgt, ld, ex),
        "dte": dte_tgt,
        "ld": ld,
        "exit": ex,
        "days": cdays,
        "debit": cdeb,
        "K": K,
        "S": S,
        "S_exit": S_exit,
        "pnl_ca": call_pnl,
        "cap_ca": cdeb,
        "xpd_ca": xpd_ca,
        "exc_ca": exc_ca,
        "pnl_sd": stock_pnl,
        "cap_sd": cdeb,
        "xpd_sd": xpd_sd,
        "exc_sd": exc_sd,
        "mark_day": mark_day,
        "first_pnl_day": first_pnl_day,
        "delta0": delta0,
        "hit100": hit100,
        "priced_by": priced_by,  # skew_model = S076×S075 (S167); rv20_fallback only if iv30_call missing
        "dist_band": (
            "ge50"
            if ent.get("dist_high") is not None and ent["dist_high"] >= 0.50
            else ("lt50" if ent.get("dist_high") is not None else "?")
        ),
    }


def pooled_xpd(rows: list[dict], arm: str) -> float:
    den = sum(r[f"cap_{arm}"] * r["days"] for r in rows if r[f"cap_{arm}"] > 0)
    if den <= 0:
        return float("nan")
    return sum(r[f"pnl_{arm}"] for r in rows) / den


def deoverlap(trades: list[dict]) -> list[dict]:
    last_exit: dict[tuple[str, str, str], date] = {}
    out: list[dict] = []
    for t in sorted(trades, key=lambda x: (x["t"], x["kind"], x["cell"], x["d"])):
        ck = (t["t"], t["kind"], t["cell"])
        if ck in last_exit and t["d"] <= last_exit[ck]:
            continue
        out.append(t)
        last_exit[ck] = t["mark_day"]
    return out


def month_t(trades: list[dict], arm: str = "ca") -> float:
    by: dict[tuple[int, int], list[float]] = defaultdict(lambda: [0.0, 0.0])
    for t in trades:
        k = (t["d"].year, t["d"].month)
        by[k][0] += t[f"pnl_{arm}"]
        by[k][1] += t[f"cap_{arm}"] * t["days"]
    monthly = [v[0] / v[1] for v in by.values() if v[1] > 0]
    if len(monthly) >= 6:
        obs = statistics.mean(monthly)
        bs = [statistics.mean([rng.choice(monthly) for _ in monthly]) for _ in range(400)]
        sd = statistics.pstdev(bs)
        return obs / sd if sd else float("nan")
    # fallback: trade-level t on xpd (when <6 months in slice)
    vx = [t[f"xpd_{arm}"] for t in trades if math.isfinite(t[f"xpd_{arm}"])]
    if len(vx) < 30:
        return float("nan")
    m = statistics.mean(vx)
    sd = statistics.pstdev(vx)
    return m / (sd / math.sqrt(len(vx))) if sd else float("nan")


def time_halves(trades: list[dict], arm: str = "ca") -> tuple[float, float]:
    if len(trades) < 4:
        return float("nan"), float("nan")
    xs = sorted(trades, key=lambda t: t["d"])
    mid = xs[len(xs) // 2]["d"]
    h1 = [t for t in xs if t["d"] < mid]
    h2 = [t for t in xs if t["d"] >= mid]
    return pooled_xpd(h1, arm) * 1e4, pooled_xpd(h2, arm) * 1e4


def to_leg_frame(rows: list[dict], arm: str) -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "ticker": r["t"],
                "session": str(r["d"]),
                "signal_bar": 0,
                "pnl_coll_frac_cross": r[f"xpd_{arm}"],
            }
            for r in rows
        ]
    )


def smoke_gate(
    entries: list[dict],
    bars: dict,
    groups: dict[str, str],
    tb: list,
    pricer: Pricer,
) -> bool:
    ok = True
    # flags
    for t, want in (("RGTI", "loss"), ("IONQ", "loss"), ("OKLO", "loss"), ("AAPL", "prof"), ("MSFT", "prof")):
        got = groups.get(t)
        print(f"SANITY flag {t}={got} want={want}")
        if got != want:
            print(f"SANITY FAIL: flag {t}")
            ok = False
    by = defaultdict(list)
    for e in entries:
        by[(e["t"], e["kind"])].append(e)
    for t in ("RGTI", "IONQ", "OKLO"):
        n1 = len(by[(t, "E1")])
        print(f"SANITY E1 {t} n={n1}")
        if n1 <= 0:
            print(f"SANITY FAIL: E1 {t} empty")
            ok = False
    for t in SMOKE_TICKERS:
        rows = bars.get(t) or []
        # E0 expect vs smoke window bars (2023–24 for loss coverage)
        n_days = sum(1 for r in rows if date(2023, 1, 1) <= r[0] <= date(2024, 12, 31))
        n0 = len(by[(t, "E0")])
        expect = max(n_days // E0_STRIDE - 2, 0)
        print(f"SANITY E0 {t} n={n0} days≈{n_days} expect≈{expect}")
        if n_days > 50 and not (expect * 0.35 <= n0 <= expect * 1.7 + 8):
            print(f"SANITY FAIL: E0 count {t}")
            ok = False
    # price one 0.50Δ hold trade per name
    hand_done = False
    for t in SMOKE_TICKERS:
        ents = [e for e in entries if e["t"] == t and e["kind"] in ("E1", "E0")]
        if not ents:
            print(f"SANITY FAIL: no entries {t}")
            ok = False
            continue
        ent = next((e for e in ents if e["kind"] == "E1"), ents[0])
        rows = bars[t]
        tr = run_entry(ent, rows, tb, pricer, 30, 0.50, "hold")
        if not tr:
            print(f"SANITY FAIL: no priced trade {t}")
            ok = False
            continue
        pct = tr["debit"] / tr["S"]
        lo, hi = (0.02, 0.20) if groups.get(t) == "loss" else (0.01, 0.08)
        print(
            f"SANITY debit {t} S={tr['S']:.2f} debit={tr['debit']:.3f} pct={pct:.3%} "
            f"band={lo:.0%}-{hi:.0%} priced_by={tr['priced_by']} "
            f"entry={tr['d']} first_pnl={tr['first_pnl_day']}"
        )
        if not (lo <= pct <= hi):
            print(f"SANITY FAIL: debit pct {t}={pct:.3%}")
            ok = False
        if not (tr["d"] < tr["first_pnl_day"]):
            print(f"SANITY FAIL: entry>=pnl bar {t}")
            ok = False
        if not hand_done:
            dS = tr["S_exit"] - tr["S"]
            expect_pnl = tr["delta0"] * dS
            print(
                f"SANITY hand Δ-stock: Δ={tr['delta0']:.2f} × dS={dS:.4f} = {expect_pnl:.4f} "
                f"trade.pnl_sd={tr['pnl_sd']:.4f} match={abs(expect_pnl - tr['pnl_sd']) < 1e-9}"
            )
            if abs(expect_pnl - tr["pnl_sd"]) > 1e-9:
                print("SANITY FAIL: Δ-stock hand check")
                ok = False
            hand_done = True
    # parameter change → output changes
    if hand_done:
        ent = next(e for e in entries if e["t"] == "RGTI")
        a = run_entry(ent, bars["RGTI"], tb, pricer, 30, 0.50, "hold")
        b = run_entry(ent, bars["RGTI"], tb, pricer, 30, 0.30, "hold")
        if a and b:
            print(f"SANITY change ld0.50 debit={a['debit']:.3f} ld0.30 debit={b['debit']:.3f}")
            if abs(a["debit"] - b["debit"]) < 1e-6:
                print("SANITY FAIL: debit unchanged when Δ changes")
                ok = False
        else:
            print("SANITY FAIL: change-cell trade missing")
            ok = False
    return ok


def best_train_cell(train_rows: list[dict]) -> str | None:
    by: dict[str, list[dict]] = defaultdict(list)
    for r in train_rows:
        if r["kind"] in ("E1", "E2"):
            by[f"{r['kind']}|{r['cell']}"].append(r)
    best, best_v = None, float("-inf")
    for k, xs in by.items():
        if len(xs) < 5:
            continue
        v = pooled_xpd(xs, "ca")
        if math.isfinite(v) and v > best_v:
            best_v, best = v, k
    return best


def summarize_arm(rows: list[dict], arm: str) -> dict:
    if not rows:
        return {"n": 0, "bp": float("nan"), "t": float("nan"), "hit": float("nan"), "med": float("nan")}
    bp = pooled_xpd(rows, arm) * 1e4
    rets = [r[f"pnl_{arm}"] / r[f"cap_{arm}"] for r in rows if r[f"cap_{arm}"] > 0]
    return {
        "n": len(rows),
        "bp": bp,
        "t": month_t(rows, arm),
        "hit": sum(r["hit100"] for r in rows) / len(rows) if arm == "ca" else float("nan"),
        "med": statistics.median(rets) if rets else float("nan"),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true")
    args = ap.parse_args()
    t0 = time.time()
    with connect() as conn:
        groups, always_loss = load_groups(conn)
        tickers = universe_tickers(conn, args.smoke)
        # ensure SPY loaded
        need = set(tickers) | {"SPY"}
        bars, _rep, tb = load(conn, need)
        spy = bars.get("SPY") or []
        if not spy:
            print("SANITY FAIL: no SPY bars")
            return 2
        # Smoke: 2023 primary; OKLO had no ≤−20% 5d in 2023 (worst −3%) and no iv30_call until 2026-09,
        # so include 2024 for loss-name crash/E0 coverage checks (printed in SANITY).
        if args.smoke:
            d0, d1 = date(2023, 1, 1), date(2024, 12, 31)
        else:
            d0, d1 = date(2021, 2, 1), date(2026, 11, 1)
        entries = collect_entries(bars, spy, tickers, groups, d0, d1)
        assign_rv_tercile(entries)
        print(
            f"entries={len(entries)} tickers={len(tickers)} loss={sum(1 for t in tickers if groups.get(t)=='loss')} "
            f"prof={sum(1 for t in tickers if groups.get(t)=='prof')} edgar_always_loss={len(always_loss)}",
            flush=True,
        )
        pricer = Pricer(conn)
        if args.smoke:
            if not smoke_gate(entries, bars, groups, tb, pricer):
                print("SMOKE GATE FAIL — stop")
                return 2
            print("SANITY smoke PASS — full run uses S167 247-name universe", flush=True)

        trades: list[dict] = []
        for ent in entries:
            rows = bars.get(ent["t"])
            if not rows:
                continue
            for dte in DTES:
                for ld in LONG_DS:
                    for ex in EXITS:
                        tr = run_entry(ent, rows, tb, pricer, dte, ld, ex)
                        if tr:
                            trades.append(tr)
        print(
            f"FIRST_RESULT trades={len(trades)} entries={len(entries)} tickers={len(tickers)} t={time.time()-t0:.0f}s",
            flush=True,
        )
        model_share = sum(1 for t in trades if t["priced_by"] == "skew_model") / max(len(trades), 1)

        train = [t for t in trades if t["d"] <= TRAIN_END]
        test = [t for t in trades if t["d"] >= TEST_START]

        lines = [
            "CONTRACT 1-7: ok",
            "# S169 — long calls after crash: loss-makers vs profitable (A244)",
            "",
            f"fills bid+23% · priced_by=skew_model share={model_share:.0%} (S076×S075; same as S167) · "
            f"train<{TEST_START} test≥{TEST_START}",
            f"trades={len(trades)} train={len(train)} test={len(test)} tickers={len(tickers)} "
            f"edgar_always_loss_n={len(always_loss)} (DB FY netIncome always<0)",
            "inputs: bars/IV=lseg_research.daily_history; groups=source_fundamentals OM+NI avg; "
            "edgar=edgar_statement_history netIncome FY; tbill=out/opt/dtb3.csv",
            "",
            "## Best train cell / group (E1|E2 × structure) → test",
        ]

        verdict = "NO-LIFT"
        pass_bits = []
        table_rows = []
        for grp in ("loss", "prof"):
            tr_g = [t for t in train if t["group"] == grp]
            te_g = [t for t in test if t["group"] == grp]
            best = best_train_cell(tr_g)
            if not best:
                lines.append(f"- {grp}: no train cell")
                continue
            kind, cell = best.split("|", 1)
            tr_cell = deoverlap([t for t in tr_g if t["kind"] == kind and t["cell"] == cell])
            te_cell = deoverlap([t for t in te_g if t["kind"] == kind and t["cell"] == cell])
            e0_te = deoverlap([t for t in te_g if t["kind"] == "E0" and t["cell"] == cell])
            e0_tr = deoverlap([t for t in tr_g if t["kind"] == "E0" and t["cell"] == cell])
            sm_tr = summarize_arm(tr_cell, "ca")
            sm_te = summarize_arm(te_cell, "ca")
            sm_sd = summarize_arm(te_cell, "sd")
            sm_e0 = summarize_arm(e0_te, "ca")
            h1, h2 = time_halves(te_cell, "ca")
            # lift vs E0 on same cell
            lift_e0 = sm_te["bp"] - sm_e0["bp"] if math.isfinite(sm_te["bp"]) and math.isfinite(sm_e0["bp"]) else float("nan")
            lift_sd = sm_te["bp"] - sm_sd["bp"] if math.isfinite(sm_te["bp"]) and math.isfinite(sm_sd["bp"]) else float("nan")
            # halves lift vs E0
            e0_h1, e0_h2 = time_halves(e0_te, "ca")
            half_lift1 = h1 - e0_h1 if math.isfinite(h1) and math.isfinite(e0_h1) else float("nan")
            half_lift2 = h2 - e0_h2 if math.isfinite(h2) and math.isfinite(e0_h2) else float("nan")
            # leak on test cell vs E0 base
            lk = {"shift_bp": float("nan"), "placebo_p": float("nan")}
            if len(te_cell) >= 10 and len(e0_te) >= 10:
                lk = leak.leak_from_trade_frames(
                    to_leg_frame(te_cell, "ca"),
                    to_leg_frame(e0_te, "ca"),
                    np.random.default_rng(169),
                )
            row = (
                f"- {grp} best={kind}|{cell} train_n={sm_tr['n']} train_bp={sm_tr['bp']:+.1f} "
                f"test_n={sm_te['n']} test_bp={sm_te['bp']:+.1f} vsE0={lift_e0:+.1f} vsΔ={lift_sd:+.1f} "
                f"t={sm_te['t']:.2f} hit100={sm_te['hit']:.1%} med={sm_te['med']:+.2%} "
                f"halves_bp={h1:+.1f}/{h2:+.1f} half_lift={half_lift1:+.1f}/{half_lift2:+.1f} "
                f"shift_bp={lk['shift_bp']:.1f} placebo_p={lk['placebo_p']:.3f}"
            )
            lines.append(row)
            table_rows.append(row)
            if grp == "loss":
                n_ok = sm_te["n"] >= 30
                t_ok = math.isfinite(sm_te["t"]) and sm_te["t"] >= 2
                e0_ok = math.isfinite(lift_e0) and lift_e0 >= 10
                sd_ok = math.isfinite(lift_sd) and lift_sd > 0
                halves_ok = (
                    math.isfinite(half_lift1)
                    and math.isfinite(half_lift2)
                    and half_lift1 > 0
                    and half_lift2 > 0
                )
                pass_bits = [n_ok, t_ok, e0_ok, sd_ok, halves_ok]
                if all(pass_bits):
                    verdict = "PASS"
                elif not n_ok or (math.isfinite(sm_te["t"]) and abs(sm_te["t"]) < 2 and sm_te["n"] < 30):
                    verdict = "UNDERPOWERED" if sm_te["n"] < 30 else "NO-LIFT"
                else:
                    verdict = "NO-LIFT"

        # report-only splits on loss E1
        lines.append("")
        lines.append("## Report-only splits (loss E1, test, pooled across structures)")
        loss_e1_te = [t for t in test if t["group"] == "loss" and t["kind"] == "E1"]
        for label, key, vals in (
            ("dist_high", "dist_band", ("lt50", "ge50")),
            ("rv_terc", "rv_terc", ("T1", "T2", "T3")),
        ):
            parts = []
            for v in vals:
                sub = deoverlap([t for t in loss_e1_te if t.get(key) == v])
                parts.append(f"{v}:n={len(sub)} bp={pooled_xpd(sub,'ca')*1e4:+.1f}" if sub else f"{v}:n=0")
            lines.append(f"- {label}: " + " · ".join(parts))

        # robustness: edgar always-loss subset on best loss cell
        lines.append("")
        lines.append("## Robustness: edgar FY always-loss subset (look-ahead-free NI history)")
        loss_best = None
        for row in table_rows:
            if row.startswith("- loss best="):
                loss_best = row.split("best=")[1].split()[0]
                break
        if loss_best and "|" in loss_best:
            kind, cell = loss_best.split("|", 1)
            sub = deoverlap(
                [
                    t
                    for t in test
                    if t["t"] in always_loss and t["kind"] == kind and t["cell"] == cell
                ]
            )
            sm = summarize_arm(sub, "ca")
            lines.append(
                f"- subset n_tickers={len(always_loss)} test_n={sm['n']} bp={sm['bp']:+.1f} "
                f"(current loss flag is look-ahead caveat)"
            )
        else:
            lines.append("- no loss best cell")

        lines.append("")
        lines.append(
            f"**Verdict:** {verdict} — pre-reg PASS needs loss best E1/E2 test ≥+10 bp vs E0 same cell, "
            f"t≥2, beats Δ-stock, both half lifts >0. bits={pass_bits}"
        )
        # E0 train context
        lines.append(
            f"E0 context loss train/test bp on loss-best cell printed above as vsE0; "
            f"prof E0 train n={sum(1 for t in train if t['group']=='prof' and t['kind']=='E0')}"
        )

        OUT.parent.mkdir(parents=True, exist_ok=True)
        # keep ≤ ~20 lines for packet body
        packet = "\n".join(lines) + "\n"
        OUT.write_text(packet)
        print(f"Wrote {OUT} verdict={verdict} t={time.time()-t0:.0f}s")
        print(packet)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
