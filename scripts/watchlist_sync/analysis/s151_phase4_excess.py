"""S151 Phase 4 revision (A328 bb65b29f): unconditional + sector-month comparators, excess t, BH, distinct signals.

    cd scripts/watchlist_sync && .venv/bin/python analysis/s151_phase4_excess.py [--smoke]
"""
from __future__ import annotations

import importlib.util
import math
import pickle
import statistics
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

# Load phase-4 module without editing busy s151_phase4_trades.py
_spec = importlib.util.spec_from_file_location("s151_p4", HERE / "s151_phase4_trades.py")
P4 = importlib.util.module_from_spec(_spec)
assert _spec.loader
_spec.loader.exec_module(P4)

import pattern_lab as PL  # noqa: E402
from build_plan import connect  # noqa: E402
import s080_long_options as S80  # noqa: E402

OUT = HERE.parent / "out" / "opt"
S151_MD = OUT / "S151.md"
ROOT = HERE.parents[2]

CHECK_END = date(2024, 12, 31)
HOLD_START = P4.HOLD_START
CHECK_HALF = P4.CHECK_HALF
HIST_END = date(2022, 12, 31)
HIST_START = date(2018, 10, 1)  # LSEG panel start (stored daily IV trades ≥2019-09)
CACHE_PKL = Path.home() / ".fildi" / "cache" / "s151_p4_base_cache.pkl"


def load_sectors(conn) -> dict[str, str]:
    rows = conn.execute(
        "SELECT ticker, gics_sector FROM research_common.security_class WHERE gics_sector IS NOT NULL"
    ).fetchall()
    return {t: s for t, s in rows}


def month_block_t(series: list[tuple[date, float]]) -> float:
    by = defaultdict(list)
    for d, v in series:
        if v == v:
            by[(d.year, d.month)].append(v)
    mo = [statistics.mean(v) for v in by.values() if len(v) >= 1]
    if len(mo) < 4:
        return float("nan")
    sd = statistics.stdev(mo)
    return statistics.mean(mo) / (sd / math.sqrt(len(mo))) if sd > 0 else float("nan")


from scipy import stats  # noqa: E402

def t_to_p(t: float, n_months: int) -> float:
    if not (t == t) or n_months < 4:
        return 1.0
    return float(2 * stats.t.sf(abs(t), df=max(1, n_months - 1)))


def monthly_excess_series(sig_tr, base_tr, start: date, end: date) -> list[tuple[date, float]]:
    sig_by = defaultdict(list)
    base_by = defaultdict(list)
    for x in sig_tr:
        if start <= x["d"] <= end:
            sig_by[(x["d"].year, x["d"].month)].append(x["pnl"])
    for x in base_tr:
        if start <= x["d"] <= end:
            base_by[(x["d"].year, x["d"].month)].append(x["pnl"])
    out = []
    for ym in sorted(set(sig_by) | set(base_by)):
        if ym not in sig_by or ym not in base_by:
            continue
        if len(sig_by[ym]) < 2 or len(base_by[ym]) < 5:
            continue
        ex = statistics.mean(sig_by[ym]) - statistics.mean(base_by[ym])
        out.append((date(ym[0], ym[1], 15), ex))
    return out


def sector_month_means(pool, sector_map: dict[str, str]) -> dict[tuple[str, int, int], float]:
    by: dict[tuple[str, int, int], list[float]] = defaultdict(list)
    for x in pool:
        sec = sector_map.get(x["ticker"], "?")
        by[(sec, x["d"].year, x["d"].month)].append(x["pnl"])
    return {k: statistics.mean(v) for k, v in by.items() if len(v) >= 3}


def metrics_for(sig_tr, base_tr, sector_map, start: date, end: date | None, pool_ctx: dict | None = None) -> dict:
    end_eff = end or date(2099, 12, 31)
    if pool_ctx:
        sm_means = pool_ctx["sm_means"]
        base_sm_index = pool_ctx["sm_index"]
        base = pool_ctx["base"]
        sig = [x for x in sig_tr if start <= x["d"] <= end_eff]
    else:
        sig = [x for x in sig_tr if start <= x["d"] <= end_eff]
        base = [x for x in base_tr if start <= x["d"] <= end_eff]
        sm_means = sector_month_means(base, sector_map)
        base_sm_index = defaultdict(list)
        for b in base:
            sec = sector_map.get(b["ticker"], "?")
            base_sm_index[(sec, b["d"].year, b["d"].month)].append(b)
    if len(sig) < 30 or len(base) < 100:
        return {}
    sm_pnls = []
    sm_breach = []
    for x in sig:
        sec = sector_map.get(x["ticker"], "?")
        key = (sec, x["d"].year, x["d"].month)
        m = sm_means.get(key)
        if m is not None:
            sm_pnls.append(x["pnl"] - m)
        pool_sm = base_sm_index.get(key, [])
        if pool_sm and x.get("breach") == x.get("breach"):
            br_pool = [b["breach"] for b in pool_sm if b.get("breach") == b.get("breach")]
            if br_pool:
                sm_breach.append(x["breach"] - float(np.mean(br_pool)))
    ms, mb = statistics.mean(x["pnl"] for x in sig), statistics.mean(x["pnl"] for x in base)
    ex_u = ms - mb
    ex_sm = statistics.mean(sm_pnls) if len(sm_pnls) >= 30 else float("nan")
    br_s = np.nanmean([x["breach"] for x in sig if x.get("breach") == x.get("breach")])
    br_b = np.nanmean([x["breach"] for x in base if x.get("breach") == x.get("breach")])
    br_sm = np.nanmean(sm_breach) if sm_breach else float("nan")
    w5_s, w5_b = P4.worst5([x["pnl"] for x in sig]), P4.worst5([x["pnl"] for x in base])
    ex_series = monthly_excess_series(sig, base, start, end_eff)
    t_ex = month_block_t(ex_series)
    n_mo = len({(d.year, d.month) for d, _ in ex_series})
    check_series = monthly_excess_series(sig, base, start, min(end_eff, CHECK_END))
    t1 = month_block_t([(d, v) for d, v in check_series if d <= CHECK_HALF])
    t2 = month_block_t([(d, v) for d, v in check_series if CHECK_HALF < d <= CHECK_END])
    hold = [x["pnl"] for x in sig_tr if x["d"] >= HOLD_START]
    hold_b = [x["pnl"] for x in base_tr if x["d"] >= HOLD_START]
    return {
        "n": len(sig),
        "mean_sig": ms,
        "mean_base_u": mb,
        "excess_mean_u": ex_u,
        "excess_mean_sm": ex_sm,
        "breach_sig": br_s,
        "breach_base_u": br_b,
        "excess_breach_u": br_s - br_b if br_s == br_s and br_b == br_b else np.nan,
        "excess_breach_sm": br_sm,
        "worst5_sig": w5_s,
        "worst5_base_u": w5_b,
        "excess_worst5_u": w5_s - w5_b if w5_s == w5_s and w5_b == w5_b else np.nan,
        "t_excess_check": t_ex,
        "t_excess_h1": t1,
        "t_excess_h2": t2,
        "p_excess": t_to_p(t_ex, n_mo),
        "hold_mean_sig": statistics.mean(hold) if hold else float("nan"),
        "hold_excess_u": statistics.mean(hold) - statistics.mean(hold_b) if hold and hold_b else float("nan"),
        "stress_mean": float(np.mean([x.get("stress", x["pnl"]) for x in sig])),
    }


def grade_excess(m: dict, inst: str, tier: str) -> str:
    if not m or m["n"] < 60:
        return "low_n"
    is_long = inst.startswith("long")
    if is_long:
        if tier not in ("strong", "model") and not (tier == "useful" and inst == "long_call"):
            return "context-only"
        if m["excess_mean_u"] <= 0 or (m["excess_mean_sm"] == m["excess_mean_sm"] and m["excess_mean_sm"] <= 0):
            return "context-only"
        if m["mean_sig"] <= 0:
            return "context-only"
        if (m["t_excess_h1"] == m["t_excess_h1"] and m["t_excess_h1"] < 2) or (
            m["t_excess_h2"] == m["t_excess_h2"] and m["t_excess_h2"] < 2
        ):
            return "context-only"
        if m["hold_excess_u"] == m["hold_excess_u"] and m["hold_excess_u"] <= 0:
            return "context-only"
        if m["stress_mean"] <= 0:
            return "context-only"
        return "PASS"
    if m["breach_sig"] > m["breach_base_u"] - 0.03:
        return "context-only"
    if m["excess_breach_sm"] == m["excess_breach_sm"] and m["excess_breach_sm"] > -0.03:
        return "context-only"
    if m["excess_mean_u"] < 0 or (m["excess_mean_sm"] == m["excess_mean_sm"] and m["excess_mean_sm"] < 0):
        return "context-only"
    if (m["t_excess_h1"] == m["t_excess_h1"] and m["t_excess_h1"] < 2) or (
        m["t_excess_h2"] == m["t_excess_h2"] and m["t_excess_h2"] < 2
    ):
        return "context-only"
    return "PASS"


def build_base_cache(px, rep, pricer, tb_dates, tb_rates, sector_map, sigs, cache_start: date):
    if CACHE_PKL.exists() and "--rebuild-cache" not in sys.argv:
        print(f"loading trade cache {CACHE_PKL}…", flush=True)
        return pickle.loads(CACHE_PKL.read_bytes())
    bkeys = set()
    for sig in sigs:
        for inst, opt_side, direction, deltas in P4.INSTRUMENTS[sig["side"]]:
            for delta in deltas:
                dte = P4.dte_for(sig, direction)
                for entry in P4.ENTRIES:
                    bkeys.add((inst, delta, dte, entry, opt_side, direction))
    base_cache = {}
    print(f"building unified cache {len(bkeys)} configs from {cache_start}…", flush=True)
    old_ts = P4.TRADE_START
    P4.TRADE_START = cache_start
    try:
        for bi, (inst, delta, dte, entry, opt_side, direction) in enumerate(sorted(bkeys)):
            bk = (inst, delta, dte, entry)
            base_cache[bk] = {em: [] for em in P4.EXITS}
            for t, rows in px.items():
                earn = rep.get(t, [])
                for i, r0 in enumerate(rows):
                    if r0[0] < cache_start or i < 252:
                        continue
                    allx = P4.price_all_exits(
                        pricer, rows, i, earn, opt_side, direction, delta, dte, entry, tb_dates, tb_rates
                    )
                    if not allx:
                        continue
                    for em, tr in allx.items():
                        base_cache[bk][em].append({**tr, "ticker": t, "sector": sector_map.get(t, "?")})
            if (bi + 1) % 8 == 0 or bi + 1 == len(bkeys):
                print(f"  cache {bi+1}/{len(bkeys)}", flush=True)
    finally:
        P4.TRADE_START = old_ts
    CACHE_PKL.parent.mkdir(parents=True, exist_ok=True)
    CACHE_PKL.write_bytes(pickle.dumps(base_cache))
    print(f"wrote trade cache {CACHE_PKL}", flush=True)
    return base_cache


def run_window_fixed(
    p_full,
    sigs,
    masks,
    base_cache,
    sector_map,
    trade_start: date,
    trade_end: date | None,
    period_tag: str,
) -> pd.DataFrame:
    sig_dates = {}
    for s in sigs:
        if period_tag == "hist" and s["horizon"] == "bars_5m":
            continue
        sub = p_full[masks[s["id"]] & (p_full.date >= pd.Timestamp(trade_start))]
        if trade_end:
            sub = sub[sub.date <= pd.Timestamp(trade_end)]
        sig_dates[s["id"]] = sub.groupby("ticker")["date"].apply(lambda x: set(x.dt.date)).to_dict()

    check_start = trade_start if period_tag == "hist" else P4.TRADE_START
    check_end = trade_end if period_tag == "hist" else CHECK_END

    pool_ctx_cache: dict = {}

    def pool_ctx_for(pool, start: date, end: date | None):
        end_eff = end or date(2099, 12, 31)
        key = (id(pool), start, end_eff)
        if key not in pool_ctx_cache:
            base = [x for x in pool if start <= x["d"] <= end_eff]
            sm_means = sector_month_means(base, sector_map)
            sm_index: dict[tuple[str, int, int], list] = defaultdict(list)
            for b in base:
                sec = sector_map.get(b["ticker"], "?")
                sm_index[(sec, b["d"].year, b["d"].month)].append(b)
            pool_ctx_cache[key] = {"base": base, "sm_means": sm_means, "sm_index": sm_index}
        return pool_ctx_cache[key]

    end_eff = check_end or date(2099, 12, 31)
    for bk, exits in base_cache.items():
        for exit_m in P4.EXITS:
            pool_ctx_for(exits[exit_m], check_start, check_end)

    cells = []
    for sig in sigs:
        if period_tag == "hist" and sig["horizon"] == "bars_5m":
            continue
        sd = sig_dates.get(sig["id"], {})
        if not sd:
            continue
        sig_set = {(t, d) for t, days in sd.items() for d in days}
        for inst, opt_side, direction, deltas in P4.INSTRUMENTS[sig["side"]]:
            for delta in deltas:
                dte = P4.dte_for(sig, direction)
                for entry in P4.ENTRIES:
                    bkey = (inst, delta, dte, entry)
                    if bkey not in base_cache:
                        continue
                    for exit_m in P4.EXITS:
                        pool = base_cache[bkey][exit_m]
                        sig_tr = [x for x in pool if (x["ticker"], x["d"]) in sig_set]
                        if len(sig_tr) < 30:
                            continue
                        ctx = pool_ctx_for(pool, check_start, check_end)
                        m = metrics_for(sig_tr, pool, sector_map, check_start, check_end, ctx)
                        if not m:
                            continue
                        cells.append(
                            {
                                "period": period_tag,
                                "horizon": sig["horizon"],
                                "signal": sig["id"],
                                "instrument": inst,
                                "delta": delta,
                                "entry": entry,
                                "exit": exit_m,
                                "tier": sig["tier"],
                                **m,
                                "verdict_raw": grade_excess(m, inst, sig["tier"]),
                            }
                        )
    return pd.DataFrame(cells)


def apply_bh_and_best(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df
    pvals = df["p_excess"].tolist()
    df = df.copy()
    df["p_bh_excess"] = PL._bh_adjust(pvals)
    df["pass_bh_excess"] = df["p_bh_excess"] < 0.05
    df["verdict"] = np.where(
        (df["verdict_raw"] == "PASS") & df["pass_bh_excess"],
        "PASS",
        df["verdict_raw"],
    )
    # best execution on 2023–24 check window (already in metrics); confirm holdout excess
    df["pass_holdout"] = df["hold_excess_u"] > 0
    df.loc[df["verdict"] == "PASS", "verdict"] = np.where(
        df.loc[df["verdict"] == "PASS", "pass_holdout"],
        "PASS",
        "context-only",
    )
    return df


def distinct_best(df: pd.DataFrame) -> pd.DataFrame:
    """One row per (horizon, signal, instrument): best excess_mean_u on check, holdout confirmed."""
    pass_df = df[df.verdict == "PASS"].copy()
    if pass_df.empty:
        return pass_df
    key = ["horizon", "signal", "instrument"]
    pass_df = pass_df.sort_values("excess_mean_u", ascending=False)
    best = pass_df.groupby(key, as_index=False).first()
    return best


def append_report(main_df, hist_df, distinct_df, geom, smoke: bool):
    if S151_MD.exists():
        text = S151_MD.read_text()
        if "## Phase 4" in text:
            text = text.split("## Phase 4")[0].rstrip()
        lines = text.splitlines()
    else:
        lines = ["# S151 — turning points by horizon (A328)", ""]
    pdh = geom[(geom.f1 == "prior_day_high") & (geom.f2 == "up_climax") & (geom.horizon == "month")] if not geom.empty else pd.DataFrame()
    geom_note = "prior_day_high+up_climax month-low close-anchored: DROPPED"
    if not pdh.empty and pdh.iloc[0].close_ok:
        geom_note = "prior_day_high+up_climax: KEPT (unexpected)"
    n_cells = len(main_df)
    n_pass = int((main_df.verdict == "PASS").sum()) if not main_df.empty else 0
    n_dist = len(distinct_df)
    lines += [
        "",
        "## Phase 4 — trades / execution (excess vs unconditional + sector-month; BH on excess t)",
        "",
        geom_note,
        "",
        f"**Check 2023–24 + holdout 2025→** · cells **{n_cells:,}** · cell-PASS after BH+holdout **{n_pass}** · "
        f"**distinct signals passing {n_dist}** (best Δ/entry/exit chosen on 2023–24, confirmed holdout excess>0)",
        "",
    ]
    if not distinct_df.empty:
        cols = [
            "horizon",
            "signal",
            "instrument",
            "delta",
            "entry",
            "exit",
            "n",
            "mean_sig",
            "mean_base_u",
            "excess_mean_u",
            "excess_mean_sm",
            "t_excess_check",
            "hold_excess_u",
        ]
        lines.append(distinct_df[cols].round(3).to_string(index=False))
    elif not main_df.empty:
        lines.append("_No distinct signals pass excess bars + BH + holdout._")
        top = main_df.sort_values("excess_mean_u", ascending=False).head(12)
        lines.append(top[["signal", "instrument", "excess_mean_u", "excess_mean_sm", "verdict"]].round(3).to_string(index=False))
    if not hist_df.empty:
        lines += [
            "",
            "### Phase 4 — daily signals 2018–2022 (panel window; bars_5m excluded)",
            "",
            f"Cells **{len(hist_df)}** · excess-t reported · comparator = unconditional + sector-month (no holdout/BH gate).",
        ]
        htop = hist_df.sort_values("excess_mean_u", ascending=False).head(15)
        lines.append(
            htop[["horizon", "signal", "instrument", "delta", "entry", "exit", "excess_mean_u", "excess_mean_sm", "t_excess_check"]]
            .round(3)
            .to_string(index=False)
        )
    else:
        lines += [
            "",
            "### Phase 4 — daily signals 2018–2022 (panel window; bars_5m excluded)",
            "",
            "Extended trade cache (pre-2023 entries) requires one-time `s151_phase4_excess.py --rebuild-cache` "
            "then re-run; table → `s151_phase4_hist1622_full.csv`.",
        ]
    lines += [
        "",
        "- Long bar: strong/model tier + **excess mean > 0** (uncond + sector-month) + excess t≥2 both 2023–24 halves + holdout excess>0 + +25% stress.",
        "- Short bar: breach ≤ base−3pp (uncond) + sector-month breach excess ≤ −3pp + excess mean ≥ 0 + excess t≥2 both halves.",
        "- Verdict: Claude.",
    ]
    S151_MD.write_text("\n".join(lines) + "\n")


def packet_lines(main_df, distinct_df, hist_df, geom) -> list[str]:
    n_pass = int((main_df.verdict == "PASS").sum()) if not main_df.empty else 0
    n_dist = len(distinct_df)
    L = [
        "**Cursor packet P4-revise 2026-11-03 (S151):**",
        f"- Comparators: unconditional all-name-days + same **gics_sector** same calendar month per cell; month-block **t on monthly excess**; BH on excess t across **{len(main_df)}** cells.",
        f"- Cell PASS (excess bars + BH + holdout excess>0): **{n_pass}** · **distinct signals {n_dist}** (best exec on 2023–24, holdout confirm).",
        f"- **2018–2022** daily-signal block: extended cache (`--rebuild-cache` once) — "
        f"**{len(hist_df)}** cells in last run; see S151 § Phase 4 hist.",
    ]
    for _, r in distinct_df.head(6).iterrows():
        L.append(
            f"- DISTINCT {r.horizon} {r.signal} {r.instrument} Δ{r.delta} {r.entry}/{r.exit} "
            f"excess_u={r.excess_mean_u:+.1%} excess_sm={r.excess_mean_sm:+.1%} hold_ex={r.hold_excess_u:+.1%}"
        )
    if n_dist == 0:
        r = main_df.sort_values("excess_mean_u", ascending=False).iloc[0]
        L.append(
            f"- Top excess (not distinct pass): {r.signal} {r.instrument} excess_u={r.excess_mean_u:+.1%} verdict={r.verdict}"
        )
    L.append("- Full: `s151_phase4_excess_full.csv` · `out/opt/S151.md`.")
    return L[:20]


def update_asks(main_df, distinct_df, hist_df, geom):
    p = ROOT / "research" / "common" / "asks" / "A328.md"
    block = "\n".join(packet_lines(main_df, distinct_df, hist_df, geom)) + "\n"
    text = p.read_text()
    marker = "**Cursor packet P4-revise"
    if marker in text:
        pre = text.split(marker)[0].rstrip()
        rest = text.split(marker, 1)[1]
        if "**Claude review" in rest:
            rest = rest[rest.index("**Claude review") :]
            text = pre + "\n\n" + block + "\n" + rest
        else:
            text = pre + "\n\n" + block
    else:
        text = text.rstrip() + "\n\n" + block
    p.write_text(text)


def update_index(main_df, distinct_df):
    idx = ROOT / "research" / "studies" / "INDEX.md"
    lines = idx.read_text().splitlines()
    n_dist = len(distinct_df)
    n_pass = int((main_df.verdict == "PASS").sum()) if not main_df.empty else 0
    for i, ln in enumerate(lines):
        if ln.startswith("| S151 |"):
            lines[i] = (
                "| S151 | 11-03 | **A328: turning points by horizon → indicators → trade + entry + exit** "
                f"(forward-only labels; S082 fix) | **P4 revised** — excess vs uncond+sector-month, BH on excess t; "
                f"{len(main_df)} cells · **{n_dist} distinct signals** pass (best exec 2023–24, holdout confirm; "
                f"2018–22 hist block) | verdict: Claude | "
                "`pattern_lab.py --s151` · `s151_phase4_excess.py` → `out/opt/S151.md` |"
            )
            break
    idx.write_text("\n".join(lines) + "\n")


def main():
    smoke = "--smoke" in sys.argv
    tickers = P4.SMOKE5 if smoke else None
    print("S151 P4-revise loading panel…", flush=True)
    p_full = PL.s151_panel(tickers, rebuild=False)
    p2 = PL.s151_phase2_separation(p_full[p_full.date <= PL.S151_FIT_END])
    geom = P4.geometry_pair_survivors(p_full, p2)
    sigs = P4.build_signals(p_full, p2, geom)
    edges = P4.fit_edges(p_full)
    scores = P4.model_scores(p_full)
    masks = {s["id"]: P4.signal_mask(p_full, s, edges, scores) for s in sigs}

    conn = connect()
    sector_map = load_sectors(conn)
    px, rep, tb, _ = S80.load(conn, set(p_full.ticker.unique()) if tickers else None, None)
    active = set(p_full.ticker.unique()) if tickers else set()
    if not smoke:
        active = set()
        for m in masks.values():
            active.update(p_full.loc[m, "ticker"].unique())
        px = {t: rows for t, rows in px.items() if t in active}
    from s076_structures_backtest import Pricer

    pricer = Pricer(conn)
    tb_dates = [d for d, _ in tb]
    tb_rates = [r for _, r in tb]

    pricer = Pricer(conn)

    base_cache = build_base_cache(px, rep, pricer, tb_dates, tb_rates, sector_map, sigs, HIST_START)

    main_df = run_window_fixed(
        p_full, sigs, masks, base_cache, sector_map, P4.TRADE_START, None, "check",
    )
    main_df = apply_bh_and_best(main_df)
    distinct_df = distinct_best(main_df)

    hist_df = pd.DataFrame()
    if not smoke:
        hist_df = run_window_fixed(
            p_full, sigs, masks, base_cache, sector_map, HIST_START, HIST_END, "hist",
        )

    OUT.mkdir(parents=True, exist_ok=True)
    tag = "smoke" if smoke else "full"
    main_df.to_csv(OUT / f"s151_phase4_excess_{tag}.csv", index=False)
    if not smoke:
        main_df.to_csv(OUT / "s151_phase4_excess_full.csv", index=False)
        distinct_df.to_csv(OUT / "s151_phase4_distinct_pass.csv", index=False)
        hist_df.to_csv(OUT / "s151_phase4_hist1622_full.csv", index=False)
        update_asks(main_df, distinct_df, hist_df, geom)
        update_index(main_df, distinct_df)
    append_report(main_df, hist_df, distinct_df, geom, smoke)
    print(f"cells={len(main_df)} pass={(main_df.verdict=='PASS').sum()} distinct={len(distinct_df)} hist={len(hist_df)}")


if __name__ == "__main__":
    main()
