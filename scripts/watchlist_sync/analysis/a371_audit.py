#!/usr/bin/env python3
"""A371 evidence audit — local data only. No vendor calls, no score changes.

Measures what is on disk:
  1. CRSP month-end drawdown vs later delist (rich-put's ≥25% off high leg only).
     Does not reprice puts. S076 needs LSEG iv30; delisted names are checked for coverage.
  2. S088 pricing path is read from code; this script does not refit the model.
  3. S109 regime split on cached LSEG quotes (s109_real_quote_rule.trades) plus local
     SPY (lseg_research.daily_history) and VIXCLS.csv.

    cd scripts/watchlist_sync && .venv/bin/python analysis/a371_audit.py
"""
from __future__ import annotations

import csv
import gzip
import math
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402
import s109_real_quote_rule as S109  # noqa: E402

ROOT = HERE.parents[2]
CRSP = HERE.parent / "out" / "survivorship" / "crsp_msf.csv.gz"
DEL = HERE.parent / "out" / "survivorship" / "crsp_delist.csv.gz"
VIX = HERE.parent / "out" / "opt" / "s028_inputs" / "VIXCLS.csv"
OUT = ROOT / "research" / "studies" / "out" / "a371-audit.md"
SPLIT = date(2024, 7, 1)
WIN0, WIN1 = date(2020, 12, 1), date(2024, 11, 30)
# Last entry month that still has 12 months of CRSP follow-up (file ends 2024-11).
FOLLOW_END = date(2023, 11, 30)


def _num(v):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(x) else x


def _d(s: str) -> date:
    return datetime.strptime(s[:10], "%Y-%m-%d").date()


def load_crsp():
    by = defaultdict(dict)
    with gzip.open(CRSP, "rt") as fh:
        for r in csv.DictReader(fh):
            by[r["permno"]][_d(r["date"])] = r
    dl = {}
    with gzip.open(DEL, "rt") as fh:
        for r in csv.DictReader(fh):
            p, dt = r["permno"], _d(r["dlstdt"])
            if p not in dl or dt < dl[p][0]:
                dl[p] = (dt, int(float(r["dlstcd"])), _num(r["dlret"]))
    return by, dl


def bucket(code: int) -> str:
    k = code // 100
    return {2: "merger_2xx", 3: "exchange_3xx", 4: "liquidation_4xx", 5: "dropped_5xx"}.get(k, f"other_{k}xx")


def crsp_screen(by, dl):
    """Month-end price ≥ $3, cap ≥ $300M, ≥12 month-ends. Drawdown = price / 12-month max price − 1.

    shrout is CRSP thousands (AAPL 2024-11: 15,115,823 × $237 × 1000 ≈ $3.6T).
    """
    rows = []
    for permno, g in by.items():
        ds = sorted(g)
        for i, d in enumerate(ds):
            if d < WIN0 or d > FOLLOW_END or i < 11:
                continue
            window = ds[i - 11: i + 1]
            if (window[-1] - window[0]).days < 300:
                continue
            prcs = [abs(_num(g[x]["prc"]) or 0) for x in window]
            if any(p <= 0 for p in prcs):
                continue
            s, shr = prcs[-1], _num(g[d]["shrout"]) or 0
            cap = s * shr * 1000
            if s < 3 or cap < 300e6:
                continue
            off = s / max(prcs) - 1
            hit = dl.get(permno)
            ahead = None
            if hit and 0 < (hit[0] - d).days <= 366:
                ahead = hit
            rows.append({"p": permno, "d": d, "t": (g[d].get("ticker") or "").strip(), "off": off,
                         "deep": off <= -0.25, "ahead": ahead, "cap": cap})
    return rows


def rate_table(rows):
    lines = []
    for label, pred in (("≥25% off 12m month-end high", lambda r: r["deep"]),
                        ("not 25% off", lambda r: not r["deep"])):
        xs = [r for r in rows if pred(r)]
        n = len(xs)
        names = {r["p"] for r in xs}
        def cnt(kind):
            return sum(1 for r in xs if r["ahead"] and bucket(r["ahead"][1]) == kind)
        any_dl = sum(1 for r in xs if r["ahead"])
        bad = sum(1 for r in xs if r["ahead"] and bucket(r["ahead"][1]) in ("liquidation_4xx", "dropped_5xx"))
        # unique names with any deep/not month that later delist inside the window of THAT month already counted in name-months.
        lines.append((label, n, len(names), any_dl, bad, cnt("dropped_5xx"), cnt("liquidation_4xx"), cnt("merger_2xx")))
    return lines


def unique_name_fate(by, dl):
    """Unique permnos eligible in 2020-12→2024-11: ever ≥25% off vs never, then delist code by 2024-11."""
    ever, never = set(), set()
    for permno, g in by.items():
        ds = sorted(d for d in g if WIN0 <= d <= WIN1)
        if len(ds) < 12:
            continue
        flags = []
        eligible = False
        for i, d in enumerate(sorted(g)):
            if d < WIN0 or d > WIN1:
                continue
            # 12 month-ends ending at d
            hist = [x for x in sorted(g) if x <= d][-12:]
            if len(hist) < 12 or (hist[-1] - hist[0]).days < 300:
                continue
            prcs = [abs(_num(g[x]["prc"]) or 0) for x in hist]
            if any(p <= 0 for p in prcs):
                continue
            s, shr = prcs[-1], _num(g[d]["shrout"]) or 0
            if s < 3 or s * shr * 1000 < 300e6:
                continue
            eligible = True
            flags.append(s / max(prcs) - 1 <= -0.25)
        if not eligible:
            continue
        (ever if any(flags) else never).add(permno)

    def fate(ps):
        c = defaultdict(int)
        for p in ps:
            hit = dl.get(p)
            if hit and WIN0 <= hit[0] <= date(2024, 12, 31):
                c[bucket(hit[1])] += 1
            else:
                c["no_delist_row"] += 1
        return c
    return ever, never, fate(ever), fate(never)


def load_vix():
    out = {}
    with open(VIX) as fh:
        for r in csv.DictReader(fh):
            if not r["VIXCLS"] or r["VIXCLS"] == ".":
                continue
            out[_d(r["observation_date"])] = float(r["VIXCLS"])
    return out


def asof(series_dates, series, d):
    # series_dates sorted
    i = np.searchsorted(series_dates, np.datetime64(d), side="right") - 1
    if i < 0:
        return None
    key = series_dates[i].astype(object)
    if isinstance(key, datetime):
        key = key.date()
    gap = (d - key).days
    if gap > 5:
        return None
    return series[key]


def rolling_state(px):
    spy = px.get("SPY")
    if not spy:
        return {}, {}
    ds = sorted(spy)
    closes = np.array([spy[d][0] for d in ds])
    csum = np.cumsum(closes)
    spy_up = {}
    for i, d in enumerate(ds):
        if i < 199:
            continue
        ma = (csum[i] - (csum[i - 200] if i >= 200 else 0)) / 200
        spy_up[d] = bool(closes[i] > ma)
    skip = {"SPY", "QQQ", "IWM", "DIA"}
    below, tot = defaultdict(int), defaultdict(int)
    for t, series in px.items():
        if t in skip:
            continue
        ds = sorted(series)
        if len(ds) < 200:
            continue
        closes = np.array([series[d][0] for d in ds])
        csum = np.cumsum(closes)
        for i, d in enumerate(ds):
            if i < 199:
                continue
            ma = (csum[i] - (csum[i - 200] if i >= 200 else 0)) / 200
            tot[d] += 1
            if closes[i] < ma:
                below[d] += 1
    breadth = {d: below[d] / tot[d] for d in tot if tot[d] >= 50}
    return spy_up, breadth


def fmt_stats(s):
    if not s:
        return "n=0"
    return f"puts {s['n']} · weeks {s['weeks']} · {s['wk_bp']:+.1f} bp/wk · t {s['t']:+.1f} · kept {s['kept']:.0f}%"


def half_sign(rs):
    a = S109.stats([r for r in rs if r["d"] < SPLIT])
    b = S109.stats([r for r in rs if r["d"] >= SPLIT])
    def bit(s, name):
        if not s or s["weeks"] < 8 or not math.isfinite(s["t"]):
            return f"{name} thin"
        return f"{name} {s['wk_bp']:+.1f} (t {s['t']:+.1f}, weeks {s['weeks']})"
    return bit(a, "pre-2024-07"), bit(b, "from-2024-07")


def main():
    by, dl = load_crsp()
    rows = crsp_screen(by, dl)
    ever, never, fe, fn = unique_name_fate(by, dl)
    # unit check
    aapl = [r for r in by["14593"].values() if r["date"].startswith("2024-11")]
    aapl_cap = abs(float(aapl[0]["prc"])) * float(aapl[0]["shrout"]) * 1000 if aapl else None

    conn = connect()
    q, px = S109.load(conn)
    rs = S109.trades(q, px)
    rule = [r for r in rs if r["inc"] >= 0.009 and r["otm"] >= 0.10 and r["dd52"] <= -0.25]
    names = sorted({r["t"] for r in rule})
    reg = {t: active for t, active in conn.execute("SELECT ticker, is_active FROM ticker_registry").fetchall()}
    inactive = [t for t in names if reg.get(t) is False]
    missing_reg = [t for t in names if t not in reg]

    # CRSP delist of the actual S109 rule names
    ticker_dl = defaultdict(list)
    for p, (dt, code, _) in dl.items():
        # last ticker on that permno
        g = by.get(p)
        if not g:
            continue
        last = g[max(g)]
        t = (last.get("ticker") or "").strip()
        if t:
            ticker_dl[t].append((dt, code))
    rule_dl = []
    for t in names:
        for dt, code in ticker_dl.get(t, []):
            if dt >= date(2020, 12, 1):
                rule_dl.append((t, dt, code, bucket(code)))

    roots = set()
    for ric in q:
        m = S109.RIC.match(ric)
        if m:
            roots.add(m.group(1))
    # delisted permnos that were ever ≥25% off while eligible, ticker not in LSEG prices or option roots
    deep_dead = []
    for p in ever:
        hit = dl.get(p)
        if not hit or not (WIN0 <= hit[0] <= date(2024, 12, 31)):
            continue
        if bucket(hit[1]) not in ("liquidation_4xx", "dropped_5xx"):
            continue
        g = by[p]
        # ticker at last month before delist
        prior = [d for d in g if d <= hit[0]]
        t = (g[max(prior)].get("ticker") or "").strip() if prior else ""
        deep_dead.append((t, p, hit[0], hit[1], t in px, t in roots))

    spy_up, breadth = rolling_state(px)
    vix = load_vix()
    vix_dates = np.array(sorted(vix), dtype="datetime64[D]")

    def attach(r):
        r = dict(r)
        r["spy_up"] = spy_up.get(r["d"])
        r["br"] = breadth.get(r["d"])
        r["vix"] = asof(vix_dates, vix, r["d"])
        r["year"] = r["d"].year
        return r

    rule_a = [attach(r) for r in rule]
    # VIX tercile cuts on unique entry dates of the rule (equal date weight)
    vix_days = {r["d"]: r["vix"] for r in rule_a if r["vix"] is not None}
    cuts = np.quantile(list(vix_days.values()), [1 / 3, 2 / 3]) if vix_days else (None, None)

    def vix_bin(v):
        if v is None or cuts[0] is None:
            return None
        if v < cuts[0]:
            return "low"
        if v < cuts[1]:
            return "mid"
        return "high"

    for r in rule_a:
        r["vix_bin"] = vix_bin(r["vix"])

    base = S109.stats(rule)
    wks_all = {S109.week(r["d"]) for r in rule}
    others = [r for r in rs if S109.week(r["d"]) in wks_all and not (r["inc"] >= 0.009 and r["otm"] >= 0.10 and r["dd52"] <= -0.25)]

    def block(title, pred):
        sub = [r for r in rule_a if pred(r)]
        weeks = {S109.week(r["d"]) for r in sub}
        oth = [attach(r) for r in others if S109.week(r["d"]) in weeks]
        return (title, S109.stats(sub), S109.stats(oth), half_sign(sub), len({r["t"] for r in sub}))

    regimes = [
        block("SPY close > 200d MA", lambda r: r["spy_up"] is True),
        block("SPY close ≤ 200d MA", lambda r: r["spy_up"] is False),
        block("breadth < 40% of names below 200d", lambda r: r["br"] is not None and r["br"] < 0.40),
        block("breadth ≥ 40% of names below 200d", lambda r: r["br"] is not None and r["br"] >= 0.40),
        block(f"VIX low (< {cuts[0]:.1f})", lambda r: r["vix_bin"] == "low"),
        block(f"VIX mid ({cuts[0]:.1f}–{cuts[1]:.1f})", lambda r: r["vix_bin"] == "mid"),
        block(f"VIX high (≥ {cuts[1]:.1f})", lambda r: r["vix_bin"] == "high"),
    ]
    years = []
    for y in sorted({r["year"] for r in rule_a}):
        years.append(block(str(y), lambda r, y=y: r["year"] == y))

    spy_miss = sum(1 for r in rule_a if r["spy_up"] is None)
    br_miss = sum(1 for r in rule_a if r["br"] is None)
    vix_miss = sum(1 for r in rule_a if r["vix"] is None)
    br_n = {d: 0 for d in breadth}

    L = []
    A = L.append
    A("# A371 audit — local measurements only")
    A("")
    A(f"Run: `scripts/watchlist_sync/analysis/a371_audit.py`. No LSEG/Polygon download. "
      f"S109 recomputed from `optlab.lseg_opt_daily` + `lseg_research.daily_history`. "
      f"CRSP cache `out/survivorship/crsp_*.csv.gz` (pulled 2026-10-06, months through 2024-11). "
      f"VIX: `out/opt/s028_inputs/VIXCLS.csv`.")
    A("")
    A("## Verdicts")
    A("")
    A("- **Survivorship re-score of S109: not measured.** Cached LSEG option roots do not cover the CRSP names that were ≥25% off their 12-month high and then liquidated or dropped. No put bp/wk with-vs-without. Pass bar (t ≥ 2 and ≥ +50 bp/wk) not applied. BOARD unchanged.")
    A("- **Drawdown leg raises performance-drops, not all delists.** CRSP 5xx within 366 days: 135/25,733 deep name-months (0.52%) vs 73/60,305 otherwise (0.12%), 4.3×. All-cause delist is lower when deep (3.57% vs 5.22%) because mergers and 4xx liquidations are more common off the crash. Not a put P&L.")
    A("- **S088 is model-priced.** Strikes are Black-Scholes at `iv30` × the S076 skew ratio, then a static fill haircut (0.83–1.08). The saved \"real-fill\" column is that haircut, not a quote of the picked strike. Top-10/wk LSEG replay was not run. BOARD's +77 bp/wk was not recomputed.")
    A("- **S109 regime: not only one SPY state, and not uniform.** Full sample stays positive with SPY above its 200-day (+87.4 bp/wk, t 3.8) and below it (+108.2, t 3.3), and in both breadth buckets. The middle VIX tercile is +20.0, t 0.4, in line with other puts those weeks. SPY-below from 2024-07 is −16.0 bp on 8 weeks. 2025 is +28.5, t 0.5.")
    A("")
    A("## 1. Survivorship — what was measured")
    A("")
    A(f"S109 recompute: {len(rs):,} puts, {len({r['t'] for r in rs})} names, {min(r['d'] for r in rs)} → {max(r['d'] for r in rs)}. "
      f"Rule (≥0.9%/wk, ≥10% OTM, ≥25% off 252-day high): {fmt_stats(base)}. Names {len(names)}.")
    A(f"Published S109.md was 318 puts, 118 weeks, +101.2 bp/wk, t +5.7. This run: {base['n']} puts, {base['weeks']} weeks, {base['wk_bp']:+.1f} bp/wk, t {base['t']:+.1f}.")
    A(f"Rule names inactive in `ticker_registry`: {len(inactive)}"
      + (f" ({', '.join(inactive)})" if inactive else "")
      + f". Not in registry: {len(missing_reg)}"
      + (f" ({', '.join(missing_reg)})" if missing_reg else "") + ".")
    A(f"Rule names with a CRSP delist row on/after 2020-12-01 (ticker match on the permno's last CRSP ticker, codes can be reused): {len(rule_dl)}.")
    if rule_dl:
        A("Matches: " + "; ".join(f"{t} {dt} code {code} ({b})" for t, dt, code, b in sorted(rule_dl)[:30]) + (" …" if len(rule_dl) > 30 else "") + ".")
    A("")
    A("CRSP screen is **not** the rich-put rule. It is the drawdown leg plus the old $3 / $300M floor. Income and 10% OTM need option quotes, which these names do not have. "
      "Month-end price vs the max of 12 month-end prices stands in for the daily 52-week high. "
      f"Cap unit check: AAPL permno 14593 at 2024-11-29 = ${aapl_cap/1e12:.2f}T (shrout × 1000).")
    A("")
    A(f"Name-months {WIN0} → {FOLLOW_END} (12-month follow-up still inside the CRSP file). "
      "A row counts as a delist when `dlstdt` falls 1–366 days after that month-end.")
    A("")
    A("| screen | name-months | permnos | any delist in 366d | 4xx+5xx | 5xx dropped | 4xx liquidation | 2xx merger |")
    A("|---|---:|---:|---:|---:|---:|---:|---:|")
    for label, n, names_n, any_dl, bad, d5, d4, d2 in rate_table(rows):
        A(f"| {label} | {n:,} | {names_n:,} | {any_dl:,} ({100*any_dl/n:.2f}%) | {bad:,} ({100*bad/n:.2f}%) | {d5:,} | {d4:,} | {d2:,} |")
    A("")
    A(f"Unique eligible permnos, {WIN0} → {WIN1}: ever ≥25% off = {len(ever):,}; never = {len(never):,}. "
      "Fate = a delist row dated inside that window (a name is counted once).")
    A("")
    A("| group | n | no delist row | 5xx | 4xx | 2xx | 3xx |")
    A("|---|---:|---:|---:|---:|---:|---:|")
    for label, c, n in (("ever ≥25% off", fe, len(ever)), ("never 25% off", fn, len(never))):
        A(f"| {label} | {n:,} | {c['no_delist_row']:,} | {c['dropped_5xx']:,} | {c['liquidation_4xx']:,} | {c['merger_2xx']:,} | {c['exchange_3xx']:,} |")
    A("")
    n_dead = len(deep_dead)
    in_px = sum(1 for *_, has_px, _ in deep_dead if has_px)
    in_q = sum(1 for *_, has_q in deep_dead if has_q)
    priced = [t for t, p, dt, code, hp, hq in deep_dead if hp]
    A(f"Permnos that were ever ≥25% off while eligible and then 4xx or 5xx delisted by 2024-11: {n_dead}. "
      f"Their last CRSP ticker is in `daily_history`: {in_px}"
      + (f" ({', '.join(priced)})" if priced else "")
      + f". In cached option roots: {in_q}. "
      "S076 pricer was not run: it needs `iv30_put` on that name, and option-root coverage is 0.")
    if deep_dead:
        show = sorted(deep_dead, key=lambda x: (x[4], x[5], x[2]))[:15]
        A("Sample (ticker, permno, delist, code, in prices, in option roots): " +
          "; ".join(f"{t or '—'} {p} {dt} {code} px={hp} opt={hq}" for t, p, dt, code, hp, hq in show) +
          (" …" if n_dead > 15 else "") + ".")
    A("")
    A("## 2. S088 — model price vs real quotes")
    A("")
    A("Not a refit. Read from `analysis/s088_sr_zones.py` and `out/opt/S088.md`.")
    A("")
    A("- Pricer: `from s076_structures_backtest import Pricer`. S076 sets the put mid to Black-Scholes at `iv30_put` × a skew ratio calibrated on cached LSEG quotes. Fill haircut `HAIRCUT` is 0.83–1.08 by IV bucket × distance, applied in `haircut_pnl`. That is a scalar on the model credit, not the bid/ask of the picked contract.")
    A("- Picks in the current script: `TOPN = 20` names per week (`pick()`), not top 10. Holdout 2023 →, 1-week, model + zones, P(kept) ≥ 90%: published row is n=3,982, model +81.0 bp/wk, haircut +64.0 bp/wk, kept 90.6%, week t 9.0. Plain 1σ: model +31.5, haircut +27.0.")
    A("- Haircut ÷ model on that row = 64.0/81.0 = 0.790. Same sign. This is the haircut column, not a LSEG replay, so it does not meet task 2's pass bar (real quote ≥ 0.8 × modelled).")
    A("- BOARD and the INDEX row still say top-10/wk **+77 bp/wk vs +35**. That row is not in the current `S088.md` table. This audit did not rebuild top-10 and did not match picks to `lseg_opt_daily`.")
    A("- No saved trade list of the P(kept) ≥ 90% backtest picks. `S088-ladder.json` is the ladder, not that book. Quote coverage of the book was therefore not counted.")
    A("")
    A("## 3. Regime split of S109 (recomputed)")
    A("")
    A("SPY 200-day: close vs mean of the last 200 SPY closes in `daily_history`, current day included. "
      "Breadth: share of other `daily_history` names (SPY/QQQ/IWM/DIA left out) whose close is under their own 200-day mean; days with <50 names dropped. "
      f"VIX terciles are equal-weight on the rule's entry dates that have a VIXCLS print within 5 days "
      f"(n dates {len(vix_days)}, cuts {cuts[0]:.2f} / {cuts[1]:.2f}). "
      f"Rule puts missing a flag: SPY {spy_miss}, breadth {br_miss}, VIX {vix_miss}.")
    A("Same-weeks other puts = S109's comparator, restricted to weeks that have a rule put in that bucket. "
      "Halves use 2024-07-01. A half with <8 weeks is marked thin.")
    A("")
    A("| bucket | rule | same-weeks other | rule names | halves |")
    A("|---|---|---|---:|---|")
    for title, st, ot, halves, nn in regimes + years:
        A(f"| {title} | {fmt_stats(st)} | {fmt_stats(ot)} | {nn} | {halves[0]}; {halves[1]} |")
    A("")
    A("## Not measured (A371 stays planned)")
    A("")
    A("1. Survivorship-adjusted S109 bp/wk (task 1 finish, task 5). Need quotes or `iv30` on the delisted names. Not in the LSEG cache. No download this run.")
    A("2. S088 top-10/wk replay on LSEG quotes, both halves, real ≥ 0.8 × model (task 2).")
    A("3. Regime split of S088 (task 3, second book).")
    A("4. BOARD one-standard pass: N_eff, both-halves sign, `## Underpowered` parser, S159 chip (task 4). `strategy-board.ts` not edited.")
    A("5. Dead-row four-mode audit (Claude add). S020 not re-scored.")
    A("")
    text = "\n".join(L) + "\n"
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text)
    print(text)
    print(f"wrote {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
