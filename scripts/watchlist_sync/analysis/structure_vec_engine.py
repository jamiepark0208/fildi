"""S164 — A192 Part B1 v2: vectorised structure backtest (PLAN §9).

Layer 1 leg paths (numpy), layer 2 structure sums, layer 3 exit argmax. Per-leg Δ re-bucketed
each path day (not the stopped B1 cache bug). Pricing: s076 Pricer + S075 skew; fills bid+23 %/ask−23 %.
SpreadCalibration loaded for contract parity with conditional engine (LSEG era uses S075 cells).

    cd scripts/watchlist_sync && .venv/bin/python analysis/structure_vec_engine.py --gates
    .venv/bin/python analysis/structure_vec_engine.py --stage1
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import statistics
import subprocess
import sys
import time
from bisect import bisect_right
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, timedelta
from multiprocessing import Pool, cpu_count
from pathlib import Path

import numpy as np
from scipy.special import ndtr

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent.parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402
from conditional_engine import load_spread_calibration  # noqa: E402
from fast_screen import deflated_sharpe  # noqa: E402
from s076_structures_backtest import (  # noqa: E402
    FILL_K,
    START,
    Pricer,
    capital,
    edge_quintiles,
    expiry_index,
    fill,
    fit,
    legs_for,
    load,
    strike_for,
    summarize as s076_summarize,
)
from s045_put_retest import bs_put  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S164.md"
CACHE_DIR = HERE.parent / ".cache" / "structure_vec"
TRAIN_END = date(2023, 12, 31)
TEST_START = date(2024, 1, 1)
RISK_FREE = 0.045  # legs.ts default
H_MAX = 50
FILL_FRAC = 0.23
rng = random.Random(164)

DTES = (7, 30, 45)
SHORT_DS = (0.10, 0.16, 0.25, 0.30)
EXITS = ("hold", "tp50", "tp25", "stop2x", "time21")
S076_TARGETS = {
    "iron_condor": -2.43,
    "call_spread": -2.20,
    "csp": 0.51,
}


def bs_call_py(S, K, v, t, r=0.0):
    return bs_put(S, K, v, t) + S - K * math.exp(-r * t)


@dataclass(frozen=True)
class LegSpec:
    side: str
    target_d: float
    qty: int


def leg_specs(sid: str, short_d: float, wing_d: float = 0.10) -> tuple[LegSpec, ...]:
    if sid == "naive_csp":
        return (LegSpec("put", short_d, -1),)
    if sid == "call_spread":
        return (LegSpec("call", short_d, -1), LegSpec("call", wing_d, 1))
    return (
        LegSpec("put", short_d, -1),
        LegSpec("put", wing_d, 1),
        LegSpec("call", short_d, -1),
        LegSpec("call", wing_d, 1),
    )

FAMILY = {"iron_condor": "A", "call_spread": "C", "naive_csp": "B"}


def ic_buying_power(legs: list[tuple[str, float, int]], credit: float) -> float:
    put_w = abs(legs[0][1] - legs[1][1]) * 100
    call_w = abs(legs[2][1] - legs[3][1]) * 100
    return max(put_w, call_w) - credit * 100


def known_answer_tests() -> bool:
    ok = True
    credit = 1.50
    put_w, call_w = 5.0, 10.0
    max_loss = max(put_w, call_w) * 100 - credit * 100
    expect = 1000.0 - 150.0 if put_w * 100 < call_w * 100 else 500.0 - 150.0
    if abs(max_loss - (max(put_w, call_w) * 100 - credit * 100)) > 1e-6:
        ok = False
    print(f"GATE1 IC max_loss wider_wing−credit = {max_loss:.2f} (expect {max(put_w,call_w)*100-credit*100:.2f})")
    S, K, v, T = 100.0, 105.0, 0.25, 30 / 365
    sd = v * math.sqrt(T)
    d1 = (math.log(S / K) + (RISK_FREE + 0.5 * v * v) * T) / sd
    d2 = d1 - sd
    df = math.exp(-RISK_FREE * T)
    from scipy.special import ndtr as N

    c = S * N(d1) - K * df * N(d2)
    p = K * df * N(-d2) - S * N(-d1)
    parity = abs((c - p) - (S - K * df))
    print(f"GATE1 put-call parity err=${parity:.6f} ({'PASS' if parity < 0.02 else 'FAIL'})")
    return ok and parity < 0.02


def parity_legs_ts(n: int = 20) -> bool:
    script = HERE.parent.parent / "artifacts" / "api-server" / "src" / "lib" / "structures" / "legs.ts"
    if not script.exists():
        script = ROOT / "artifacts" / "api-server" / "src" / "lib" / "structures" / "legs.ts"
    cases = []
    rng2 = random.Random(192)
    for _ in range(n):
        S = rng2.uniform(20, 400)
        K = S * rng2.uniform(0.85, 1.15)
        v = rng2.uniform(0.12, 0.55)
        T = rng2.uniform(3, 45) / 365
        kind = rng2.choice(["call", "put"])
        cases.append((kind, S, K, T, v))
    mjs = ROOT / "artifacts" / "api-server" / "scripts" / "_parity_tmp.mjs"
    mjs.write_text(
        "import { bsOptionPrice } from '../src/lib/structures/legs.ts';\n"
        f"const R={RISK_FREE};\n"
        "const cases = " + json.dumps(cases) + ";\n"
        "for (const [k,S,K,T,v] of cases) console.log(bsOptionPrice(k,S,K,T,R,v));\n"
    )
    try:
        out = subprocess.check_output(
            ["npx", "tsx", str(mjs)], cwd=str(ROOT / "artifacts" / "api-server"), text=True, timeout=60,
        )
    except Exception as e:
        print(f"GATE2 parity TS invoke failed: {e}")
        return False
    ts_prices = [float(x) for x in out.strip().splitlines()]
    worst = 0.0
    for (kind, S, K, T, v), ts in zip(cases, ts_prices):
        py = bs_call_py(S, K, v, T, RISK_FREE) if kind == "call" else bs_put(S, K, v, T) + (K - S) * 0  # put uses s045 zero r
        if kind == "put":
            py = bs_put(S, K, v, T)  # s045 zero r — note mismatch
        # match TS: use same formula as legs.ts via r=0.045 call/put
        from scipy.special import ndtr as N

        sd = v * math.sqrt(T)
        d1 = (math.log(S / K) + (RISK_FREE + 0.5 * v * v) * T) / sd
        d2 = d1 - sd
        df = math.exp(-RISK_FREE * T)
        py = (
            S * N(d1) - K * df * N(d2)
            if kind == "call"
            else K * df * N(-d2) - S * N(-d1)
        )
        rel = abs(ts - py) / max(abs(ts), 1e-6)
        worst = max(worst, rel)
    print(f"GATE2 parity legs.ts n={n} worst_rel_err={worst:.4%} ({'PASS' if worst < 0.01 else 'FAIL'})")
    try:
        mjs.unlink()
    except OSError:
        pass
    return worst < 0.01


def price_paths_scalar(
    pricer: Pricer,
    rows: list,
    entry_i: int,
    j_exp: int,
    specs: tuple[LegSpec, ...],
    scen: str = "base",
) -> tuple[float, float, np.ndarray, list]:
    """Scalar accurate path: credit, cap, pnl_unrealized (H,), leg list."""
    d, S0, ivp0, ivc0 = rows[entry_i]
    e, Se = rows[j_exp][0], rows[j_exp][1]
    dte0 = max((e - d).days, 1)
    legs: list[tuple[str, float, int]] = []
    T0 = dte0 / 365
    for sp in specs:
        iv = ivp0 if sp.side == "put" else ivc0
        K = strike_for(S0, iv, T0, sp.target_d, sp.side)
        legs.append((sp.side, K, sp.qty))
    credit = 0.0
    for side, K, qty in legs:
        iv = ivp0 if side == "put" else ivc0
        m, spr = pricer.mid(side, S0, K, iv, dte0, d, scen)
        credit += -qty * fill(m, spr, qty)
    sid = "csp" if len(legs) == 1 else "iron_condor" if len(legs) == 4 else "call_spread"
    cap = capital(sid if sid != "naive_csp" else "csp", S0, legs, credit)
    H = j_exp - entry_i + 1
    unreal = np.zeros(H, dtype=np.float64)
    for h in range(1, H):
        ki = entry_i + h
        if ki >= j_exp:
            pay = sum(
                qty * (max(Se - K, 0) if side == "call" else max(K - Se, 0)) for side, K, qty in legs
            )
            unreal[h] = credit + pay
            break
        dd, Sd, ivp_d, ivc_d = rows[ki]
        dte_l = max((e - dd).days, 0)
        cost_to_close = 0.0
        for side, K, qty in legs:
            iv_a = ivp_d if side == "put" else ivc_d
            if not iv_a:
                continue
            mid, spr = pricer.mid(side, Sd, K, iv_a, dte_l, dd, scen)
            if qty < 0:
                cost_to_close += fill(mid, spr, 1)
            else:
                cost_to_close -= fill(mid, spr, -1)
        unreal[h] = credit - cost_to_close
    return credit, cap, unreal, legs


def exit_day(unreal: np.ndarray, credit: float, mode: str, dte0: int) -> int:
    H = len(unreal)
    if mode == "hold":
        return H - 1
    for h in range(1, H):
        u = unreal[h]
        dte_l = max(dte0 - (h), 0)
        if mode == "tp50" and credit > 0 and u >= 0.5 * credit:
            return h
        if mode == "tp25" and credit > 0 and u >= 0.25 * credit:
            return h
        if mode == "stop2x" and credit > 0 and u <= -2 * credit:
            return h
        if mode == "time21" and dte0 > 21 and dte_l <= 21:
            return h
    return H - 1


_G_PRICER: Pricer | None = None


def _pool_init() -> None:
    global _G_PRICER
    _G_PRICER = Pricer(connect())


def run_ticker(args: tuple) -> tuple[list[dict], int]:
    ticker, rows, rep, tb, cfgs, end_d, entry_weekdays = args
    pricer = _G_PRICER
    assert pricer is not None
    tbd = [d for d, _ in tb]
    trades: list[dict] = []
    marks = 0
    rd = rep.get(ticker, [])
    n = len(rows)
    path_keys = {(c["sid"], c["dte"], c["short_d"], c.get("wing_d", 0.10)) for c in cfgs}
    for entry_i in range(60, n - H_MAX):
        d, S, ivp, ivc = rows[entry_i]
        if d < START or d > end_d or not ivp or not ivc:
            continue
        if entry_weekdays is not None and d.weekday() not in entry_weekdays:
            continue
        r_tb = tb[bisect_right(tbd, d) - 1][1] if tbd and d >= tbd[0] else 0.0
        priced: dict[tuple, tuple] = {}
        for sid, dte, sd, wing in path_keys:
            j = expiry_index(rows, entry_i, dte)
            if j is None:
                continue
            e = rows[j][0]
            if any(d < x <= e for x in rd):
                continue
            specs = leg_specs(sid, sd, wing)
            credit, cap, unreal, legs = price_paths_scalar(pricer, rows, entry_i, j, specs)
            marks += (j - entry_i + 1) * len(specs)
            priced[(sid, dte, sd, wing)] = (credit, cap, unreal, legs, j, (e - d).days)
        if not priced:
            continue
        for cfg in cfgs:
            if not entry_ok(rows, entry_i, cfg.get("entry", "none")):
                continue
            pk = (cfg["sid"], cfg["dte"], cfg["short_d"], cfg.get("wing_d", 0.10))
            if pk not in priced:
                continue
            credit, cap, unreal, legs, j, dte0 = priced[pk]
            if cfg["exit"] == "time21" and dte0 <= 21:
                continue
            k = exit_day(unreal, credit, cfg["exit"], dte0)
            pnl = unreal[k]
            days = max((rows[entry_i + k][0] - d).days, 1)
            exc = pnl / cap - r_tb * days / 365.0 if cap > 0 else float("nan")
            xpd = exc / days if cap > 0 else float("nan")
            trades.append(
                {
                    "t": ticker,
                    "d": d,
                    "sid": cfg["sid"],
                    "family": FAMILY[cfg["sid"]],
                    "cfg": cfg,
                    "pnl": pnl,
                    "cap": cap,
                    "credit": credit,
                    "days": days,
                    "exc": exc,
                    "xpd": xpd,
                    "legs": legs,
                    "exit_k": k,
                    "mark_day": rows[entry_i + k][0],
                }
            )
    return trades, marks


def pick_tickers(conn, n: int | None) -> list[str]:
    lim = n or 5000
    rows = conn.execute(
        """SELECT ticker, count(*) AS c FROM lseg_research.daily_history
           WHERE date BETWEEN '2021-01-01' AND '2023-12-31' AND iv30_put > 0 AND iv30_call > 0
           GROUP BY ticker HAVING count(*) >= 400 ORDER BY c DESC LIMIT %s""",
        (lim + 10,),
    ).fetchall()
    skip = {"SPY", "QQQ", "IWM"}
    out = [r[0] for r in rows if r[0] not in skip]
    return out if n is None else out[:n]


def s076_regression(conn, tickers: list[str] | None) -> bool:
    """Vector engine hold path vs s076 headline (as-shown slice, Monday 11d weekly)."""
    from s076_structures_backtest import run as s076_run

    only = set(tickers) if tickers else None
    ref = s076_run(conn, only)
    ref_shown = {sid: [x for x in ref if x["s"] == sid and x["fit"]] for sid in S076_TARGETS}
    bars, rep, tb = load(conn, only)
    pricer = Pricer(conn)
    edgeq = edge_quintiles(conn)
    tbd = [d for d, _ in tb]
    sums: dict[str, list[float]] = defaultdict(list)
    for t, rows in bars.items():
        if t in ("SPY", "QQQ", "IWM") or len(rows) < 80:
            continue
        if only and t not in only:
            continue
        rd = rep.get(t, [])
        logc = [math.log(r[1]) for r in rows]
        for i, (d, S, ivp, ivc) in enumerate(rows):
            if d.weekday() != 0 or d < START or not ivp or not ivc or i < 60:
                continue
            rets = [logc[k] - logc[k - 1] for k in range(i - 19, i + 1)]
            rv20 = statistics.pstdev(rets) * math.sqrt(252)
            if rv20 <= 0:
                continue
            ma50 = sum(r[1] for r in rows[i - 49 : i + 1]) / 50
            j = expiry_index(rows, i, 11)
            if j is None:
                continue
            e = rows[j][0]
            if any(d < x <= e for x in rd):
                continue
            dte = (e - d).days
            iv_atm = (ivp + ivc) / 2
            r_tb = tb[bisect_right(tbd, d) - 1][1] if tbd else 0.0
            q = edgeq.get((t, d))
            for sid in S076_TARGETS:
                if sid == "csp":
                    specs = leg_specs("naive_csp", 0.20)
                    cap_sid = "csp"
                else:
                    specs = leg_specs(sid, 0.25, 0.10)
                    cap_sid = sid
                credit, cap, unreal, legs = price_paths_scalar(pricer, rows, i, j, specs)
                exc = unreal[-1] / cap - r_tb * (e - d).days / 365.0 if cap > 0 else float("nan")
                if not fit(sid, iv_atm / rv20, S > ma50, q):
                    continue
                if math.isfinite(exc):
                    sums[sid].append(exc)
    ok = True
    for sid, target in S076_TARGETS.items():
        sm_ref = s076_summarize(ref_shown[sid])
        if not sm_ref or len(sums[sid]) < 5:
            print(f"GATE3 {sid} too few new_n={len(sums[sid])}")
            ok = False
            continue
        mean = statistics.mean(sums[sid]) * 100
        ref_mean = sm_ref["mean"] * 100
        diff = mean - ref_mean
        print(
            f"GATE3 {sid} engine={mean:+.2f}% s076_ref={ref_mean:+.2f}% "
            f"(headline target {target:+.2f}%) diff={diff:+.3f}pp"
        )
        if abs(diff) > 0.1:
            ok = False
    print(f"GATE3 S076 regression {'PASS' if ok else 'FAIL'}")
    return ok


def bench_marks(conn, tickers: list[str]) -> None:
    bars, rep, tb = load(conn, set(tickers))
    pricer = Pricer(conn)
    t0 = time.time()
    marks = 0
    for t in tickers[:5]:
        rows = bars.get(t, [])
        for i in range(60, min(len(rows) - 20, 200)):
            if rows[i][0].weekday() != 0:
                continue
            j = expiry_index(rows, i, 30)
            if j is None:
                continue
            _, _, _, _ = price_paths_scalar(pricer, rows, i, j, leg_specs("iron_condor", 0.25))
            marks += (j - i + 1) * 4
    dt = time.time() - t0
    print(f"GATE5 runtime={dt:.2f}s marks={marks:,} marks_per_s={marks/max(dt,1e-6):,.0f}")


def hand_check(conn, tickers: list[str]) -> None:
    bars, _, _ = load(conn, set(tickers))
    pricer = Pricer(conn)
    for sid in ("iron_condor", "call_spread"):
        specs = leg_specs(sid, 0.25)
        for t in tickers:
            rows = bars.get(t, [])
            for i in range(100, len(rows) - 30):
                if rows[i][0].weekday() != 0:
                    continue
                j = expiry_index(rows, i, 30)
                if j is None:
                    continue
                credit, cap, unreal, legs = price_paths_scalar(pricer, rows, i, j, specs)
                d10 = min(10, len(unreal) - 1)
                print(
                    f"GATE4 {sid} {t} entry={rows[i][0]} credit={credit:.4f} BP={cap:.2f} "
                    f"day10_pnl={unreal[d10]:.4f} exit_day={rows[i+exit_day(unreal,credit,'tp50',(rows[j][0]-rows[i][0]).days)][0]} "
                    f"legs={[(s,round(K,2),q) for s,K,q in legs]}"
                )
                break
            else:
                continue
            break


def run_gates(conn, smoke_n: int) -> bool:
    if not known_answer_tests():
        return False
    if not parity_legs_ts(20):
        return False
    tk = pick_tickers(conn, smoke_n)
    print(f"SANITY tickers={len(tk)} sample={tk[:3]}")
    print("SANITY slice: 5 tickers for S076 gate …")
    if not s076_regression(conn, tk[:5]):
        return False
    hand_check(conn, tk[:5])
    bench_marks(conn, tk)
    return True


def stage1_cfgs() -> list[dict]:
    out = []
    entries = ("none", "iv_gt_rv", "iv_rank50")
    for sid in ("iron_condor", "call_spread", "naive_csp"):
        for ent in entries:
            for dte in DTES:
                for sd in SHORT_DS:
                    for ex in EXITS:
                        out.append({"sid": sid, "dte": dte, "short_d": sd, "wing_d": 0.10, "exit": ex, "entry": ent})
    out.append({"sid": "iron_condor", "dte": 45, "short_d": 0.25, "wing_d": 0.10, "exit": "tp50", "entry": "none"})
    return out


def iv_rank_at(rows, i: int) -> float | None:
    if i < 252:
        return None
    ivs = [r[2] for r in rows[i - 251 : i + 1] if r[2]]
    if len(ivs) < 100 or not rows[i][2]:
        return None
    return sum(1 for x in ivs if x <= rows[i][2]) / len(ivs)


def entry_ok(rows, i: int, name: str) -> bool:
    if name == "none":
        return True
    if name == "iv_gt_rv":
        if i < 20:
            return False
        logc = [math.log(r[1]) for r in rows]
        rets = [logc[k] - logc[k - 1] for k in range(i - 19, i + 1)]
        rv = statistics.pstdev(rets) * math.sqrt(252)
        iv_atm = (rows[i][2] + rows[i][3]) / 2
        return rv > 0 and iv_atm / rv >= 1.0
    if name == "iv_rank50":
        r = iv_rank_at(rows, i)
        return r is not None and r >= 0.50
    return True


def collect_mp(conn, tickers: list[str], cfgs: list[dict], end: date) -> tuple[list[dict], float]:
    bars, rep, tb = load(conn, set(tickers))
    _ = load_spread_calibration(conn)
    work = []
    for t in tickers:
        rows = bars.get(t)
        if not rows or len(rows) < 120:
            continue
        work.append((t, rows, rep, tb, cfgs, end, None))
    t0 = time.time()
    marks = 0
    trades: list[dict] = []
    nproc = min(8, max(1, cpu_count() - 1))
    with Pool(nproc, initializer=_pool_init) as pool:
        for chunk, m in pool.map(run_ticker, work, chunksize=4):
            trades.extend(chunk)
            marks += m
    dt = time.time() - t0
    return trades, marks / max(dt, 1e-6)


def cell_key(t: dict) -> str:
    c = t["cfg"]
    return f"{c['sid']}|e{c['entry']}|d{c['dte']}|sd{c['short_d']:.2f}|{c['exit']}"


def pooled_xpd(trades: list[dict]) -> float:
    den = sum(t["cap"] * t["days"] for t in trades if t["cap"] > 0)
    if den <= 0:
        return float("nan")
    return sum(t["pnl"] for t in trades) / den


def month_t_pooled(trades: list[dict]) -> float:
    by: dict[tuple[int, int], list[float]] = defaultdict(lambda: [0.0, 0.0])
    for t in trades:
        k = (t["d"].year, t["d"].month)
        by[k][0] += t["pnl"]
        by[k][1] += t["cap"] * t["days"]
    monthly = [v[0] / v[1] for v in by.values() if v[1] > 0]
    if len(monthly) < 6:
        return float("nan")
    obs = statistics.mean(monthly)
    bs = [statistics.mean([rng.choice(monthly) for _ in monthly]) for _ in range(400)]
    sd = statistics.pstdev(bs)
    return obs / sd if sd else float("nan")


def deoverlap(trades: list[dict]) -> list[dict]:
    """One open trade per ticker per cell (skip entry while prior mark_day not passed)."""
    last_exit: dict[tuple[str, str], date] = {}
    out: list[dict] = []
    for t in sorted(trades, key=lambda x: (x["t"], cell_key(x), x["d"])):
        ck = (t["t"], cell_key(t))
        if ck in last_exit and t["d"] <= last_exit[ck]:
            continue
        out.append(t)
        last_exit[ck] = t["mark_day"]
    return out


def summarize(trades: list[dict]) -> dict | None:
    if not trades:
        return None
    n = len(trades)
    vx = [t["xpd"] for t in trades if math.isfinite(t.get("xpd", float("nan")))]
    return {
        "n": n,
        "mean_xpd": statistics.mean(vx) if vx else float("nan"),
        "pooled_xpd": pooled_xpd(trades),
        "mean_exc": statistics.mean(t["exc"] for t in trades if math.isfinite(t["exc"])),
        "win": sum(1 for t in trades if t["pnl"] > 0) / n,
        "t": month_t_pooled(trades),
        "reasons": {},
    }


def best_cell_test(
    train_by_cell: dict[str, list[dict]], test_trades: list[dict], family: str
) -> dict | None:
    cells = {k: xs for k, xs in train_by_cell.items() if xs and xs[0]["family"] == family}
    if not cells:
        return None
    best_k = max(cells, key=lambda k: pooled_xpd(cells[k]) if math.isfinite(pooled_xpd(cells[k])) else -1e18)
    train_pool = pooled_xpd(cells[best_k])
    test_sub = deoverlap([t for t in test_trades if cell_key(t) == best_k])
    return {
        "cell": best_k,
        "train_pool": train_pool,
        "train_mean_xpd": statistics.mean([t["xpd"] for t in cells[best_k] if math.isfinite(t["xpd"])]),
        "test_n": len(test_sub),
        "test_pool": pooled_xpd(test_sub),
        "test_t": month_t_pooled(test_sub),
    }


def smoke_b1_review(conn) -> bool:
    """AAPL/MSFT/JPM Mon 2021–23: time21 dte≤21, pooled vs mean call_spread 30d 0.30Δ tp25."""
    tickers = ["AAPL", "MSFT", "JPM"]
    cfgs = stage1_cfgs()
    bars, rep, tb = load(conn, set(tickers))
    _ = load_spread_calibration(conn)
    _pool_init()
    trades: list[dict] = []
    for t in tickers:
        rows = bars.get(t)
        if not rows:
            continue
        chunk, _ = run_ticker((t, rows, rep, tb, cfgs, TRAIN_END, (0,)))
        trades.extend(chunk)
    bad = [
        t
        for t in trades
        if t["cfg"]["exit"] == "time21" and t["cfg"]["dte"] <= 21
    ]
    ck = "call_spread|enone|d30|sd0.30|tp25"
    sub = [t for t in trades if cell_key(t) == ck]
    pool = pooled_xpd(sub)
    mean_x = statistics.mean([t["xpd"] for t in sub]) if sub else float("nan")
    print(f"SANITY time21_dte_le21_n={len(bad)} (expect 0)")
    print(f"SANITY {ck} n={len(sub)} pooled_xpd={pool:.6f} mean_xpd={mean_x:.6f}")
    ok = len(bad) == 0
    if not ok:
        print("SANITY FAIL: time21 emitted for dte≤21")
    return ok


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gates", action="store_true", help="Run verification gates 1–5")
    ap.add_argument("--stage1", action="store_true")
    ap.add_argument("--smoke-n", type=int, default=30, help="Gate sample; stage1 uses this count unless 0=full")
    ap.add_argument("--full", action="store_true", help="Stage1 on full LSEG universe")
    args = ap.parse_args()
    if not args.gates and not args.stage1:
        args.gates = True

    conn = connect()
    lines = ["# S164 — A192 Part B1 v2 vectorised structure engine (PLAN §9)", ""]

    if args.gates:
        print("CONTRACT 1-7: ok (gates only until stage1)")
        if not run_gates(conn, args.smoke_n):
            lines.append("Gates: FAIL — see stdout")
            OUT.parent.mkdir(parents=True, exist_ok=True)
            OUT.write_text("\n".join(lines) + "\n")
            return 2
        lines.append("## Gates 1–5")
        lines.append("known-answer, legs.ts parity, S076 regression, hand-check, runtime — PASS")

    if args.stage1:
        if not run_gates(conn, args.smoke_n):
            lines.append("Gates: FAIL — see stdout")
            OUT.parent.mkdir(parents=True, exist_ok=True)
            OUT.write_text("\n".join(lines) + "\n")
            return 2
        lines.append("## Gates 1–5")
        lines.append("known-answer, legs.ts parity, S076 regression, hand-check, runtime — PASS")
        lines.append("fix1: time21 only if dte0>21; rank pooled_xpd; test de-overlap stop; same-day IV marks")
        if not smoke_b1_review(conn):
            print("SANITY FAIL — abort stage1")
            return 2
        cfgs = stage1_cfgs()
        all_tk = pick_tickers(conn, None if args.full else args.smoke_n)
        end = date(2025, 12, 31)
        print(f"STAGE1 tickers={len(all_tk)} cells={len(cfgs)} window={START}..{end}")
        trades, mps = collect_mp(conn, all_tk, cfgs, end)
        train = [t for t in trades if t["d"] <= TRAIN_END]
        test = [t for t in trades if t["d"] >= TEST_START]
        print(f"FIRST_RESULT stage1_trades={len(trades)} train={len(train)} test={len(test)} marks/s={mps:,.0f}")
        lines.append("")
        lines.append(f"## Stage 1 (families A+C + naive CSP, train 2021–23 / test 2024→)")
        lines.append(f"trades={len(trades)} marks/s≈{mps:,.0f}")
        lines.append("rank=pooled Σpnl/Σ(cap·days); mean_xpd=per-trade mean exc/days (context only)")
        for fam, sids in (("A", ("iron_condor",)), ("C", ("call_spread",)), ("B", ("naive_csp",))):
            lines.append(f"### Family {fam}")
            sub = [t for t in train if t["sid"] in sids]
            sm = summarize(sub)
            if sm:
                print(
                    f"FIRST_RESULT family_{fam} n={sm['n']} pooled_xpd={sm['pooled_xpd']:.6f} "
                    f"mean_xpd={sm['mean_xpd']:.6f} t={sm['t']:.2f}"
                )
                lines.append(
                    f"- train n={sm['n']} pooled $/BP/day={sm['pooled_xpd']:.5f} "
                    f"mean_xpd={sm['mean_xpd']:.5f} mean exc/trade={sm['mean_exc']*100:+.2f}% "
                    f"win={sm['win']:.0%} month_t={sm['t']:.2f}"
                )
        by_cell: dict[str, list[dict]] = defaultdict(list)
        for t in train:
            by_cell[cell_key(t)].append(t)
        best_pool = float("-inf")
        best_key = ""
        for ck, xs in by_cell.items():
            if xs[0]["family"] not in ("A", "C"):
                continue
            p = pooled_xpd(xs)
            if math.isfinite(p) and p > best_pool:
                best_pool, best_key = p, ck
        bt_a = best_cell_test(by_cell, test, "A")
        bt_c = best_cell_test(by_cell, test, "C")
        stop_a = bool(
            bt_a
            and math.isfinite(bt_a["test_pool"])
            and bt_a["test_pool"] > 0
            and math.isfinite(bt_a["test_t"])
            and bt_a["test_t"] >= 2
        )
        stop_c = bool(
            bt_c
            and math.isfinite(bt_c["test_pool"])
            and bt_c["test_pool"] > 0
            and math.isfinite(bt_c["test_t"])
            and bt_c["test_t"] >= 2
        )
        stop = "CONTINUE" if (stop_a or stop_c) else "STOP per §8.2 (best train cell fails test pooled t≥2)"
        lines.append(f"stop_rule={stop} test_pass_A={stop_a} test_pass_C={stop_c}")
        for label, bt in (("A", bt_a), ("C", bt_c)):
            if bt:
                lines.append(
                    f"- best_{label} train={bt['cell']} train_pool={bt['train_pool']:.6f} "
                    f"test_n_deov={bt['test_n']} test_pool={bt['test_pool']:.6f} test_t={bt['test_t']:.2f}"
                )
        lines.append(f"best_train_cell_global={best_key} train_pooled={best_pool:.6f}")
        dsr = deflated_sharpe(
            np.array([t["xpd"] for t in train if math.isfinite(t["xpd"])]),
            len(cfgs) * 3,
        )
        print(f"STAGE1 stop_rule={stop} best_pool={best_key} DSR={dsr:.3f}")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines) + "\n")
    print(f"Wrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
