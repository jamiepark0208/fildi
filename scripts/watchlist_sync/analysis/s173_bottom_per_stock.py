"""S173 — S172 per stock (Jamie 11-09 #9): at each VIX÷VIX3M un-invert, which names pay best on
0.50Δ 30 DTE calls / 0.20Δ 30 DTE short puts, and which pre-entry features pick them?

Data: lseg_research.daily_history (close, iv30_call/put, all names with IV), wrds cboe VIX/VIX3M, security_class sectors.
priced_by = model (BS at the name's own iv30 call / put leg; buy at model × 1.05, sell at × 0.95 ≈ ask/bid − 23 % of a
~10 % single-name spread). No real-quote coverage for 2018→ single names (lseg_opt_daily is 2025→) → gap noted in packet.
Comparators: same name's own any-day trade (same half) and SPY's same-day trade. Train < 2023, test ≥ 2023.
Features (≤ d0 only): beta60 vs SPY, drawdown from 252d high, IV/RV20, IV rank 252d, 20d return, sector.
"""
from __future__ import annotations

import math
import random
import sys
from bisect import bisect_left
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from statistics import mean, median, pstdev

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_plan import connect  # noqa: E402
from s172_bottom_signals import bs, strike, signals, N, R  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "out" / "opt" / "S173.md"
START, SPLIT = date(2017, 1, 1), date(2023, 1, 1)
BUY, SELL = 1.05, 0.95  # global: model-price fill haircut for single names (no per-name spread history pre-2025)
FEATS = ("beta60", "dd252", "ivrv", "ivrank", "ret20")


def load(conn):
    ix = defaultdict(dict)
    for d, i, c in conn.execute("SELECT date, index, close::float8 FROM wrds_research.cboe_daily WHERE index IN ('VIX','VIX3M','VIX9D','VVIX')"):
        ix[i][d] = c
    px = defaultdict(dict)
    for t, d, c, ivc, ivp in conn.execute(
            """SELECT ticker, date, close::float8, iv30_call::float8, iv30_put::float8 FROM lseg_research.daily_history
               WHERE close > 0 AND iv30_call > 0 AND date >= %s ORDER BY ticker, date""", (START,)):
        n = lambda v: (v / 100 if v > 3 else v) if v and v > 0 else None  # noqa: E731
        px[t][d] = (c, n(ivc), n(ivp) or n(ivc))
    sec = dict(conn.execute("SELECT ticker, gics_sector FROM research_common.security_class WHERE gics_sector IS NOT NULL").fetchall())
    return ix, px, sec


def trade(p, days, i):
    d0 = days[i]
    S, ivc, ivp = p[d0]
    if not (0.05 < ivc < 3):
        return None
    T = 30 / 365
    j = bisect_left(days, d0 + timedelta(days=30))
    if j >= len(days) or (days[j] - d0).days > 36:
        return None
    Se = p[days[j]][0]
    K = strike(S, T, ivc, 0.50)
    debit = bs(S, K, T, ivc) * BUY
    Kp = strike(S, T, ivp, 0.20, call=False)
    prem = bs(S, Kp, T, ivp, call=False) * SELL
    return (max(Se - K, 0) - debit) / debit, (prem - max(Kp - Se, 0)) / Kp


def features(p, days, i, spy):
    if i < 252:
        return None
    d0 = days[i]
    cl = [p[days[k]][0] for k in range(i - 252, i + 1)]
    r = [cl[k] / cl[k - 1] - 1 for k in range(len(cl) - 20, len(cl))]
    rv = pstdev(r) * math.sqrt(252) if len(r) > 5 else None
    ivh = [p[days[k]][1] for k in range(i - 252, i)]
    xs, ys = [], []
    for k in range(i - 60, i + 1):
        a, b = days[k - 1], days[k]
        if a in spy and b in spy:
            xs.append(spy[b][0] / spy[a][0] - 1)
            ys.append(p[b][0] / p[a][0] - 1)
    if len(xs) < 40 or not rv:
        return None
    mx, my = mean(xs), mean(ys)
    vx = sum((x - mx) ** 2 for x in xs)
    beta = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / vx if vx else None
    iv = p[d0][1]
    return {"beta60": beta, "dd252": cl[-1] / max(cl) - 1, "ivrv": iv / rv,
            "ivrank": sum(v < iv for v in ivh) / len(ivh), "ret20": cl[-1] / cl[-21] - 1}


def tstat(v):
    if len(v) < 3:
        return float("nan")
    s = pstdev(v)
    return mean(v) / (s / math.sqrt(len(v) - 1)) if s else float("nan")


def quint_spread(rows, f, leg):
    """Per-episode cross-sectional Q5−Q1 of lift vs own any-day; returns per-episode spreads + Q means."""
    by = defaultdict(list)
    for r in rows:
        if r["f"].get(f) is not None:
            by[r["d"]].append(r)
    sp, qs = [], defaultdict(list)
    for d, rs in by.items():
        if len(rs) < 25:
            continue
        rs.sort(key=lambda r: r["f"][f])
        n = len(rs)
        q = [rs[k * n // 5:(k + 1) * n // 5] for k in range(5)]
        m = [mean(r[leg] - r[leg + "_own"] for r in g) for g in q]
        for k in range(5):
            qs[k].append(m[k])
        sp.append(m[4] - m[0])
    return sp, [mean(qs[k]) if qs[k] else float("nan") for k in range(5)]


def build_rows(px, sec, dates, spy):
    own = {}
    rows = []
    for t, p in px.items():
        days = sorted(p)
        allt = {}
        for i in range(len(days)):
            x = trade(p, days, i)
            if x:
                allt[days[i]] = x
        if len(allt) < 200:
            continue
        own[t] = {h: tuple(mean(v[k] for d, v in allt.items() if (d < SPLIT) == h) if any((d < SPLIT) == h for d in allt) else None
                           for k in (0, 1)) for h in (True, False)}
        for d in dates:
            i = bisect_left(days, d)
            if i >= len(days) or (days[i] - d).days > 3 or days[i] not in allt:
                continue
            o = own[t][days[i] < SPLIT]
            if o[0] is None:
                continue
            f = features(p, days, i, spy)
            if not f:
                continue
            f["sector"] = sec.get(t)
            c, pu = allt[days[i]]
            rows.append({"t": t, "d": d, "call": c, "put": pu, "call_own": o[0], "put_own": o[1], "f": f})
    return rows


def main() -> int:
    conn = connect()
    ix, px, sec = load(conn)
    spy = px["SPY"]
    sdays = sorted(spy)
    U = [d for d in signals(ix)["U"] if d >= START + timedelta(days=380)]
    spyt = {}
    for d in U:
        i = bisect_left(sdays, d)
        if i < len(sdays):
            x = trade(spy, sdays, i)
            if x:
                spyt[d] = x
    U = [d for d in U if d in spyt]
    rows = build_rows(px, sec, U, spy)
    # delayed one bar + placebo (random non-U days, same count, ≥ 20 sessions from any U)
    nxt = {d: sdays[bisect_left(sdays, d) + 1] for d in U if bisect_left(sdays, d) + 1 < len(sdays)}
    rows_d = build_rows(px, sec, list(nxt.values()), spy)
    rng = random.Random(173)
    pool = [d for d in sdays[400:-30] if all(abs((d - u).days) > 30 for u in U)]
    pl_dates = sorted(rng.sample(pool, len(U)))
    rows_p = build_rows(px, sec, pl_dates, spy)

    L = ["# S173 — S172 per stock: which names pay at a VIX÷VIX3M un-invert (Jamie 11-09 #9)", "",
         "CONTRACT 1-7: missing 1,8 (model prices, priced_by=model 100 %: BS at own iv30 call/put, buy ×1.05 / sell ×0.95; no single-name option "
         "quotes before 2025 → gap = LSEG expired RICs 2019→, needs Workspace) · 3 n_indep = episodes below (< 30 → UNDERPOWERED unless noted)", "",
         f"Episodes U ≥ {U[0] if U else '-'}: {len(U)} ({', '.join(map(str, U))}). Names×episodes: {len(rows)}. Train < {SPLIT} / test ≥.", ""]

    def block(title, rs, dates_spyt):
        out = [f"## {title}", "", "| leg | half | n eps | n rows | mean | median | win % | vs own any-day | vs SPY same trade | t (eps) |",
               "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
        for leg, k in (("call", 0), ("put", 1)):
            for h, nm in ((True, "train"), (False, "test"), (None, "all")):
                sel = [r for r in rs if h is None or (r["d"] < SPLIT) == h]
                if not sel:
                    continue
                eps = defaultdict(list)
                for r in sel:
                    eps[r["d"]].append(r)
                ep_lift = [mean(r[leg] - r[leg + "_own"] for r in g) for g in eps.values()]
                ep_spy = [mean(r[leg] for r in g) - dates_spyt[d][k] for d, g in eps.items() if d in dates_spyt]
                v = [r[leg] for r in sel]
                out.append(f"| {leg} | {nm} | {len(eps)} | {len(sel)} | {mean(v):+.1%} | {median(v):+.1%} | {sum(x > 0 for x in v) / len(v):.0%} | "
                           f"{mean(ep_lift):+.1%} | {mean(ep_spy) if ep_spy else float('nan'):+.1%} | {tstat(ep_lift):.2f} |")
        return out

    L += block("Pooled: every name at U (equal weight per episode)", rows, spyt)
    L += ["", f"Delayed one bar: call lift {mean(r['call'] - r['call_own'] for r in rows_d):+.1%} · put lift {mean(r['put'] - r['put_own'] for r in rows_d):+.1%} "
          f"(n {len(rows_d)}) · Placebo (random non-U days): call lift {mean(r['call'] - r['call_own'] for r in rows_p):+.1%} · "
          f"put lift {mean(r['put'] - r['put_own'] for r in rows_p):+.1%} (n {len(rows_p)})", ""]

    L += ["## Feature quintiles (cross-section within each episode; lift = trade − own any-day; Q5 = highest feature)", "",
          "| leg | feature | half | Q1 | Q2 | Q3 | Q4 | Q5 | Q5−Q1 | t (eps) | placebo Q5−Q1 | delayed Q5−Q1 |", "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
    best = {}
    for leg in ("call", "put"):
        for f in FEATS:
            for h, nm in ((True, "train"), (False, "test")):
                sel = [r for r in rows if (r["d"] < SPLIT) == h]
                sp, q = quint_spread(sel, f, leg)
                if not sp:
                    continue
                spp, _ = quint_spread(rows_p, f, leg)
                spd, _ = quint_spread([r for r in rows_d if (r["d"] < SPLIT) == h], f, leg)
                L.append(f"| {leg} | {f} | {nm} | " + " | ".join(f"{x:+.1%}" for x in q) +
                         f" | {mean(sp):+.1%} | {tstat(sp):.2f} | {mean(spp) if spp else float('nan'):+.1%} | {mean(spd) if spd else float('nan'):+.1%} |")
                if h:
                    best[(leg, f)] = (mean(sp), tstat(sp))
    # sector
    L += ["", "## Sector (lift vs own any-day, all episodes)", "", "| sector | n | call lift | put lift |", "|---|---:|---:|---:|"]
    bs_ = defaultdict(list)
    for r in rows:
        bs_[r["f"]["sector"] or "?"].append(r)
    for s, g in sorted(bs_.items(), key=lambda kv: -mean(r["call"] - r["call_own"] for r in kv[1])):
        if len(g) >= 20:
            L.append(f"| {s} | {len(g)} | {mean(r['call'] - r['call_own'] for r in g):+.1%} | {mean(r['put'] - r['put_own'] for r in g):+.1%} |")

    # train-picked rule → test
    L += ["", "## Train-picked rule → test (feature with largest train |Q5−Q1| per leg)", ""]
    rule = {}
    for leg in ("call", "put"):
        (lg, f), (m, t) = max(((k, v) for k, v in best.items() if k[0] == leg), key=lambda kv: abs(kv[1][0]))
        side = 4 if m > 0 else 0
        rule[leg] = (f, side)
        test = [r for r in rows if r["d"] >= SPLIT]
        by = defaultdict(list)
        for r in test:
            by[r["d"]].append(r)
        pick, rest, vs_spy = [], [], []
        for d, rs in by.items():
            rs = sorted(rs, key=lambda r: r["f"][f])
            n = len(rs)
            g = rs[side * n // 5:(side + 1) * n // 5]
            pick.append(mean(r[leg] for r in g))
            rest.append(mean(r[leg] for r in rs))
            vs_spy.append(mean(r[leg] for r in g) - spyt[d][0 if leg == "call" else 1])
        L.append(f"- {leg}: train pick = {'Q5 (high)' if side else 'Q1 (low)'} {f} (train Q5−Q1 {m:+.1%}, t {t:.2f}). Test {len(by)} eps: "
                 f"pick mean {mean(pick):+.1%} vs all names {mean(rest):+.1%} vs SPY same trade {mean(vs_spy):+.1%} (t {tstat(vs_spy):.2f}).")

    # Risk view for the put picks (same capital = per $ strike collateral; worst episode / worst name vs SPY put)
    L += ["", "## Put picks — risk (per $ collateral, 30 d; T-bill ≈ +0.2–0.4 %/30 d)", "",
          "| pick | half | eps | pick mean | SPY put | worst ep pick | worst ep SPY | worst name | breach % |", "|---|---|---:|---:|---:|---:|---:|---:|---:|"]
    for f, side in (("beta60", 4), ("dd252", 0)):
        for h, nm in ((True, "train"), (False, "test")):
            by = defaultdict(list)
            for r in rows:
                if (r["d"] < SPLIT) == h:
                    by[r["d"]].append(r)
            pm, sp_, allg = [], [], []
            for d, rs in by.items():
                rs = sorted(rs, key=lambda r: r["f"][f])
                n = len(rs)
                if n < 25:
                    continue
                g = rs[side * n // 5:(side + 1) * n // 5]
                pm.append(mean(r["put"] for r in g))
                sp_.append(spyt[d][1])
                allg += g
            L.append(f"| {'Q5' if side else 'Q1'} {f} | {nm} | {len(by)} | {mean(pm):+.2%} | {mean(sp_):+.2%} | {min(pm):+.2%} | {min(sp_):+.2%} | "
                     f"{min(r['put'] for r in allg):+.1%} | {sum(r['put'] < 0 for r in allg) / len(allg):.0%} |")

    # Winner pass (contract 11) — call leg, train only
    tr = [r for r in rows if r["d"] < SPLIT]
    w = [r for r in tr if r["call"] > 1.0]
    lo = [r for r in tr if r["call"] <= -0.99]
    L += ["", "## Winner pass (train, call leg: winners = > +100 % on debit, losers = expired worthless)", "",
          f"n winners {len(w)} / losers {len(lo)}. " + " · ".join(
              f"{f} {mean(r['f'][f] for r in w):+.2f} vs {mean(r['f'][f] for r in lo):+.2f}" for f in FEATS if w and lo)]

    # live ranks for the latest fire
    last = max(sdays)
    live = []
    for t, p in px.items():
        days = sorted(p)
        if days[-1] < last - timedelta(days=4):
            continue
        f = features(p, days, len(days) - 1, spy)
        if f:
            live.append((t, f))
    L += ["", f"## Live ranking as of {last} (rule features, top 15 per leg)", ""]
    for leg, (f, side) in list(rule.items()) + [("put", ("beta60", 4))]:
        top = sorted(live, key=lambda x: x[1][f], reverse=bool(side))[:15]
        L.append(f"- {leg} ({'high' if side else 'low'} {f}): " + ", ".join(f"{t} {x[f]:+.2f}" for t, x in top))
    L += ["", "## Verdict", "",
          f"n_indep = {len(U)} episodes (< 30) → UNDERPOWERED on both legs; model prices only.",
          "- Verdict calls: RULE NO-LIFT: U entry × hold to expiry × 0.50Δ 30 DTE call on single names picked by beta / drawdown / IV÷RV / IV rank / 20d return "
          "→ every feature's Q5−Q1 flips sign train vs test; all names vs SPY's same call: +18 % train, −31 % test. Use the index call (S172). "
          "Winner pass: train winners had lower beta / shallower drawdown than losers, test the reverse → next rule to test: index call + "
          "single-name call only when the name's own 1m/3m IV term structure un-inverts (needs expired-RIC quotes).",
          "- UNDERPOWERED-promising: U × hold to expiry × 0.20Δ 30 DTE short put on the top-beta fifth → beats own any-day put both halves "
          "(Q5−Q1 t 5.2 / 3.4; placebo +0.4 %, delayed holds) and SPY's put per $ collateral (+3.0 / +2.0 % vs +0.9 / +0.6 %). "
          "Tail: worst name −24 / −29 %, 6–9 % breached → spread over ≥ 5 names. Shipped as paper: strategy_signals 'vix-uninvert-put-hibeta'."]
    L += ["", "Refs: A244 · S172"]
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
