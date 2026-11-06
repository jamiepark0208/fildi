#!/usr/bin/env python3
"""A327 replay: weekly v2 learning loop on historical engines (2021-01 → 2026-10).

    cd scripts/watchlist_sync && .venv/bin/python analysis/a327_replay.py
"""
from __future__ import annotations

import copy
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
    decide,
    load_learning_rules,
    observe_live,
    prior_from_trades,
    prob_below_floor,
)

import s059_option_factors as S59  # noqa: E402
import s101_band_regime as S101  # noqa: E402
import s109_real_quote_rule as S109  # noqa: E402

REPLAY_START = date(2021, 1, 4)
REPLAY_END = date(2026, 10, 27)
PRIOR_END_S059 = date(2020, 12, 31)
PRIOR_END_S109 = date(2021, 12, 31)
REPLAY_FROM_S109 = date(2022, 1, 4)
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


def learning_prior_end(spec: dict) -> date:
    study = str(spec.get("study") or "")
    if "S109" in study:
        return PRIOR_END_S109
    return PRIOR_END_S059


def learning_replay_from(spec: dict) -> date:
    study = str(spec.get("study") or "")
    if "S109" in study:
        return REPLAY_FROM_S109
    return REPLAY_START


def prior_and_live(trades: list[dict], as_of: date, spec: dict) -> tuple:
    pe = learning_prior_end(spec)
    prior_trades = [t for t in trades if t["d"] < pe]
    live_trades = [t for t in trades if pe <= t["d"] < as_of]
    prior = prior_from_trades(prior_trades, use_month_blocks=True)
    return prior, live_trades


def replay_prior(trades: list[dict], as_of: date, spec: dict) -> tuple:
    pe = learning_prior_end(spec)
    prior_trades = [t for t in trades if t["d"] < pe]
    return prior_from_trades(prior_trades, use_month_blocks=True), prior_trades


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
        if as_of < learning_replay_from(spec):
            continue
        prior, live = prior_and_live(trades, as_of, spec)
        demote, reason, _ = decide(prior, live, spec["floor"])
        if demote:
            active.discard(rid)
            shadow.add(rid)
            demoted.append((rid, as_of.isoformat(), reason))
    replay_pnl = {}
    for rid in rules_spec:
        if rid.startswith("_"):
            continue
        spec = rules_spec[rid]
        prior, cut = replay_prior(all_rules.get(rid, []), as_of, spec)
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


def rule_posterior_snapshot(
    all_rules: dict[str, list[dict]],
    rules_spec: dict,
    as_of: date,
) -> list[dict]:
    rows_out = []
    for rid, spec in rules_spec.items():
        if rid.startswith("_"):
            continue
        trades = all_rules.get(rid, [])
        if as_of < learning_replay_from(spec):
            continue
        prior, live = prior_and_live(trades, as_of, spec)
        post = observe_live(prior, live)
        post.n_live_weeks = len({t.get("week") or iso_week(t["d"]) for t in live if t.get("d")})
        floor = spec["floor"]
        rows_out.append(
            {
                "rule": rid,
                "live_weeks": post.n_live_weeks,
                "pnl_wk_bp": (post.pnl.mu or 0) * 1e4,
                "floor_bp": floor.get("pnl_wk_bp"),
                "p_below": prob_below_floor(post, floor),
            }
        )
    return rows_out


def run_replay(conn, *, fast: bool = False) -> dict:
    rules_spec = load_learning_rules()
    all_rules = load_rule_trades(conn)
    s059_pool = L.warm_s059_promotion_cache(conn, REPLAY_END + timedelta(days=7))
    weeks = list(iter_weeks(REPLAY_START, REPLAY_END))
    if fast:
        weeks = weeks[::4]
    active = {k for k in rules_spec if not k.startswith("_") and all_rules.get(k)}
    shadow: set[str] = set()
    demote_log: list[tuple] = []
    promotions: list[str] = []
    proposal_log: list[tuple] = []
    promo_months: dict[tuple[int, int], int] = defaultdict(int)
    weight_snap: list[tuple[date, dict]] = []
    champ = copy.deepcopy(PM.SEED)
    pending_dirs: dict[str, str] = {}

    for w in weeks:
        for rid in list(active):
            spec = rules_spec[rid]
            if w < learning_replay_from(spec):
                continue
            trades = all_rules.get(rid, [])
            prior, live = prior_and_live(trades, w, spec)
            demote, reason, _ = decide(prior, live, spec["floor"])
            if demote:
                active.discard(rid)
                shadow.add(rid)
                demote_log.append((rid, w.isoformat(), reason))

        if w.day <= 7:
            ev = L.backtest_evidence(as_of=w)
            live_stub = {"folders": {}}
            NP, why = L.propose_params(champ, ev, live_stub)
            new_dirs = {x["param"]: L.param_direction(x) for x in why}
            confirmed = [x for x in why if pending_dirs.get(x["param"]) == L.param_direction(x)]
            pending_dirs = new_dirs
            _p_better = None
            if confirmed:
                ok, _p_better = L.challenger_posterior_ok(champ, NP, ev, conn=conn, as_of=w, s059_pool=s059_pool)
            if why:
                proposal_log.append((w.isoformat(), [f"{x['param']} {x['old']}→{x['new']}" for x in why], len(confirmed), _p_better))
            if confirmed:
                if ok:
                    ym = (w.year, w.month)
                    if promo_months[ym] < 1:
                        champ = L.apply_rationale(champ, confirmed)
                        promotions.append(w.isoformat())
                        promo_months[ym] += 1
            weight_snap.append((w, dict(champ["premium"])))

    w_vals = [x[1] for x in weight_snap]
    keys = sorted(w_vals[0].keys()) if w_vals else []
    first12 = w_vals[:12]
    last12 = w_vals[-12:] if len(w_vals) >= 12 else w_vals

    def stds(block):
        return {k: float(np.std([b[k] for b in block])) for k in keys}

    std_first = stds(first12)
    std_last = stds(last12)

    q5_kept = "put_edge_q5" in active
    iv_demoted = any(r == "iv_rv_gate" for r, _, _ in demote_log)
    promo_ok = all(c <= 1 for c in promo_months.values())
    conv_ok = sum(std_last.values()) <= sum(std_first.values()) * 1.05 + 1e-9
    rule_table = rule_posterior_snapshot(all_rules, rules_spec, REPLAY_END)
    iv_demote_wk = next((date.fromisoformat(x[1]) for x in demote_log if x[0] == "iv_rv_gate"), None)
    iv_hand_at_demote = None
    if iv_demote_wk:
        for row in rule_posterior_snapshot(all_rules, rules_spec, iv_demote_wk + timedelta(days=1)):
            if row["rule"] == "iv_rv_gate":
                iv_hand_at_demote = row
                break

    return {
        "weeks": len(weeks),
        "proposal_log": proposal_log,
        "active_end": sorted(active),
        "shadow": sorted(shadow),
        "demote_log": demote_log,
        "promotions": promotions,
        "promo_months": dict(promo_months),
        "std_first": std_first,
        "std_last": std_last,
        "checks": {
            "i_q5_kept": q5_kept,
            "ii_demotion_path": iv_demoted,
            "iii_promo_monthly": promo_ok,
            "iv_weight_converge": conv_ok,
        },
        "rule_table": rule_table,
        "iv_rv_gate_hand": iv_hand_at_demote,
        "iv_rv_gate_demote_week": iv_demote_wk.isoformat() if iv_demote_wk else None,
        "weight_snap": weight_snap,
        "std_first_vals": {k: [b[k] for b in first12] for k in keys} if first12 else {},
        "std_last_vals": {k: [b[k] for b in last12] for k in keys} if last12 else {},
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
        f"Months with a proposed move: {len(res.get('proposal_log', []))} · confirmed 2 cycles: {sum(1 for x in res.get('proposal_log', []) if x[2])} · "
        f"max P(better) {max([x[3] for x in res.get('proposal_log', []) if x[3] is not None], default=None)}",
        "",
        *[f"- {d}: {'; '.join(m)} · confirmed {c} · P {p if p is None else round(p, 3)}" for d, m, c, p in res.get('proposal_log', [])[:40]],
    ]
    if res.get("promotions"):
        by_m: dict[str, list[str]] = defaultdict(list)
        for wk in res["promotions"]:
            d = date.fromisoformat(wk)
            by_m[f"{d.year}-{d.month:02d}"].append(wk)
        lines.append("")
        lines.append("### Promotions by month")
        for ym in sorted(by_m):
            lines.append(f"- {ym}: {', '.join(by_m[ym])}")
    lines += [
        "",
        "## Per-rule posteriors @ replay end",
        "",
        "| rule | live weeks | P&L/wk bp (post) | floor bp | P(below floor) |",
        "|---|---:|---:|---:|---:|",
    ]
    for row in res.get("rule_table") or []:
        lines.append(
            f"| {row['rule']} | {row['live_weeks']} | {row['pnl_wk_bp']:+.1f} | {row['floor_bp']} | {row['p_below']:.3f} |"
        )
    hand = res.get("iv_rv_gate_hand")
    if hand:
        lines += [
            "",
            f"**Hand-check iv_rv_gate @ {res.get('iv_rv_gate_demote_week')}:** "
            f"live weeks {hand['live_weeks']}, posterior P&L/wk {hand['pnl_wk_bp']:+.1f} bp vs floor {hand['floor_bp']} bp, "
            f"P(below floor)={hand['p_below']:.4f}",
        ]
    lines += [
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
    if res.get("weight_snap"):
        d0, w0 = res["weight_snap"][0]
        d1, w1 = res["weight_snap"][-1]
        lines += [
            "",
            f"First monthly snapshot ({d0}): "
            + ", ".join(f"{k}={w0[k]:.4f}" for k in sorted(w0)),
            f"Last monthly snapshot ({d1}): "
            + ", ".join(f"{k}={w1[k]:.4f}" for k in sorted(w1)),
            "",
        ]
    for k in sorted(res["std_first"]):
        fv = res.get("std_first_vals", {}).get(k, [])
        lv = res.get("std_last_vals", {}).get(k, [])
        lines.append(
            f"| {k} | {res['std_first'][k]:.4f} | {res['std_last'].get(k, float('nan')):.4f} |"
            + (f" last mo {lv[:3]}" if lv else "")
        )
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
