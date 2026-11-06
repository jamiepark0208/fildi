#!/usr/bin/env python3
"""A352 — does option_score rank short puts once strike IV is removed?

Question: on weekly ~1σ short puts, 2021→2026, does the live option-score formula
(rebuilt from inputs known on the entry date) rank within the week
(a) stock excess return to expiry and (b) short-put P&L as a percent of strike?
IV-neutral = residual of that score on strike IV inside the week.

Pass: IV-neutral rank IC of put P&L > 0 and the week-clustered 90% CI sits above 0.
Inverted: that IC, or the stock-excess IV-neutral IC, is < 0 with the CI below 0.
Then the challenger is the IV-residual score with at most portfolio.max_per_sector
names per co-movement group, compared with the raw-score champion, a random
same-delta pick from the same week, and the 3-month T-bill, paired by week.
Stop: fewer than 150 weeks with a rebuilt cross-section → report coverage and stop.
Does not change live scores or the Model List.

    cd scripts/watchlist_sync && .venv/bin/python analysis/a352_score_rank.py
"""
from __future__ import annotations

import math
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT))

import a327_replay as A327  # noqa: E402
import s045_put_retest as S  # noqa: E402
import s059_option_factors as S59  # noqa: E402
from build_plan import connect  # noqa: E402
from grade_weeks import iso_week  # noqa: E402
from portfolio import DEFAULTS as PORT  # noqa: E402
from rule_posterior import prior_from_trades, prob_better_than  # noqa: E402
from scipy.stats import spearmanr  # noqa: E402

MIN_WEEK = 150
MIN_NAMES = 20
BOOT = 2000
REPORT = ROOT.parent.parent / "research" / "studies" / "a352-put-score-rank.md"
TBILL = ROOT / "out" / "opt" / "dtb3.csv"

# Live put weights (lib/option-scoring/src/option-scorer-constants.ts). Support, node gap,
# and vol-of-vol stay out: node/vol weights are 0, and swing-low support is not stored on the lab row.
W_INCOME, W_BUFFER, W_IV_REL, W_IV_ABS, W_QUALITY, W_DTE = 0.30, 0.32, 0.10, 0.06, 0.12, 0.04
INCOME_FLOOR, INCOME_TARGET, INCOME_DECAY = 0.5, 1.0, 0.70
DELTA_SWEET, DELTA_MAX = 0.15, 0.35  # BASELINE regime — lab rows do not store the macro regime
SD_TARGET = 1.25
IV_ABS_CAP = 0.85


def _c01(v: float) -> float:
    return max(0.0, min(1.0, v))


def score_income(weekly: float) -> float:
    if not math.isfinite(weekly) or weekly < INCOME_FLOOR:
        return 0.0
    if weekly <= INCOME_TARGET:
        return (weekly - INCOME_FLOOR) / (INCOME_TARGET - INCOME_FLOOR)
    return _c01(INCOME_DECAY + (1.0 - INCOME_DECAY) * (INCOME_TARGET / weekly))


def score_delta(abs_delta: float) -> float:
    if abs_delta >= DELTA_MAX:
        return 0.0
    if abs_delta <= DELTA_SWEET:
        return _c01(1.0 - 0.3 * (abs_delta / DELTA_SWEET))
    return _c01(0.7 * (1.0 - (abs_delta - DELTA_SWEET) / (DELTA_MAX - DELTA_SWEET)))


def score_sd(otm: float, iv: float, dte: float) -> float:
    if iv <= 0 or dte <= 0:
        return 0.0
    em = iv * math.sqrt(dte / 365.0)
    if em <= 0 or otm <= 0:
        return 0.0
    return _c01((otm / em) / SD_TARGET)


def score_buffer(delta: float, iv: float, dte: float, otm: float) -> float:
    return _c01(0.60 * score_delta(abs(delta)) + 0.40 * score_sd(otm, iv, dte))


def score_dte(dte: float) -> float:
    if dte <= 7:
        return 1.0
    if dte <= 14:
        return 0.8
    if dte <= 21:
        return 0.6
    return 0.4


def blend(parts: list[tuple[float, float | None]]) -> float | None:
    avail = [(w, s) for w, s in parts if s is not None]
    tw = sum(w for w, _ in avail)
    if tw <= 0:
        return None
    return round(100.0 * sum(w * s for w, s in avail) / tw, 1)


def put_delta(spot: float, strike: float, iv: float, t: float) -> float | None:
    if spot <= 0 or strike <= 0 or iv <= 0 or t <= 0:
        return None
    sd = iv * math.sqrt(t)
    d1 = (math.log(spot / strike) + 0.5 * sd * sd) / sd
    return S.ncdf(d1) - 1.0


def load_tbill() -> list[tuple[date, float]]:
    rows = []
    if not TBILL.is_file():
        return rows
    for line in TBILL.read_text().splitlines()[1:]:
        dd, v = line.split(",")
        if v not in ("", "."):
            rows.append((date.fromisoformat(dd), float(v) / 100.0))
    return rows


def tbill_at(curve: list[tuple[date, float]], d: date) -> float | None:
    if not curve:
        return None
    lo, hi = 0, len(curve) - 1
    if curve[0][0] > d:
        return curve[0][1]
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if curve[mid][0] <= d:
            lo = mid
        else:
            hi = mid - 1
    return curve[lo][1]


def load_groups(conn) -> dict[str, str]:
    rows = conn.execute(
        """SELECT t2.ticker, t2.group_id FROM (
             SELECT ticker, group_id FROM peer_group_overrides
             UNION ALL
             SELECT DISTINCT ON (ticker) ticker, group_id FROM peer_group_members m
             WHERE removed_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM peer_group_overrides o WHERE o.ticker = m.ticker)
           ) t2"""
    ).fetchall()
    return {t: g for t, g in rows}


def _closes(conn, tickers: list[str], dates: list[date]) -> dict[tuple, float]:
    px = {}
    if not tickers or not dates:
        return px
    for t, d, c in conn.execute(
        """SELECT ticker, date, close::float8 FROM lseg_research.daily_history
           WHERE ticker = ANY(%s) AND date = ANY(%s) AND close > 0""",
        (tickers, dates),
    ).fetchall():
        px[(t, d)] = c
    return px


def _universe_medians(conn, dates: list[date], windows: set[tuple[date, date]]) -> dict[tuple, float]:
    uni: dict[str, dict] = defaultdict(dict)
    for t, d, c in conn.execute(
        """SELECT h.ticker, h.date, h.close::float8
           FROM lseg_research.daily_history h
           JOIN fmp_fundamentals f ON f.ticker = h.ticker
           WHERE h.date = ANY(%s) AND h.close > 0""",
        (dates,),
    ).fetchall():
        uni[t][d] = c
    out = {}
    for d0, d1 in windows:
        rets = []
        for series in uni.values():
            a, b = series.get(d0), series.get(d1)
            if a and b and a > 0:
                rets.append(b / a - 1.0)
        if rets:
            out[(d0, d1)] = float(np.median(rets))
    return out


def rebuild_book(conn) -> list[dict]:
    """A327/S059 weekly puts, scored from entry-date inputs only."""
    ev = S59.aligned_events(conn)
    ev = [e for e in ev if A327.REPLAY_START <= e["d"] <= A327.REPLAY_END and e.get("iv30")]
    dates = sorted({e["d"] for e in ev} | {e["expiry"] for e in ev})
    tickers = sorted({e["t"] for e in ev})
    px = _closes(conn, tickers, dates)
    windows = {(e["d"], e["expiry"]) for e in ev}
    med = _universe_medians(conn, dates, windows)
    ready = []
    for e in ev:
        spot, settle = px.get((e["t"], e["d"])), px.get((e["t"], e["expiry"]))
        if not spot or not settle or spot <= 0:
            continue
        iv = float(e["iv30"])
        t_year = e["hold_sessions"] / 252.0
        strike = spot * math.exp(-S.Z * iv * math.sqrt(t_year))
        delta = put_delta(spot, strike, iv, t_year)
        if delta is None:
            continue
        days = max((e["expiry"] - e["d"]).days, 1)
        prem = S.bs_put(spot, strike, iv, t_year)
        weekly = (prem / spot) * 100.0 * 7.0 / days
        otm = (spot - strike) / spot
        tech = e.get("tech_total")
        quality = None if tech is None else _c01(float(tech) / 100.0)
        ready.append({
            **e,
            "spot": spot,
            "settle": settle,
            "strike": strike,
            "iv": iv,
            "delta": delta,
            "weekly": weekly,
            "otm": otm,
            "dte": days,
            "quality": quality,
            "stock_ret": settle / spot - 1.0,
            "excess": (settle / spot - 1.0 - med[(e["d"], e["expiry"])]) if (e["d"], e["expiry"]) in med else None,
            "pnl": float(e["pnl"]),
        })
    by: dict[date, list[dict]] = defaultdict(list)
    for e in ready:
        by[e["d"]].append(e)
    scored = []
    for g in by.values():
        ivs = [e["iv"] for e in g]
        rvs = [e["iv_rv"] for e in g if e.get("iv_rv") is not None]
        for e in g:
            iv_abs = min(sum(v <= e["iv"] for v in ivs) / len(ivs), IV_ABS_CAP)
            iv_rel = None
            if e.get("iv_rv") is not None and rvs:
                iv_rel = _c01(sum(v <= e["iv_rv"] for v in rvs) / len(rvs))
            e["score"] = blend([
                (W_INCOME, score_income(e["weekly"])),
                (W_BUFFER, score_buffer(e["delta"], e["iv"], e["dte"], e["otm"])),
                (W_IV_REL, iv_rel),
                (W_IV_ABS, iv_abs),
                (W_QUALITY, e["quality"]),
                (W_DTE, score_dte(e["dte"])),
            ])
            if e["score"] is not None and e["excess"] is not None:
                scored.append(e)
    return scored


def sanity(rows: list[dict]) -> list[str]:
    sample = rows[:8]
    bad = []
    if len(rows) < 5:
        return ["fewer than 5 scored puts"]
    for e in sample:
        if not (e["strike"] < e["spot"]):
            bad.append(f"{e['t']} {e['d']} strike {e['strike']:.2f} not below spot {e['spot']:.2f}")
        if not (0.05 <= abs(e["delta"]) <= 0.45):
            bad.append(f"{e['t']} {e['d']} delta {e['delta']:.3f} outside 1σ band")
        if not (0.0 <= e["score"] <= 100.0):
            bad.append(f"{e['t']} {e['d']} score {e['score']}")
    return bad


def _rho(x, y) -> float | None:
    if len(x) < MIN_NAMES:
        return None
    res = spearmanr(x, y)
    rho = getattr(res, "statistic", None)
    if rho is None:
        rho = res[0]
    return None if rho is None or not math.isfinite(float(rho)) else float(rho)


def week_ics(rows: list[dict]) -> dict[str, list[float]]:
    by: dict[date, list[dict]] = defaultdict(list)
    for e in rows:
        by[e["d"]].append(e)
    out = {"excess_raw": [], "excess_iv": [], "pnl_raw": [], "pnl_iv": [], "iv_excess": [], "iv_pnl": [], "resid_iv_pearson": []}
    for g in by.values():
        if len(g) < MIN_NAMES:
            continue
        score = np.array([e["score"] for e in g], float)
        iv = np.array([e["iv"] for e in g], float)
        excess = np.array([e["excess"] for e in g], float)
        pnl = np.array([e["pnl"] for e in g], float)
        x = iv - iv.mean()
        vx = float(np.dot(x, x))
        resid = score - score.mean() if vx <= 0 else (score - score.mean()) - x * (float(np.dot(x, score - score.mean())) / vx)
        pairs = (
            ("excess_raw", score, excess),
            ("excess_iv", resid, excess),
            ("pnl_raw", score, pnl),
            ("pnl_iv", resid, pnl),
            ("iv_excess", iv, excess),
            ("iv_pnl", iv, pnl),
        )
        for key, a, b in pairs:
            rho = _rho(a, b)
            if rho is not None:
                out[key].append(rho)
        vr = float(np.dot(resid, resid))
        if vx > 0 and vr > 0:
            out["resid_iv_pearson"].append(float(np.dot(resid, x) / math.sqrt(vr * vx)))
    return out


def boot_mean(xs: list[float], seed: int) -> tuple[float, float, float] | None:
    arr = np.asarray(xs, float)
    if len(arr) < 2:
        return None
    rng = np.random.default_rng(seed)
    take = rng.integers(0, len(arr), size=(BOOT, len(arr)))
    means = arr[take].mean(axis=1)
    lo, hi = np.quantile(means, [0.05, 0.95])
    return float(arr.mean()), float(lo), float(hi)


def call_status(stat) -> str:
    if stat is None:
        return "no estimate"
    mean, lo, hi = stat
    if mean > 0 and lo > 0:
        return "pass"
    if mean < 0 and hi < 0:
        return "inverted"
    return "inconclusive"


def cap_book(ranked: list[dict], group_of: dict[str, int], n_keep: int, max_per: int) -> list[dict]:
    kept, counts = [], defaultdict(int)
    for e in ranked:
        g = group_of.get(e["t"], e["t"])
        if counts[g] >= max_per:
            continue
        counts[g] += 1
        kept.append(e)
        if len(kept) >= n_keep:
            break
    return kept


def paired(rows: list[dict], group_of: dict[str, int], curve) -> dict | None:
    """Top third by raw score vs IV-residual score capped by co-movement group vs random vs T-bill."""
    max_per = int(PORT["max_per_sector"])
    by: dict[date, list[dict]] = defaultdict(list)
    for e in rows:
        by[e["d"]].append(e)
    chall, champ, rnd, tb, dates = [], [], [], [], []
    for d in sorted(by):
        g = by[d]
        if len(g) < MIN_NAMES:
            continue
        n_keep = max(1, len(g) // 3)
        iv = np.array([e["iv"] for e in g], float)
        score = np.array([e["score"] for e in g], float)
        x = iv - iv.mean()
        vx = float(np.dot(x, x))
        resid = score - score.mean() if vx <= 0 else (score - score.mean()) - x * (float(np.dot(x, score - score.mean())) / vx)
        for e, r in zip(g, resid):
            e["resid"] = float(r)
        champ_book = sorted(g, key=lambda e: (-e["score"], e["t"]))[:n_keep]
        chall_book = cap_book(sorted(g, key=lambda e: (-e["resid"], e["t"])), group_of, n_keep, max_per)
        if len(chall_book) < max(1, n_keep // 2):
            continue
        rng = np.random.default_rng(int(d.strftime("%Y%m%d")))
        pick = rng.choice(len(g), size=n_keep, replace=False)
        rand_book = [g[i] for i in pick]
        rate = tbill_at(curve, d)
        if rate is None:
            continue
        days = max((g[0]["expiry"] - d).days, 1)
        dates.append(d)
        champ.append(float(np.mean([e["pnl"] for e in champ_book])))
        chall.append(float(np.mean([e["pnl"] for e in chall_book])))
        rnd.append(float(np.mean([e["pnl"] for e in rand_book])))
        tb.append(rate * days / 365.0)

    def arm(name, a, b, seed):
        diff = [x - y for x, y in zip(a, b)]
        stat = boot_mean(diff, seed)
        better = sum(x > y for x, y in zip(a, b))
        return {"vs": name, "n_weeks": len(diff), "weeks_better": better, "bp": None if stat is None else [v * 1e4 for v in stat]}

    if len(dates) < 2:
        return None
    trades = lambda series: [{"d": d, "ret": r, "week": iso_week(d), "breach": r < 0, "month": (d.year, d.month)} for d, r in zip(dates, series)]
    p_champ = prob_better_than(prior_from_trades(trades(chall)), prior_from_trades(trades(champ)))
    p_rand = prob_better_than(prior_from_trades(trades(chall)), prior_from_trades(trades(rnd)))
    return {
        "weeks": len(dates),
        "chall_bp": float(np.mean(chall) * 1e4),
        "champ_bp": float(np.mean(champ) * 1e4),
        "random_bp": float(np.mean(rnd) * 1e4),
        "tbill_bp": float(np.mean(tb) * 1e4),
        "vs_champ": arm("champion", chall, champ, 3521),
        "vs_random": arm("random", chall, rnd, 3522),
        "vs_tbill": arm("tbill", chall, tb, 3523),
        "p_better_champ": p_champ,
        "p_better_random": p_rand,
        "max_per_group": max_per,
    }


def fmt_stat(stat) -> str:
    if stat is None:
        return "n/a"
    mean, lo, hi = stat
    return f"{mean:+.4f} [{lo:+.4f}, {hi:+.4f}]"


def fmt_bp(arm) -> str:
    if not arm or not arm.get("bp"):
        return "n/a"
    mean, lo, hi = arm["bp"]
    return f"{mean:+.1f} bp [{lo:+.1f}, {hi:+.1f}] · better {arm['weeks_better']}/{arm['n_weeks']} weeks"


def write_report(text: str) -> None:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(text)


def main() -> int:
    with connect() as conn:
        rows = rebuild_book(conn)
        groups = load_groups(conn)
    problems = sanity(rows)
    weeks = len({e["d"] for e in rows})
    thick = 0
    by = defaultdict(int)
    for e in rows:
        by[e["d"]] += 1
    thick = sum(1 for n in by.values() if n >= MIN_NAMES)
    print(f"A352 scored puts {len(rows)} · weeks {weeks} · weeks with ≥{MIN_NAMES} names {thick}")
    for e in rows[:5]:
        print(f"  {e['t']} {e['d']} spot {e['spot']:.2f} K {e['strike']:.2f} iv {e['iv']:.2f} "
              f"d {e['delta']:.3f} score {e['score']:.1f} pnl {e['pnl'] * 100:+.2f}% excess {e['excess'] * 100:+.2f}pp")
    if problems:
        print("SANITY FAIL")
        for p in problems:
            print(" ", p)
        return 1
    if thick < MIN_WEEK:
        text = "\n".join([
            "# A352 put-score rank",
            "",
            f"Stop rule: {thick} weeks with ≥{MIN_NAMES} rebuilt scores (need {MIN_WEEK}).",
            f"Scored puts {len(rows)} on {weeks} entry dates, window {A327.REPLAY_START} → {A327.REPLAY_END}.",
            "IC and the challenger comparison were not run.",
            "",
        ])
        write_report(text)
        print(text)
        return 0
    ics = week_ics(rows)
    stats = {k: boot_mean(v, 3520 + i) for i, (k, v) in enumerate(ics.items())}
    labels = {
        "excess_raw": "stock excess, raw score",
        "excess_iv": "stock excess, IV-neutral",
        "pnl_raw": "put P&L % strike, raw score",
        "pnl_iv": "put P&L % strike, IV-neutral",
    }
    pnl_state = call_status(stats["pnl_iv"])
    xs_state = call_status(stats["excess_iv"])
    raw_xs = call_status(stats["excess_raw"])
    # Inversion of any measured IC (raw or IV-neutral, either target) runs the challenger.
    run_challenger = "inverted" in (pnl_state, xs_state, raw_xs, call_status(stats["pnl_raw"]))
    chall = paired(rows, groups, load_tbill()) if run_challenger else None
    lines = [
        "# A352 put-score rank",
        "",
        f"Window {A327.REPLAY_START} → {A327.REPLAY_END}. Rebuilt option_score from entry-date IV, IV/RV, tech total, premium and 1σ strike.",
        f"Scored puts {len(rows)}. Weeks with ≥{MIN_NAMES} names: {thick} (stop bar {MIN_WEEK}).",
        "Rank IC is the within-week Spearman, averaged across weeks. 90% CI resamples weeks.",
        "",
        "| target | weeks | IC mean [90% CI] | call |",
        "|---|---|---|---|",
    ]
    for key in ("excess_raw", "excess_iv", "pnl_raw", "pnl_iv"):
        lines.append(f"| {labels[key]} | {len(ics[key])} | {fmt_stat(stats[key])} | {call_status(stats[key])} |")
    lines += ["", f"Pass bar is the IV-neutral put-P&L IC: **{pnl_state}**. Stock-excess IV-neutral: **{xs_state}**. Raw stock-excess: **{raw_xs}**."]
    lines.append(
        "Mechanics check, not the pass bar: Pearson(score residual, strike IV) "
        f"{fmt_stat(stats['resid_iv_pearson'])} (about 0 means the residual has no linear IV). "
        f"Strike IV vs put P&L {fmt_stat(stats['iv_pnl'])}. Strike IV vs stock excess {fmt_stat(stats['iv_excess'])}."
    )
    if not run_challenger:
        lines.append("Challenger comparison not run: neither IV-neutral IC is inverted with the CI below 0.")
    elif chall is None:
        lines.append("Challenger comparison: not enough paired weeks.")
    else:
        lines += [
            "",
            f"Challenger = IV-residual score, ≤{chall['max_per_group']} names per co-movement group. "
            f"Champion = raw score, same count. Random = same-delta (the 1σ put) same week. T-bill = FRED DTB3 over the hold.",
            f"Level, bp of strike per week: challenger {chall['chall_bp']:+.1f} · champion {chall['champ_bp']:+.1f} · "
            f"random {chall['random_bp']:+.1f} · T-bill {chall['tbill_bp']:+.1f} · n {chall['weeks']} weeks.",
            f"Paired challenger − champion: {fmt_bp(chall['vs_champ'])}. P(challenger mean > champion) {chall['p_better_champ']:.2f}.",
            f"Paired challenger − random: {fmt_bp(chall['vs_random'])}. P(challenger mean > random) {chall['p_better_random']:.2f}.",
            f"Paired challenger − T-bill: {fmt_bp(chall['vs_tbill'])}.",
        ]
    lines += [
        "",
        "Live scores were not changed.",
        "",
        "Known weaknesses: income uses the mid 1σ premium, not a live bid; regime fixed at BASELINE; "
        "support, fund total, and the 7-day earnings haircut are not on the stored lab row; "
        "co-movement groups are today's membership.",
        "",
    ]
    text = "\n".join(lines)
    write_report(text)
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
