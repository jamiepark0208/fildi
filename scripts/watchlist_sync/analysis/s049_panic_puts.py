"""S049 / A178 — panic put-selling, pre-registered in asks/A178.md (one run, no re-tuning).

Events (S025 rule): 5-day log return ÷ (prior 60-day daily σ·√5) ≤ −2, one per name per 10 days, 2026, on the names we
hold real option chains for (optlab, ~100 book names; deviation from "Model List universe": only these have real closes).
Trade: next day's close, sell the put nearest 0.20Δ (BS at that day's LSEG iv30_put) at the expiry closest to 30 DTE
within 15–45, entry = real option close that day (skip if none), held to expiry, settled at the unadjusted close.
Baseline: same name, one random non-event day (≥ 10 days from any event), same rule. Split: in-sample entries < 07-01,
holdout ≥ 07-01; cut = SPY above vs below its 200-day.
Pass (holdout): event − baseline ≥ +0.30 % of collateral per trade, block-bootstrap p < 0.05 by expiry week, and
event worst-decile not worse than baseline's by > 1 % of collateral.

    cd scripts/watchlist_sync && .venv/bin/python analysis/s049_panic_puts.py [--write]
"""
from __future__ import annotations

import math
import random
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import option_history as OH  # noqa: E402  (rate-limited Polygon get + chain/bar caches)
from build_plan import connect  # noqa: E402

START, HOLDOUT = date(2026, 1, 2), date(2026, 7, 1)
OUT = HERE.parent / "out" / "opt" / "S049.md"
rng = random.Random(49)


def ncdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def put_delta(S, K, v, t):
    sd = v * math.sqrt(t)
    return ncdf((math.log(S / K) + 0.5 * sd * sd) / sd) - 1


def load(conn):
    names = [r[0] for r in conn.execute("SELECT DISTINCT underlying FROM optlab.contracts").fetchall()]
    h = defaultdict(list)
    for t, d, c, iv in conn.execute("""SELECT ticker, date, close::float, iv30_put::float FROM lseg_research.daily_history
                                       WHERE ticker = ANY(%s) AND date >= %s ORDER BY ticker, date""",
                                    (names, START - timedelta(days=120))).fetchall():
        h[t].append((d, c, iv))
    raw = defaultdict(dict)
    for t, d, c in conn.execute("SELECT ticker, date, c FROM optlab.underlying WHERE ticker = ANY(%s) AND date >= %s",
                                (names, START)).fetchall():
        raw[t][d] = c
    spy = conn.execute("SELECT date, close::float FROM prices_historical WHERE ticker = 'SPY' AND date >= %s ORDER BY date",
                       (START - timedelta(days=400),)).fetchall()
    sma = {}
    for i in range(199, len(spy)):
        sma[spy[i][0]] = spy[i][1] < sum(c for _, c in spy[i - 199:i + 1]) / 200
    return h, raw, sma


def events(h):
    ev = defaultdict(list)
    for t, rows in h.items():
        last = None
        for i in range(65, len(rows) - 1):
            d = rows[i][0]
            if d < START:
                continue
            lr = [math.log(rows[j][1] / rows[j - 1][1]) for j in range(i - 64, i - 4)]
            sd = (sum((x - sum(lr) / len(lr)) ** 2 for x in lr) / (len(lr) - 1)) ** 0.5
            z = math.log(rows[i][1] / rows[i - 5][1]) / (sd * math.sqrt(5)) if sd else 0
            if z <= -2 and (last is None or (d - last).days >= 10):
                ev[t].append((i, z))
                last = d
    return ev


def trade(conn, t, rows, raw, i):
    """Enter at rows[i+1] close; None if no real price."""
    d, S_lseg, iv = rows[i + 1]
    S = raw[t].get(d)
    if not S or not iv:
        return None
    v = iv / 100
    exps = [r[0] for r in conn.execute("""SELECT DISTINCT expiry FROM optlab.contracts WHERE underlying = %s
                                          AND expiry BETWEEN %s AND %s""", (t, d + timedelta(15), d + timedelta(45))).fetchall()]
    if not exps:  # no listing cached → ask Polygon for the monthly nearest 30 DTE (third Friday)
        f = d + timedelta(30)
        third = date(f.year, f.month, 15) + timedelta((4 - date(f.year, f.month, 15).weekday()) % 7)
        exps = [third] if 15 <= (third - d).days <= 45 else []
    if not exps:
        return None
    e = min(exps, key=lambda x: abs((x - d).days - 30))
    if e >= OH.TODAY:
        return None
    ch = [c for c in OH.chain(conn, t, e, S) if c["type"] == "put"]
    T = (e - d).days / 365
    best = min(ch, key=lambda c: abs(put_delta(S, c["strike"], v, T) + 0.20), default=None)
    if not best:
        return None
    occ, K = best["occ"], float(best["strike"])
    OH.fetch_bars(conn, occ, e)
    px = conn.execute("SELECT c FROM optlab.bars WHERE occ = %s AND date = %s", (occ, d)).fetchone()
    settle = raw[t].get(e) or next((raw[t][x] for x in sorted(raw[t], reverse=True) if x <= e), None)
    if not px or not px[0] or settle is None:
        return None
    prem, intr = float(px[0]), max(0.0, K - settle)
    return dict(t=t, d=d, e=e, K=K, occ=occ, prem=prem, intr=intr, S=S, iv=iv, ret=(prem - intr) / K, breach=intr > 0)


def boot_p(ev, base, n=5000):
    """One-sided p that event − baseline ≤ 0, resampling expiry weeks (S015: breaches cluster by expiry)."""
    wk = defaultdict(lambda: ([], []))
    for x in ev:
        wk[x["e"].isocalendar()[:2]][0].append(x["ret"])
    for x in base:
        wk[x["e"].isocalendar()[:2]][1].append(x["ret"])
    keys = list(wk)
    obs, worse = None, 0
    for b in range(n + 1):
        ks = keys if b == 0 else [rng.choice(keys) for _ in keys]
        a = [r for k in ks for r in wk[k][0]]
        c = [r for k in ks for r in wk[k][1]]
        if not a or not c:
            continue
        diff = sum(a) / len(a) - sum(c) / len(c)
        if b == 0:
            obs = diff
        elif diff <= 0:
            worse += 1
    return obs, worse / n


def summ(x):
    if not x:
        return dict(n=0, mean=float("nan"), breach=float("nan"), worst=float("nan"))
    r = sorted(y["ret"] for y in x)
    w = r[: max(1, len(r) // 10)]
    return dict(n=len(x), mean=sum(r) / len(r), breach=sum(y["breach"] for y in x) / len(x), worst=sum(w) / len(w))


def main(write=False):
    conn = connect()
    h, raw, below = load(conn)
    ev_idx = events(h)
    ev, base = [], []
    for t, lst in ev_idx.items():
        rows = h[t]
        evd = [rows[i][0] for i, _ in lst]
        for i, z in lst:
            if i + 1 >= len(rows):
                continue
            tr = trade(conn, t, rows, raw, i)
            if tr:
                tr.update(z=z, below=below.get(rows[i][0]))
                ev.append(tr)
            ok = [j for j in range(65, len(rows) - 1) if rows[j][0] >= START
                  and all(abs((rows[j][0] - x).days) >= 10 for x in evd)]
            if ok:
                j = rng.choice(ok)
                bt = trade(conn, t, rows, raw, j)
                if bt:
                    bt.update(below=below.get(rows[j][0]))
                    base.append(bt)
        print(f"{t}: {len(lst)} events · running {len(ev)} ev / {len(base)} base", flush=True)
    report(ev, base)
    if write:
        publish(conn, ev)


def report(ev, base):
    L = ["# S049 — panic put-selling vs normal weeks (A178)", "",
         "Real option closes (optlab), 0.20Δ put ~30 DTE, next-day entry after a ≥ 2σ 5-day drop, held to expiry.", ""]
    L.append("| slice | events n | mean % coll | breach | worst 10 % | baseline n | mean | breach | worst 10 % |")
    L.append("|---|---|---|---|---|---|---|---|---|")
    sl = [("in-sample", lambda x: x["d"] < HOLDOUT), ("holdout", lambda x: x["d"] >= HOLDOUT), ("all", lambda x: True),
          ("SPY < 200d", lambda x: x["below"] is True), ("SPY ≥ 200d", lambda x: x["below"] is False)]
    for lab, f in sl:
        a, b = summ([x for x in ev if f(x)]), summ([x for x in base if f(x)])
        L.append(f"| {lab} | {a['n']} | {a['mean']:+.2%} | {a['breach']:.0%} | {a['worst']:+.1%} | {b['n']} | "
                 f"{b['mean']:+.2%} | {b['breach']:.0%} | {b['worst']:+.1%} |")
    he, hb = [x for x in ev if x["d"] >= HOLDOUT], [x for x in base if x["d"] >= HOLDOUT]
    diff, p = boot_p(he, hb) if he and hb else (float("nan"), 1.0)
    a, b = summ(he), summ(hb)
    ok = diff >= 0.003 and p < 0.05 and a["worst"] >= b["worst"] - 0.01
    L += ["", f"**Holdout: event − baseline = {diff:+.2%} per trade, bootstrap p = {p:.3f}, worst decile "
              f"{a['worst']:+.1%} vs {b['worst']:+.1%} → {'PASS' if ok else 'FAIL'}**"]
    OUT.write_text("\n".join(L))
    print("\n".join(L[3:]))


def publish(conn, ev):
    import strategy_lib as SL
    spy = [(d, float(c)) for d, c in conn.execute(
        "SELECT date, close FROM prices_historical WHERE ticker = 'SPY' AND date >= %s ORDER BY date", (START,)).fetchall()]
    he = [x for x in ev if x["d"] >= HOLDOUT]
    passed = "PASS" in OUT.read_text().splitlines()[-1]
    rows = [dict(entry_ts=SL.ts(x["d"]), exit_ts=SL.ts(x["e"]), ticker=x["t"], instrument="option", side="short",
                 option_type="P", strike=x["K"], expiry=x["e"], dte_at_entry=(x["e"] - x["d"]).days, qty=100,
                 entry_px=x["prem"], exit_px=x["intr"], capital=x["K"] * 100, pnl=(x["prem"] - x["intr"]) * 100,
                 ret_pct=x["ret"], trigger=f"{x['t']} fell {x['z']:.1f}σ in 5 days; IV {x['iv']:.0f} %",
                 exit_reason="held to expiry") for x in ev]
    s = dict(strategy_id="panic-puts", version="1", name="Panic put-selling", family="options-income", instrument="option",
             status="live" if passed else "failed", study_ref="S049",
             summary="After a stock falls ≥ 2σ in 5 days, sell a ~0.20Δ put ~30 DTE the next day.",
             rules_md=("Event: 5-day log return ÷ (60-day daily σ·√5) ≤ −2, one per name per 10 days. Next day: sell the put "
                       "nearest 0.20Δ at the expiry closest to 30 DTE (15–45), at the real option close; hold to expiry."),
             caveats_md=(f"- Universe = ~100 names we hold real option chains for (your book), not the full Model List.\n"
                         f"- Entry = last trade close, ~3 % above mid (S019) — same bias for the baseline.\n"
                         f"- Holdout trades: {len(he)}."),
             price_source="close", holdout_start=HOLDOUT)
    eq, _ = SL.equity(rows, spy, HOLDOUT)
    SL.write_rows(conn, s, rows, eq)
    conn.commit()


if __name__ == "__main__":
    main("--write" in sys.argv)
