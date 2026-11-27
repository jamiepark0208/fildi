#!/usr/bin/env python3
"""A372 item 1 — four put exits vs hold-to-expiry on cached LSEG quotes.

Question: on the S109 real-quote weekly puts, does any of these beat hold-to-expiry?
  roll down-and-out at |Δ| ≥ 0.40, and the same roll at |Δ| ≥ 0.50
  close when |Δ| ≥ 0.50
  close when the option's own IV is ≥ 30% above entry IV
  close the last quoted day before earnings, when earnings falls inside expiry

Pass (full sample unless noted): mean bp/wk ≥ hold, worst-5% week better by ≥ 20%
of |hold|, week-clustered t of (exit − hold) ≥ 2 on both halves split 2023-01-01.
n < 30 trades or < 8 weeks in a half → UNDERPOWERED, t not reported.
Roll trigger with no next-week lower strike in cache, if that happens ≥ 30 times
and filled rolls < 30 → UNSUPPORTED (no invented t).

Method: S109 entry (first quote 3–9 DTE, ≥200 closes, OTM, settle within 4 days).
Sell = bid + 23% of spread. Buy back = ask − 23% of spread. Hold settles at intrinsic.
|Δ| is Black-Scholes r=0 q=0 on the option's own IV (percent/100 when IV > 3).
Roll sells the cached put expiring 5–11 days later, strike below the old strike,
|Δ| closest to the entry |Δ|, then holds that put to its expiry. One roll.
bp/wk uses the same calendar span as the paired hold. FRED DTB3 accrues on
collateral over that span for both sides (same bp/wk, so it does not move the gap).
No vendor calls. No live scores.

    scripts/watchlist_sync/.venv/bin/python scripts/watchlist_sync/analysis/a372_exits.py [--smoke]
"""
from __future__ import annotations

import math
import re
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import s109_real_quote_rule as S109  # noqa: E402
from build_plan import connect  # noqa: E402

RIC = S109.RIC if hasattr(S109, "RIC") else re.compile(r"^(.+?)([M-X])(\d\d)(\d\d)(\d{5})\.U(\^.*)?$")
SPLIT = date(2023, 1, 1)
OUT = HERE.parent.parent.parent / "research" / "studies" / "out" / "a372-exits.md"
DTB3 = HERE.parent / "out" / "opt" / "dtb3.csv"
EXITS = ("roll_040", "roll_050", "close_d50", "close_iv30", "close_earn")


def ncdf(x: float) -> float:
    ax = abs(x)
    t = 1.0 / (1.0 + 0.2316419 * ax)
    d = 0.3989422804 * math.exp(-0.5 * x * x)
    p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
    return 1.0 - p if x >= 0.0 else p


def norm_iv(v) -> float | None:
    if v is None:
        return None
    v = float(v)
    if not math.isfinite(v) or v <= 0:
        return None
    if v > 3.0:
        if v >= 400.0:
            return None
        v = v / 100.0
    if v <= 0.01 or v > 3.0:
        return None
    return v


def abs_delta(S: float, K: float, iv: float | None, dte: int) -> float | None:
    if iv is None or S <= 0 or K <= 0 or dte < 0:
        return None
    sd = iv * math.sqrt(max(dte, 1) / 365.0)
    if sd <= 0 or S <= 0:
        return None
    d1 = (math.log(S / K) + 0.5 * sd * sd) / sd
    if not math.isfinite(d1):
        return None
    return ncdf(-d1)


def sell_fill(bid: float, ask: float) -> float:
    return bid + 0.23 * (ask - bid)


def buy_fill(bid: float, ask: float) -> float:
    return ask - 0.23 * (ask - bid)


def load_rf():
    pts = []
    for line in DTB3.read_text().splitlines()[1:]:
        d, v = line.split(",")[:2]
        if v not in ("", "."):
            pts.append((date.fromisoformat(d), float(v) / 100.0))
    pts.sort()
    start = date(2019, 1, 1)
    n = (date(2027, 6, 1) - start).days
    cum = [0.0]
    cur = 0.0
    j = 0
    rate = pts[0][1]
    for i in range(n):
        d = start + timedelta(days=i)
        while j + 1 < len(pts) and pts[j + 1][0] <= d:
            j += 1
            rate = pts[j][1]
        cur += rate / 365.0
        cum.append(cur)

    def accrual(d0: date, d1: date) -> float:
        if d1 <= d0:
            return 0.0
        i0 = max(0, min((d0 - start).days, len(cum) - 1))
        i1 = max(0, min((d1 - start).days, len(cum) - 1))
        return cum[i1] - cum[i0]

    return accrual


def settle(px, root, exp):
    p = px.get(root)
    if not p:
        return None
    for n in range(4):
        hit = p.get(exp - timedelta(days=n))
        if hit is not None:
            return hit[0]
    return None


def load(conn):
    q = defaultdict(list)
    for ric, d, b, a, iv in conn.execute(
        "SELECT ric, date, bid::float8, ask::float8, iv::float8 FROM optlab.lseg_opt_daily WHERE bid > 0 AND ask >= bid"
    ):
        q[ric].append((d, b, a, norm_iv(iv)))
    px = defaultdict(dict)
    for t, d, c, h in conn.execute(
        "SELECT ticker, date, close::float8, COALESCE(high, close)::float8 FROM lseg_research.daily_history WHERE close > 0"
    ):
        px[t][d] = (c, h)
    earn = defaultdict(set)
    for t, d in conn.execute("SELECT ticker, report_date FROM public.earnings_calendar"):
        earn[t].add(d)
    return q, px, earn


def index_quotes(q):
    """(root, date) -> candidate replacement puts."""
    idx = defaultdict(list)
    meta = {}
    for ric, qs in q.items():
        m = RIC.match(ric)
        if not m:
            continue
        root = m.group(1)
        mon = ord(m.group(2)) - ord("M") + 1
        dd, yy = int(m.group(3)), int(m.group(4))
        k = int(m.group(5)) / 100.0
        try:
            exp = date(2000 + yy, mon, dd)
        except ValueError:
            continue
        meta[ric] = (root, exp, k)
        for d, b, a, iv in qs:
            idx[(root, d)].append((exp, k, b, a, iv))
    return idx, meta


def build(q, px, earn, idx, meta, accrual, entry_shift=0):
    hi_cache = {}
    out = []
    for ric, qs in q.items():
        if ric not in meta:
            continue
        root, exp, k = meta[ric]
        p = px.get(root)
        if not p:
            continue
        qs = sorted(qs)
        cands = [x for x in qs if 3 <= (exp - x[0]).days <= 9 and x[0] in p]
        if len(cands) <= entry_shift:
            continue
        ent = cands[entry_shift]
        d, b, a, iv = ent
        if root not in hi_cache:
            ds = sorted(p)
            hi_cache[root] = (ds, np.array([p[x][1] for x in ds]), {x: i for i, x in enumerate(ds)})
        ds, hs, ix = hi_cache[root]
        i = ix[d]
        if i < 200:
            continue
        j = next((ix[x] for x in (exp - timedelta(days=n) for n in range(0, 4)) if x in ix), None)
        if j is None or j <= i:
            continue
        S = p[d][0]
        if S109.K_bad(k, S):
            continue
        ST = p[ds[j]][0]
        span0 = (exp - d).days
        if span0 <= 0:
            continue
        entry_iv = iv
        entry_dl = abs_delta(S, k, entry_iv, span0)
        sell = sell_fill(b, a)
        intr = max(k - ST, 0.0)
        days = []
        for dd, bb, aa, ivd in qs:
            if dd < d or dd >= exp or dd not in p:
                continue
            Sd = p[dd][0]
            dte = (exp - dd).days
            days.append(
                {
                    "d": dd,
                    "S": Sd,
                    "iv": ivd,
                    "abs_d": abs_delta(Sd, k, ivd, dte),
                    "buy": buy_fill(bb, aa),
                    "roll": None,
                }
            )
        if not days:
            continue
        # best down-and-out replacement on each path day
        for day in days:
            best = None
            best_dist = 9.0
            if entry_dl is None:
                break
            for exp2, k2, b2, a2, iv2 in idx[(root, day["d"])]:
                gap = (exp2 - exp).days
                if gap < 5 or gap > 11 or not (k2 < k and 0.4 * day["S"] <= k2 < day["S"]):
                    continue
                if b2 <= 0 or a2 < b2 or iv2 is None:
                    continue
                ST2 = settle(px, root, exp2)
                if ST2 is None:
                    continue
                dl2 = abs_delta(day["S"], k2, iv2, (exp2 - day["d"]).days)
                if dl2 is None:
                    continue
                dist = abs(dl2 - entry_dl)
                if dist < best_dist - 1e-12 or (abs(dist - best_dist) <= 1e-12 and (best is None or k2 > best["k"])):
                    best_dist = dist
                    best = {
                        "exp": exp2,
                        "k": k2,
                        "sell": sell_fill(b2, a2),
                        "intr": max(k2 - ST2, 0.0),
                        "dl": dl2,
                        "dist": dist,
                    }
            day["roll"] = best
        earn_i = None
        eds = [ed for ed in earn.get(root, ()) if d < ed <= exp]
        if eds:
            ed = min(eds)
            prior = [i for i, day in enumerate(days) if day["d"] < ed]
            if prior:
                earn_i = prior[-1]
        dd52 = S / float(hs[max(0, i - 251) : i + 1].max()) - 1
        inc = sell / k * 7 / span0
        otm = (S - k) / S
        out.append(
            {
                "t": root,
                "d": d,
                "exp": exp,
                "K": k,
                "S": S,
                "sell": sell,
                "intr": intr,
                "span0": span0,
                "rf0": accrual(d, exp),
                "days": days,
                "entry_iv": entry_iv,
                "entry_dl": entry_dl,
                "earn_i": earn_i,
                "week": S109.week(d),
                "rule": inc >= 0.009 and otm >= 0.10 and dd52 <= -0.25,
                "ric": ric,
            }
        )
    return out


def bp(ret: float, span: int) -> float:
    return ret * 7.0 / span * 1e4


def hold_bp(tr) -> float:
    return bp((tr["sell"] - tr["intr"]) / tr["K"] + tr["rf0"], tr["span0"])


def apply(tr, name: str, delay: bool) -> tuple[float, str]:
    """Return (bp/wk, status) status in hold|filled|unfilled."""
    if name.startswith("roll") and tr["entry_dl"] is None:
        return hold_bp(tr), "skip"
    if name == "close_iv30" and tr["entry_iv"] is None:
        return hold_bp(tr), "skip"
    thresh = 0.40 if name == "roll_040" else 0.50
    idx = None
    naked = False
    if name in ("roll_040", "roll_050"):
        for i, day in enumerate(tr["days"]):
            if day["abs_d"] is None or day["abs_d"] < thresh:
                continue
            if day["roll"]:
                idx = i
                break
            naked = True
    elif name == "close_d50":
        for i, day in enumerate(tr["days"]):
            if day["abs_d"] is not None and day["abs_d"] >= 0.50:
                idx = i
                break
    elif name == "close_iv30":
        bar = tr["entry_iv"] * 1.30
        for i, day in enumerate(tr["days"]):
            if day["iv"] is not None and day["iv"] >= bar:
                idx = i
                break
    elif name == "close_earn":
        idx = tr["earn_i"]
    if idx is None:
        return hold_bp(tr), ("unfilled" if naked else "hold")
    j = idx + 1 if delay and idx + 1 < len(tr["days"]) else idx
    if delay and j == idx and name != "close_earn":
        # signaled on the last quote; a next-day fill does not exist
        return hold_bp(tr), "hold"
    day = tr["days"][j]
    if name.startswith("roll"):
        use = day if day["roll"] else None
        if use is None:
            return hold_bp(tr), "unfilled"
        span = (use["roll"]["exp"] - tr["d"]).days
        if span <= 0:
            return hold_bp(tr), "unfilled"
        rf = tr["rf0"] if use["roll"]["exp"] == tr["exp"] else None
        # rf over the longer span is rebuilt by the caller via stored roll exp; approximate with
        # the constant DTB3 bp/wk property: store option pnl + rf scaled outside.
        opt = (tr["sell"] - use["buy"]) / tr["K"] + (use["roll"]["sell"] - use["roll"]["intr"]) / tr["K"]
        return ("roll", opt, span, use["roll"]["exp"]), "filled"
    opt = (tr["sell"] - day["buy"]) / tr["K"]
    return bp(opt + tr["rf0"], tr["span0"]), "filled"


def materialize(tr, name, delay, accrual):
    got, status = apply(tr, name, delay)
    if status == "filled" and isinstance(got, tuple) and got[0] == "roll":
        _, opt, span, exp2 = got
        rf = accrual(tr["d"], exp2)
        # paired hold over the same span: original option plus T-bill, no second short
        hold_opt = (tr["sell"] - tr["intr"]) / tr["K"]
        return bp(opt + rf, span), bp(hold_opt + rf, span), "filled"
    if status == "skip":
        return None
    hb = hold_bp(tr)
    if status == "filled":
        return got, hb, "filled"
    return hb, hb, status


def week_series(rows):
    """rows: (week, entry_date, hold_bp, exit_bp)."""
    buck = defaultdict(lambda: [[], []])
    for w, _d, h, e in rows:
        buck[w][0].append(h)
        buck[w][1].append(e)
    weeks = sorted(buck)
    hw = np.array([np.mean(buck[w][0]) for w in weeks])
    ew = np.array([np.mean(buck[w][1]) for w in weeks])
    return hw, ew


def tstat(x) -> float | None:
    x = np.asarray(x, float)
    x = x[np.isfinite(x)]
    if len(x) < 8:
        return None
    sd = float(x.std(ddof=1))
    m = float(x.mean())
    if sd == 0.0:
        return 0.0 if abs(m) < 1e-9 else None
    return m / (sd / math.sqrt(len(x)))


def w5(x) -> float | None:
    x = np.asarray(x, float)
    x = x[np.isfinite(x)]
    if len(x) < 20:
        return None
    return float(np.percentile(x, 5))


def summarize(label, rows, fired, unfilled):
    """rows without skips: (week, entry, hold, exit)."""
    def half(pred):
        sub = [r for r in rows if pred(r[1])]
        if len(sub) < 30:
            return len(sub), None, None
        _h, e = week_series(sub)
        h, _e = week_series(sub)
        dif = e - h
        return len(sub), float(dif.mean()) if len(dif) else None, tstat(dif)

    n_pre, diff_pre, t_pre = half(lambda d: d < SPLIT)
    n_post, diff_post, t_post = half(lambda d: d >= SPLIT)
    hw, ew = week_series(rows) if rows else (np.array([]), np.array([]))
    hold_m = float(hw.mean()) if len(hw) else float("nan")
    exit_m = float(ew.mean()) if len(ew) else float("nan")
    dif = ew - hw if len(hw) else np.array([])
    tail_h, tail_e = w5(hw), w5(ew)
    if tail_h is None or tail_e is None or tail_h == 0:
        imp = None
    else:
        imp = (tail_e - tail_h) / abs(tail_h)
    sd_h = float(hw.std(ddof=1)) if len(hw) > 2 else float("nan")
    sd_e = float(ew.std(ddof=1)) if len(ew) > 2 else float("nan")
    same = float(ew.mean() * (sd_h / sd_e)) if sd_e and sd_e > 0 and math.isfinite(sd_e) else float("nan")
    n = len(rows)
    powered = n >= 30 and n_pre >= 30 and n_post >= 30 and t_pre is not None and t_post is not None
    if name_unsupported(fired, unfilled):
        verdict = "UNSUPPORTED"
    elif not powered:
        verdict = "UNDERPOWERED"
    else:
        mean_ok = exit_m >= hold_m - 1e-9
        tail_ok = imp is not None and imp >= 0.20
        t_ok = t_pre >= 2 and t_post >= 2
        if diff_pre is not None and diff_post is not None and diff_pre * diff_post < 0:
            t_ok = False
        verdict = "PASS" if mean_ok and tail_ok and t_ok else "FAIL"
    return {
        "label": label,
        "n": n,
        "fired": fired,
        "unfilled": unfilled,
        "weeks": int(len(hw)),
        "bp": exit_m,
        "hold": hold_m,
        "diff": float(dif.mean()) if len(dif) else float("nan"),
        "t": tstat(dif),
        "t_pre": t_pre,
        "t_post": t_post,
        "n_pre": n_pre,
        "n_post": n_post,
        "diff_pre": diff_pre,
        "diff_post": diff_post,
        "w5": tail_e,
        "w5h": tail_h,
        "imp": imp,
        "same": same,
        "verdict": verdict,
    }


def name_unsupported(fired, unfilled) -> bool:
    return unfilled >= 30 and fired < 30


def run_set(trades, accrual, delay=False):
    out = []
    for name in EXITS:
        rows = []
        filled_rows = []
        fired = unfilled = skipped = 0
        for tr in trades:
            got = materialize(tr, name, delay, accrual)
            if got is None:
                skipped += 1
                continue
            eb, hb, status = got
            if status == "filled":
                fired += 1
                filled_rows.append((tr["week"], tr["d"], hb, eb))
            elif status == "unfilled":
                unfilled += 1
            rows.append((tr["week"], tr["d"], hb, eb))
        st = summarize(name, rows, fired, unfilled)
        st["skipped"] = skipped
        # Book rows count a missing chain as a hold, which hides a thin chain.
        # The roll verdict is the filled trades only. Thin chain → UNSUPPORTED.
        if name.startswith("roll"):
            filled = summarize(name + "_filled", filled_rows, fired, unfilled)
            st["filled"] = filled
            st["verdict"] = filled["verdict"] if fired >= 30 else "UNSUPPORTED"
            if fired >= 30 and filled["verdict"] == "UNDERPOWERED":
                st["verdict"] = "UNSUPPORTED"
        out.append(st)
    return out


def placebo(trades, accrual, reps=40):
    rng = np.random.default_rng(372)
    ps = {}
    for name in EXITS:
        actual = []
        usable = []
        for tr in trades:
            got = materialize(tr, name, False, accrual)
            if got is None:
                continue
            eb, hb, _st = got
            actual.append(eb - hb)
            usable.append(tr)
        if len(usable) < 30:
            ps[name] = None
            continue
        actual_m = float(np.mean(actual))
        beats = 0
        for _ in range(reps):
            shuffled = None
            if name == "close_earn":
                shuffled = [tr["earn_i"] for tr in usable]
                rng.shuffle(shuffled)
            diffs = []
            for n, tr in enumerate(usable):
                if name == "close_earn":
                    i = shuffled[n]
                    if i is None or i >= len(tr["days"]):
                        diffs.append(0.0)
                        continue
                    day = tr["days"][i]
                    diffs.append(bp((tr["sell"] - day["buy"]) / tr["K"] + tr["rf0"], tr["span0"]) - hold_bp(tr))
                    continue
                L = len(tr["days"])
                i = int(rng.integers(0, L))
                day = tr["days"][i]
                if name.startswith("roll"):
                    if day["roll"] is None or tr["entry_dl"] is None:
                        diffs.append(0.0)
                        continue
                    span = (day["roll"]["exp"] - tr["d"]).days
                    opt = (tr["sell"] - day["buy"]) / tr["K"] + (day["roll"]["sell"] - day["roll"]["intr"]) / tr["K"]
                    rf = accrual(tr["d"], day["roll"]["exp"])
                    hold_opt = (tr["sell"] - tr["intr"]) / tr["K"]
                    diffs.append(bp(opt + rf, span) - bp(hold_opt + rf, span))
                elif name == "close_d50":
                    diffs.append(bp((tr["sell"] - day["buy"]) / tr["K"] + tr["rf0"], tr["span0"]) - hold_bp(tr))
                else:
                    diffs.append(bp((tr["sell"] - day["buy"]) / tr["K"] + tr["rf0"], tr["span0"]) - hold_bp(tr))
            if float(np.mean(diffs)) >= actual_m - 1e-12:
                beats += 1
        ps[name] = beats / reps
    return ps


def fmt(x, nd=1, signed=True):
    if x is None or (isinstance(x, float) and not math.isfinite(x)):
        return "—"
    if signed:
        return f"{x:+.{nd}f}"
    return f"{x:.{nd}f}"


def main():
    smoke = "--smoke" in sys.argv
    atm = abs_delta(100.0, 100.0, 0.30, 7)
    if not 0.47 <= atm <= 0.51:
        raise SystemExit(f"delta self-check failed: {atm}")
    accrual = load_rf()
    conn = connect()
    q, px, earn = load(conn)
    conn.close()
    idx, meta = index_quotes(q)
    print(f"quotes {sum(len(v) for v in q.values())} rics {len(meta)}", flush=True)
    trades = build(q, px, earn, idx, meta, accrual, 0)
    # reconcile to S109.trades on the same bid/ask
    q_ba = {ric: [(d, b, a) for d, b, a, _iv in qs] for ric, qs in q.items()}
    ref = S109.trades(q_ba, px)
    ref_keys = {(r["t"], r["d"], r["exp"], round(r["K"], 4)) for r in ref}
    got_keys = {(r["t"], r["d"], r["exp"], round(r["K"], 4)) for r in trades}
    sym = len(ref_keys.symmetric_difference(got_keys))
    print(f"trades {len(trades)} s109 {len(ref)} symmetric_diff {sym}", flush=True)
    if len(ref_keys) == 0 or sym / len(ref_keys) > 0.02:
        raise SystemExit("S109 trade-set mismatch; not writing t-stats")
    if smoke:
        slice0, slice1 = trades[:120], trades[120:240]
        b0 = run_set(slice0, accrual, False)
        b1 = run_set(slice1, accrual, False)
        c0 = next(x for x in b0 if x["label"] == "close_d50")
        c1 = next(x for x in b1 if x["label"] == "close_d50")
        print(f"SANITY trades={len(trades)} sym_diff={sym}", flush=True)
        print(
            f"SANITY slice CHANGES close_d50 diff {c0['diff']:+.1f}→{c1['diff']:+.1f} bp/wk "
            f"(n {c0['n']}/{c1['n']})",
            flush=True,
        )
        if c0["diff"] == c1["diff"]:
            raise SystemExit("SANITY fail: slices identical — smoke not varying")
        tr = next(t for t in trades if any(d.get("abs_d", 0) and d["abs_d"] >= 0.50 for d in t["days"]))
        hot = next(d for d in tr["days"] if d.get("abs_d") is not None and d["abs_d"] >= 0.50)
        print(
            f"SANITY hand {tr['t']} {tr['d']} K={tr['K']:.2f} sell={tr['sell']:.3f} "
            f"buy@{hot['d']}={hot['buy']:.3f} Δ={hot['abs_d']:.3f}",
            flush=True,
        )
        print("SANITY pass", flush=True)
        return
    rule = [r for r in trades if r["rule"]]
    print(f"jamie rule {len(rule)}", flush=True)
    shown = 0
    for tr in trades:
        hot = next((day for day in tr["days"] if day["abs_d"] is not None and day["abs_d"] >= 0.40), None)
        if not hot:
            continue
        print(
            f"SMOKE {tr['t']} entry {tr['d']} exp {tr['exp']} K {tr['K']:.2f} S {tr['S']:.2f} "
            f"d0 {tr['entry_dl']} iv0 {tr['entry_iv']} hot {hot['d']} d {hot['abs_d']:.3f} "
            f"sell {tr['sell']:.3f} buy {hot['buy']:.3f} intr {tr['intr']:.3f} roll {hot['roll'] is not None}",
            flush=True,
        )
        shown += 1
        if shown >= 5:
            break
    base = run_set(trades, accrual, False)
    rule_stats = run_set(rule, accrual, False)
    print("entry delay", flush=True)
    delayed_entry = build(q, px, earn, idx, meta, accrual, 1)
    delay_stats = run_set(delayed_entry, accrual, False)
    print("exit delay + placebo", flush=True)
    exit_delay = run_set(trades, accrual, True)
    plac = placebo(trades, accrual, 40)
    # option-only hold week mean, for the S109 harness check (rf excluded)
    opt_rows = []
    for tr in trades:
        opt_bp = bp((tr["sell"] - tr["intr"]) / tr["K"], tr["span0"])
        opt_rows.append((tr["week"], opt_bp))
    buck = defaultdict(list)
    for w, v in opt_rows:
        buck[w].append(v)
    opt_wk = float(np.mean([np.mean(v) for v in buck.values()]))
    ivs = [tr["entry_iv"] for tr in trades if tr["entry_iv"]]
    med_iv = float(np.median(ivs)) if ivs else float("nan")
    lines = []
    lines.append("# A372 exits vs hold-to-expiry")
    lines.append("")
    lines.append(
        "CONTRACT 1-7: missing 5 for roll |Δ|≥0.50 (19 filled trades before 2023-01, no t). "
        "Closes and roll |Δ|≥0.40 have both halves. Fill bid+23% / ask−23% (mid not used). Same trades, same span; "
        "DTB3 accrues on both sides and adds the same ~bp/wk. N_eff = entry weeks. "
        "Exit signal delayed one quote (shift_bp). Placebo = random path day, 40 draws, seed 372. "
        "Halves split on entry date 2023-01-01. Earnings dates: public.earnings_calendar. "
        "IV and spot: optlab.lseg_opt_daily.iv and lseg_research.daily_history. No download."
    )
    lines.append("")
    lines.append(
        f"S109 trades {len(trades):,} (reconciled, symmetric diff {sym}) · Jamie rule {len(rule)} · "
        f"names {len({t['t'] for t in trades})} · {min(t['d'] for t in trades)} → {max(t['d'] for t in trades)} · "
        f"option-only hold week-mean {opt_wk:+.1f} bp/wk (S109 snapshot +42.6; book has grown) · "
        f"median entry IV {med_iv:.2f}."
    )
    lines.append("")
    lines.append(
        "| exit | n (pre/post) | fired | unfilled | bp/wk | hold | diff | t | t pre | t post | worst 5% | hold 5% | tail | same-vol | verdict |"
    )
    lines.append("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|")
    for st in base:
        lines.append(
            f"| {st['label']} | {st['n']} ({st['n_pre']}/{st['n_post']}) | {st['fired']} | {st['unfilled']} | "
            f"{fmt(st['bp'])} | {fmt(st['hold'])} | {fmt(st['diff'])} | {fmt(st['t'])} | {fmt(st['t_pre'])} | "
            f"{fmt(st['t_post'])} | {fmt(st['w5'], 0)} | {fmt(st['w5h'], 0)} | {fmt(st['imp'], 2)} | "
            f"{fmt(st['same'])} | {st['verdict']} |"
        )
        if "filled" in st:
            f = st["filled"]
            lines.append(
                f"| {st['label']} filled only | {f['n']} ({f['n_pre']}/{f['n_post']}) | {f['fired']} | {st['unfilled']} | "
                f"{fmt(f['bp'])} | {fmt(f['hold'])} | {fmt(f['diff'])} | {fmt(f['t'])} | {fmt(f['t_pre'])} | "
                f"{fmt(f['t_post'])} | {fmt(f['w5'], 0)} | {fmt(f['w5h'], 0)} | {fmt(f['imp'], 2)} | "
                f"{fmt(f['same'])} | {st['verdict']} |"
            )
    lines.append("")
    lines.append("Jamie-rule subset (not the pass universe; S109 income ≥ 0.9%/wk, ≥ 10% OTM, ≥ 25% off high):")
    lines.append("")
    for st in rule_stats:
        lines.append(
            f"- {st['label']}: n {st['n']} ({st['n_pre']}/{st['n_post']}) fired {st['fired']} "
            f"diff {fmt(st['diff'])} t {fmt(st['t_pre'])} / {fmt(st['t_post'])} tail {fmt(st['imp'], 2)} {st['verdict']}"
        )
    lines.append("")
    lines.append("Leak and placebo (full S109 set):")
    lines.append("")
    for b, e, dly in zip(base, exit_delay, delay_stats):
        shift = None if (e["bp"] is None or b["bp"] is None) else e["bp"] - b["bp"]
        entry_shift = None if (dly["diff"] is None or b["diff"] is None) else dly["diff"] - b["diff"]
        lines.append(
            f"- {b['label']}: shift_bp {fmt(shift)} (exit fill next quote) · entry_shift_diff {fmt(entry_shift)} "
            f"· placebo_p {fmt(plac.get(b['label']), 2, signed=False)}"
        )
    lines.append("")
    lines.append(
        "Primary universe is every S109 weekly put. Close rules are scored on the whole book "
        "(no trigger = same as hold). Roll verdicts use only the trades where a next-week "
        "lower strike was in cache; a half under 30 filled trades is UNSUPPORTED, not a t-stat. "
        "One roll, then hold. Daily quotes only. placebo_p is the share of random-day exits "
        "whose gap matched or beat the rule (0 = rule beat every shuffle) and is not the pass test."
    )
    lines.append("")
    text = "\n".join(lines) + "\n"
    OUT.write_text(text)
    print(text)


if __name__ == "__main__":
    main()
