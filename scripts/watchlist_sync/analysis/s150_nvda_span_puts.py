#!/usr/bin/env python3
"""S150 / A325 — short semis puts spanning NVDA earnings vs control windows (S081 pricing stack).

Universe: GICS Semiconductors + Semiconductor Equipment (+ SMH), ex NVDA. Software GICS comparator.
Trades: Friday entry, 0.25Δ and 0.15Δ puts, expiry Friday 30–45 DTE, hold to expiry, S076 Pricer + fill(mid, spr, -1).
Spanning = NVDA effective print in (entry, expiry]; control = no NVDA print and no own print in window.

    cd scripts/watchlist_sync && .venv/bin/python -u analysis/s150_nvda_span_puts.py [--smoke] [--hand-check]
"""
from __future__ import annotations

import math
import statistics
import sys
from bisect import bisect_left, bisect_right
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402
import s080_long_options as S80  # noqa: E402
from s076_structures_backtest import Pricer, fill, strike_for  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S150.md"
START = date(2016, 1, 1)
END = date(2025, 12, 31)
DELTAS = (0.25, 0.15)
SMOKE_TICKERS = ("MRVL", "AVGO", "AMD", "MU", "ASML")


def load_universe(conn):
    semi = {
        t
        for t, _ in conn.execute(
            "SELECT ticker, gics_sub_industry FROM research_common.security_class "
            "WHERE gics_sub_industry IN ('Semiconductors', 'Semiconductor Equipment')"
        )
    }
    semi.add("SMH")
    semi.discard("NVDA")
    soft = {
        t
        for t, in conn.execute(
            "SELECT ticker FROM research_common.security_class "
            "WHERE gics_sub_industry ILIKE '%software%' OR gics_sector ILIKE '%Software%'"
        )
    }
    return semi, soft


def trading_days(conn, since=date(2012, 1, 1)):
    row = conn.execute(
        "SELECT MIN(date)::date FROM lseg_research.daily_history WHERE ticker='SPY'"
    ).fetchone()
    since = max(since, row[0] if row and row[0] else since)
    return [r[0] for r in conn.execute(
        "SELECT DISTINCT date::date FROM lseg_research.daily_history "
        "WHERE ticker='SPY' AND date >= %s ORDER BY 1", (since,)
    )]


def next_session(days: list[date], d: date) -> date | None:
    i = bisect_right(days, d)
    return days[i] if i < len(days) else None


def load_nvda_effective(conn, cal: list[date]) -> list[date]:
    """NVDA prints: earnings_calendar 2012→; AMC → next NYSE session (NVDA reports after close)."""
    raw = [
        r[0]
        for r in conn.execute(
            "SELECT report_date::date FROM earnings_calendar "
            "WHERE ticker='NVDA' AND report_date >= '2012-01-01' AND report_date <= %s ORDER BY 1",
            (END,),
        )
    ]
    eff = []
    for rd in raw:
        ns = next_session(cal, rd)
        if ns and ns <= END:
            eff.append(ns)
    return sorted(set(eff))


def load_own_earnings(conn, tickers: set[str]) -> dict[str, list[date]]:
    rep: dict[str, list[date]] = defaultdict(list)
    for t, d in conn.execute(
        "SELECT ticker, report_date::date FROM lseg_research.earnings_moves "
        "WHERE ticker = ANY(%s) AND report_date >= %s",
        (list(tickers), START - timedelta(days=30)),
    ):
        rep[t].append(d)
    for t, d in conn.execute(
        "SELECT ticker, report_date::date FROM earnings_calendar "
        "WHERE ticker = ANY(%s) AND report_date >= '2012-01-01'",
        (list(tickers),),
    ):
        if d not in rep[t]:
            rep[t].append(d)
    for t in rep:
        rep[t].sort()
    return rep


def pick_expiry_idx(dates: list[date], i: int) -> int | None:
    t0 = dates[i]
    lo, hi = t0 + timedelta(days=30), t0 + timedelta(days=45)
    best = None
    for j in range(i + 1, len(dates)):
        d = dates[j]
        if d < lo:
            continue
        if d > hi:
            break
        if d.weekday() == 4:
            best = j
    return best


def spans_nvda(entry: date, expiry: date, nvda_eff: list[date]) -> bool:
    return any(entry < e <= expiry for e in nvda_eff)


def own_in_window(entry: date, expiry: date, earn: list[date]) -> bool:
    return any(entry < e <= expiry for e in earn)


def smh_drop_regime(smh_rows: list[tuple], i: int) -> bool:
    """S149: SMH fell >= 9% over 2 sessions ending at entry."""
    if i < 2:
        return False
    c0 = smh_rows[i][1]
    c2 = smh_rows[i - 2][1]
    if c2 <= 0:
        return False
    return (c0 / c2 - 1.0) <= -0.09


def short_put_trade(pricer, rows, i, je, delta, tbd, tb):
    d, S, ivp = rows[i][0], rows[i][1], rows[i][2]
    e, Se = rows[je][0], rows[je][1]
    if not ivp or ivp <= 0:
        return None
    dte = (e - d).days
    if dte < 30 or dte > 45:
        return None
    K = strike_for(S, ivp, dte / 365, delta, "put")
    m, spr = pricer.mid("put", S, K, ivp, dte, d)
    cr = fill(m, spr, -1)
    if cr <= 0.01:
        return None
    exit_p = max(K - Se, 0.0)
    r_tb = tb[bisect_right(tbd, d) - 1][1] if tbd and d >= tbd[0] else 0.0
    pnl = (cr - exit_p) / K - r_tb * dte / 365
    breach = Se < K
    return {
        "t": None,
        "d": d,
        "e": e,
        "S": S,
        "Se": Se,
        "K": K,
        "dte": dte,
        "delta": delta,
        "iv": ivp,
        "cr": cr,
        "pnl": pnl,
        "breach": breach,
        "regime_drop": False,
        "arm": None,
    }


def build_group(conn, tickers: set[str], nvda_eff, cal, px, rep, tb, tbd, pricer, smh_regime):
    trades = []
    skipped_own = 0
    for t in sorted(tickers):
        rows = px.get(t)
        if not rows or len(rows) < 300:
            continue
        dates = [r[0] for r in rows]
        earn = rep.get(t, [])
        for i in range(252, len(rows)):
            d = dates[i]
            if d < START or d > END or d.weekday() != 4:
                continue
            je = pick_expiry_idx(dates, i)
            if je is None:
                continue
            e = dates[je]
            if own_in_window(d, e, earn):
                skipped_own += 1
                continue
            span = spans_nvda(d, e, nvda_eff)
            arm = "span" if span else "ctrl"
            reg = smh_regime(t, i) if smh_regime else False
            for delta in DELTAS:
                tr = short_put_trade(pricer, rows, i, je, delta, tbd, tb)
                if not tr:
                    continue
                tr.update({"t": t, "arm": arm, "regime_drop": reg})
                trades.append(tr)
    return trades, skipped_own


def smh_regime_fn(smh_rows):
    dates = [r[0] for r in smh_rows]
    pos = {d: i for i, d in enumerate(dates)}

    def fn(t, i):
        if t != "SMH" and smh_rows:
            # regime from SMH on same calendar day as entry ticker
            d = None
            return False
        return smh_drop_regime(smh_rows, i)

    def entry_regime(entry_date: date) -> bool:
        j = bisect_right(dates, entry_date) - 1
        if j < 2:
            return False
        return smh_drop_regime(smh_rows, j)

    return entry_regime


def summarize(xs):
    if not xs:
        return dict(n=0, breach=float("nan"), mean=float("nan"), med=float("nan"), worst=float("nan"), iv=float("nan"))
    pnls = sorted(x["pnl"] for x in xs)
    n = len(xs)
    w = pnls[: max(1, n // 20)]
    return {
        "n": n,
        "breach": sum(x["breach"] for x in xs) / n,
        "mean": statistics.mean(pnls),
        "med": statistics.median(pnls),
        "worst": statistics.mean(w),
        "iv": statistics.mean(x["iv"] for x in xs),
    }


def month_block_t(span, ctrl, key="pnl", n=500):
    by_s, by_c = defaultdict(list), defaultdict(list)
    for x in span:
        by_s[(x["d"].year, x["d"].month)].append(x[key])
    for x in ctrl:
        by_c[(x["d"].year, x["d"].month)].append(x[key])
    keys = sorted(set(by_s) | set(by_c))
    if len(keys) < 6:
        return float("nan")
    agg_s = {k: (math.fsum(v), len(v)) for k, v in by_s.items()}
    agg_c = {k: (math.fsum(v), len(v)) for k, v in by_c.items()}
    rng = np.random.default_rng(150)

    def gap(sel):
        gs = gc = 0.0
        for k in sel:
            if k in agg_s:
                gs += agg_s[k][0] / agg_s[k][1]
            if k in agg_c:
                gc += agg_c[k][0] / agg_c[k][1]
        return gs - gc

    g0 = gap(keys)
    draws = []
    for _ in range(n):
        sel = [keys[i] for i in rng.integers(0, len(keys), len(keys))]
        draws.append(gap(sel))
    sd = statistics.pstdev(draws) or 1e-12
    return g0 / sd


def hand_check(conn, tr, pricer=None):
    """Compare model fill to cached LSEG quote or recompute pnl from trade fields."""
    if pricer is None:
        pricer = Pricer(conn)
    dte = tr["dte"]
    m, spr = pricer.mid("put", tr["S"], tr["K"], tr["iv"], dte, tr["d"])
    model_cr = fill(m, spr, -1)
    from s075_skew_calibration import RIC  # noqa: E402

    for ric, _bd, bid, ask, mid in conn.execute(
        "SELECT ric, date::date, bid::float, ask::float, mid::float FROM optlab.lseg_opt_daily "
        "WHERE date = %s AND ric LIKE %s",
        (tr["d"], tr["t"] + "%P%"),
    ):
        mric = RIC.match(ric)
        if not mric:
            continue
        root, let, dd, yy, k = mric.groups()
        if root != tr["t"]:
            continue
        K = int(k) / 100
        if abs(K - tr["K"]) > 1.5:
            continue
        try:
            exp = date(2000 + int(yy), (ord(let) - ord("A")) % 12 + 1, int(dd))
        except ValueError:
            continue
        if abs((exp - tr["e"]).days) > 7:
            continue
        if bid and ask and ask >= bid > 0:
            real_fill = bid + 0.23 * (ask - bid)
            return {
                "K_listed": K,
                "exp": exp,
                "bid": bid,
                "ask": ask,
                "real_fill_sell": real_fill,
                "model_cr": model_cr,
            }
    exit_p = max(tr["K"] - tr["Se"], 0.0)
    raw = (tr["cr"] - exit_p) / tr["K"]
    return {
        "model_cr": tr["cr"],
        "recomputed_pnl_raw": raw,
        "reported_pnl": tr["pnl"],
        "note": "reported includes T-bill excess (~0.5%/yr)",
    }


def run(conn, smoke=False, hand=False):
    semi, soft = load_universe(conn)
    cal = trading_days(conn)
    nvda_eff = load_nvda_effective(conn, cal)
    px, rep_all, tb, _tech = S80.load(conn)
    tbd = [d for d, _ in tb]
    all_tickers = semi | soft
    rep = load_own_earnings(conn, all_tickers)
    pricer = Pricer(conn)
    smh_rows = px.get("SMH") or []
    entry_regime = smh_regime_fn(smh_rows)

    if smoke:
        semi = {t for t in SMOKE_TICKERS if t in semi}
        # two recent NVDA effective prints with semis data
        nvda_pick = [d for d in nvda_eff if d >= date(2023, 1, 1)][-2:]
        if len(nvda_pick) < 2:
            nvda_pick = nvda_eff[-2:]

    trades_s, skip_s = build_group(conn, semi, nvda_eff, cal, px, rep, tb, tbd, pricer, None)
    for tr in trades_s:
        tr["regime_drop"] = entry_regime(tr["d"])

    trades_w, skip_w = build_group(conn, soft, nvda_eff, cal, px, rep, tb, tbd, pricer, None)

    if smoke:
        trades_s = [
            tr
            for tr in trades_s
            if tr["arm"] == "span" and spans_nvda(tr["d"], tr["e"], nvda_pick)
        ]
        trades_s += [
            tr
            for tr in build_group(conn, semi, nvda_eff, cal, px, rep, tb, tbd, pricer, None)[0]
            if tr["arm"] == "ctrl"
        ][:200]

    hc = None
    if hand:
        sample = trades_s[0] if trades_s else None
        if sample:
            hc = hand_check(conn, sample, pricer)
            print(f"HAND {sample['t']} {sample['d']}: {hc}")

    return {
        "nvda_source": "earnings_calendar (NVDA AMC → next SPY session)",
        "nvda_n": len(nvda_eff),
        "nvda_eff": nvda_eff,
        "skipped_own": skip_s,
        "semi": trades_s,
        "soft": trades_w,
        "skip_soft": skip_w,
        "semi_n": len(semi),
        "soft_n": len(soft),
        "gics_note": "Static research_common.security_class (no point-in-time GICS history in DB).",
        "hand": hc,
        "smoke_nvda": nvda_pick if smoke else None,
    }


def report(data, sha: str, smoke: bool):
    lines = [
        f"# S150 — semis short puts spanning NVDA earnings (A325){' [SMOKE]' if smoke else ''}",
        "",
        f"NVDA events: {data['nvda_n']} effective sessions mapped to LSEG SPY calendar "
        f"({data['nvda_source']}; panel sessions from 2018-10-02). "
        f"Universe: {data['semi_n']} semis+SMH (ex NVDA), {data['soft_n']} software comparator. "
        f"Own-earnings windows dropped: {data['skipped_own']} entries. {data['gics_note']}",
        "",
    ]
    if data.get("hand"):
        h = data["hand"]
        if "real_fill_sell" in h:
            lines.append(
                f"Hand-check LSEG {h.get('K_listed')} exp {h.get('exp')}: model credit {h['model_cr']:.3f} vs "
                f"bid+23% fill {h['real_fill_sell']:.3f} (bid {h['bid']:.2f} ask {h['ask']:.2f})."
            )
        else:
            lines.append(
                f"Hand-check arithmetic: raw pnl {h['recomputed_pnl_raw']:+.2%} vs reported (excess) {h['reported_pnl']:+.2%}; "
                f"{h.get('note', '')}"
            )
        lines.append("")

    pass_lines = []
    for group_name, trades in (("Semis", data["semi"]), ("Software", data["soft"])):
        lines.append(f"## {group_name}")
        lines.append("")
        lines.append("| Δ | arm | n | breach | mean pnl/$ | med | worst 5% | mean entry iv30 |")
        lines.append("|---|---|---:|---:|---:|---:|---:|---:|")
        for delta in DELTAS:
            for arm in ("span", "ctrl"):
                xs = [x for x in trades if x["delta"] == delta and x["arm"] == arm]
                s = summarize(xs)
                lines.append(
                    f"| {delta:.2f} | {arm} | {s['n']} | {s['breach']:.1%} | {s['mean']:+.2%} | {s['med']:+.2%} | "
                    f"{s['worst']:+.2%} | {s['iv']:.1%} |"
                )
        lines.append("")
        for delta in DELTAS:
            sp = [x for x in trades if x["delta"] == delta and x["arm"] == "span"]
            ct = [x for x in trades if x["delta"] == delta and x["arm"] == "ctrl"]
            ss, sc = summarize(sp), summarize(ct)
            t = month_block_t(sp, ct)
            ivg = ss["iv"] - sc["iv"] if ss["n"] and sc["n"] else float("nan")
            brg = (ss["breach"] - sc["breach"]) * 100 if ss["n"] and sc["n"] else float("nan")
            plg = ss["mean"] - sc["mean"] if ss["n"] and sc["n"] else float("nan")
            lines.append(
                f"**Δ={delta:.2f} gap (span−ctrl):** breach {brg:+.1f} pp · pnl {plg:+.2%} · month-block t {t:.2f} · "
                f"entry iv30 gap {ivg:+.2%}"
            )
            if group_name == "Semis":
                pass_lines.append((delta, brg, t, plg, ivg))
        # S149 regime split (semis only in pass bar; report both)
        if group_name == "Semis":
            lines.append("")
            lines.append("**S149 regime (SMH ≥9% 2-session drop before entry):**")
            for delta in DELTAS:
                for arm in ("span", "ctrl"):
                    for reg, lab in ((True, "after_drop"), (False, "other")):
                        xs = [
                            x
                            for x in trades
                            if x["delta"] == delta and x["arm"] == arm and x["regime_drop"] == reg
                        ]
                        s = summarize(xs)
                        lines.append(f"- Δ={delta:.2f} {arm} {lab}: n={s['n']} breach={s['breach']:.1%} pnl={s['mean']:+.2%}")
        lines.append("")

    # Pass bar (semis primary Δ=0.25; report 0.15 too)
    d25 = pass_lines[0] if pass_lines else None
    d15 = pass_lines[1] if len(pass_lines) > 1 else None
    # software comparator at 0.25
    sp_s = [x for x in data["soft"] if x["delta"] == 0.25 and x["arm"] == "span"]
    ct_s = [x for x in data["soft"] if x["delta"] == 0.25 and x["arm"] == "ctrl"]
    ss_s, sc_s = summarize(sp_s), summarize(ct_s)
    soft_br = (ss_s["breach"] - sc_s["breach"]) * 100 if ss_s["n"] and sc_s["n"] else float("nan")
    semi_br = d25[1] if d25 else float("nan")
    comp_surv = (semi_br - soft_br) if semi_br == semi_br and soft_br == soft_br else float("nan")

    if d25:
        br, t, pl, ivg = d25[1], d25[2], d25[3], d25[4]
        pre = (
            br >= 4.0 and t <= -2.0 and comp_surv >= 3.0
        )
        lines.append("## Pre-registered bar (0.25Δ semis)")
        lines.append(
            f"- breach gap {br:+.1f} pp (need ≥+4): {'ok' if br >= 4 else 'fail'}"
        )
        lines.append(f"- pnl gap month-block t {t:.2f} (need ≤−2): {'ok' if t <= -2 else 'fail'}")
        lines.append(
            f"- semis−software breach gap {comp_surv:+.1f} pp (need ≥+3): {'ok' if comp_surv >= 3 else 'fail'}"
        )
        lines.append(f"- entry iv30 span−ctrl {ivg:+.2%} (descriptive — edge must not be fully iv-priced)")
        lines.append("")
        lines.append(
            f"**Verdict (Cursor arithmetic only; Claude judges):** {'PASS' if pre else 'FAIL'} on 0.25Δ pre-reg bar."
        )
    lines.append(f"\nRun SHA: `{sha}`")
    return "\n".join(lines)


def main():
    smoke = "--smoke" in sys.argv
    hand = smoke or "--hand-check" in sys.argv
    conn = connect()
    data = run(conn, smoke=smoke, hand=hand or not smoke)
    sha = __import__("subprocess").check_output(
        ["git", "rev-parse", "--short", "HEAD"], cwd=HERE.parents[2], text=True
    ).strip()
    if smoke:
        print(f"smoke semi trades {len(data['semi'])} skipped_own {data['skipped_own']}")
        for tr in data["semi"][:6]:
            print(
                f"  {tr['t']} {tr['d']}→{tr['e']} Δ{tr['delta']} {tr['arm']} "
                f"K={tr['K']:.1f} pnl={tr['pnl']:+.2%} breach={tr['breach']}"
            )
        return
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(report(data, sha, smoke=False))
    print(OUT)
    print(report(data, sha, False).split("Verdict")[1][:200])


if __name__ == "__main__":
    main()
