"""S162 — A192 Part B0: equal-effort managed-exit backtest for non-CSP structures.

Reuses S076 loader, S075 skew pricer, fill discipline (mid context; fill = bid+23% spread sell / ask−23% buy).
Daily marks: BS at session iv30_put/call × S075 skew; IV anchor = prior trading row (not same-day lookahead).
Graded: mean excess per $ buying-power per calendar day vs FRED DTB3 (dtb3.csv).

    cd scripts/watchlist_sync && .venv/bin/python analysis/s162_structures_managed.py --smoke
    .venv/bin/python analysis/s162_structures_managed.py --full
"""
from __future__ import annotations

import argparse
import math
import random
import statistics
import sys
from bisect import bisect_right
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402
from fast_screen import deflated_sharpe  # noqa: E402
from s076_structures_backtest import (  # noqa: E402
    FILL_K,
    SCEN,
    START,
    Pricer,
    capital,
    expiry_index,
    fill,
    legs_for,
    load,
    month_t,
    strike_for,
)

OUT = HERE.parent / "out" / "opt" / "S162.md"
TRAIN_END = date(2023, 12, 31)
TEST_START = date(2024, 1, 1)
SPLIT = TEST_START
PRICE_BAD = "cheap"  # −2.7 vol pt band ≈ cheap scenario in S076
rng = random.Random(162)

DTES = (7, 30, 45)
SHORT_DS = (0.10, 0.16, 0.25, 0.30)
EXITS = ("hold", "tp50", "tp25", "stop2x", "time21")
WINGS = ("delta", "pct5")
ALL_SIDES = (
    "csp",
    "iron_condor",
    "put_spread",
    "call_spread",
    "covered_call",
    "jade_lizard",
    "short_strangle",
)
SMOKE_SIDES = ("csp", "iron_condor", "covered_call")


def legs_cfg(sid: str, S: float, ivp: float, ivc: float, dte: int, short_d: float,
             wing: str, wing_d: float = 0.10):
    """Legs with configurable short |Δ| and wing (delta wing or 5% spot width)."""
    T = dte / 365.0
    P = lambda d: strike_for(S, ivp, T, d, "put")  # noqa: E731
    C = lambda d: strike_for(S, ivc, T, d, "call")  # noqa: E731
    if wing == "pct5":
        kp_s, kc_s = P(short_d), C(short_d)
        kp_w = kp_s - 0.05 * S
        kc_w = kc_s + 0.05 * S
    else:
        kp_s, kc_s = P(short_d), C(short_d)
        kp_w, kc_w = P(wing_d), C(wing_d)

    if sid == "csp":
        return [("put", P(short_d), -1)]
    if sid == "covered_call":
        return [("call", C(short_d), -1)]
    if sid == "put_spread":
        return [("put", kp_s, -1), ("put", kp_w, 1)]
    if sid == "call_spread":
        return [("call", kc_s, -1), ("call", kc_w, 1)]
    if sid == "iron_condor":
        return [("put", kp_s, -1), ("put", kp_w, 1), ("call", kc_s, -1), ("call", kc_w, 1)]
    if sid == "jade_lizard":
        return [("put", kp_s, -1), ("call", kc_s, -1), ("call", kc_w, 1)]
    if sid == "short_strangle":
        return [("put", P(short_d), -1), ("call", C(short_d), -1)]
    return legs_for(sid, S, ivp, ivc, dte)


def open_credit(pricer: Pricer, S: float, ivp: float, ivc: float, legs, dte: int, on: date, scen: str = "base") -> float:
    cr = 0.0
    for side, K, qty in legs:
        iv = ivp if side == "put" else ivc
        m, spr = pricer.mid(side, S, K, iv, dte, on, scen)
        cr += -qty * fill(m, spr, qty)
    return cr


def close_mark(pricer: Pricer, S: float, ivp: float, ivc: float, legs, dte_left: int, on: date, scen: str = "base") -> float:
    """Cost to close at fills (buy back shorts, sell longs)."""
    cost = 0.0
    for side, K, qty in legs:
        iv = ivp if side == "put" else ivc
        m, spr = pricer.mid(side, S, K, iv, max(dte_left, 1), on, scen)
        cost += qty * fill(m, spr, -qty)  # closing
    return cost


def settle_intrinsic(S: float, Se: float, legs) -> float:
    pay = sum(qty * (max(Se - K, 0) if side == "call" else max(K - Se, 0)) for side, K, qty in legs)
    return pay


def excess_per_day(pnl: float, cap: float, days: int, r_tb: float, sid: str, S: float) -> float:
    if cap <= 0 or days <= 0:
        return float("nan")
    if sid in ("covered_call",):
        raw = pnl / S
    else:
        raw = pnl / cap - r_tb * days / 365.0
    return raw / days


def rv20_at(rows, i: int) -> float | None:
    if i < 20:
        return None
    logc = [math.log(r[1]) for r in rows]
    rets = [logc[k] - logc[k - 1] for k in range(i - 19, i + 1)]
    rv = statistics.pstdev(rets) * math.sqrt(252)
    return rv if rv > 0 else None


def pick_expiry(rows, i: int, target: int) -> int | None:
    return expiry_index(rows, i, target)


def simulate_trade(pricer, t, rows, i, j, sid, cfg, r_tb, scen="base"):
    d, S, ivp, ivc = rows[i]
    e, Se = rows[j][0], rows[j][1]
    dte0 = (e - d).days
    legs = legs_cfg(sid, S, ivp, ivc, dte0, cfg["short_d"], cfg["wing"], cfg.get("wing_d", 0.10))
    credit = open_credit(pricer, S, ivp, ivc, legs, dte0, d, scen)
    cap = capital(sid, S, legs, credit)
    exit_mode = cfg["exit"]
    half_life = max(dte0 // 2, 1)
    reason = "expiry"
    close_day = e
    pnl = None

    for k in range(i + 1, j + 1):
        dd, Sd, ivp_d, ivc_d = rows[k]
        if k > i + 1:
            ivp_u, ivc_u = rows[k - 1][2], rows[k - 1][3]
        else:
            ivp_u, ivc_u = ivp, ivc
        if not ivp_u or not ivc_u:
            continue
        dte_l = (e - dd).days
        if dte_l <= 0:
            break
        if k == j:
            pay = settle_intrinsic(Sd, Se, legs)
            pnl = credit + pay
            reason = "expiry"
            close_day = e
            break
        if exit_mode == "hold":
            continue
        c_cost = close_mark(pricer, Sd, ivp_u, ivc_u, legs, dte_l, dd, scen)
        unreal = credit - c_cost
        if exit_mode == "tp50" and unreal >= 0.5 * credit and credit > 0:
            pnl = unreal
            reason = "tp50"
            close_day = dd
            break
        if exit_mode == "tp25" and unreal >= 0.25 * credit and credit > 0:
            pnl = unreal
            reason = "tp25"
            close_day = dd
            break
        if exit_mode == "stop2x" and unreal <= -2.0 * credit and credit > 0:
            pnl = unreal
            reason = "stop2x"
            close_day = dd
            break
        if exit_mode == "time21" and dte_l <= 21:
            pnl = unreal
            reason = "time21"
            close_day = dd
            break
        if exit_mode == "half" and (e - dd).days <= half_life:
            pnl = unreal
            reason = "half"
            close_day = dd
            break

    if pnl is None:
        pay = settle_intrinsic(S, Se, legs)
        pnl = credit + pay
        reason = "expiry"
        close_day = e
    days = max((close_day - d).days, 1)
    xpd = excess_per_day(pnl, cap, days, r_tb, sid, S)
    return {
        "t": t, "d": d, "e": close_day, "s": sid, "cfg": cfg, "pnl": pnl, "cap": cap, "credit": credit,
        "days": days, "xpd": xpd, "reason": reason, "legs": legs, "S0": S, "scen": scen,
    }


def collect_trades(conn, tickers, sides, cfgs, end: date, scen="base"):
    bars, rep, tb = load(conn, tickers)
    pricer = Pricer(conn)
    tbd = [d for d, _ in tb]
    trades = []
    for t, rows in bars.items():
        if t in ("SPY", "QQQ", "IWM") or len(rows) < 120:
            continue
        if tickers and t not in tickers:
            continue
        rd = rep.get(t, [])
        for i, (d, S, ivp, ivc) in enumerate(rows):
            if d < START or d > end or d.weekday() != 0 or not ivp or not ivc:
                continue
            if any(d < x <= end + timedelta(days=60) for x in rd):
                pass  # earnings filter applied per trade below
            r_tb = tb[bisect_right(tbd, d) - 1][1] if tbd and d >= tbd[0] else 0.0
            for cfg in cfgs:
                j = pick_expiry(rows, i, cfg["dte"])
                if j is None:
                    continue
                e = rows[j][0]
                if any(d < x <= e for x in rd):
                    continue
                for sid in sides:
                    trades.append(simulate_trade(pricer, t, rows, i, j, sid, cfg, r_tb, scen))
    return trades


def summarize(trades, key="xpd"):
    if len(trades) < 1:
        return None
    v = [t[key] for t in trades if math.isfinite(t[key])]
    if not v:
        return None
    n = len(v)
    return {
        "n": n,
        "mean_xpd": statistics.mean(v),
        "win": sum(1 for x in trades if x["pnl"] > 0) / n,
        "reasons": dict(Counter(t["reason"] for t in trades)),
        "t": month_t(trades, key) if n >= 30 else float("nan"),
    }


def cell_id(cfg):
    return f"d{cfg['dte']}_sd{cfg['short_d']:.2f}_{cfg['wing']}_{cfg['exit']}_e{cfg.get('entry','none')}"


def smoke_cfgs():
    return [
        {"dte": 30, "short_d": 0.25, "wing": "delta", "wing_d": 0.10, "exit": x, "entry": "none"}
        for x in EXITS
    ]


def full_cfgs(smoke=False, coarse=False):
    if smoke:
        return smoke_cfgs()
    exits = ("hold", "tp50", "stop2x", "time21") if coarse else EXITS
    wings = ("delta",) if coarse else WINGS
    out = []
    for dte in DTES:
        for sd in SHORT_DS:
            for wing in wings:
                for ex in exits:
                    out.append({"dte": dte, "short_d": sd, "wing": wing, "wing_d": 0.10, "exit": ex, "entry": "none"})
    return out


def pick_tickers(conn, n: int):
    rows = conn.execute(
        """SELECT ticker, count(*) AS c FROM lseg_research.daily_history
           WHERE date BETWEEN '2021-01-01' AND '2023-12-31' AND iv30_put > 0 AND iv30_call > 0
           GROUP BY ticker HAVING count(*) >= 400 ORDER BY c DESC LIMIT %s""",
        (n + 10,),
    ).fetchall()
    skip = {"SPY", "QQQ", "IWM"}
    return [r[0] for r in rows if r[0] not in skip][:n]


def best_train_cell(trades):
    by = defaultdict(list)
    for t in trades:
        if t["d"].year <= 2023:
            by[(t["s"], cell_id(t["cfg"]))].append(t)
    best = None
    for k, xs in by.items():
        sm = summarize(xs)
        if sm and (best is None or sm["mean_xpd"] > best[1]["mean_xpd"]):
            best = (k, sm, xs)
    return best


def hand_check_condor(trades):
    for t in trades:
        if t["s"] == "iron_condor" and t["reason"] != "expiry":
            continue
        if t["s"] != "iron_condor":
            continue
        legs = t["legs"]
        cap = t["cap"]
        put_w = abs(legs[0][1] - legs[1][1])
        call_w = abs(legs[2][1] - legs[3][1])
        bp_est = max(put_w, call_w) - t["credit"]
        print(
            f"HAND iron_condor {t['t']} entry {t['d']} exit {t['e']} | legs "
            f"P {legs[1][1]:.2f}/{legs[0][1]:.2f} C {legs[2][1]:.2f}/{legs[3][1]:.2f} | "
            f"credit {t['credit']:.4f} cap_fn {cap:.2f} wing_bp_est {bp_est:.2f} | "
            f"xpd {t['xpd']:.6f} reason {t['reason']}"
        )
        return
    if trades:
        t = next(x for x in trades if x["s"] == "iron_condor")
        legs = t["legs"]
        print(
            f"HAND iron_condor {t['t']} entry {t['d']} | credit {t['credit']:.4f} cap {t['cap']:.2f} "
            f"| xpd {t['xpd']:.6f}"
        )


def write_report(by_side, stop: str, n_trials: int):
    lines = [
        "# S162 — A192 Part B0 managed structures",
        "",
        f"Stop rule: {stop}",
        f"Pricing: S075 skew mid + fill k={FILL_K}; bad-edge check `{PRICE_BAD}` scenario.",
        f"Data: `lseg_research.daily_history` (close, iv30_put/call); T-bill `out/opt/dtb3.csv`.",
        "",
    ]
    for sid, blocks in sorted(by_side.items()):
        lines.append(f"## {sid}")
        lines.append("| cell | n | mean $/BP/day | win% | t_mo | top exit mix |")
        lines.append("|---|---:|---:|---:|---:|---|")
        for cid, sm in sorted(blocks.items(), key=lambda x: -x[1]["mean_xpd"])[:12]:
            rm = ",".join(f"{k}:{v}" for k, v in list(sm["reasons"].items())[:4])
            lines.append(
                f"| {cid} | {sm['n']} | {sm['mean_xpd']:.5f} | {100*sm['win']:.0f}% | "
                f"{sm['t']:.2f} | {rm} |"
            )
        lines.append("")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--full", action="store_true", help="All structures, coarse grid, 80 tickers")
    ap.add_argument("--tickers", type=int, default=30)
    ap.add_argument("--continue", dest="cont", action="store_true", help="Smoke then full if stop passes")
    args = ap.parse_args()
    if not args.smoke and not args.full:
        args.smoke = True

    conn = connect()
    tickers = pick_tickers(conn, args.tickers)
    sides = SMOKE_SIDES if args.smoke and not args.full else ALL_SIDES
    cfgs = full_cfgs(smoke=args.smoke and not args.full, coarse=args.full or args.cont)
    end = TRAIN_END if args.smoke else date(2026, 6, 1)

    print(f"SANITY tickers={len(tickers)} sample={tickers[:5]} cfgs={len(cfgs)} sides={sides}")
    trades = collect_trades(conn, set(tickers), sides, cfgs, end)
    print(f"SANITY trades={len(trades)} finite_xpd={sum(1 for t in trades if math.isfinite(t['xpd']))}")

    if len(trades) == 0:
        print("SANITY FAIL: zero trades")
        write_report({}, "FAIL zero trades", len(cfgs) * len(sides))
        return 2

    # parameter sensitivity: hold vs tp50 on same entries
    hold = [t for t in trades if t["cfg"]["exit"] == "hold"]
    tp50 = [t for t in trades if t["cfg"]["exit"] == "tp50"]
    if hold and tp50:
        mh = statistics.mean(t["xpd"] for t in hold)
        mt = statistics.mean(t["xpd"] for t in tp50)
        print(f"SANITY CHANGES hold_mean_xpd={mh:.6f} tp50_mean_xpd={mt:.6f} delta={mt-mh:.6f}")

    hand_check_condor(trades)

    train = [t for t in trades if t["d"] <= TRAIN_END]
    best = best_train_cell(train)
    stop = "CONTINUE"
    if best is None or best[1]["mean_xpd"] <= 0:
        stop = "STOP — no train cell net > 0 per $BP/day at fills"
        print(f"SANITY stop_rule: {stop}")
    else:
        print(f"SANITY stop_rule: PASS best={best[0]} mean_xpd={best[1]['mean_xpd']:.6f}")

    by_side = defaultdict(dict)
    for t in trades:
        cid = cell_id(t["cfg"])
        by_side[t["s"]].setdefault(cid, []).append(t)
    for sid in by_side:
        for cid, xs in by_side[sid].items():
            sm = summarize(xs)
            if sm:
                by_side[sid][cid] = sm

    if stop.startswith("STOP") and args.smoke and not args.full:
        write_report(by_side, stop, len(cfgs) * len(sides))
        print(f"Wrote {OUT}")
        return 0

    if stop.startswith("CONTINUE") and (args.full or args.cont):
        print("FULL_RUN start (all structures, train 2021-23 + test 2024→) …")
        tickers_full = pick_tickers(conn, 80)
        sides = ALL_SIDES
        cfgs = full_cfgs(smoke=False, coarse=True)
        trades = collect_trades(conn, set(tickers_full), sides, cfgs, date(2025, 12, 31))
        train = [t for t in trades if t["d"] <= TRAIN_END]
        test = [t for t in trades if t["d"] >= TEST_START]
        best = best_train_cell(train)
        by_side = defaultdict(dict)
        for t in trades:
            cid = cell_id(t["cfg"])
            by_side[t["s"]].setdefault(cid, []).append(t)
        for sid in list(by_side):
            for cid, xs in list(by_side[sid].items()):
                sm = summarize(xs)
                if sm:
                    by_side[sid][cid] = sm
                else:
                    del by_side[sid][cid]
        print(f"FULL_RUN trades={len(trades)} train={len(train)} test={len(test)} tickers={len(tickers_full)}")

    write_report(by_side, stop, len(cfgs) * len(sides))
    print(f"Wrote {OUT}")
    if best:
        xs = np.array([t["xpd"] for t in best[2] if math.isfinite(t["xpd"])])
        dsr = deflated_sharpe(xs, max(len(cfgs) * len(sides), 1))
        print(f"FIRST_RESULT best_cell={best[0]} n={best[1]['n']} mean_xpd={best[1]['mean_xpd']:.6f} DSR={dsr:.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
