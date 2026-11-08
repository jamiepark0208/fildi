#!/usr/bin/env python3
"""S167 / A192 Part D2 — bull call debit on S100 + S046 entries vs Δ-stock vs long call (no price stop).

    cd scripts/watchlist_sync && .venv/bin/python analysis/s167_spreads_on_edge.py [--smoke]
"""
from __future__ import annotations

import argparse
import math
import random
import statistics
import sys
import time
from bisect import bisect_right
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

import structure_vec_engine as E  # noqa: E402
import s081_long_options as S081  # noqa: E402
import study_leak as leak  # noqa: E402
from build_plan import connect  # noqa: E402
from s076_structures_backtest import (  # noqa: E402
    Pricer,
    expiry_index,
    fill,
    load,
    strike_for,
)

OUT = HERE.parent / "out" / "opt" / "S167.md"
TRAIN_END = E.TRAIN_END
TEST_START = E.TEST_START
DTES = (30, 45)
LONG_DS = (0.50, 0.65)
SHORT_SIG = (0.5, 1.0)
EXITS = ("hold", "tp75", "tp90", "dte7")
rng = random.Random(167)
S100_PAIR = ("ibes_drift", "ret60")
S046_FEATS = ("call_volume", "call_trend_ext")


def strike_sigma(S: float, iv: float, T: float, sig: float) -> float:
    return S * math.exp(sig * iv * math.sqrt(T))


def legs_bull(S: float, ivc: float, T: float, ld: float, ssig: float) -> list[tuple[str, float, int]]:
    w = max(0.05 * S, 1.0)
    Kl = strike_for(S, ivc, T, ld, "call")
    Ks = strike_sigma(S, ivc, T, ssig)
    if Ks <= Kl:
        Ks = Kl + w
    return [("call", Kl, 1), ("call", Ks, -1)]


def exit_k(unreal: np.ndarray, debit: float, max_val: float, dte0: int, rule: str) -> int:
    H = len(unreal)
    if rule == "hold":
        return H - 1
    for h in range(1, H):
        dte_l = max(dte0 - h, 0)
        u = unreal[h]
        if rule == "tp75" and max_val > 0 and u >= 0.75 * max_val:
            return h
        if rule == "tp90" and max_val > 0 and u >= 0.90 * max_val:
            return h
        if rule == "dte7" and dte_l <= 7:
            return h
    return H - 1


def tbill_at(tb: list[tuple[date, float]], d: date) -> float:
    tbd = [x[0] for x in tb]
    if not tbd or d < tbd[0]:
        return tb[0][1] if tb else 0.0
    return tb[bisect_right(tbd, d) - 1][1]


def long_call_unreal(pricer: Pricer, rows: list, i: int, j: int, ld: float) -> tuple[float, float, np.ndarray]:
    d, S0, _, ivc0 = rows[i]
    e = rows[j][0]
    dte0 = max((e - d).days, 1)
    T0 = dte0 / 365.0
    K = strike_for(S0, ivc0, T0, ld, "call")
    mid, spr = pricer.mid("call", S0, K, ivc0, dte0, d)
    debit = fill(mid, spr, 1)
    if debit <= 0:
        return 0.0, 0.0, np.zeros(1)
    H = j - i + 1
    unreal = np.zeros(H)
    Se = rows[j][1]
    for h in range(1, H):
        if i + h >= j:
            unreal[h] = max(Se - K, 0.0) - debit
            break
        dd, Sd, _, ivc_d = rows[i + h]
        dte_l = max((e - dd).days, 0)
        if not ivc_d:
            continue
        m, sp = pricer.mid("call", Sd, K, ivc_d, max(dte_l, 1), dd)
        unreal[h] = fill(m, sp, -1) - debit
    return debit, K, unreal


def collect_s100_entries(conn) -> list[dict]:
    import s085_regime_analog as e
    import s086_strategy_board as B
    from s100_factor_pairs import IV_FIXED, LONG_FACTORS, TOPN, rank

    e.DIGEST = B.pick_digest(conn)
    px = e.load_prices(conn)
    universe = sorted(t for t in px if t not in e.BENCH)
    tech, fund, tgt, _ = e.load_lab(conn, set(universe))
    weeks = sorted(d for d in set(tech) | set(fund) if tgt.get(d))
    panel = e.build_panel(px, universe, weeks, tech, fund)
    for row in panel.values():
        for t, f in row.items():
            f.update(B.extras(px[t], f["_i"]))
    avail = set(e.factor_names(panel)) | {"ret60", "ibes_drift"}
    if not all(f in avail for f in S100_PAIR):
        return []

    def val(row, t, f):
        v = row[t].get(f)
        return v if isinstance(v, (int, float)) and v == v else None

    sg = {f: IV_FIXED.get(f, 1) for f in S100_PAIR}
    out = []
    for d, row in panel.items():
        if len(row) < 40:
            continue
        names = [t for t in row if all(val(row, t, f) is not None for f in S100_PAIR)]
        if len(names) < 40:
            continue
        sc = sum(sg[f] * rank([val(row, t, f) for t in names]) for f in S100_PAIR)
        for k in np.argsort(sc)[-TOPN:]:
            out.append({"t": names[k], "d": d, "source": "S100"})
    return out


def collect_s046_entries(conn) -> list[dict]:
    import s045_put_retest as S
    import s046_calls_avoid as C
    import s059_option_factors as F
    from s100_factor_pairs import rank, weekly_groups

    rows, tech, fund, px = S.load(conn)
    ev = C.build(rows, tech, fund, px)
    C.attach_call_tech(conn, ev)
    F.add_features(conn, ev)
    sign = {f: -1 for f in S046_FEATS}
    out = []
    for g in weekly_groups(ev, list(S046_FEATS)).values():
        sc = sum(sign[f] * rank([e[f] for e in g]) for f in S046_FEATS)
        q = max(1, len(g) // 5)
        for k in np.argsort(sc)[-q:]:
            e = g[k]
            out.append({"t": e["t"], "d": e["d"], "source": "S046"})
    return out


def bar_index(rows: list, d: date) -> int | None:
    ds = [r[0] for r in rows]
    j = bisect_right(ds, d) - 1
    if j < 0:
        return None
    if rows[j][0] == d:
        return j
    if j + 1 < len(rows):
        return j + 1
    return j


def move_bucket(move_sig: float) -> str:
    if not math.isfinite(move_sig):
        return "?"
    if move_sig < -0.5:
        return "<-0.5"
    if move_sig < 0:
        return "-0.5–0"
    if move_sig < 0.5:
        return "0–0.5"
    if move_sig < 1.5:
        return "0.5–1.5"
    return ">1.5"


def cell_key(dte: int, ld: float, ssig: float, ex: str) -> str:
    return f"d{dte}|ld{ld:.2f}|s{ssig}|{ex}"


def run_entry(
    ent: dict,
    rows: list,
    rep: list,
    tb: list[tuple[date, float]],
    pricer: Pricer,
    dte_tgt: int,
    ld: float,
    ssig: float,
    ex: str,
) -> dict | None:
    i = bar_index(rows, ent["d"])
    if i is None or i < 50:
        return None
    d, S, ivp, ivc = rows[i]
    if not ivp or not ivc:
        return None
    j = expiry_index(rows, i, dte_tgt)
    if j is None:
        return None
    e = rows[j][0]
    if any(d < x <= e for x in rep):
        return None
    dte0 = (e - d).days
    legs = legs_bull(S, ivc, dte0 / 365.0, ld, ssig)
    credit, cap, unreal, legs = E.price_paths_from_legs(pricer, rows, i, j, legs, "bull_call_debit")
    if cap is None:
        return None
    debit, width, max_val = E.debit_open(legs, credit)
    if debit <= 0 or debit > width + 1e-6:
        return None
    k = exit_k(unreal, debit, max_val, dte0, ex)
    pnl = unreal[k]
    days = max((rows[i + k][0] - d).days, 1)
    S_exit = rows[i + k][1]
    r_tb = tbill_at(tb, d)
    delta0 = E.net_delta_at_entry(rows, i, legs, dte0)
    stock_pnl = delta0 * (S_exit - S)
    stock_risk = abs(delta0) * S
    exc_sp = pnl / debit - r_tb * days / 365.0
    exc_st = stock_pnl / stock_risk - r_tb * days / 365.0 if stock_risk > 0 else float("nan")
    xpd_sp = exc_sp / days
    xpd_st = exc_st / days

    cdeb, _, cunreal = long_call_unreal(pricer, rows, i, j, ld)
    if cdeb <= 0:
        return None
    ck = exit_k(cunreal, cdeb, max(cdeb * 2, 0.01), dte0, ex)
    call_pnl = cunreal[ck]
    cdays = max((rows[i + ck][0] - d).days, 1)
    exc_ca = call_pnl / cdeb - r_tb * cdays / 365.0
    xpd_ca = exc_ca / cdays

    ST = rows[j][1]
    T = dte0 / 365.0
    move_sig = math.log(ST / S) / (ivc * math.sqrt(T)) if T > 0 and ivc > 0 else float("nan")

    return {
        **ent,
        "d": d,
        "cell": cell_key(dte_tgt, ld, ssig, ex),
        "dte": dte_tgt,
        "ld": ld,
        "ssig": ssig,
        "exit": ex,
        "days": days,
        "debit": debit,
        "width": width,
        "pnl_sp": pnl,
        "xpd_sp": xpd_sp,
        "exc_sp": exc_sp,
        "exc_st": exc_st,
        "cap_sp": debit,
        "pnl_st": stock_pnl,
        "xpd_st": xpd_st,
        "cap_st": stock_risk,
        "pnl_ca": call_pnl,
        "xpd_ca": xpd_ca,
        "exc_ca": exc_ca,
        "cap_ca": cdeb,
        "mark_day": rows[i + k][0],
        "move_sig": move_sig,
        "Kl": legs[0][1],
        "Ks": legs[1][1],
        "S": S,
        "ST": ST,
        "delta0": delta0,
    }


def to_leg_frame(rows: list[dict], arm: str) -> pd.DataFrame:
    rec = []
    for r in rows:
        rec.append(
            {
                "ticker": r["t"],
                "session": str(r["d"]),
                "signal_bar": 0,
                "pnl_coll_frac_cross": r[f"xpd_{arm}"],
            }
        )
    return pd.DataFrame(rec)


def pooled_xpd(rows: list[dict], arm: str) -> float:
    den = sum(r[f"cap_{arm}"] * r["days"] for r in rows if r[f"cap_{arm}"] > 0)
    if den <= 0:
        return float("nan")
    key = f"pnl_{arm}" if arm != "sp" else "pnl_sp"
    return sum(r[key] for r in rows) / den


def summarize_cell(rows: list[dict], arm: str) -> dict:
    trades = [{**r, "pnl": r[f"pnl_{arm}"], "cap": r[f"cap_{arm}"], "xpd": r[f"xpd_{arm}"], "d": r["d"]} for r in rows]
    sm = E.summarize(trades)
    if not sm:
        return {"n": 0}
    sm["pool_bp"] = pooled_xpd(rows, arm) * 1e4
    return sm


def smoke_hand_check(conn, entries: list[dict], bars: dict) -> bool:
    pricer = Pricer(conn)
    by_t = Counter(e["t"] for e in entries)
    tickers = [t for t, _ in by_t.most_common(3)]
    ok = True
    for t in tickers:
        rows = bars.get(t)
        if not rows:
            print(f"SANITY FAIL: no bars {t}")
            return False
        ent = next(e for e in entries if e["t"] == t)
        tr = None
        for dte in DTES:
            for ld in LONG_DS:
                for ssig in SHORT_SIG:
                    for ex in EXITS:
                        tr = run_entry(ent, rows, [], [], pricer, dte, ld, ssig, ex)
                        if tr:
                            break
                    if tr:
                        break
                if tr:
                    break
            if tr:
                break
        if not tr:
            print(f"SANITY FAIL: no trade priced {t}")
            ok = False
            continue
        payoff = min(max(tr["ST"] - tr["Kl"], 0), tr["Ks"] - tr["Kl"])
        print(
            f"SANITY hand {t} spread Kl={tr['Kl']:.2f} Ks={tr['Ks']:.2f} debit={tr['debit']:.3f} "
            f"width={tr['width']:.3f} payoff@exp={payoff:.3f} debit<=width={tr['debit'] <= tr['width']}"
        )
        if tr["debit"] > tr["width"] + 1e-4:
            ok = False
        i = bar_index(rows, ent["d"])
        cdeb, K, _ = long_call_unreal(pricer, rows, i, expiry_index(rows, i, tr["dte"]), tr["ld"])
        print(f"SANITY hand long_call K={K:.2f} debit={cdeb:.3f}")
    eras = ("train", "test")
    for src in ("S100", "S046"):
        for era in eras:
            n = sum(
                1
                for e in entries
                if e["source"] == src
                and ((e["d"] <= TRAIN_END and era == "train") or (e["d"] >= TEST_START and era == "test"))
            )
            print(f"SANITY entries {src} {era} n={n}")
            if n <= 0:
                print(f"SANITY FAIL: zero {src} {era}")
                ok = False
    return ok


def bucket_table(rows: list[dict]) -> list[str]:
    buckets = ["<-0.5", "-0.5–0", "0–0.5", "0.5–1.5", ">1.5"]
    lines = ["| bucket | n | share | spread exc | call exc | stock exc |", "|---|---:|---:|---:|---:|---:|"]
    n = len(rows)
    for b in buckets:
        sub = [r for r in rows if move_bucket(r["move_sig"]) == b]
        if not sub:
            lines.append(f"| {b} | 0 | 0% | — | — | — |")
            continue
        sh = len(sub) / n
        ms = statistics.mean(r["exc_sp"] for r in sub)
        mc = statistics.mean(r["exc_ca"] for r in sub)
        mt = statistics.mean(r["exc_st"] for r in sub)
        lines.append(f"| {b} | {len(sub)} | {sh:.1%} | {ms:+.2%} | {mc:+.2%} | {mt:+.2%} |")
    return lines


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true")
    args = ap.parse_args()
    t0 = time.time()
    with connect() as conn:
        print("collecting entries…", flush=True)
        entries = collect_s100_entries(conn) + collect_s046_entries(conn)
        entries = [e for e in entries if e["d"] >= date(2021, 2, 1)]
        if args.smoke:
            by_t = Counter(e["t"] for e in entries)
            keep = {t for t, _ in by_t.most_common(3)}
            entries = [e for e in entries if e["t"] in keep]
        tickers = sorted({e["t"] for e in entries})
        bars, rep, tb = load(conn, set(tickers))
        if args.smoke:
            if not smoke_hand_check(conn, entries, bars):
                print("SMOKE GATE FAIL — stop")
                return 2
            print("SANITY smoke change: 3 tickers only — full run uses all entry tickers", flush=True)
        pricer = Pricer(conn)
        trades: list[dict] = []
        for ent in entries:
            rows = bars.get(ent["t"])
            if not rows:
                continue
            rd = rep.get(ent["t"], [])
            for dte in DTES:
                for ld in LONG_DS:
                    for ssig in SHORT_SIG:
                        for ex in EXITS:
                            tr = run_entry(ent, rows, rd, tb, pricer, dte, ld, ssig, ex)
                            if tr:
                                trades.append(tr)
        print(f"FIRST_RESULT trades={len(trades)} entries={len(entries)} tickers={len(tickers)} t={time.time()-t0:.0f}s", flush=True)

        train = [t for t in trades if t["d"] <= TRAIN_END]
        test = [t for t in trades if t["d"] >= TEST_START]
        by_cell: dict[str, list[dict]] = defaultdict(list)
        for t in train:
            by_cell[t["cell"]].append(t)

        best_cell, best_pool = "", float("-inf")
        for ck, xs in by_cell.items():
            p = pooled_xpd(xs, "sp")
            if math.isfinite(p) and p > best_pool:
                best_pool, best_cell = p, ck
        stock_pool_best = pooled_xpd(by_cell.get(best_cell, []), "st")
        every_trails = all(
            pooled_xpd(xs, "sp") < pooled_xpd(xs, "st")
            for xs in by_cell.values()
            if len(xs) >= 10
        )

        lines = [
            "# S167 — spreads on direction-edge entries (A192 Part D2)",
            "",
            f"entries S100+S046 weekly · fills bid+23% · grade exc/($risk·day) · train≤{TRAIN_END} test≥{TEST_START}",
            f"trades={len(trades)} train={len(train)} test={len(test)} tickers={len(tickers)}",
            "",
            "## Per-source entry counts",
        ]
        for src in ("S100", "S046"):
            for era, cut in (("train", lambda d: d <= TRAIN_END), ("test", lambda d: d >= TEST_START)):
                n = sum(1 for e in entries if e["source"] == src and cut(e["d"]))
                lines.append(f"- {src} {era}: {n} entries")
        lines.append("")

        verdict = "INCOMPLETE"
        stop_test = every_trails and len(by_cell) > 0
        test_block = []
        placebo_p = shift_bp = float("nan")
        if stop_test:
            verdict = "STOP train — every spread cell trails Δ-stock"
            lines.append(f"**Stop rule:** all train cells spread pool < stock → no test peek. verdict={verdict}")
            lines.extend(["", f"## Move buckets (best train cell {best_cell})"])
            lines.extend(bucket_table(by_cell.get(best_cell, [])))
        else:
            test_sub = E.deoverlap([t for t in test if t["cell"] == best_cell])
            test_sp = pooled_xpd(test_sub, "sp") * 1e4
            test_st = pooled_xpd(test_sub, "st") * 1e4
            test_ca = pooled_xpd(test_sub, "ca") * 1e4
            sm_t = E.summarize(
                [{**r, "pnl": r["pnl_sp"], "cap": r["cap_sp"], "xpd": r["xpd_sp"]} for r in test_sub]
            )
            test_t = sm_t["t"] if sm_t else float("nan")
            cond = to_leg_frame(test_sub, "sp")
            base = to_leg_frame([t for t in test if t["source"] == test_sub[0]["source"]], "sp") if test_sub else cond
            lk = leak.leak_from_trade_frames(cond, base, np.random.default_rng(167))
            placebo_p, shift_bp = lk["placebo_p"], lk["shift_bp"]
            test_block = [
                f"best_train_cell={best_cell} train_sp={best_pool*1e4:+.2f}bp stock={stock_pool_best*1e4:+.2f}bp",
                f"test n_deov={len(test_sub)} spread={test_sp:+.2f} stock={test_st:+.2f} call={test_ca:+.2f} bp/day month_t={test_t:.2f}",
                f"leak shift_bp={shift_bp:.1f} placebo_p={placebo_p:.3f}",
            ]
            lines.extend(["## Best train cell → test", *test_block, ""])
            if len(test_sub) < 30:
                verdict = "UNDERPOWERED"
            elif test_sp > test_st and test_sp > test_ca and (sm_t or {}).get("t", 0) >= 2 and placebo_p <= 0.10:
                verdict = "WORKS"
            elif test_sp > test_st and test_sp > test_ca:
                verdict = "NO_LIFT"
            else:
                verdict = "FAIL"
            lines.append(f"**Verdict:** {verdict}")
            lines.extend(["", "## Move buckets (best train cell, all eras)"])
            lines.extend(bucket_table(by_cell.get(best_cell, []) + [t for t in test if t["cell"] == best_cell]))

        lines.insert(0, "CONTRACT 1-7: ok|missing 6 (halves/SPY200)")
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text("\n".join(lines) + "\n")
        print(f"Wrote {OUT} verdict={verdict}")

        if not args.smoke:
            packet = [
                "## Cursor packet (Part D2)",
                "CONTRACT 1-7: ok|missing 6",
                "smoke: PASS (ran before full)",
            ]
            for src in ("S100", "S046"):
                nt = sum(1 for e in entries if e["source"] == src and e["d"] <= TRAIN_END)
                ns = sum(1 for e in entries if e["source"] == src and e["d"] >= TEST_START)
                packet.append(f"{src} entries train/test={nt}/{ns}")
            packet.append(f"best_train={best_cell} train_sp={best_pool*1e4:+.1f}bp vs stock={stock_pool_best*1e4:+.1f}bp")
            if stop_test:
                packet.append("test: STOP all train cells trail stock (no peek)")
                pkt_buckets = bucket_table(by_cell.get(best_cell, []))
                packet.extend(pkt_buckets[2:7])
                packet.append(f"verdict: {verdict}")
            else:
                packet.extend(test_block)
                packet.append(f"placebo_p={placebo_p:.3f}")
                pkt_buckets = bucket_table(by_cell.get(best_cell, []) + [t for t in test if t["cell"] == best_cell])
                packet.extend(pkt_buckets[2:5])
                packet.append(f"verdict: {verdict}")
            packet.append("Agent: cursor · Refs: A192")
            ask = HERE.parent.parent.parent / "research" / "common" / "asks" / "A192.md"
            text = ask.read_text()
            if "## Cursor packet (Part D2)" in text:
                text = text.split("## Cursor packet (Part D2)")[0].rstrip() + "\n\n"
            ask.write_text(text + "\n".join(packet) + "\n")
            print("\n".join(packet))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
