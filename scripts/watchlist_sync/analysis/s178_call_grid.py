"""S178 — long calls: right strike, expiry, exit, skew pairing, on the sold-put entry days (Jamie 11-09).

Jamie: "maybe you did not choose the right strike or expiry (longer the better), take advantage of option skews, maybe pair with
sell puts (which we know works); identify which of those opportunities were truly best for long calls, then tighten entry/close
conditions so the model only buys calls at the best timings."

S177 tested ONE call (30 DTE, flat iv30 × Schwab one-day ladder, held to expiry). Here:
  pricing  S178 surface from 548k real LSEG quotes (s178_surface_calib.py): call IV = iv30_call × call cell (DTE, Δ) ≈ 1.0,
           put IV = iv30_put × put cell (DTE, |Δ|, iv-pctile tercile) (0.25Δ ≈ 1.09×); long-DTE regime tilt from ATM puts.
           Fills: bid + 23 % of the cell's real relative spread. Exit repriced on the exit date's iv30 (vol crush / spike included).
  grid     long call Δ {0.30, 0.50, 0.70} × DTE {30, 60, 120, 240} × exit {21 td, 63 td, expiry (≤ 60 DTE), TP 2× / stop −50 %
           weekly within 63 td}; risk reversal = short 0.25Δ put + long call Δ {0.30, 0.50}, same DTE, cash-secured put strike as
           capital, vs the short put alone (same exit) → does the call add to the put we know works?
  entries  Mondays 2021-02 →, S175 names (~260). Sets: ALL · PANIC (VIX÷VIX3M ≥ 1) · DIP (ret20 ≤ −15 %) · RICH (iv30/rv20 ≥ 1.3)
           · PUT = any of the three (the sold-put days) · IVLOW (iv pctile ≤ 0.2).
  metric   pnl ÷ $ debit (calls) / ÷ $ capital (RR, CSP); per-21-td rate so holds compare; same-Δ stock comparator (Δ × ΔS ÷ debit);
           eras < 2024 / ≥ 2024; month-block t of lift vs the same config on ALL days.
Pre-registered: a call config 'works' on a set if mean lift vs ALL > 0 both eras, t ≥ 2, and it beats same-Δ stock both eras.
Then step 2 (winner anatomy): on PUT days, the best config's top-decile vs bottom-half entry features; ONE tightened rule picked on
2021–23 only, judged once on 2024 →.
    cd scripts/watchlist_sync && .venv/bin/python analysis/s178_call_grid.py
"""
from __future__ import annotations

import json
import math
import pickle
import statistics as st
import sys
from bisect import bisect_right
from collections import defaultdict
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent)); sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402
from s045_put_retest import ncdf  # noqa: E402

SURF = json.loads((HERE.parent / "out" / "opt" / "s178_surface.json").read_text())
CELLS, DTE_B, DL_B = SURF["cells"], [tuple(x) for x in SURF["dte_b"]], [tuple(x) for x in SURF["dl_b"]]
CACHE = Path.home() / ".fildi/cache/s175_trades.pkl"
OUTP = Path.home() / ".fildi/cache/s178_rows.pkl"
START, SPLIT, END = date(2021, 2, 1), date(2024, 1, 1), date(2026, 11, 6)
FK = 0.27
DTES, DELTAS = (30, 60, 120, 240), (0.30, 0.50, 0.70)


def bkt(x, B):
    for b in B:
        if b[0] <= x < b[1]:
            return b
    return B[0] if x < B[0][0] else B[-1]


def cell(side, dte, dl, ivpb="all"):
    db, lb = bkt(dte, DTE_B), bkt(dl, DL_B)
    k = f"{side}|{db[0]}-{db[1]}|{lb[0]:.2f}-{lb[1]:.2f}|{ivpb}"
    c = CELLS.get(k) or CELLS.get(f"{side}|{db[0]}-{db[1]}|{lb[0]:.2f}-{lb[1]:.2f}|all")
    return c




def bs(S, K, v, T, call):
    sd = v * math.sqrt(T)
    d1 = (math.log(S / K) + 0.5 * sd * sd) / sd
    if call:
        return S * ncdf(d1) - K * ncdf(d1 - sd), ncdf(d1)
    return K * ncdf(sd - d1) - S * ncdf(-d1), 1 - ncdf(d1)


def strike(S, v, T, target, call):
    sd = v * math.sqrt(T); lo, hi = S * 0.2, S * 4
    for _ in range(50):
        k = (lo + hi) / 2
        d1 = (math.log(S / k) + 0.5 * sd * sd) / sd
        dl = ncdf(d1) if call else 1 - ncdf(d1)
        if call:
            lo, hi = (k, hi) if dl > target else (lo, k)
        else:
            lo, hi = (lo, k) if dl > target else (k, hi)
    return (lo + hi) / 2


# Term structure (fit on real quotes, s178 beta fit): ATM IV_T = ivbar × exp(a_T + b_T · ln(iv30 ÷ ivbar)), ivbar = trailing 252-day
# median of the stock's iv30. b = same-contract 30-day change beta (long-dated IV moves 0.19× iv30 at 200+ DTE, not 1×);
# a = level, average of put- and call-quote fits, held flat ≥ 150 DTE so rolling down the curve never fakes an IV gain.
TS = [(13, 0.020, 1.000), (35, 0.014, 0.713), (75, 0.056, 0.483), (150, 0.105, 0.256), (310, 0.105, 0.187)]
# variant B (S178_TS=level): b from the cross-sectional level fit (0.93 / 0.71 / 0.58 / 0.45) — iv30 noise attenuates both fits,
# so the true response sits between A (change β, low vega) and B; a verdict must hold under both.
if __import__("os").environ.get("S178_TS") == "level":
    TS = [(13, 0.036, 1.000), (35, 0.029, 0.933), (75, 0.046, 0.708), (150, 0.064, 0.575), (310, 0.100, 0.449)]
    OUTP = OUTP.with_name("s178_rows_level.pkl")


def term(dte):
    if dte <= TS[0][0]:
        return TS[0][1:]
    for (d0, a0, b0), (d1, a1, b1) in zip(TS, TS[1:]):
        if d0 <= dte <= d1:
            w = (dte - d0) / (d1 - d0)
            return a0 + w * (a1 - a0), b0 + w * (b1 - b0)
    return TS[-1][1:]


def smile(side, dte, dl):
    c, a = cell("P", dte, dl if side == "P" else 1 - dl), cell("P", dte, 0.5)
    if side == "C":   # real call quotes: flat in Δ (0.98–1.05 × ATM) → no call wing
        s = cell("C", dte, dl)
        return 1.0, (s[2] if s else (c[2] if c else 0.12))
    return (c[0] / a[0] if (c and a) else 1.0), (c[2] if c else 0.15)


def price(side, S, K, dte, iv30, ibar):
    """(mid, rel spread, Δ) on the S178 surface."""
    if dte <= 2:
        return (max(S - K, 0) if side == "C" else max(K - S, 0)), 0.0, None
    T = dte / 365
    a, b = term(dte)
    atm = ibar * math.exp(a + b * math.log(iv30 / ibar))
    _, d0 = bs(S, K, atm, T, side == "C")
    ratio, spr = smile(side, dte, d0)
    px, dl = bs(S, K, atm * ratio, T, side == "C")
    if side == "P":   # validation vs 300k real put quotes: model 0–12 % rich by DTE → scale to real (calls validate 0.90–1.08, left as is)
        px /= 1.0 + 0.12 * min(max((dte - 13) / 200, 0), 1)
    return px, spr, dl


def month_t(xs):
    by = defaultdict(list)
    for d, v in xs:
        by[(d.year, d.month)].append(v)
    m = [st.mean(v) for v in by.values()]
    return st.mean(m) / (st.pstdev(m) / math.sqrt(len(m))) if len(m) > 2 and st.pstdev(m) > 0 else float("nan")


def load():
    names = sorted({x["t"] for x in pickle.loads(CACHE.read_bytes())})
    B = defaultdict(list)
    with connect() as conn:
        for t, d, c, ip, ic in conn.execute("""SELECT ticker, date, close::float8, iv30_put::float8, iv30_call::float8
                FROM lseg_research.daily_history WHERE ticker = ANY(%s) AND date >= '2019-06-01' AND close > 0 ORDER BY ticker, date""",
                                            (names,)):
            f = lambda x: None if x is None else (x / 100 if x > 3 else x)  # noqa: E731
            B[t].append((d, c, f(ip), f(ic)))
        vx = {}
        for d, i, c in conn.execute("SELECT date, index, close::float8 FROM wrds_research.cboe_daily WHERE index IN ('VIX','VIX3M')"):
            vx.setdefault(d, {})[i] = c
        for d, r in conn.execute("""SELECT a.date, a.value / b.value FROM watchlist_sync.macro_daily a JOIN watchlist_sync.macro_daily b
                                    ON b.date = a.date AND b.series = 'vix3m' WHERE a.series = 'vix' AND b.value > 0"""):
            vx[d] = float(r)
    vr = {d: (v if isinstance(v, float) else (v["VIX"] / v["VIX3M"] if "VIX" in v and v.get("VIX3M") else None)) for d, v in vx.items()}
    vr = {d: v for d, v in vr.items() if v}
    return B, vr


def main():
    B, vr = load()
    vd = sorted(vr)
    rows = []
    for t, h in B.items():
        ds = [r[0] for r in h]
        ivs = []
        for i, (d, S, ip, ic) in enumerate(h):
            if ic and ip:
                ivs.append((ic + ip) / 2)
            if d < START or d.weekday() != 0 or i < 260 or not ic or not ip:
                continue
            c = [r[1] for r in h[i - 260:i + 1]]
            lr = [math.log(c[j] / c[j - 1]) for j in range(-20, 0)]
            rv20 = st.pstdev(lr) * math.sqrt(252)
            w = ivs[-252:]
            ibar = st.median(w)
            ivb = (ic + ip) / 2
            ivp = sum(x <= ivb for x in w) / len(w)
            ivpb = f"{[0, 1 / 3, 2 / 3][min(int(ivp * 3), 2)]:.2f}"
            k = bisect_right(vd, d) - 1
            m50 = st.mean(c[-50:]); s50 = st.pstdev(c[-50:]) or 1
            f = {"t": t, "d": d, "ret5": c[-1] / c[-6] - 1, "ret20": c[-1] / c[-21] - 1, "ret60": c[-1] / c[-61] - 1,
                 "z50": (c[-1] - m50) / s50, "off_hi": c[-1] / max(c[-252:]) - 1, "ivrv": ivb / rv20 if rv20 > 0 else None,
                 "ivp": ivp, "vixr": vr[vd[k]] if k >= 0 else None, "iv": ivb, "skew": ip / ic}
            out = {}
            for dte in DTES:
                # path: bar indices up to expiry
                exp_i = bisect_right(ds, date.fromordinal(d.toordinal() + dte)) - 1
                if exp_i <= i + 5 or h[exp_i][0] > END or (date.fromordinal(d.toordinal() + dte) > END and dte <= 60):
                    continue
                Tn = dte / 365
                a_, b_ = term(dte); ivT = ibar * math.exp(a_ + b_ * math.log(ivb / ibar))
                kp = strike(S, ivT * 1.06, Tn, 0.25, False)
                pm, ps, _ = price("P", S, kp, dte, ivb, ibar)
                pcred = pm * (1 - FK * ps)
                legs = {}
                for D in DELTAS:
                    kc = strike(S, ivT, Tn, D, True)
                    cm, cs, cdl = price("C", S, kc, dte, ivb, ibar)
                    legs[D] = (kc, cm * (1 + FK * cs), cdl)
                exp_d = date.fromordinal(d.toordinal() + dte)
                past_end = exp_d > END                      # A388: expiry after the last bar → exp_i is the data end, not expiry
                exits = {nm: min(i + n, exp_i) for n, nm in ((21, "h21"), (63, "h63")) if not (past_end and i + n > exp_i)}
                if dte <= 60:
                    exits["exp"] = exp_i
                for en, j in exits.items():
                    if h[j][0] > END or j >= len(h):
                        continue
                    dj, Sj, ipj, icj = h[j]
                    ivj = (ipj + icj) / 2 if (ipj and icj) else None
                    rem = 0 if (j == exp_i and not past_end) else max((exp_d - dj).days, 0)   # A388: true remaining life
                    if not ivj:
                        continue
                    for D, (kc, debit, cdl) in legs.items():
                        if debit <= 0.01 * S * 0.01:
                            continue
                        cv, cvs, _ = price("C", Sj, kc, rem, ivj, ibar)
                        val = cv * (1 - FK * cvs) if rem > 2 else cv
                        out[(dte, D, en)] = (val / debit - 1, (j - i), cdl * (Sj - S) / debit)
                    pv, pvs, _ = price("P", Sj, kp, rem, ivj, ibar)
                    pclose = pv * (1 + FK * pvs) if rem > 2 else pv
                    csp = (pcred - pclose) / kp
                    out[(dte, "csp", en)] = (csp, j - i, None)
                    for D in (0.30, 0.50):
                        kc, debit, _ = legs[D]
                        cv, cvs, _ = price("C", Sj, kc, rem, ivj, ibar)
                        val = cv * (1 - FK * cvs) if rem > 2 else cv
                        out[(dte, f"rr{D:.2f}", en)] = ((pcred - pclose - debit + val) / kp, j - i, None)
                # TP 2× / stop −50 %, weekly checks within 63 td (calls only)
                for D, (kc, debit, cdl) in legs.items():
                    if past_end and i + 63 > exp_i:                # A388: TP window runs past the data end
                        break
                    jj = i
                    while True:
                        jj = min(jj + 5, exp_i, i + 63)
                        dj, Sj, ipj, icj = h[jj]
                        if not (icj and ipj):
                            break
                        ivj = (ipj + icj) / 2
                        rem = 0 if (jj == exp_i and not past_end) else max((exp_d - dj).days, 0)
                        cv, cvs, _ = price("C", Sj, kc, rem, ivj, ibar)
                        val = cv * (1 - FK * cvs) if rem > 2 else cv
                        r = val / debit - 1
                        if r >= 1.0 or r <= -0.5 or jj >= min(exp_i, i + 63):
                            out[(dte, D, "tp")] = (r, jj - i, cdl * (Sj - S) / debit)
                            break
            if out:
                rows.append((f, out))
    OUTP.write_bytes(pickle.dumps(rows))
    print(f"S178: {len(rows)} entries · {len(B)} names → {OUTP}")
    report(rows)


SETS = {
    "ALL": lambda f: True,
    "PANIC": lambda f: (f["vixr"] or 0) >= 1,
    "DIP": lambda f: f["ret20"] <= -0.15,
    "RICH": lambda f: (f["ivrv"] or 0) >= 1.3,
    "PUT": lambda f: (f["vixr"] or 0) >= 1 or f["ret20"] <= -0.15 or (f["ivrv"] or 0) >= 1.3,
    "IVLOW": lambda f: f["ivp"] <= 0.2,
}


def summ(rows, key, fn):
    v = [(f["d"], o[key][0], o[key][1], o[key][2]) for f, o in rows if key in o and fn(f)]
    if len(v) < 60:
        return None
    m = st.mean(x[1] for x in v)
    e = [st.mean([x[1] for x in v if (x[0] < SPLIT) == a] or [float("nan")]) for a in (True, False)]
    stk = [x[3] for x in v if x[3] is not None]
    se = [st.mean([x[3] for x in v if x[3] is not None and (x[0] < SPLIT) == a] or [float("nan")]) for a in (True, False)]
    return {"n": len(v), "m": m, "med": st.median(x[1] for x in v), "e": e, "win": sum(x[1] > 0 for x in v) / len(v),
            "hold": st.mean(x[2] for x in v), "stk": st.mean(stk) if stk else None, "se": se, "v": v}


def report(rows):
    keys = sorted({k for _, o in rows for k in o}, key=lambda k: (k[0], str(k[1]), k[2]))
    base = {k: summ(rows, k, SETS["ALL"]) for k in keys}
    for sname, fn in SETS.items():
        print(f"\n== {sname}  (entries {sum(fn(f) for f, _ in rows)})")
        print("  DTE  leg     exit |   n    mean   med   win  hold | per21td | eras <24/≥24 | Δstock eras    | lift vs ALL  t")
        for k in keys:
            s = summ(rows, k, fn)
            b = base.get(k)
            if not s or not b:
                continue
            lift = s["m"] - b["m"]
            lv = [(d, x - b["m"]) for d, x, _, _ in s["v"]]
            leg = k[1] if isinstance(k[1], str) else f"C{k[1]:.2f}"
            se = "" if s["stk"] is None else f"{100 * s['se'][0]:+6.1f}/{100 * s['se'][1]:+6.1f}"
            print(f"  {k[0]:3d}  {leg:7s} {k[2]:4s} | {s['n']:5d} {100 * s['m']:+6.1f} {100 * s['med']:+6.1f} {100 * s['win']:4.0f} "
                  f"{s['hold']:5.1f} | {100 * s['m'] * 21 / max(s['hold'], 1):+6.1f} | {100 * s['e'][0]:+6.1f}/{100 * s['e'][1]:+6.1f} | "
                  f"{se:14s} | {100 * lift:+6.1f} {month_t(lv) if sname != 'ALL' else float('nan'):4.1f}")



def anatomy():
    """Step 2: winners vs losers inside the passing cell; one extra filter picked on < 2024 only, judged once on ≥ 2024;
    entry-price stress (debit × 1.10, exit unchanged); RR vs same-Δ stock in PANIC."""
    rows = pickle.loads(OUTP.read_bytes())
    feats = ["ret5", "ret20", "ret60", "z50", "off_hi", "ivrv", "ivp", "vixr", "skew", "iv"]
    for key, sname in [((240, 0.30, "h63"), "IVLOW"), ((120, 0.30, "h63"), "IVLOW"), ((30, 0.70, "exp"), "PANIC")]:
        R = [(f, o[key]) for f, o in rows if key in o and SETS[sname](f)]
        allm = st.mean(o[key][0] for f, o in rows if key in o)
        R.sort(key=lambda x: x[1][0]); n = len(R)
        win, lose = R[-n // 10:], R[:n // 2]
        print(f"\n== anatomy {key} on {sname}: n {n}, mean {100 * st.mean(x[1][0] for x in R):+.1f} %")
        print("  stress debit×1.10: " + f"{100 * st.mean((1 + x[1][0]) / 1.10 - 1 for x in R):+.1f} %  ·  "
              f"distinct names {len({f['t'] for f, _ in R})}, months {len({(f['d'].year, f['d'].month) for f, _ in R})}")
        print("  feature   winners  losers | train quintile means (Q1..Q5)")
        best = None
        for k in feats:
            V = [x for x in R if x[0].get(k) is not None]
            tr = sorted([x for x in V if x[0]["d"] < SPLIT], key=lambda x: x[0][k])
            if len(tr) < 250:
                continue
            q = [tr[i * len(tr) // 5:(i + 1) * len(tr) // 5] for i in range(5)]
            qm = [st.mean(x[1][0] for x in b) for b in q]
            print(f"  {k:8s} {st.median(x[0][k] for x in win if x[0].get(k) is not None):8.3f} "
                  f"{st.median(x[0][k] for x in lose if x[0].get(k) is not None):7.3f} | " + " ".join(f"{100 * v:+6.1f}" for v in qm))
            # candidate filters: drop the worst train quintile at either end (keep ≥ 80 %)
            for side, cut in (("≥", q[0][-1][0][k]), ("≤", q[4][0][0][k])):
                keep = (lambda f, c=cut, kk=k: f[kk] is not None and f[kk] >= c) if side == "≥" else \
                       (lambda f, c=cut, kk=k: f[kk] is not None and f[kk] <= c)
                trm = st.mean(x[1][0] for x in tr if keep(x[0]))
                if not best or trm > best[0]:
                    best = (trm, f"{k} {side} {cut:.3f}", keep)
        te = [x for x in R if x[0]["d"] >= SPLIT]
        tek = [x for x in te if best[2](x[0])]
        teall = [o[key] for f, o in rows if key in o and f["d"] >= SPLIT]
        print(f"  TIGHTEN (picked on train): {best[1]} → train {100 * best[0]:+.1f} % · TEST {100 * st.mean(x[1][0] for x in tek):+.1f} % "
              f"(n {len(tek)}) vs cell test {100 * st.mean(x[1][0] for x in te):+.1f} % vs all-days test {100 * st.mean(x[0] for x in teall):+.1f} %, "
              f"t {month_t([(f['d'], r[0] - allm) for f, r in tek]):.1f} · Δstock {100 * st.mean(x[1][2] for x in tek):+.1f} %")
    # RR vs CSP vs Δ-matched stock in PANIC (per $ put strike): stock leg = (0.25 + call Δ) × ret
    print("\n== PANIC risk reversal vs short put alone vs same-Δ stock (per $ capital)")
    for dte in (30, 60):
        for D in (0.30, 0.50):
            k_rr, k_c = (dte, f"rr{D:.2f}", "exp"), (dte, D, "exp")
            v = [(f, o[k_rr][0], o[(dte, "csp", "exp")][0], o[k_c][2]) for f, o in rows
                 if k_rr in o and k_c in o and SETS["PANIC"](f)]
            # Δstock in o[k_c][2] is per $ call debit → re-derive the stock return from it is messy; use ret from bars instead
            print(f"  {dte} DTE rr{D:.2f}: n {len(v)} RR {100 * st.mean(x[1] for x in v):+.1f} · CSP {100 * st.mean(x[2] for x in v):+.1f} · "
                  f"eras RR−CSP {100 * st.mean([x[1] - x[2] for x in v if x[0]['d'] < SPLIT]):+.1f}/"
                  f"{100 * st.mean([x[1] - x[2] for x in v if x[0]['d'] >= SPLIT]):+.1f} · RR win {100 * sum(x[1] > 0 for x in v) / len(v):.0f} % · "
                  f"RR worst 5 % {100 * sorted(x[1] for x in v)[len(v) // 20]:+.1f} vs CSP {100 * sorted(x[2] for x in v)[len(v) // 20]:+.1f}")

if __name__ == "__main__":
    if "--anatomy" in sys.argv:
        anatomy()
    elif "--report" in sys.argv:
        report(pickle.loads(OUTP.read_bytes()))
    else:
        main()
