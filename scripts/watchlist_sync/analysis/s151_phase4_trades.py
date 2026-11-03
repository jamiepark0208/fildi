"""S151 Phase 4 (A328) — signal days → option trades (S081/S076 engine + optlab.bars where matched).

    cd scripts/watchlist_sync && .venv/bin/python analysis/s151_phase4_trades.py [--smoke]
"""
from __future__ import annotations

import json
import math
import statistics
import sys
from bisect import bisect_right
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402
import pattern_lab as PL  # noqa: E402
import s080_long_options as S80  # noqa: E402
from s076_structures_backtest import Pricer, fill, strike_for  # noqa: E402

OUT = HERE.parent / "out" / "opt"
PAIRS_CSV = OUT / "s151_phase3_pairs_full.csv"
TIERS_CSV = OUT / "s151_phase3_tiers_full.csv"
S151_MD = OUT / "S151.md"

TRADE_START = date(2023, 1, 1)
CHECK_HALF = date(2023, 12, 31)
HOLD_START = date(2025, 1, 1)
SMOKE5 = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL"]

LONG_DTE = 30
PUT_DELTAS = (0.08, 0.12, 0.20)
LONG_DELTAS = (0.50, 0.30)
ENTRIES = ("close", "next_open")
EXITS = ("expiry", "tp50", "tp100", "stop50", "half_dte")

# Phase-3 survivors promoted to Phase 4 (Claude 2d0b4cf9 + geometry re-check)
P3_SINGLES = [
    ("week", "low", "z5_close", "useful"),
    ("week", "low", "rsi2", "weak"),
    ("week", "low", "up_climax", "useful"),
    ("intra", "low", "up_climax", "strong"),
    ("bars_5m", "low", "up_climax", "strong"),
]
P3_MODELS = [("week", "low"), ("month", "high")]

INSTRUMENTS = {
    "low": (("sell_put", "put", "short", PUT_DELTAS), ("long_call", "call", "long", LONG_DELTAS)),
    "high": (("sell_call", "call", "short", PUT_DELTAS), ("long_put", "put", "long", LONG_DELTAS)),
}


def month_block_t(series: list[tuple[date, float]]) -> float:
    by = defaultdict(list)
    for d, v in series:
        if v == v:
            by[(d.year, d.month)].append(v)
    mo = [statistics.mean(v) for v in by.values() if len(v) >= 2]
    if len(mo) < 4:
        return float("nan")
    sd = statistics.stdev(mo)
    return statistics.mean(mo) / (sd / math.sqrt(len(mo))) if sd > 0 else float("nan")


def worst5(xs: list[float]) -> float:
    v = sorted(x for x in xs if x == x)
    if len(v) < 20:
        return float("nan")
    k = max(1, int(0.05 * len(v)))
    return statistics.mean(v[:k])


def geometry_pair_survivors(p: pd.DataFrame, p2: pd.DataFrame) -> pd.DataFrame:
    """Re-check BH pairs touching geometry feats using close-anchored label (fast tier lookup + spot-check top pair)."""
    if not PAIRS_CSV.exists():
        return pd.DataFrame()
    pg = pd.read_csv(PAIRS_CSV)
    geom = pg[pg.pass_bh & (pg.f1.isin(PL.S151_GEOMETRY_FEATS) | pg.f2.isin(PL.S151_GEOMETRY_FEATS))].copy()
    tr = pd.read_csv(TIERS_CSV) if TIERS_CSV.exists() else pd.DataFrame()
    rows = []
    for _, r in geom.iterrows():
        close_ok = False
        lift_c1 = lift_c2 = np.nan
        if not tr.empty:
            ok_feats = True
            for f in (r.f1, r.f2):
                if f not in PL.S151_GEOMETRY_FEATS:
                    continue
                lab = f"good_{r.side}_{r.horizon}"
                sub = tr[(tr.feature == f) & (tr.label_geom == lab)]
                if sub.empty:
                    ok_feats = False
                    break
                row = sub.iloc[0]
                if row.get("tier_close", "none") in ("none", np.nan) or row.get("lift_close_H1", 0) < 1.25:
                    ok_feats = False
                    break
                lift_c1 = row.get("lift_close_H1", lift_c1)
                lift_c2 = row.get("lift_close_H2", lift_c2)
            close_ok = ok_feats
        if (r.f1 == "prior_day_high" and r.f2 == "up_climax" and r.horizon == "month" and r.side == "low"):
            g = PL.s151_pair_grid(p, "good_low_close_month", ["prior_day_high", "up_climax"], "low")
            if not g.empty:
                h = g.iloc[0]
                close_ok = h.lift_H1 >= 1.25 and h.lift_H2 >= 1.25
                lift_c1, lift_c2 = h.lift_H1, h.lift_H2
        rows.append({**r.to_dict(), "close_ok": close_ok, "lift_close_H1": lift_c1, "lift_close_H2": lift_c2})
    return pd.DataFrame(rows)


def build_signals(p: pd.DataFrame, p2: pd.DataFrame, geom: pd.DataFrame) -> list[dict]:
    sigs = []
    for hz, side, feat, tier in P3_SINGLES:
        sigs.append({"id": f"single:{hz}:{side}:{feat}", "horizon": hz, "side": side, "kind": "single",
                     "feats": [feat], "tier": tier, "label": f"good_{side}_{hz}" if hz != "bars_5m" else "good_low_rest"})
    for hz, side in P3_MODELS:
        sigs.append({"id": f"model:{hz}:{side}", "horizon": hz, "side": side, "kind": "model", "feats": [],
                     "tier": "model", "label": f"good_{side}_{hz}"})
    pg = pd.read_csv(PAIRS_CSV)
    for (hz, side), g in pg[pg.pass_bh].groupby(["horizon", "side"]):
        g = g.sort_values("t_check", ascending=False)
        ng = g[~(g.f1.isin(PL.S151_GEOMETRY_FEATS) | g.f2.isin(PL.S151_GEOMETRY_FEATS))].head(2)
        for _, r in ng.iterrows():
            sigs.append({"id": f"pair:{r.horizon}:{r.side}:{r.f1}+{r.f2}", "horizon": r.horizon, "side": r.side,
                         "kind": "pair", "feats": [r.f1, r.f2], "tier": "useful", "label": r.label})
        for _, r in g[g.f1.isin(PL.S151_GEOMETRY_FEATS) | g.f2.isin(PL.S151_GEOMETRY_FEATS)].iterrows():
            gr = geom[(geom.f1 == r.f1) & (geom.f2 == r.f2) & (geom.horizon == hz)] if not geom.empty else pd.DataFrame()
            if not gr.empty and gr.iloc[0].close_ok:
                sigs.append({"id": f"pair:{r.horizon}:{r.side}:{r.f1}+{r.f2}", "horizon": r.horizon, "side": r.side,
                             "kind": "pair", "feats": [r.f1, r.f2], "tier": "useful", "label": r.label})
    return sigs


def fit_edges(p: pd.DataFrame) -> dict:
    fit = p[p.date <= PL.S151_P3_FIT_END]
    edges = {}
    for f in PL.FEATS_S151:
        if f in PL.BINARY:
            continue
        d = fit[f].dropna()
        if len(d) >= 1000:
            edges[f] = np.unique(np.nanquantile(d, [0, 0.2, 0.4, 0.6, 0.8, 1.0]))
    return edges


def model_scores(p: pd.DataFrame) -> dict:
    from sklearn.ensemble import HistGradientBoostingClassifier

    out = {}
    for hz, side in P3_MODELS:
        lab = f"good_{side}_{hz}"
        d = p[p[lab].notna()].copy()
        fit = d.date <= PL.S151_P3_FIT_END
        feats = [f for f in PL.FEATS_S151 if d.loc[fit, f].nunique() > 1]
        m = HistGradientBoostingClassifier(max_iter=250, learning_rate=0.05, max_leaf_nodes=31,
                                           min_samples_leaf=800, l2_regularization=1.0, random_state=0)
        m.fit(d.loc[fit, feats].astype(float), d.loc[fit, lab].astype(int))
        sc = pd.Series(m.predict_proba(d[feats].astype(float))[:, 1], index=d.index)
        full = pd.Series(np.nan, index=p.index)
        full.loc[d.index] = sc
        out[(hz, side)] = full
    return out


def signal_mask(p: pd.DataFrame, sig: dict, edges: dict, scores: dict) -> pd.Series:
    if sig["kind"] == "model":
        sc = scores[(sig["horizon"], sig["side"])]
        thr = np.nanquantile(sc.dropna(), 0.9)
        return sc >= thr
    low = sig["side"] == "low"
    m = pd.Series(True, index=p.index)
    for f in sig["feats"]:
        if f in PL.BINARY:
            m &= p[f].fillna(0).astype(int) == 1
        else:
            e = edges.get(f)
            if e is None or len(e) < 4:
                return pd.Series(False, index=p.index)
            b = np.clip(np.searchsorted(e, p[f], side="right") - 1, 0, len(e) - 2)
            m &= b == (0 if low else len(e) - 2)
    return m


def dte_for(sig: dict, direction: str) -> int:
    if direction == "long":
        return LONG_DTE
    h = PL.S151_HORIZONS.get(sig["horizon"], 5)
    return int(min(45, max(14, h * 5)))


def _walk_long(pricer, opt_side, path, d0, e, K, debit):
    half = d0 + timedelta(days=max(1, (e - d0).days // 2))
    out = {m: None for m in EXITS}
    for dk, Sk, ivk in path:
        rem = (e - dk).days
        mk, sprk = pricer.mid(opt_side, Sk, K, ivk, max(rem, 1), dk)
        val = fill(mk, sprk, -1)
        r = val / debit - 1
        if out["tp100"] is None and r >= 1.0:
            out["tp100"] = 1.0
        if out["tp50"] is None and r >= 0.5:
            out["tp50"] = 0.5
        if out["stop50"] is None and r <= -0.5:
            out["stop50"] = r
        if out["half_dte"] is None and dk >= half:
            out["half_dte"] = r
    Se = path[-1][1]
    intr = max(Se - K, 0.0) if opt_side == "call" else max(K - Se, 0.0)
    out["expiry"] = intr / debit - 1
    for m in EXITS:
        if out[m] is None:
            out[m] = out["expiry"]
    return out


def _walk_short(pricer, opt_side, path, d0, e, K, credit):
    half = d0 + timedelta(days=max(1, (e - d0).days // 2))
    breach = False
    out = {m: None for m in EXITS}
    for dk, Sk, ivk in path:
        if opt_side == "put" and Sk < K:
            breach = True
        if opt_side == "call" and Sk > K:
            breach = True
        rem = (e - dk).days
        mk, sprk = pricer.mid(opt_side, Sk, K, ivk, max(rem, 1), dk)
        buyback = fill(mk, sprk, 1)
        r = (credit - buyback) / credit
        if out["tp100"] is None and r >= 1.0:
            out["tp100"] = 1.0
        if out["tp50"] is None and r >= 0.5:
            out["tp50"] = r
        if out["stop50"] is None and r <= -0.5:
            out["stop50"] = r
        if out["half_dte"] is None and dk >= half:
            out["half_dte"] = r
    Se = path[-1][1]
    obl = max(K - Se, 0.0) if opt_side == "put" else max(Se - K, 0.0)
    out["expiry"] = (credit - obl) / credit
    for m in EXITS:
        if out[m] is None:
            out[m] = out["expiry"]
    return out, breach


def price_all_exits(pricer, rows, i, earn, opt_side, direction, delta, dte, entry, tb_dates, tb_rates):
    d0 = rows[i][0]
    if d0 < TRADE_START:
        return None
    e = d0 + timedelta(days=dte)
    if any(d0 < x <= e for x in earn):
        return None
    S = rows[i][1]
    ivp, ivc = rows[i][2], rows[i][3]
    iv0 = ivc if opt_side == "call" else ivp
    if not iv0 or iv0 <= 0:
        return None
    if entry == "next_open":
        if i + 1 >= len(rows):
            return None
        S, d0, i = rows[i + 1][1], rows[i + 1][0], i + 1
        e = d0 + timedelta(days=dte)
    je = bisect_right([r[0] for r in rows], e) - 1
    if je <= i:
        return None
    path = [(rows[k][0], rows[k][1], (rows[k][3] if opt_side == "call" else rows[k][2]) or iv0)
            for k in range(i + 1, je + 1)]
    K = strike_for(S, iv0, dte / 365, delta, opt_side)
    days = (path[-1][0] - d0).days
    tb_i = bisect_right(tb_dates, d0) - 1
    r_tb = tb_rates[tb_i] if tb_i >= 0 else 0.0
    tb_adj = r_tb * days / 365
    if direction == "long":
        debit = fill(*pricer.mid(opt_side, S, K, iv0, dte, d0)[:2], 1)
        if debit < 0.05:
            return None
        rich = fill(*pricer.mid(opt_side, S, K, iv0, dte, d0, "rich")[:2], 1)
        raws = _walk_long(pricer, opt_side, path, d0, e, K, debit)
        stress_factor = (debit / rich) if rich > 0 else 1.0
        return {m: {"d": d0, "pnl": raws[m] - tb_adj, "raw": raws[m], "stress": raws[m] * stress_factor,
                    "breach": np.nan, "S": S, "K": K, "debit": debit} for m in EXITS}
    credit = fill(*pricer.mid(opt_side, S, K, iv0, dte, d0)[:2], -1)
    if credit < 0.05:
        return None
    raws, breach = _walk_short(pricer, opt_side, path, d0, e, K, credit)
    return {m: {"d": d0, "pnl": raws[m] - tb_adj, "raw": raws[m], "stress": raws[m],
                "breach": float(breach), "S": S, "K": K, "credit": credit} for m in EXITS}


def price_trade(pricer, rows, i, earn, opt_side, direction, delta, dte, entry, exit_m, tb_dates, tb_rates):
    allx = price_all_exits(pricer, rows, i, earn, opt_side, direction, delta, dte, entry, tb_dates, tb_rates)
    return allx.get(exit_m) if allx else None


def grade(sig_tr, base_tr, inst, tier) -> str:
    if len(sig_tr) < 60 or len(base_tr) < 150:
        return "low_n"
    is_long = inst.startswith("long")
    t1 = month_block_t([(x["d"], x["pnl"]) for x in sig_tr if x["d"] <= CHECK_HALF])
    t2 = month_block_t([(x["d"], x["pnl"]) for x in sig_tr if CHECK_HALF < x["d"] < HOLD_START])
    ms = statistics.mean(x["pnl"] for x in sig_tr)
    mb = statistics.mean(x["pnl"] for x in base_tr)
    hold = [x["pnl"] for x in sig_tr if x["d"] >= HOLD_START]
    if is_long:
        strong_enough = tier in ("strong", "model") or (tier == "useful" and inst == "long_call")
        if not strong_enough:
            return "context-only"
        if ms <= 0 or (t1 == t1 and t1 < 2) or (t2 == t2 and t2 < 2):
            return "context-only"
        if hold and statistics.mean(hold) <= 0:
            return "context-only"
        if statistics.mean(x.get("stress", x["pnl"]) for x in sig_tr) <= 0:
            return "context-only"
        return "PASS"
    br_s = np.mean([x["breach"] for x in sig_tr])
    br_b = np.mean([x["breach"] for x in base_tr])
    if br_s > br_b - 0.03 or ms < mb or (t1 == t1 and t1 < 2) or (t2 == t2 and t2 < 2):
        return "context-only"
    return "PASS"


def run(smoke: bool):
    print("S151 P4 loading panel…", flush=True)
    tickers = SMOKE5 if smoke else None
    p_full = PL.s151_panel(tickers, rebuild=False)
    p2 = PL.s151_phase2_separation(p_full[p_full.date <= PL.S151_FIT_END])
    geom = geometry_pair_survivors(p_full, p2)
    sigs = build_signals(p_full, p2, geom)
    edges = fit_edges(p_full)
    scores = model_scores(p_full)
    masks = {s["id"]: signal_mask(p_full, s, edges, scores) for s in sigs}
    sig_dates = {}
    for s in sigs:
        sub = p_full[masks[s["id"]] & (p_full.date >= pd.Timestamp(TRADE_START))]
        sig_dates[s["id"]] = sub.groupby("ticker")["date"].apply(lambda x: set(x.dt.date)).to_dict()

    conn = connect()
    px, rep, tb, _ = S80.load(conn, set(p_full.ticker.unique()) if tickers else None, None)
    active = set(p_full.ticker.unique())
    if not smoke:
        active = set()
        for m in masks.values():
            active.update(p_full.loc[m, "ticker"].unique())
        px = {t: rows for t, rows in px.items() if t in active}
    pricer = Pricer(conn)
    tb_dates = [d for d, _ in tb]
    tb_rates = [r for _, r in tb]
    idx = {t: {r[0]: i for i, r in enumerate(rows)} for t, rows in px.items()}

    cells, hands = [], []
    inst_hand = set()
    base_cache: dict = {}
    bkey_specs: dict = {}
    for sig in sigs:
        for inst, opt_side, direction, deltas in INSTRUMENTS[sig["side"]]:
            for delta in deltas:
                dte = dte_for(sig, direction)
                for entry in ENTRIES:
                    bk = (inst, delta, dte, entry)
                    bkey_specs[bk] = (opt_side, direction)
    print(f"prebuilding {len(bkey_specs)} trade configs on {len(px)} names…", flush=True)
    for bi, (bk, (opt_side, direction)) in enumerate(bkey_specs.items()):
        inst, delta, dte, entry = bk
        base_cache[bk] = {em: [] for em in EXITS}
        for t, rows in px.items():
            earn = rep.get(t, [])
            for i, r0 in enumerate(rows):
                if r0[0] < TRADE_START or i < 252:
                    continue
                allx = price_all_exits(pricer, rows, i, earn, opt_side, direction, delta, dte, entry, tb_dates, tb_rates)
                if not allx:
                    continue
                for em, tr in allx.items():
                    base_cache[bk][em].append({**tr, "ticker": t})
        if (bi + 1) % 5 == 0 or bi + 1 == len(bkey_specs):
            print(f"  cache {bi+1}/{len(bkey_specs)} {bk} n≈{len(base_cache[bk]['expiry'])}", flush=True)

    for si, sig in enumerate(sigs):
        sd = sig_dates.get(sig["id"], {})
        if not sd:
            continue
        sig_set = {(t, d) for t, days in sd.items() for d in days}
        print(f"signal {si+1}/{len(sigs)} {sig['id']}", flush=True)
        for inst, opt_side, direction, deltas in INSTRUMENTS[sig["side"]]:
            for delta in deltas:
                dte = dte_for(sig, direction)
                for entry in ENTRIES:
                    bkey = (inst, delta, dte, entry)
                    if bkey not in base_cache:
                        continue
                    for exit_m in EXITS:
                        pool = base_cache[bkey][exit_m]
                        sig_tr = [x for x in pool if (x["ticker"], x["d"]) in sig_set]
                        base_tr = pool
                        if not sig_tr:
                            continue
                        pnls = [x["pnl"] for x in sig_tr]
                        cells.append({
                            "horizon": sig["horizon"], "signal": sig["id"], "instrument": inst, "delta": delta,
                            "entry": entry, "exit": exit_m, "n": len(sig_tr),
                            "n_months": len({(x["d"].year, x["d"].month) for x in sig_tr}),
                            "win": float(np.mean([x["pnl"] > 0 for x in sig_tr])),
                            "mean_pnl": float(np.mean(pnls)), "median_pnl": float(np.median(pnls)),
                            "worst5": worst5(pnls),
                            "t_check": month_block_t([(x["d"], x["pnl"]) for x in sig_tr if x["d"] < HOLD_START]),
                            "stress_mean": float(np.mean([x["stress"] for x in sig_tr])),
                            "hold_sign": float(np.mean([x["pnl"] for x in sig_tr if x["d"] >= HOLD_START]))
                            if any(x["d"] >= HOLD_START for x in sig_tr) else float("nan"),
                            "verdict": grade(sig_tr, base_tr, inst, sig["tier"]),
                        })
                        if smoke and inst not in inst_hand and sig_tr:
                            inst_hand.add(inst)
                            hands.append({"instrument": inst, "signal": sig["id"], **sig_tr[0]})
    return pd.DataFrame(cells), hands, geom


def append_report(df: pd.DataFrame, geom: pd.DataFrame, hands: list, smoke: bool):
    lines = []
    if S151_MD.exists():
        text = S151_MD.read_text()
        if "## Phase 4" in text:
            text = text.split("## Phase 4")[0].rstrip()
        lines = text.splitlines()
        lines = [ln for ln in lines if "Phase 4 (trades / execution grid) not run" not in ln]
    else:
        lines = ["# S151 — turning points by horizon (A328)", ""]
    pdh = geom[(geom.f1 == "prior_day_high") & (geom.f2 == "up_climax") & (geom.horizon == "month")]
    geom_note = "prior_day_high+up_climax month-low close-anchored: "
    if pdh.empty:
        geom_note += "not re-run"
    else:
        r = pdh.iloc[0]
        geom_note += f"{'KEPT' if r.close_ok else 'DROPPED'} (lift {r.get('lift_close_H1', float('nan')):.2f}/{r.get('lift_close_H2', float('nan')):.2f}×)"
    lines += ["", "## Phase 4 — trades / execution (2023→, S076/S081 engine; +25% call-cost stress on longs)", "",
                geom_note, ""]
    if df.empty:
        lines.append("_No cells._")
    else:
        pass_df = df[df.verdict == "PASS"]
        lines.append(f"Cells **{len(df):,}** · **PASS {len(pass_df)}** · smoke={smoke}")
        if not pass_df.empty:
            cols = ["horizon", "signal", "instrument", "delta", "entry", "exit", "n", "win", "mean_pnl", "t_check", "verdict"]
            lines.append(pass_df.sort_values("mean_pnl", ascending=False).head(40)[cols].round(3).to_string(index=False))
        lines.append("")
        lines.append("### Hand-checked trades (smoke)" if smoke else "### Sample hand-check")
        for h in hands[:5]:
            lines.append(f"- {h['instrument']} {h.get('signal','')} {h.get('ticker')} {h['d']} S={h['S']:.2f} K={h['K']:.2f} pnl={h['pnl']:+.1%}")
    lines += ["", "- Entries: close · next_open (vwap_reclaim needs bars_5m — not batch-run here).",
                "- Long DTE=30; short DTE scales with horizon (14–45).",
                "- Verdict: Claude."]
    S151_MD.write_text("\n".join(lines) + "\n")


def packet_lines(df: pd.DataFrame, geom: pd.DataFrame) -> list[str]:
    pdh = geom[(geom.f1 == "prior_day_high") & (geom.f2 == "up_climax")] if not geom.empty else pd.DataFrame()
    kept = len(pdh[pdh.close_ok]) if not pdh.empty else 0
    drop = len(pdh) - kept
    pass_df = df[df.verdict == "PASS"] if not df.empty else pd.DataFrame()
    L = [
        "**Cursor packet P4 2026-11-03 (S151):**",
        f"- Geometry re-check: {len(pdh)} geom BH pairs · {kept} kept under close-anchored · {drop} dropped.",
        f"- Trade grid: {len(df)} cells · **PASS {len(pass_df)}** (sell: breach ≤ base−3pp + mean≥base + t≥2; long: strong/model + mean>0 + stress + holdout sign).",
    ]
    for _, r in pass_df.head(8).iterrows():
        L.append(f"- PASS {r.horizon} {r.signal} {r.instrument} Δ{r.delta} {r.entry}/{r.exit} n={r.n} mean={r.mean_pnl:+.1%} t={r.t_check:.1f}")
    L.append(f"- Full table: `out/opt/s151_phase4_full.csv` · report `out/opt/S151.md`.")
    return L[:20]


ROOT = HERE.parents[2]


def update_asks_packet(df: pd.DataFrame, geom: pd.DataFrame):
    p = ROOT / "research" / "common" / "asks" / "A328.md"
    if not p.exists():
        return
    block = "\n".join(packet_lines(df, geom)) + "\n"
    text = p.read_text()
    if "**Cursor packet P4" in text:
        pre = text.split("**Cursor packet P4")[0].rstrip()
        text = pre + "\n\n" + block
    else:
        text = text.rstrip() + "\n\n" + block
    p.write_text(text)


def update_index(df: pd.DataFrame):
    idx = ROOT / "research" / "studies" / "INDEX.md"
    if not idx.exists():
        return
    lines = idx.read_text().splitlines()
    pass_n = int((df.verdict == "PASS").sum()) if not df.empty else 0
    for i, ln in enumerate(lines):
        if ln.startswith("| S151 |"):
            lines[i] = (
                "| S151 | 11-03 | **A328: turning points by horizon → indicators → trade + entry + exit** "
                f"(forward-only labels; S082 fix) | **P4 done** — {len(df)} cells · **PASS {pass_n}** "
                "(geometry pairs re-checked on close anchor; S076/S081 engine) | verdict: Claude | "
                "`pattern_lab.py --s151` · `s151_phase4_trades.py` → `out/opt/S151.md` |"
            )
            break
    idx.write_text("\n".join(lines) + "\n")


def main():
    smoke = "--smoke" in sys.argv
    df, hands, geom = run(smoke)
    tag = "smoke" if smoke else "full"
    OUT.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUT / f"s151_phase4_{tag}.csv", index=False)
    if not smoke:
        df.to_csv(OUT / "s151_phase4_full.csv", index=False)
        update_asks_packet(df, geom)
        update_index(df)
    append_report(df, geom, hands, smoke)
    print(f"cells={len(df)} pass={(df.verdict=='PASS').sum() if not df.empty else 0}")


if __name__ == "__main__":
    main()
