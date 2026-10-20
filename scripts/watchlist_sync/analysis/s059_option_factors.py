"""S059 — literature option-return factors on simulated short puts (Claude 10-19; Jamie: "find other factors / methods and make
sense of the options scores"). Pre-registered in research/studies/INDEX.md.

A206 simulator correction: enter the first NYSE session of each week, expire the
last session of that same week, using exact dated bars and session-count pricing.
Net fills remain bid + 23% of spread. Existing fixed-four-session calibration has
NOT been rerun or validated for this corrected horizon; historical results below
must not be presented as validation of this version.
New features (known at the as_of close; lseg_research.daily_history):
  vol_of_vol   std of daily Δln(IV30 put) over 60 days         Cao, Vasquez, Xiao, Zhan — higher → options overpriced
  term_slope   IV30 put − IV60 put                              Vasquez 2017 — inverted (> 0 here) → short-dated rich
  skew         IV30 put − IV30 call                             Xing, Zhang, Zhao 2010 — rich put skew
  idio_vol     σ of residual daily returns vs SPY, 60 days     Cao & Han 2013 — higher → options overpriced
  mom_12_1     return t−252 → t−21                              Zhan, Han, Cao, Tong 2022
  rev_1m       return t−21 → t
  iv_rv        IV30 / RV (already in S045 controls; reported without controls = the Goyal-Saretto test)
Test: S045 fm() (weekly Spearman on pnl and breach, controls iv_rv / iv30 / earnings), |t| ≥ 3 and both halves same sign.
R2: composite = mean of within-week ranks of passing features (signed by their IC sign, fit on < 2024-07 only) + the live put tech
score (trend − volumeConfirm, A167); holdout 2024-07→ top−bottom quintile pnl vs tech alone.

    .venv/bin/python analysis/s059_option_factors.py
"""
from __future__ import annotations

import math
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import s045_put_retest as S  # noqa: E402
from build_plan import connect  # noqa: E402
from weekly_put_calendar import HORIZON_VERSION, weekly_sessions

SPLIT = date(2024, 7, 1)
NEW = ["vol_of_vol", "term_slope", "skew", "idio_vol", "mom_12_1", "rev_1m"]
OUT = HERE.parent / "out/opt/S059.md"


def add_features(conn, ev):
    tick = sorted({e["t"] for e in ev})
    iv = defaultdict(dict)
    for t, d, p30, c30, p60 in conn.execute("""SELECT ticker, date, iv30_put::float8, iv30_call::float8, iv60_put::float8
                                              FROM lseg_research.daily_history WHERE ticker = ANY(%s) AND iv30_put > 0""", (tick,)).fetchall():
        iv[t][d] = (p30, c30, p60)
    spy = {d: c for d, c in conn.execute("SELECT date, close::float8 FROM lseg_research.daily_history WHERE ticker = 'SPY' ORDER BY date").fetchall()}
    _, _, _, px = None, None, None, None
    closes = defaultdict(list)
    for t, d, c in conn.execute("""SELECT ticker, date, close::float8 FROM lseg_research.daily_history WHERE ticker = ANY(%s) AND close > 0
                                   ORDER BY ticker, date""", (tick,)).fetchall():
        closes[t].append((d, c))
    pos = {t: {d: i for i, (d, _) in enumerate(b)} for t, b in closes.items()}
    for e in ev:
        b, i = closes.get(e["t"]), pos.get(e["t"], {}).get(e["d"])
        if b is None or i is None or i < 253:
            continue
        ds = [x[0] for x in b[i - 60:i + 1]]
        cs = np.array([x[1] for x in b[i - 60:i + 1]])
        r = np.diff(np.log(cs))
        sp = [spy.get(d) for d in ds]
        if all(sp):
            rs = np.diff(np.log(np.array(sp)))
            beta = np.cov(r, rs)[0, 1] / (np.var(rs) or 1e-9)
            e["idio_vol"] = float(np.std(r - beta * rs) * math.sqrt(252))
        e["mom_12_1"] = b[i - 21][1] / b[i - 252][1] - 1
        e["rev_1m"] = b[i][1] / b[i - 21][1] - 1
        ivs = [iv[e["t"]].get(d) for d in ds]
        p = [x[0] for x in ivs if x and x[0]]
        if len(p) >= 40:
            e["vol_of_vol"] = float(np.std(np.diff(np.log(p))))
        today = iv[e["t"]].get(e["d"])
        if today:
            p30, c30, p60 = today
            if p60:
                e["term_slope"] = p30 - p60
            if c30:
                e["skew"] = p30 - c30
        tc = e.get("tech_trendContext"), e.get("tech_volumeConfirm")
        if None not in tc:
            e["put_tech"] = tc[0] - tc[1]   # A167 options-1.1.0 put tech (quantile-matched live; raw diff here)


def composite_holdout(ev, feats, signs):
    by = defaultdict(list)
    for e in ev:
        if e["d"] >= SPLIT and all(e.get(f) is not None for f in feats + ["put_tech", "iv_rv"]):
            by[e["d"]].append(e)
    res = {}
    for name, fs, sg in (("put tech alone (live A167)", ["put_tech"], [1]), ("IV/RV alone", ["iv_rv"], [1]),
                         ("IV/RV + new", ["iv_rv"] + feats, [1] + signs),
                         ("IV/RV + new + put tech", ["iv_rv"] + feats + ["put_tech"], [1] + signs + [1])):
        top, bot = [], []
        for g in by.values():
            if len(g) < 30:
                continue
            sc = np.zeros(len(g))
            for f, s in zip(fs, sg):
                sc += s * S.rank([e[f] for e in g])
            o = np.argsort(sc)
            q = len(g) // 5
            bot += [g[k] for k in o[:q]]
            top += [g[k] for k in o[-q:]]
        res[name] = {"pnl_top": 1e4 * np.mean([e["pnl"] for e in top]), "pnl_bot": 1e4 * np.mean([e["pnl"] for e in bot]),
                     "breach_top": np.mean([e["breach"] for e in top]), "breach_bot": np.mean([e["breach"] for e in bot]),
                     "weeks": len(by)}
    return res


def aligned_events(conn):
    """Use exact same-week entry/expiry bars; no holiday spill into the next week."""
    import put_edge as PE
    rows, tech, fund, px = S.load(conn)
    ev = S.build(rows, tech, fund, px, weekly_window=weekly_sessions)
    for e in ev:
        tt = e["hold_sessions"] / 252
        K_over_S = math.exp(-S.Z * e["iv30"] * math.sqrt(tt))
        prem_k = S.bs_put(1.0, K_over_S, e["iv30"], tt) / K_over_S
        e["pnl_mid"] = e["pnl"]
        e["pnl"] = e["pnl"] - PE.fill_cost(prem_k)
    add_features(conn, ev)
    return ev


def main():
    with connect() as conn:
        ev = aligned_events(conn)
    print(f"S059 · {len(ev)} simulated puts, {len({e['d'] for e in ev})} weeks, {len({e['t'] for e in ev})} names")
    lines = ["# S059 — literature option factors on simulated short puts", "",
             f"Horizon: {HORIZON_VERSION}; exact first/last NYSE sessions of each week.", "",
             "| feature | target | controls | IC | t | half A | half B | verdict |", "|---|---|---|---|---|---|---|---|"]
    passing, signs = [], []
    for f in ["iv_rv"] + NEW + ["put_tech"]:
        for tgt in ("pnl", "breach"):
            for ctl in ((False,) if f == "iv_rv" else (True,)):
                r = S.fm([e for e in ev if e["d"] < SPLIT], f, tgt, controls=ctl)   # A196: select on pre-holdout weeks only
                if not r:
                    continue
                ok = abs(r["t"]) >= 3 and np.sign(r["ic_a"]) == np.sign(r["ic_b"]) == np.sign(r["ic"])
                if ok and tgt == "pnl" and f in NEW:
                    passing.append(f); signs.append(int(np.sign(r["ic"])))
                line = f"| {f} | {tgt} | {'yes' if ctl else 'no'} | {r['ic']:+.4f} | {r['t']:+.1f} | {r['ic_a']:+.4f} | {r['ic_b']:+.4f} | {'PASS' if ok else '—'} |"
                print(line); lines.append(line)
    lines += ["", f"Passing on pnl: {passing or 'none'}", ""]
    for f in NEW:
        q = S.quint(ev, f)
        lines.append(f"- {f}: top quintile pnl {q['pnl_top']:+.1f} bp / breach {100 * q['breach_top']:.1f} % · bottom {q['pnl_bot']:+.1f} bp / {100 * q['breach_bot']:.1f} %")
    if passing:
        # signs re-checked on the pre-holdout period only (no look-ahead into the holdout)
        pre = [e for e in ev if e["d"] < SPLIT]
        signs = [int(np.sign(S.fm(pre, f, "pnl")["ic"])) for f in passing]
        h = composite_holdout(ev, passing, signs)
        lines += ["", f"## Holdout {SPLIT}→ (top − bottom quintile, bp/week of collateral)"]
        for k, v in h.items():
            lines.append(f"- {k}: top {v['pnl_top']:+.1f} / bottom {v['pnl_bot']:+.1f} → spread {v['pnl_top'] - v['pnl_bot']:+.1f} bp · "
                         f"breach {100 * v['breach_top']:.1f} % vs {100 * v['breach_bot']:.1f} % ({v['weeks']} weeks)")
    # paired weekly holdout test: composite (iv_rv + vol_of_vol + put_tech) vs put tech alone, top quintile, net of fills
    byw = defaultdict(list)
    for e in ev:
        if e["d"] >= SPLIT and all(e.get(k) is not None for k in ("iv_rv", "vol_of_vol", "put_tech")):
            byw[e["d"]].append(e)
    dd, db = [], []
    for g in byw.values():
        if len(g) < 30:
            continue
        q = len(g) // 5
        def top(fs):
            o = np.argsort(sum(S.rank([e[k] for e in g]) for k in fs))[-q:]
            return np.mean([g[k]["pnl"] for k in o]), np.mean([g[k]["breach"] for k in o])
        a, b = top(["put_tech"]), top(["iv_rv", "vol_of_vol", "put_tech"])
        dd.append(1e4 * (b[0] - a[0])); db.append(b[1] - a[1])
    dd, db = np.array(dd), np.array(db); h = len(dd) // 2
    tt = lambda v: v.mean() / (v.std(ddof=1) / math.sqrt(len(v)))
    lines += ["", f"## Paired holdout vs live put tech (net of fills, same-week sessions): top quintile {dd.mean():+.1f} bp/wk (t {tt(dd):+.2f}, "
              f"halves {dd[:h].mean():+.1f} / {dd[h:].mean():+.1f}, weeks better {np.mean(dd > 0):.0%}); breach {100 * db.mean():+.2f} pp (t {tt(db):+.2f})"]
    # calibration for put_edge.py: composite quintile → simulated pnl / breach on the holdout (never the fit period)
    import json
    by = defaultdict(list)
    for e in ev:
        if e["d"] >= SPLIT and all(e.get(k) is not None for k in ("iv_rv", "vol_of_vol", "put_tech")):
            by[e["d"]].append(e)
    qs = defaultdict(list)
    for g in by.values():
        if len(g) < 30:
            continue
        sc = S.rank(sum(S.rank([e[k] for e in g]) for k in ("iv_rv", "vol_of_vol", "put_tech")))
        for e, v in zip(g, sc):
            qs[min(4, int(v * 5))].append(e)
    cal = {str(q + 1): {"pnl_bp": round(1e4 * float(np.mean([e["pnl"] for e in v])), 1),
                        "pnl_mid_bp": round(1e4 * float(np.mean([e["pnl_mid"] for e in v])), 1),
                        "breach": round(float(np.mean([e["breach"] for e in v])), 4), "n": len(v)} for q, v in sorted(qs.items())}
    (HERE.parent / "put_edge_calibration.json").write_text(json.dumps({"holdout_from": str(SPLIT), "horizon_version": HORIZON_VERSION, "basis": "First → last NYSE session of same week, exact dated bars; pnl net of fills (bid + 23 % of spread); A206", "quintiles": cal}, indent=1))
    lines += ["", "## Composite quintile calibration (holdout)"] + [f"- Q{q}: {v['pnl_bp']:+.1f} bp/wk net (mid {v['pnl_mid_bp']:+.1f}) · breach {100 * v['breach']:.1f} % (n {v['n']})" for q, v in cal.items()]
    OUT.write_text("\n".join(lines) + "\n")
    print("\n".join(lines[-12:]))


if __name__ == "__main__":
    main()
