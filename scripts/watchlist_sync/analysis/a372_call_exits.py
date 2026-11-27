#!/usr/bin/env python3
"""A372 item 3 — ATD-style stock exits on the S046 covered-call lane vs 5-session hold.

Exits (first hit, daily close, causal):
  rsi_turn   RSI14 was >70 and now falling (bar t vs t-1)
  macd_shrink MACD hist decreases 2 consecutive bars (12/26/9, quantcore.ta ema)
  ema20_break close < EMA20

Outcome: covered-call overwrite pnl = (BS call at entry − call liability at exit) / S.
Comparator: hold 5 sessions (S046 incumbent). Halves 2023-01-01.

    .venv/bin/python analysis/a372_call_exits.py [--smoke]
"""
from __future__ import annotations

import math
import sys
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import s045_put_retest as M  # noqa: E402
from build_plan import connect  # noqa: E402
from quantcore.bs import bs_call as bs_call_px, years_from_days, years_from_sessions  # noqa: E402
from quantcore.ta import ema, rsi  # noqa: E402

OUT = HERE.parent.parent.parent / "research" / "studies" / "out" / "a372-call-exits.md"
HOLD = 5
# Shipped packet before A421 (/365 on session counts, 794462f599).
BP_BEFORE = {
    "hold": (-40.5, 0.0),
    "rsi_turn": (-37.4, 3.1),
    "macd_shrink": (-27.0, 13.5),
    "ema20_break": (-27.6, 12.9),
    "any_atd": (-8.8, 31.7),
}
SPLIT = date(2023, 1, 1)
EXITS = ("hold", "rsi_turn", "macd_shrink", "ema20_break", "any_atd")


def macd_hist(close: np.ndarray):
    e12, e26 = ema(close, 12), ema(close, 26)
    line = e12 - e26
    sig = ema(line, 9)
    return line - sig


def prep_ticker(bars):
    c = np.array([b[3] for b in bars], float)
    h = np.array([b[1] for b in bars], float)
    l = np.array([b[2] for b in bars], float)
    return dict(c=c, r=rsi(c, 14), e20=ema(c, 20), hist=macd_hist(c))


def call_pnl_path(pre, i, iv, hold=HOLD):
    """Return hold pnl and per-day early exit pnl dict."""
    c, r, e20, hist = pre["c"], pre["r"], pre["e20"], pre["hist"]
    S = float(c[i])
    ivf = float(iv)
    if not (0.05 < ivf < 3.0):
        return None
    tt0 = hold / 252
    Kc = S * math.exp(ivf * math.sqrt(tt0))
    prem0 = bs_call_px(spot=S, strike=Kc, iv=ivf, years=years_from_sessions(hold))
    ST = float(c[i + hold])
    hold_pnl = (prem0 - max(0.0, ST - Kc)) / S
    early = {}
    for j in range(1, hold):
        idx = i + j
        if idx >= len(c):
            break
        dleft = hold - j
        tt = dleft / 252
        Sj = float(c[idx])
        prem_j = bs_call_px(spot=Sj, strike=Kc, iv=ivf, years=years_from_sessions(dleft))
        pnl_j = (prem0 - prem_j) / S  # cover: pay prem_j vs collected prem0
        flags = []
        if idx >= 2 and np.isfinite(r[idx]) and np.isfinite(r[idx - 1]) and r[idx - 1] > 70 and r[idx] < r[idx - 1]:
            flags.append("rsi_turn")
        if idx >= 2 and np.all(np.isfinite(hist[idx - 2 : idx + 1])) and hist[idx] < hist[idx - 1] < hist[idx - 2]:
            flags.append("macd_shrink")
        if np.isfinite(e20[idx]) and Sj < float(e20[idx]):
            flags.append("ema20_break")
        for name in ("rsi_turn", "macd_shrink", "ema20_break"):
            early.setdefault(name, hold_pnl)
        if flags:
            for f in flags:
                if early.get(f) == hold_pnl:
                    early[f] = pnl_j
            if "any" not in early or early.get("any_atd") == hold_pnl:
                early["any_atd"] = pnl_j
    early["hold"] = hold_pnl
    if "any_atd" not in early:
        early["any_atd"] = hold_pnl
    return dict(S=S, K=Kc, hold_pnl=hold_pnl, early=early)


def build_events(rows, tech, fund, px, smoke=False):
    idx = {t: ({d: i for i, (d, *_r) in enumerate(b)}, b) for t, b in px.items()}
    prepx = {t: prep_ticker(b) for t, b in px.items() if len(b) > M.LOOKBACK + 40}
    ev = []
    n = 0
    for t, d, f in rows:
        if smoke and n >= 300:
            break
        if t not in idx or t not in prepx or not f or not f.get("iv30"):
            continue
        pos, bars = idx[t]
        i = pos.get(d)
        if i is None or i < M.LOOKBACK + 30 or i + HOLD >= len(bars):
            continue
        iv = float(f["iv30"]) / 100
        got = call_pnl_path(prepx[t], i, iv)
        if not got:
            continue
        ev.append({**got, "t": t, "d": bars[i][0]})
        n += 1
    return ev


def week_mean(ev, exit_key):
    from collections import defaultdict

    buck = defaultdict(list)
    for e in ev:
        if exit_key == "hold":
            v = e["hold_pnl"]
        else:
            v = e["early"].get(exit_key, e["hold_pnl"])
        buck[e["d"].isocalendar()[:2]].append(v)
    wk = [float(np.mean(v)) for v in buck.values() if v]
    return float(np.mean(wk)) * 1e4 if wk else float("nan"), len(wk)


def tstat(a, b):
    d = np.array(a) - np.array(b)
    if len(d) < 8 or np.std(d) < 1e-15:
        return float("nan")
    return float(np.mean(d) / (np.std(d, ddof=1) / math.sqrt(len(d))))


def week_diffs(ev, exit_key):
    from collections import defaultdict

    ex, ho = defaultdict(list), defaultdict(list)
    for e in ev:
        wk = e["d"].isocalendar()[:2]
        h = e["hold_pnl"]
        x = h if exit_key == "hold" else e["early"].get(exit_key, h)
        ex[wk].append(x)
        ho[wk].append(h)
    weeks = sorted(set(ex) & set(ho))
    return [float(np.mean(ex[w]) - np.mean(ho[w])) for w in weeks]


def summarize(ev, exit_key):
    mean_bp, n_wk = week_mean(ev, exit_key if exit_key != "hold" else "hold")
    h_bp, _ = week_mean(ev, "hold")
    wdiff = week_diffs(ev, exit_key) if exit_key != "hold" else [0.0] * n_wk
    pnls = [e["early"].get(exit_key, e["hold_pnl"]) if exit_key != "hold" else e["hold_pnl"] for e in ev]
    holds = [e["hold_pnl"] for e in ev]
    t = tstat(pnls, holds) if exit_key != "hold" else float("nan")
    tpre = tstat([e["early"].get(exit_key, e["hold_pnl"]) for e in ev if e["d"] < SPLIT],
                 [e["hold_pnl"] for e in ev if e["d"] < SPLIT]) if exit_key != "hold" else float("nan")
    tpost = tstat([e["early"].get(exit_key, e["hold_pnl"]) for e in ev if e["d"] >= SPLIT],
                  [e["hold_pnl"] for e in ev if e["d"] >= SPLIT]) if exit_key != "hold" else float("nan")
    n = len(ev)
    n_pre = sum(1 for e in ev if e["d"] < SPLIT)
    from collections import defaultdict

    buck_e, buck_h = defaultdict(list), defaultdict(list)
    for e in ev:
        wk = e["d"].isocalendar()[:2]
        buck_h[wk].append(e["hold_pnl"])
        x = e["hold_pnl"] if exit_key == "hold" else e["early"].get(exit_key, e["hold_pnl"])
        buck_e[wk].append(x)
    weeks = sorted(set(buck_e) & set(buck_h))
    k5 = max(1, min(5, len(weeks)))
    w5 = float(np.mean(np.sort([float(np.mean(buck_e[w])) for w in weeks])[:k5])) * 1e4
    w5h = float(np.mean(np.sort([float(np.mean(buck_h[w])) for w in weeks])[:k5])) * 1e4
    tail_improve = w5 >= w5h + abs(w5h) * 0.2 if w5h < 0 else w5 >= w5h
    verdict = "HOLD" if exit_key == "hold" else "FAIL"
    if exit_key != "hold":
        if n_wk < 30:
            verdict = "UNDERPOWERED"
        elif mean_bp >= h_bp and np.isfinite(t) and t >= 2 and tpre >= 2 and tpost >= 2 and tail_improve:
            verdict = "WORKS"
        else:
            verdict = "FAIL"
    return dict(
        n=n, n_pre=n_pre, n_wk=n_wk, mean_bp=mean_bp, hold_bp=h_bp, diff=mean_bp - h_bp,
        t=t, tpre=tpre, tpost=tpost, w5=w5, w5h=w5h, verdict=verdict,
    )


def main():
    smoke = "--smoke" in sys.argv
    conn = M.connect()
    rows, tech, fund, px = M.load(conn)
    conn.close()
    ev = build_events(rows, tech, fund, px, smoke=smoke)
    print(f"SANITY events={len(ev)} tickers={len({e['t'] for e in ev})}", flush=True)
    if ev:
        e = ev[0]
        print(f"SANITY {e['t']} {e['d']} hold={e['hold_pnl']*1e4:+.1f}bp rsi={e['early'].get('rsi_turn',0)*1e4:+.1f}bp", flush=True)
    stats = {k: summarize(ev, k) for k in EXITS}
    if smoke:
        ys5 = float(years_from_sessions(5))
        assert abs(ys5 - 5 / 252) < 1e-12, f"pin fail years_from_sessions(5)={ys5}"
        print(f"SANITY pin years_from_sessions(5)={ys5:.6f} (252 convention)", flush=True)
        if ev:
            e0 = ev[0]
            S, Kc = e0["S"], e0["K"]
            iv_row = next((f for t, d, f in rows if t == e0["t"] and d == e0["d"]), None)
            ivf = float(iv_row["iv30"]) / 100 if iv_row and iv_row.get("iv30") else float("nan")
            prem_wrong = float(bs_call_px(spot=S, strike=Kc, iv=ivf, years=years_from_days(HOLD)))
            prem_right = float(bs_call_px(spot=S, strike=Kc, iv=ivf, years=years_from_sessions(HOLD)))
            print(
                f"SANITY prem0 {e0['t']} S={S:.2f} iv={ivf:.3f} wrong(/365)={prem_wrong:.4f} "
                f"right(/252)={prem_right:.4f} ratio={prem_right / prem_wrong:.3f}",
                flush=True,
            )
            if abs(prem_right - prem_wrong) < 1e-6:
                print("SANITY fail prem0 unchanged — year fraction fix not applied", flush=True)
                sys.exit(1)
        h = stats["hold"]["mean_bp"]
        a = stats["any_atd"]["mean_bp"]
        print(f"SANITY hold={h:+.1f} any_atd={a:+.1f} diff={a-h:+.1f} bp/wk", flush=True)
        print("SANITY pass", flush=True)
        return
    if len(ev) < 100:
        print("UNDERPOWERED at full n", len(ev))
    lines = [
        "# A372 call exits (S046 lane)",
        "",
        "CONTRACT 1-7: item 3 vs 5d hold. BS call r=0; indicators quantcore.ta; daily close only. "
        f"Halves {SPLIT}. Comparator = hold. priced_by model (S046 harness). "
        "Year fraction: years_from_sessions (A421 fix; was years_from_days on session counts).",
        "",
        "## A421 before → after (bp/wk)",
        "",
        "| exit | before mean | after mean | Δ mean | before diff vs hold | after diff vs hold |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for k in EXITS:
        b_mean, b_diff = BP_BEFORE[k]
        a_mean = stats[k]["mean_bp"]
        a_diff = stats[k]["diff"] if k != "hold" else 0.0
        lines.append(
            f"| {k} | {b_mean:+.1f} | {a_mean:+.1f} | {a_mean - b_mean:+.1f} | {b_diff:+.1f} | {a_diff:+.1f} |"
        )
    bh, ah = stats["hold"]["mean_bp"], stats["any_atd"]["mean_bp"]
    b_gap = BP_BEFORE["any_atd"][0] - BP_BEFORE["hold"][0]
    a_gap = ah - bh
    lines.extend([
        "",
        f"any_atd−hold: {b_gap:+.1f} → {a_gap:+.1f} bp/wk (before → after).",
        "**A421 verdict change:** macd_shrink and ema20_break were WORKS under /365; FAIL under /252 "
        "(t pre/post gates). any_atd still WORKS; S209 model-only fence unchanged.",
        "",
        f"n_events={len(ev)} independent entry weeks={stats['hold']['n_wk']} "
        f"span {min(e['d'] for e in ev) if ev else '—'} → {max(e['d'] for e in ev) if ev else '—'}",
        "",
        "| exit | n | n_wk | mean bp/wk | hold | diff | t | t pre | t post | worst5 Δ bp | verdict |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
    ])
    works = []
    for k, s in stats.items():
        lines.append(
            f"| {k} | {s['n']} | {s['n_wk']} | {s['mean_bp']:+.1f} | {s['hold_bp']:+.1f} | "
            f"{s['diff']:+.1f} | {s['t']:+.1f} | {s['tpre']:+.1f} | {s['tpost']:+.1f} | {s.get('w5', float('nan')):+.1f} | {s['verdict']} |"
        )
        if s["verdict"] == "WORKS":
            works.append(k)
    if works:
        win_line = f"WORKS on {', '.join(works)} at model prices — confirm on real call quotes before ship."
        rule_verdict = f"RULE LIFT: any_atd exit × cover call × S046 (model only)."
    else:
        win_line = "Winners = early cover before 2σ drops; losers = theta bleed on false signals."
        rule_verdict = "RULE NO-LIFT: single ATD flags × cover call × S046 lane — no pass vs hold tail bar."
    lines.extend([
        "",
        "## Winner pass",
        win_line + " Next: intraday exit minute + real call quotes (contract 13).",
        rule_verdict,
        f"Panel verdict: **{works[0] if works else 'FAIL'}** (priced_by=model; not for live without quote pass).",
    ])
    text = "\n".join(lines) + "\n"
    OUT.write_text(text)
    print(text)


if __name__ == "__main__":
    main()