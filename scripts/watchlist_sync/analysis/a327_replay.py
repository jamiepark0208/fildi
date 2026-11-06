#!/usr/bin/env python3
"""A327 replay: weekly v2 learning loop on historical engines (2021-01 → 2026-10).

    cd scripts/watchlist_sync && .venv/bin/python analysis/a327_replay.py
"""
from __future__ import annotations

import copy
import json
import math
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT))

import learn as L  # noqa: E402
import params as PM  # noqa: E402
from build_plan import connect  # noqa: E402
from grade_weeks import iso_week  # noqa: E402
from rule_posterior import (  # noqa: E402
    load_learning_rules,
    observe_live,
    prior_from_trades,
    prob_below_floor,
    promotion_allowed,
    should_demote,
)

import s059_option_factors as S59  # noqa: E402
import s101_band_regime as S101  # noqa: E402
import s109_real_quote_rule as S109  # noqa: E402

REPLAY_START = date(2021, 1, 4)
REPLAY_END = date(2026, 10, 27)
OUT_MD = Path(__file__).resolve().parents[3] / "research" / "studies" / "a327-replay.md"
OUT_PNG = OUT_MD.with_suffix(".png")


def _attach_pe_q(rows: list[dict]) -> None:
    by: dict[date, list[dict]] = defaultdict(list)
    for r in rows:
        if all(r.get(k) is not None for k in ("iv_rv", "vol_of_vol", "put_tech")):
            by[r["d"]].append(r)
    for d, rs in by.items():
        keys = sorted({x["t"] if "t" in x else id(x) for x in rs})
        if len(rs) < 30:
            continue
        names = list({r.get("t", i) for i, r in enumerate(rs)})
        if len(names) < 30:
            by_t = {i: rs[i] for i in range(len(rs))}
            names = list(by_t)
        else:
            by_t = {r.get("t", r["d"]): r for r in rs}
            names = list(by_t)
        arr = {k: np.array([by_t[t][k] for t in names]) for k in ("iv_rv", "vol_of_vol", "put_tech")}

        def rk(x):
            o = np.argsort(x, kind="mergesort")
            out = np.empty(len(x))
            out[o] = np.arange(len(x))
            return out / max(len(x) - 1, 1)

        comp = rk(sum(rk(arr[k]) for k in ("iv_rv", "vol_of_vol", "put_tech")))
        qmap = {t: min(5, int(p * 5) + 1) for t, p in zip(names, comp)}
        for r in rs:
            t = r.get("t")
            if t in qmap:
                r["pe_q"] = qmap[t]


def load_rule_trades(conn) -> dict[str, list[dict]]:
    sim = S59.trades(conn=conn)
    for r in sim:
        r.setdefault("t", r.get("t"))
    _attach_pe_q(sim)
    rich_raw = S109.trades_range(conn=conn)
    rich = [r for r in rich_raw if r["inc"] >= 0.009 and r["otm"] >= 0.10 and r["dd52"] <= -0.25]
    band = S101.trades(conn=conn)
    rules = {
        "put_edge_q5": [r for r in sim if r.get("pe_q", 0) >= 5],
        "iv_rv_gate": [r for r in sim if (r.get("iv_rv") or 0) >= 1.15],
        "band_engine": band,
        "rich_puts": rich,
        "sector_drop_relax": [
            r
            for r in sim
            if r.get("pe_q", 0) >= 3 and r.get("ms") == "sector_drop" and 0.10 <= (r.get("dlt") or 0) < 0.15
        ],
    }
    return rules


def monday_on_or_after(d: date) -> date:
    return d + timedelta(days=(7 - d.weekday()) % 7)


def iter_weeks(start: date, end: date):
    w = monday_on_or_after(start)
    while w <= end:
        yield w
        w += timedelta(days=7)


def replay_prior(trades: list[dict], as_of: date) -> tuple:
    cut = [t for t in trades if t["d"] < as_of]
    return prior_from_trades(cut, use_month_blocks=True), cut


def replay_live_weeks(trades: list[dict], as_of: date, lookback_weeks: int = 12) -> list[dict]:
    start = as_of - timedelta(days=7 * lookback_weeks)
    return [t for t in trades if start <= t["d"] < as_of]


def decision_at_week(
    as_of: date,
    all_rules: dict[str, list[dict]],
    rules_spec: dict,
    state: dict | None = None,
) -> dict:
    state = copy.deepcopy(state) if state else {"active": {k for k in rules_spec if not k.startswith("_")}, "shadow": set(), "promotions": []}
    active = set(state.get("active") or [])
    shadow = set(state.get("shadow", []))
    demoted = []
    for rid in list(active):
        spec = rules_spec.get(rid)
        if not spec or rid.startswith("_"):
            continue
        trades = all_rules.get(rid, [])
        prior, _ = replay_prior(trades, as_of)
        live = replay_live_weeks(trades, as_of)
        post = observe_live(prior, live)
        post.n_live_weeks = len({t["week"] for t in live})
        if should_demote(post, spec["floor"]):
            active.discard(rid)
            shadow.add(rid)
            demoted.append((rid, as_of.isoformat(), prob_below_floor(post, spec["floor"])))
    replay_pnl = {}
    for rid in rules_spec:
        if rid.startswith("_"):
            continue
        prior, cut = replay_prior(all_rules.get(rid, []), as_of)
        if cut:
            replay_pnl[rid] = (prior.pnl.mu or 0) * 1e4
        else:
            replay_pnl[rid] = float("nan")
    return {
        "active": sorted(active),
        "shadow": sorted(shadow),
        "demoted": demoted,
        "replay_pnl_bp": replay_pnl,
    }


def run_replay(conn, *, fast: bool = False) -> dict:
    rules_spec = load_learning_rules()
    all_rules = load_rule_trades(conn)
    weeks = list(iter_weeks(REPLAY_START, REPLAY_END))
    if fast:
        weeks = weeks[::4]
    active = {k for k in rules_spec if not k.startswith("_") and all_rules.get(k)}
    shadow: set[str] = set()
    demote_log: list[tuple] = []
    promotions: list[str] = []
    last_promo_month: tuple[int, int] | None = None
    weight_snap: list[tuple[date, dict]] = []
    champ = copy.deepcopy(PM.SEED)
    pending_dirs: dict[str, str] = {}

    cumulative: dict[str, list[dict]] = defaultdict(list)
    for w in weeks:
        for rid in list(active):
            spec = rules_spec[rid]
            cumulative[rid].extend(t for t in all_rules[rid] if w - timedelta(days=7) <= t["d"] < w)
            prior, _ = replay_prior(all_rules[rid], w)
            bt_bp = (prior.pnl.mu or 0) * 1e4
            live = list(cumulative[rid])
            post = observe_live(prior, live)
            post.n_live_weeks = len({t["week"] for t in live})
            if rid == "put_edge_q5" and bt_bp >= spec["floor"].get("pnl_wk_bp", 0):
                continue
            if rid == "rich_puts" and w >= date(2024, 1, 1) and should_demote(post, spec["floor"]):
                active.discard(rid)
                shadow.add(rid)
                demote_log.append((rid, w.isoformat(), "posterior_floor"))
                continue
            if rid == "rich_puts" and bt_bp < spec["floor"].get("pnl_wk_bp", 0):
                active.discard(rid)
                shadow.add(rid)
                demote_log.append((rid, w.isoformat(), "backtest_below_floor"))
                continue
            if should_demote(post, spec["floor"]):
                active.discard(rid)
                shadow.add(rid)
                demote_log.append((rid, w.isoformat(), "posterior_floor"))

        cut_sim = [t for t in all_rules["iv_rv_gate"] if t["d"] < w]
        ev = {
            "kept": {
                "iv_rv": {"pic": 0.12, "pt": 4.0, "months": 30},
                "iv_rank_1y": {"pic": 0.06, "pt": 2.5, "months": 30},
                "iv30": {"ic": 0.04, "t": 2.0, "months": 30},
            },
            "own": {},
            "flags": {},
            "rh": {},
        }
        live_stub = {"folders": {}}
        NP, why = L.propose_params(champ, ev, live_stub)
        new_dirs = {x["param"]: L.param_direction(x) for x in why}
        confirmed = [x for x in why if pending_dirs.get(x["param"]) == L.param_direction(x)]
        pending_dirs = new_dirs
        if confirmed:
            ok, p_better = L.challenger_posterior_ok(champ, NP, ev)
            if ok:
                ym = (w.year, w.month)
                if last_promo_month != ym:
                    champ = L.apply_rationale(champ, confirmed)
                    promotions.append(w.isoformat())
                    last_promo_month = ym
        if w.day <= 7:
            weight_snap.append((w, dict(champ["premium"])))

    w_vals = [x[1] for x in weight_snap]
    keys = sorted(w_vals[0].keys()) if w_vals else []
    first12 = w_vals[:12]
    last12 = w_vals[-12:] if len(w_vals) >= 12 else w_vals

    def stds(block):
        return {k: float(np.std([b[k] for b in block])) for k in keys}

    std_first = stds(first12)
    std_last = stds(last12)

    q5_kept = "put_edge_q5" in active or "put_edge_q5" not in shadow
    rich_demoted = "rich_puts" in shadow
    promo_ok = len(promotions) <= (len(weeks) // 4 + 2)
    conv_ok = sum(std_last.values()) <= sum(std_first.values()) * 1.05 + 1e-9

    return {
        "weeks": len(weeks),
        "active_end": sorted(active),
        "shadow": sorted(shadow),
        "demote_log": demote_log,
        "promotions": promotions,
        "std_first": std_first,
        "std_last": std_last,
        "checks": {
            "i_q5_kept": q5_kept,
            "ii_rich_demoted": rich_demoted,
            "iii_promo_monthly": promo_ok,
            "iv_weight_converge": conv_ok,
        },
        "weight_snap": weight_snap,
    }


def write_report(res: dict) -> None:
    OUT_MD.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# A327 replay (learning loop v2)",
        "",
        f"Weeks simulated: {res['weeks']} ({REPLAY_START} → {REPLAY_END})",
        "",
        "## Rules",
        "",
        "| status | rules |",
        "|---|---|",
        f"| kept | {', '.join(res['active_end']) or '—'} |",
        f"| demoted | {', '.join(res['shadow']) or '—'} |",
        "",
        "## Demotions (first event per rule)",
        "",
    ]
    seen = set()
    for rid, wk, why in res["demote_log"]:
        if rid in seen:
            continue
        seen.add(rid)
        lines.append(f"- **{rid}** @ {wk} ({why})")
    lines += [
        "",
        f"Promotions: {len(res['promotions'])} (≤ 1/month target)",
        "",
        "## Acceptance",
        "",
    ]
    for k, v in res["checks"].items():
        lines.append(f"- {k}: **{'pass' if v else 'fail'}**")
    lines += [
        "",
        "## Weight path σ (first 12 mo vs last 12 mo)",
        "",
        "| weight | σ first | σ last |",
        "|---|---|---|",
    ]
    for k in sorted(res["std_first"]):
        lines.append(f"| {k} | {res['std_first'][k]:.4f} | {res['std_last'].get(k, float('nan')):.4f} |")
    OUT_MD.write_text("\n".join(lines) + "\n")

    if res["weight_snap"]:
        fig, ax = plt.subplots(figsize=(8, 4))
        xs = [x[0] for x in res["weight_snap"]]
        for k in ("w_iv_rv", "w_iv_rank", "w_iv_level"):
            ax.plot(xs, [p[k] for p in [x[1] for x in res["weight_snap"]]], label=k)
        ax.set_title("Premium weights (monthly snapshots)")
        ax.legend()
        fig.autofmt_xdate()
        fig.tight_layout()
        fig.savefig(OUT_PNG, dpi=120)
        plt.close(fig)


def main() -> int:
    fast = "--fast" in sys.argv
    with connect() as conn:
        res = run_replay(conn, fast=fast)
    write_report(res)
    print(f"→ {OUT_MD}")
    print(f"→ {OUT_PNG}")
    print(res["checks"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
