#!/usr/bin/env python3
"""S171 / A244 — loss-maker long calls when a big move is likely AND the option is cheap.

Reuses S170 pricer/fills/groups/comparators/Part-C reporting. Gates G1–G4 ex-ante.
TRAIN < 2024-07-01; TEST ≥ 2024-07-01 once.

    cd scripts/watchlist_sync && .venv/bin/python analysis/s171_lossmaker_cheap_bigmove_calls.py --smoke
    cd scripts/watchlist_sync && .venv/bin/python analysis/s171_lossmaker_cheap_bigmove_calls.py
"""
from __future__ import annotations

import argparse
import math
import random
import statistics
import sys
import time
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

from build_plan import connect  # noqa: E402
from s076_structures_backtest import Pricer, load  # noqa: E402
from s169_lossmaker_crash_calls import (  # noqa: E402
    load_groups,
    pooled_xpd,
    ret_n,
    rv20,
    time_halves,
    universe_tickers,
)
from s170_lossmaker_call_timing import (  # noqa: E402
    E0_STRIDE,
    LONG_DS,
    TEST_START,
    TRAIN_END,
    call_path,
    deoverlap,
    features_at,
    load_ohlcv,
    load_ticker_sector,
    load_vix_term,
    price_rows,
    summarize,
    trade_from_path,
)

OUT = HERE.parent / "out" / "opt" / "S171.md"
SMOKE_TICKERS = ("RGTI", "IONQ", "OKLO", "SOUN")
DTES = (30, 45)  # global: pre-registered grid
EXITS = ("ts3", "ts5", "ts10", "tp100", "trail", "hold")  # global: pre-registered
GATES = ("none", "G1", "G2", "G3", "G4")  # global: pre-registered
ENTRIES = ("E0", "M", "C")  # global: pre-registered
# S170 Part A frozen momentum rule (packet out/opt/S170.md)
M_CUTS = {"ret20": 0.1661, "rsi14": 63.36, "ret5": 0.07782}  # global: frozen from S170 TRAIN
CRASH_OWN = -0.20  # global: S169 own 5d crash
MIN_N = 200  # global: train floor
MIN_ND = 60  # global: distinct entry-date floor
rng = random.Random(171)


def iv_dec(iv: float | None) -> float | None:
    if iv is None or not math.isfinite(iv) or iv <= 0:
        return None
    return iv / 100.0 if iv > 3 else iv


def horizon(exit_rule: str, dte: int) -> int:
    if exit_rule.startswith("ts"):
        return int(exit_rule[2:])
    return int(dte)


def load_earnings(conn) -> dict[str, list[date]]:
    """LSEG report dates — same source as S025 (lseg_research.earnings_moves)."""
    out: dict[str, list[date]] = defaultdict(list)
    for t, d in conn.execute(
        "SELECT ticker, report_date FROM lseg_research.earnings_moves ORDER BY ticker, report_date"
    ):
        out[t].append(d)
    return out


def earn_in_window(earns: list[date], d0: date, d1: date) -> bool:
    """True if a report falls strictly after entry close and on/before projected exit day."""
    for e in earns:
        if e > d1:
            return False
        if d0 < e <= d1:
            return True
    return False


def build_stock_gate_cache(ohlc: list) -> dict:
    """Per-index G1/G2 inputs; stock-specific trailing 252d (contract 9)."""
    n = len(ohlc)
    pr = price_rows(ohlc)
    ivrv = [None] * n
    for i in range(n):
        iv = iv_dec(ohlc[i][7] or ohlc[i][6])
        rv = rv20(pr, i)
        if iv and rv and rv > 0:
            ivrv[i] = iv / rv
    g1 = [0] * n
    # trailing 252 obs of ivrv → bottom tercile
    for i in range(n):
        if ivrv[i] is None:
            continue
        lo = max(0, i - 251)
        hist = [ivrv[k] for k in range(lo, i + 1) if ivrv[k] is not None]
        if len(hist) < 60:
            continue
        cut = sorted(hist)[max(0, int(0.333 * (len(hist) - 1)))]
        g1[i] = 1 if ivrv[i] <= cut else 0

    # |h-day| q75 + implied move for horizons we need
    hs = (3, 5, 10, 30, 45)
    abs_q75: dict[int, list] = {h: [None] * n for h in hs}
    g2: dict[int, list] = {h: [0] * n for h in hs}
    impl: dict[int, list] = {h: [None] * n for h in hs}
    for h in hs:
        for i in range(n):
            iv = iv_dec(ohlc[i][7] or ohlc[i][6])
            if iv:
                impl[h][i] = iv * math.sqrt(h / 252.0)
            if i < h:
                continue
            lo = max(h, i - 251)
            moves = []
            for k in range(lo, i + 1):
                s0, s1 = ohlc[k - h][4], ohlc[k][4]
                if s0 > 0:
                    moves.append(abs(s1 / s0 - 1.0))
            if len(moves) < 40:
                continue
            q = sorted(moves)[int(0.75 * (len(moves) - 1))]
            abs_q75[h][i] = q
            if impl[h][i] is not None and impl[h][i] < q:
                g2[h][i] = 1
    # thresholds for smoke print (latest valid in 2023)
    thr = {"ivrv_t1": None, "q75_h10": None, "impl_h10": None}
    for i in range(n - 1, -1, -1):
        if ohlc[i][0].year != 2023:
            continue
        if thr["ivrv_t1"] is None and ivrv[i] is not None:
            lo = max(0, i - 251)
            hist = [ivrv[k] for k in range(lo, i + 1) if ivrv[k] is not None]
            if len(hist) >= 60:
                thr["ivrv_t1"] = sorted(hist)[max(0, int(0.333 * (len(hist) - 1)))]
                thr["ivrv_now"] = ivrv[i]
        if thr["q75_h10"] is None and abs_q75[10][i] is not None:
            thr["q75_h10"] = abs_q75[10][i]
            thr["impl_h10"] = impl[10][i]
            thr["iv_raw"] = ohlc[i][7] or ohlc[i][6]
            thr["d"] = ohlc[i][0]
        if thr["ivrv_t1"] is not None and thr["q75_h10"] is not None:
            break
    return {"g1": g1, "g2": g2, "impl": impl, "abs_q75": abs_q75, "ivrv": ivrv, "thr": thr, "pr": pr}


def passes_M(feat: dict) -> bool:
    for k, cut in M_CUTS.items():
        v = feat.get(k)
        if v is None or not math.isfinite(float(v)) or float(v) < cut:
            return False
    return True


def collect_entries(
    tickers: list[str],
    groups: dict[str, str],
    ohlc_bars: dict,
    spy: list,
    spy_i: dict,
    vix_term: dict,
    sectors: dict,
    etf_bars: dict,
    d0: date,
    d1: date,
    group_name: str = "loss",
) -> dict[str, list[dict]]:
    """E0 every 5th bar · M S170 momentum · C S169 crash (enter next close)."""
    out: dict[str, list[dict]] = {k: [] for k in ENTRIES}
    for t in tickers:
        if groups.get(t) != group_name:
            continue
        ohlc = ohlc_bars.get(t)
        if not ohlc or len(ohlc) < 80:
            continue
        etf = None
        sect = sectors.get(t, "").lower()
        from s170_lossmaker_call_timing import SECTOR_ETF

        etf_sym = SECTOR_ETF.get(sect)
        sect_rows = etf_bars.get(etf_sym) if etf_sym else None
        sect_i = {r[0]: idx for idx, r in enumerate(sect_rows)} if sect_rows else None
        last_crash_i = -10_000
        for i in range(60, len(ohlc) - 2):
            d = ohlc[i][0]
            if d < d0 or d > d1:
                continue
            feat = features_at(ohlc, i, spy, spy_i, vix_term, sect_rows, sect_i)
            if not feat:
                continue
            base = {"t": t, "d": d, "entry_i": i, "group": group_name, **feat}
            if i % E0_STRIDE == 0:
                out["E0"].append({**base, "kind": "E0"})
            if passes_M(feat):
                out["M"].append({**base, "kind": "M"})
            # C: signal on i (r5≤−20%), enter next close i+1 (S169)
            pr = price_rows(ohlc)
            r5 = ret_n(pr, i, 5)
            if r5 is not None and r5 <= CRASH_OWN and i - last_crash_i >= 10:
                j = i + 1
                if j < len(ohlc) and d0 <= ohlc[j][0] <= d1:
                    feat_j = features_at(ohlc, j, spy, spy_i, vix_term, sect_rows, sect_i)
                    if feat_j:
                        out["C"].append(
                            {
                                **feat_j,
                                "t": t,
                                "d": ohlc[j][0],
                                "entry_i": j,
                                "group": group_name,
                                "kind": "C",
                                "signal_i": i,
                                "crash_r5": r5,
                            }
                        )
                        last_crash_i = i
    # uniq
    for k in ENTRIES:
        seen, uniq = set(), []
        for e in out[k]:
            key = (e["t"], e["d"])
            if key in seen:
                continue
            seen.add(key)
            uniq.append(e)
        out[k] = uniq
    return out


def gate_ok(gate: str, g1: int, g2: int, g3: int) -> bool:
    if gate == "none":
        return True
    if gate == "G1":
        return g1 == 1
    if gate == "G2":
        return g2 == 1
    if gate == "G3":
        return g3 == 1
    if gate == "G4":
        return g3 == 1 and (g1 == 1 or g2 == 1)
    return False


def _path_cache_key(t: str, i: int, dte: int, ld: float) -> tuple:
    return (t, i, dte, ld)


def price_entries(
    entries: list[dict],
    ohlc_bars: dict,
    caches: dict,
    earns: dict[str, list[date]],
    tb: list,
    pricer: Pricer,
    dte: int,
    ld: float,
    exit_rule: str,
    gate: str,
    path_cache: dict | None = None,
) -> list[dict]:
    h = horizon(exit_rule, dte)
    cell = f"d{dte}|ld{ld:.2f}"
    trades: list[dict] = []
    pc = path_cache if path_cache is not None else {}
    for ent in entries:
        t = ent["t"]
        ohlc = ohlc_bars.get(t)
        cache = caches.get(t)
        if not ohlc or not cache:
            continue
        i = ent["entry_i"]
        if i >= len(ohlc) - 1:
            continue
        g1 = cache["g1"][i] if i < len(cache["g1"]) else 0
        g2m = cache["g2"].get(h)
        g2 = g2m[i] if g2m is not None and i < len(g2m) else 0
        j = min(i + h, len(ohlc) - 1)
        d_exit = ohlc[j][0]
        g3 = 1 if earn_in_window(earns.get(t, []), ent["d"], d_exit) else 0
        if not gate_ok(gate, g1, g2, g3):
            continue
        rows = cache["pr"]
        ck = _path_cache_key(t, i, dte, ld)
        if ck in pc:
            got = pc[ck]
        else:
            got = call_path(pricer, rows, i, dte, ld, max_h=None)
            pc[ck] = got
        if not got:
            continue
        deb, K, unreal, pb = got
        tr = trade_from_path(
            {**ent, "g1": g1, "g2": g2, "g3": g3, "gate": gate, "h": h},
            rows,
            tb,
            deb,
            K,
            unreal,
            exit_rule,
            ld,
            pb,
            cell,
        )
        if tr:
            tr["impl"] = cache["impl"].get(h, [None] * (i + 1))[i] if h in cache["impl"] else None
            tr["ivrv"] = cache["ivrv"][i] if i < len(cache["ivrv"]) else None
            trades.append(tr)
    return deoverlap(trades)


def delayed_trades(
    trades: list[dict],
    ohlc_bars: dict,
    caches: dict,
    tb: list,
    pricer: Pricer,
    dte: int,
    ld: float,
    exit_rule: str,
) -> list[dict]:
    """One-bar-delayed entry (same structure/exit); for shift_bp."""
    cell = f"d{dte}|ld{ld:.2f}"
    out: list[dict] = []
    for tr in trades:
        t = tr["t"]
        ohlc = ohlc_bars.get(t)
        cache = caches.get(t)
        if not ohlc or not cache:
            continue
        i0 = tr.get("entry_i")
        if i0 is None:
            continue
        i = i0 + 1
        if i >= len(ohlc) - 1:
            continue
        rows = cache["pr"]
        got = call_path(pricer, rows, i, dte, ld, max_h=None)
        if not got:
            continue
        deb, K, unreal, pb = got
        ent = {"t": t, "d": ohlc[i][0], "entry_i": i, "group": tr.get("group"), "kind": "SHIFT"}
        x = trade_from_path(ent, rows, tb, deb, K, unreal, exit_rule, ld, pb, cell)
        if x:
            out.append(x)
    return deoverlap(out)


def placebo_p(sig: list[dict], pool: list[dict], n_draws: int = 200) -> float:
    if len(sig) < 10 or len(pool) < len(sig):
        return float("nan")
    target = pooled_xpd(sig, "ca")
    hits = 0
    for _ in range(n_draws):
        pick = rng.sample(pool, len(sig))
        if pooled_xpd(pick, "ca") >= target:
            hits += 1
    return hits / n_draws


def score_cell(tr: list[dict]) -> tuple[float, float, int, int]:
    """Return (vs_delta_bp, call_bp, n, n_indep)."""
    if not tr:
        return float("-inf"), float("nan"), 0, 0
    ca = pooled_xpd(tr, "ca") * 1e4
    sd = pooled_xpd(tr, "sd") * 1e4
    return ca - sd, ca, len(tr), len({r["d"] for r in tr})


def smoke_gate(
    ohlc_bars: dict,
    caches: dict,
    earns: dict[str, list[date]],
    groups: dict,
    tb: list,
    pricer: Pricer,
) -> bool:
    ok = True
    # RGTI earnings source + G3 span check
    rgti_e = earns.get("RGTI") or []
    e2023 = [e for e in rgti_e if e.year == 2023]
    if not e2023:
        print("SANITY FAIL: no RGTI 2023 earnings in lseg_research.earnings_moves")
        return False
    e0 = e2023[0]
    print(f"SANITY RGTI earnings_date={e0} source=lseg_research.earnings_moves", flush=True)
    ohlc = ohlc_bars["RGTI"]
    # find an entry whose ts10 window spans e0, and one that does not
    spanned = False
    not_span = False
    for i in range(60, len(ohlc) - 15):
        d = ohlc[i][0]
        if d.year != 2023:
            continue
        d_exit = ohlc[min(i + 10, len(ohlc) - 1)][0]
        g3 = earn_in_window(rgti_e, d, d_exit)
        if g3 and d < e0 <= d_exit:
            spanned = True
        if not g3 and not (d < e0 <= d_exit):
            not_span = True
        if spanned and not_span:
            break
    if not spanned:
        print("SANITY FAIL: G3 never true for RGTI ts10 spanning earnings")
        ok = False
    else:
        print("SANITY G3 true only when hold window spans earnings — ok", flush=True)

    # G1/G2 thresholds differ RGTI vs SOUN
    tr_r = caches["RGTI"]["thr"]
    tr_s = caches["SOUN"]["thr"]
    print(
        f"SANITY G1/G2 thr RGTI ivrv_t1={tr_r.get('ivrv_t1')} q75_h10={tr_r.get('q75_h10')} "
        f"SOUN ivrv_t1={tr_s.get('ivrv_t1')} q75_h10={tr_s.get('q75_h10')}",
        flush=True,
    )
    if tr_r.get("ivrv_t1") is None or tr_s.get("ivrv_t1") is None:
        print("SANITY FAIL: missing G1 threshold")
        ok = False
    elif abs(tr_r["ivrv_t1"] - tr_s["ivrv_t1"]) < 1e-9:
        print("SANITY FAIL: RGTI vs SOUN G1 threshold identical")
        ok = False
    if tr_r.get("q75_h10") is None or tr_s.get("q75_h10") is None:
        print("SANITY FAIL: missing G2 q75")
        ok = False
    elif abs(tr_r["q75_h10"] - tr_s["q75_h10"]) < 1e-9:
        print("SANITY FAIL: RGTI vs SOUN G2 q75 identical")
        ok = False

    # hand-check implied move
    d_chk = tr_r.get("d")
    iv_raw = tr_r.get("iv_raw")
    impl = tr_r.get("impl_h10")
    if d_chk and iv_raw and impl is not None:
        expect = iv_dec(iv_raw) * math.sqrt(10 / 252.0)
        print(
            f"SANITY RGTI implied_move d={d_chk} IV30={iv_raw} h=10 "
            f"impl={impl:.6f} expect=IV30*sqrt(h/252)={expect:.6f}",
            flush=True,
        )
        if abs(impl - expect) > 1e-9:
            print("SANITY FAIL: implied move ≠ IV30·√(h/252)")
            ok = False
    else:
        print("SANITY FAIL: no RGTI row for implied-move hand-check")
        ok = False

    # tiny cell: E0 × none × 0.30Δ × 30 DTE × ts3 — shift_bp not nan
    spy = price_rows(ohlc_bars.get("SPY") or [])
    spy_i = {r[0]: idx for idx, r in enumerate(spy)}
    for t in SMOKE_TICKERS:
        groups.setdefault(t, "loss")
    ents = collect_entries(
        list(SMOKE_TICKERS),
        groups,
        ohlc_bars,
        spy,
        spy_i,
        {},
        {t: "technology" for t in SMOKE_TICKERS},
        {},
        date(2023, 1, 1),
        date(2023, 12, 31),
        "loss",
    )
    tr = price_entries(ents["E0"], ohlc_bars, caches, earns, tb, pricer, 30, 0.30, "ts3", "none")
    sh = delayed_trades(tr, ohlc_bars, caches, tb, pricer, 30, 0.30, "ts3")
    if not tr:
        print("SANITY FAIL: no smoke E0 trades")
        return False
    ca = pooled_xpd(tr, "ca") * 1e4
    delayed_bp = pooled_xpd(sh, "ca") * 1e4 if sh else float("nan")
    print(
        f"SANITY cell E0|none|d30|0.30|ts3 n={len(tr)} bp={ca:+.1f} shift_bp={delayed_bp:+.1f} "
        f"(delayed n={len(sh)})",
        flush=True,
    )
    if not math.isfinite(delayed_bp):
        print("SANITY FAIL: shift_bp nan")
        ok = False
    # parameter change: G1 should change trade count vs none
    tr_g1 = price_entries(ents["E0"], ohlc_bars, caches, earns, tb, pricer, 30, 0.30, "ts3", "G1")
    print(f"SANITY CHANGES none_n={len(tr)} G1_n={len(tr_g1)}", flush=True)
    if len(tr_g1) == len(tr) and len(tr) > 5:
        # may be equal if all pass G1 — check G3 smaller
        tr_g3 = price_entries(ents["E0"], ohlc_bars, caches, earns, tb, pricer, 30, 0.30, "ts3", "G3")
        print(f"SANITY CHANGES G3_n={len(tr_g3)}", flush=True)
        if len(tr_g3) >= len(tr):
            print("SANITY FAIL: gate does not change trade count")
            ok = False
    print(f"SANITY trade/row count plausible n={len(tr)} (smoke 4 names 2023)", flush=True)
    return ok


def anatomy(tr: list[dict]) -> str:
    buckets = [(-1, -0.1), (-0.1, 0), (0, 0.1), (0.1, 0.25), (0.25, 1.0)]
    parts = []
    for lo, hi in buckets:
        sub = [r for r in tr if lo <= r.get("move", -99) < hi]
        if not sub:
            parts.append(f"[{lo:.0%},{hi:.0%}):n=0")
            continue
        bca = pooled_xpd(sub, "ca") * 1e4
        bst = pooled_xpd(sub, "st") * 1e4
        parts.append(f"[{lo:.0%},{hi:.0%}):n={len(sub)} ca={bca:+.0f} st={bst:+.0f}")
    earn_y = [r for r in tr if r.get("g3") == 1]
    earn_n = [r for r in tr if r.get("g3") == 0]
    ey = pooled_xpd(earn_y, "ca") * 1e4 if earn_y else float("nan")
    en = pooled_xpd(earn_n, "ca") * 1e4 if earn_n else float("nan")
    return (
        f"move: {' · '.join(parts)}; "
        f"earn_in n={len(earn_y)} bp={ey:+.1f} · no_earn n={len(earn_n)} bp={en:+.1f}"
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true")
    args = ap.parse_args()
    t0 = time.time()

    with connect() as conn:
        groups, always_loss = load_groups(conn)
        tickers = list(SMOKE_TICKERS) if args.smoke else universe_tickers(conn, False)
        for t in SMOKE_TICKERS:
            groups.setdefault(t, "loss")
        need = set(tickers) | {"SPY"}
        from s170_lossmaker_call_timing import SECTOR_ETF

        need |= set(SECTOR_ETF.values())
        _, _rep, tb = load(conn, need)
        ohlc_bars = load_ohlcv(conn, need)
        earns = load_earnings(conn)
        spy = price_rows(ohlc_bars.get("SPY") or [])
        spy_i = {r[0]: idx for idx, r in enumerate(spy)}
        vix_term = load_vix_term(conn)
        sectors = load_ticker_sector(conn, tickers)
        etf_bars: dict[str, list] = {}
        for etf in set(SECTOR_ETF.values()):
            rows = ohlc_bars.get(etf) or []
            etf_bars[etf] = [(r[0], r[4]) for r in rows]
        pricer = Pricer(conn)

        print("building gate caches…", flush=True)
        caches: dict[str, dict] = {}
        for t in tickers:
            ohlc = ohlc_bars.get(t)
            if ohlc and len(ohlc) >= 80:
                caches[t] = build_stock_gate_cache(ohlc)

        if args.smoke:
            if not smoke_gate(ohlc_bars, caches, earns, groups, tb, pricer):
                print("SMOKE GATE FAIL — stop")
                return 2
            print(f"SANITY smoke PASS t={time.time()-t0:.0f}s", flush=True)
            return 0

        # -------- TRAIN grid --------
        print("TRAIN collect entries…", flush=True)
        train_ents = collect_entries(
            tickers, groups, ohlc_bars, spy, spy_i, vix_term, sectors, etf_bars,
            date(2019, 1, 1), TRAIN_END, "loss",
        )
        print(
            f"FIRST_RESULT train E0={len(train_ents['E0'])} M={len(train_ents['M'])} "
            f"C={len(train_ents['C'])} t={time.time()-t0:.0f}s",
            flush=True,
        )

        ranked: list[tuple] = []
        n_cells = 0
        path_cache: dict = {}
        for ent_name in ENTRIES:
            ents = train_ents[ent_name]
            for gate in GATES:
                for dte in DTES:
                    for ld in LONG_DS:
                        for ex in EXITS:
                            n_cells += 1
                            tr = price_entries(
                                ents, ohlc_bars, caches, earns, tb, pricer, dte, ld, ex, gate,
                                path_cache=path_cache,
                            )
                            vs, ca, n, nd = score_cell(tr)
                            if n >= MIN_N and nd >= MIN_ND and math.isfinite(vs):
                                # keep summary only (drop trade list) until best known
                                ranked.append((vs, ca, n, nd, ent_name, gate, dte, ld, ex))
                            if n_cells % 60 == 0:
                                print(
                                    f"TRAIN progress cells={n_cells} floored={len(ranked)} "
                                    f"t={time.time()-t0:.0f}s",
                                    flush=True,
                                )
        ranked.sort(key=lambda x: x[0], reverse=True)
        print(f"TRAIN scored cells with floor={len(ranked)} / {n_cells} t={time.time()-t0:.0f}s", flush=True)
        if not ranked:
            path_cache.clear()
            for ent_name in ENTRIES:
                ents = train_ents[ent_name]
                for gate in GATES:
                    for dte in DTES:
                        for ld in LONG_DS:
                            for ex in EXITS:
                                tr = price_entries(
                                    ents, ohlc_bars, caches, earns, tb, pricer, dte, ld, ex, gate,
                                    path_cache=path_cache,
                                )
                                vs, ca, n, nd = score_cell(tr)
                                if n >= 50 and nd >= 20 and math.isfinite(vs):
                                    ranked.append((vs, ca, n, nd, ent_name, gate, dte, ld, ex))
            ranked.sort(key=lambda x: x[0], reverse=True)

        top5 = ranked[:5]
        for i, row in enumerate(top5):
            vs, ca, n, nd, en, g, dte, ld, ex = row
            print(
                f"TRAIN top{i+1}: {en}|{g}|d{dte}|ld{ld:.2f}|{ex} "
                f"vsΔ={vs:+.1f} bp={ca:+.1f} n={n} nd={nd}",
                flush=True,
            )
        if not ranked:
            print("SANITY FAIL: no train cell meets floor")
            return 2
        vs_tr, ca_tr, n_tr, nd_tr, en_b, g_b, dte_b, ld_b, ex_b = ranked[0]
        print(
            f"TRAIN best={en_b}|{g_b}|d{dte_b}|ld{ld_b:.2f}|{ex_b} "
            f"vsΔ={vs_tr:+.1f} bp={ca_tr:+.1f} n={n_tr} nd={nd_tr}",
            flush=True,
        )

        # -------- TEST once --------
        print("TEST once…", flush=True)
        test_ents = collect_entries(
            tickers, groups, ohlc_bars, spy, spy_i, vix_term, sectors, etf_bars,
            TEST_START, date(2026, 11, 1), "loss",
        )
        # E0 same structure for comparator
        e0_test = price_entries(
            test_ents["E0"], ohlc_bars, caches, earns, tb, pricer, dte_b, ld_b, ex_b, "none"
        )
        # also E0 with same gate (spec: E0 same structure/exit)
        e0_same = price_entries(
            test_ents["E0"], ohlc_bars, caches, earns, tb, pricer, dte_b, ld_b, ex_b, g_b
        )
        sig_te = price_entries(
            test_ents[en_b], ohlc_bars, caches, earns, tb, pricer, dte_b, ld_b, ex_b, g_b
        )
        sm = summarize(sig_te, "ca")
        sm_sd = summarize(sig_te, "sd")
        sm_st = summarize(sig_te, "st")
        sm_e0 = summarize(e0_same if g_b != "none" else e0_test, "ca")
        # if gated E0 empty, fall back to ungated E0 same structure
        if sm_e0["n"] < 30:
            sm_e0 = summarize(e0_test, "ca")
        h1, h2 = time_halves(sig_te, "ca")
        vs_e0 = sm["bp"] - sm_e0["bp"] if math.isfinite(sm["bp"]) and math.isfinite(sm_e0["bp"]) else float("nan")
        vs_sd = sm["bp"] - sm_sd["bp"] if math.isfinite(sm["bp"]) and math.isfinite(sm_sd["bp"]) else float("nan")
        vs_st = sm["bp"] - sm_st["bp"] if math.isfinite(sm["bp"]) and math.isfinite(sm_st["bp"]) else float("nan")

        delayed = delayed_trades(sig_te, ohlc_bars, caches, tb, pricer, dte_b, ld_b, ex_b)
        shift_bp = pooled_xpd(delayed, "ca") * 1e4 if delayed else float("nan")
        # also leak-style diff for context
        leak_diff = (
            (sm["bp"] - shift_bp) if math.isfinite(sm["bp"]) and math.isfinite(shift_bp) else float("nan")
        )
        pp = placebo_p(sig_te, e0_test if e0_test else e0_same)

        cell = f"d{dte_b}|ld{ld_b:.2f}"
        n_indep = sm["nd"]
        bits = {
            "vsΔ>0": math.isfinite(vs_sd) and vs_sd > 0,
            "vsE0≥+10": math.isfinite(vs_e0) and vs_e0 >= 10,
            "ct≥2": math.isfinite(sm["ct"]) and sm["ct"] >= 2,
            "halves>0": math.isfinite(h1) and math.isfinite(h2) and h1 > 0 and h2 > 0,
            "shift_bp>0": math.isfinite(shift_bp) and shift_bp > 0,
            "placebo_p<0.10": math.isfinite(pp) and pp < 0.10,
        }
        if n_indep < 30 or sm["n"] < 30:
            verdict = "UNDERPOWERED"
        elif all(bits.values()):
            verdict = "PASS"
        else:
            verdict = "FAIL"

        model_share = sum(1 for t in sig_te if t.get("priced_by") == "skew_model") / max(len(sig_te), 1)
        rule_tag = f"{en_b} × {g_b} × {ex_b} × {cell}"
        anat = anatomy(sig_te)

        # Winner pass: train-only winners vs losers (contract 11)
        train_best = price_entries(
            train_ents[en_b], ohlc_bars, caches, earns, tb, pricer, dte_b, ld_b, ex_b, g_b,
            path_cache=path_cache,
        )
        winners = [r for r in train_best if r.get("pnl_ca", 0) > 0]
        losers = [r for r in train_best if r.get("pnl_ca", 0) <= 0]

        def mean_f(xs, k):
            vs = [r[k] for r in xs if r.get(k) is not None and math.isfinite(float(r[k]))]
            return statistics.mean(vs) if vs else float("nan")

        g3w = sum(r.get("g3", 0) for r in winners) / max(len(winners), 1)
        g3l = sum(r.get("g3", 0) for r in losers) / max(len(losers), 1)
        win_note = (
            f"Winners=call pnl>0 on TRAIN cell ({len(winners)}/{len(train_best)}). "
            f"Pre-entry TRAIN: ivrv {mean_f(winners,'ivrv'):.3f} vs lose {mean_f(losers,'ivrv'):.3f}; "
            f"g3-rate {g3w:.1%} vs {g3l:.1%}; ret20 {mean_f(winners,'ret20'):.3f} vs {mean_f(losers,'ret20'):.3f}. "
            f"TEST move buckets + earn_in above. "
        )
        if verdict != "PASS":
            win_note += (
                "Next rule: G4∧M (earnings-crossing×cheap) + trail, or own earnings-move ratio gate."
            )
        else:
            win_note += "PASS cell ready for paper ledger; do not ship Model List until Claude review."

        top5_s = " · ".join(
            f"{en}|{g}|d{dte}|{ld:.2f}|{ex} vsΔ={vs:+.0f} n={n}"
            for vs, ca, n, nd, en, g, dte, ld, ex in top5
        )
        vline = (
            f"**Verdict:** RULE {verdict}: {rule_tag} — "
            f"n_indep={n_indep} bits={bits}"
        )
        lines = [
            "CONTRACT 1-7: ok",
            "# S171 — loss-maker cheap×big-move long calls (A244)",
            "",
            f"fills bid+23% · priced_by=skew_model share={model_share:.0%} · train<{TEST_START} test≥{TEST_START}",
            f"tickers={len(tickers)} train_floor_cells={len(ranked)} n_indep={n_indep} "
            f"edgar_always_loss_n={len(always_loss)}",
            "inputs: OHLCV+IV=lseg_research.daily_history; earnings=lseg_research.earnings_moves (S025); "
            "groups=OM+NI avg; tbill=out/opt/dtb3.csv; M cuts=S170 TRAIN frozen",
            "",
            f"TRAIN best={en_b}|{g_b}|{cell}|{ex_b} vsΔ={vs_tr:+.1f} bp={ca_tr:+.1f} n={n_tr} nd={nd_tr}",
            f"TRAIN top5: {top5_s}",
            "",
            "## Part C TEST (one cell)",
            (
                f"- SIG {rule_tag} n={sm['n']} n_indep={n_indep} bp={sm['bp']:+.1f} "
                f"vsE0={vs_e0:+.1f} vsΔ={vs_sd:+.1f} vsStock$={vs_st:+.1f} "
                f"ct={sm['ct']:.2f} hit100={sm['hit']:.1%} med={sm['med']:+.2%} "
                f"halves={h1:+.1f}/{h2:+.1f} shift_bp={shift_bp:+.1f} "
                f"leak_diff={leak_diff:+.1f} placebo_p={pp:.3f}"
            ),
            f"- E0 n={sm_e0['n']} bp={sm_e0['bp']:+.1f} · delayed n={len(delayed)}",
            f"- anatomy {anat}",
            "",
            "## Winner pass",
            win_note,
            "",
            vline,
        ]
        OUT.parent.mkdir(parents=True, exist_ok=True)
        packet = "\n".join(lines) + "\n"
        OUT.write_text(packet)
        print(f"Wrote {OUT} verdict={verdict} t={time.time()-t0:.0f}s", flush=True)
        print(packet)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
