"""S049 / A178 — panic put-selling, pre-registered in asks/A178.md (one run, no re-tuning).

Events (S025 rule): 5-day log return ÷ (prior 60-day daily σ·√5) ≤ −2, one per name per 10 days, 2026, all LSEG names
(~265, funds excluded). Prices = LSEG daily option history (research/lseg/option_prices.py; v1 used Polygon last-trade
closes on ~100 names and was stopped 10-19 — LSEG has bid/ask/mid for expired contracts and no 5/min cap).
Trade: next day, sell the monthly put (third Friday nearest 30 DTE, 15–45) at the listed strike nearest 0.20Δ (BS at that
day's iv30_put), entry = MID that day (skip if none), exit = the contract's last mid on/before expiry (≈ intrinsic).
Baseline: same name, one random non-event day (≥ 10 days from any event), same rule. Split: in-sample entries < 07-01,
holdout ≥ 07-01; cut = SPY above vs below its 200-day.
Pass (holdout): event − baseline ≥ +0.30 % of collateral per trade, block-bootstrap p < 0.05 by expiry week, and
event worst-decile not worse than baseline's by > 1 % of collateral.

    cd research/lseg && .venv/bin/python ../../scripts/watchlist_sync/analysis/s049_panic_puts.py --tickers=LVS,MNDY,BOX   # smoke
    cd research/lseg && .venv/bin/python ../../scripts/watchlist_sync/analysis/s049_panic_puts.py [--write]   # LSEG venv
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
from build_plan import connect  # noqa: E402

LSEG = HERE.parents[2] / "research" / "lseg"
sys.path.insert(0, str(LSEG))
import option_prices as OP  # noqa: E402
from _session import lseg_session  # noqa: E402

START, HOLDOUT = date(2026, 1, 2), date(2026, 7, 1)
END = date(2099, 1, 1)
if "--year2025" in sys.argv:  # A178 confirmation period (S054 rule), never published
    START, HOLDOUT, END = date(2025, 1, 2), date(2025, 1, 2), date(2025, 12, 31)
OUT = HERE.parent / "out" / "opt" / "S049.md"
rng = random.Random(49)


def ncdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def put_delta(S, K, v, t):
    sd = v * math.sqrt(t)
    return ncdf((math.log(S / K) + 0.5 * sd * sd) / sd) - 1


FUNDS = {"SPY", "QQQ", "IWM", "SMH", "XLB", "XLC", "XLE", "XLF", "XLI", "XLK", "XLP", "XLRE", "XLU", "XLV", "XLY", "DIA", "GLD", "TLT"}


def load(conn):
    h = defaultdict(list)
    for t, d, c, iv in conn.execute("""SELECT ticker, date, close::float, iv30_put::float FROM lseg_research.daily_history
                                       WHERE close > 0 AND date >= %s ORDER BY ticker, date""",
                                    (START - timedelta(days=120),)).fetchall():
        if t not in FUNDS:
            h[t].append((d, c, iv))
    spy = conn.execute("SELECT date, close::float FROM prices_historical WHERE ticker = 'SPY' AND date >= %s ORDER BY date",
                       (START - timedelta(days=400),)).fetchall()
    sma = {}
    for i in range(199, len(spy)):
        sma[spy[i][0]] = spy[i][1] < sum(c for _, c in spy[i - 199:i + 1]) / 200
    return h, sma


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
            if d > END:
                break
            if z <= -2 and (last is None or (d - last).days >= 10):
                ev[t].append((i, z))
                last = d
    return ev


def third_friday(y, m):
    d = date(y, m, 15)
    return d + timedelta((4 - d.weekday()) % 7)


def trade(ld, conn, t, rows, i):
    """Sell the ~0.20Δ monthly put the day after rows[i]; None if LSEG has no usable mid."""
    d, S, iv = rows[i + 1]
    if not iv:
        return None
    exps = [third_friday(y, m) for y, m in ((d.year, d.month), (d.year + d.month // 12, d.month % 12 + 1),
                                            (d.year + (d.month + 1) // 12, (d.month + 1) % 12 + 1))]
    exps = [e for e in exps if 15 <= (e - d).days <= 45 and e < date.today() - timedelta(days=1)]
    if not exps:
        return None
    e = min(exps, key=lambda x: abs((x - d).days - 30))
    v, T = iv / 100, (e - d).days / 365
    lo, hi = S * 0.5, S
    for _ in range(40):  # strike with BS put delta −0.20
        k = (lo + hi) / 2
        lo, hi = (k, hi) if put_delta(S, k, v, T) > -0.20 else (lo, k)
    for K in OP.strike_ladder((lo + hi) / 2):
        hist = OP.history(ld, conn, t, e, "P", K)
        if not hist:
            continue
        day = next((r for r in hist if r[0] == d), None)
        mid = (day[3] or ((day[1] + day[2]) / 2 if day[1] is not None and day[2] is not None else None)) if day else None
        if not mid or mid <= 0:
            return None
        last = [r for r in hist if r[0] <= e and r[3] is not None]
        settle = next((c for dd, c, _ in reversed(rows) if dd <= e), None)
        # Exit = intrinsic at the expiry close (smoke check 10-19: early-dated mids left time value — LVS 2.09 vs 0 — and
        # expiry-day mids keep half the spread on OTM puts — OWL 0.10 vs 0). Expiry-day mid only if no close.
        if settle is not None and 0.5 < K / S < 1.5:
            ex = max(0.0, K - settle)
        elif last and last[-1][0] >= e - timedelta(days=1):
            ex = max(0.0, last[-1][3])
        else:
            return None
        return dict(t=t, d=d, e=e, K=K, occ=f"{t} {e:%m/%d} {K:g}P", prem=mid, intr=ex, S=S, iv=iv, ret=(mid - ex) / K,
                    breach=(settle is not None and settle < K))  # finished in the money
    return None


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
    OP.ensure(conn)
    h, below = load(conn)
    ev_idx = events(h)
    ev, base = [], []
    with lseg_session() as ld:
        only = next((a.split('=', 1)[1].split(',') for a in sys.argv if a.startswith('--tickers=')), None)
        for t, lst in sorted(ev_idx.items()):
            if only and t not in only:
                continue
            rows = h[t]
            evd = [rows[i][0] for i, _ in lst]
            ok = [j for j in range(65, len(rows) - 1) if START <= rows[j][0] <= END
                  and all(abs((rows[j][0] - x).days) >= 10 for x in evd)]
            for i, z in lst:
                tr = trade(ld, conn, t, rows, i)
                if tr:
                    tr.update(z=z, below=below.get(rows[i][0]))
                    ev.append(tr)
                if ok:
                    j = rng.choice(ok)
                    bt = trade(ld, conn, t, rows, j)
                    if bt:
                        bt.update(below=below.get(rows[j][0]))
                        base.append(bt)
            print(f"{t}: {len(lst)} events · running {len(ev)} ev / {len(base)} base", flush=True)
    if not only:
        dump(conn, ev, base)
    if only:  # smoke mode: show trades to hand-check, no verdict/publish
        for x in (ev + base)[:12]:
            print(f"{x['t']} {x['d']} → {x['e']} K {x['K']} S {x['S']:.2f} entry {x['prem']:.2f} exit {x['intr']:.2f} "
                  f"ITM {x['breach']} ret {x['ret']:+.2%}")
        return
    report(ev, base)
    if write:
        publish(conn, ev)


def dump(conn, ev, base):
    """All simulated trades → watchlist_sync.study_trades for analysis/conditions_grid.py."""
    import json
    period = str(START.year)
    conn.execute("DELETE FROM watchlist_sync.study_trades WHERE study = 'S049' AND period = %s", (period,))
    with conn.cursor() as cur:
        cur.executemany("INSERT INTO watchlist_sync.study_trades VALUES ('S049', %s, %s, %s, %s, %s, %s, %s, %s)",
                        [(period, arm, x["t"], x["d"], x["e"], x["ret"], x["breach"],
                          json.dumps({"iv": x["iv"], "K": x["K"], "S": x["S"], "z": x.get("z"), "prem": x["prem"], "exit": x["intr"]}))
                         for arm, xs in (("event", ev), ("base", base)) for x in xs])
    conn.commit()


def report(ev, base):
    L = ["# S049 — panic put-selling vs normal weeks (A178)", "",
         "LSEG option mids, 0.20Δ monthly put ~30 DTE, next-day entry after a ≥ 2σ 5-day drop, held to expiry.", ""]
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
             status="candidate" if passed else "failed", study_ref="S049",  # candidate: in-sample sign disagreed (PLAYBOOK §4)
             summary="After a stock falls ≥ 2σ in 5 days, sell a ~0.20Δ put ~30 DTE the next day.",
             rules_md=("Event: 5-day log return ÷ (60-day daily σ·√5) ≤ −2, one per name per 10 days. Next day: sell the put "
                       "nearest 0.20Δ at the expiry closest to 30 DTE (15–45), at the real option close; hold to expiry."),
             caveats_md=(f"- Universe = ~265 LSEG names; monthly expiries only.\n"
                         f"- Entry = LSEG mid; exit = last mid on/before expiry (≈ intrinsic). No fees.\n"
                         f"- Holdout trades: {len(he)}. Jan–Jun panic puts did slightly WORSE than normal weeks (Feb software selloff: "
                         f"drops kept dropping) → candidate, graded live, not adopted."),
             price_source="real_quote", holdout_start=HOLDOUT)
    eq, _ = SL.equity(rows, spy, HOLDOUT)
    SL.write_rows(conn, s, rows, eq)
    conn.commit()


if __name__ == "__main__" and "--publish-rule" not in sys.argv:
    main("--write" in sys.argv)


def publish_rule(conn):
    """S054 rule, confirmed on 2026 H2 + 2025 (A178): panic drop AND stock iv30 > 48.7 → strategy panic-puts-hiv."""
    import strategy_lib as SL
    rows = conn.execute("""SELECT ticker, entry_d, exit_d, ret, feats FROM watchlist_sync.study_trades
                           WHERE study = 'S049' AND arm = 'event' AND (feats->>'iv')::float > 48.7 ORDER BY entry_d""").fetchall()
    tr = [dict(entry_ts=SL.ts(d), exit_ts=SL.ts(e), ticker=t, instrument="option", side="short", option_type="P",
               strike=f["K"], expiry=e, dte_at_entry=(e - d).days, qty=100, entry_px=f["prem"], exit_px=f["exit"],
               capital=f["K"] * 100, pnl=r * f["K"] * 100, ret_pct=r,
               trigger=f"{t} fell {f['z']:.1f}σ in 5 days; IV {f['iv']:.0f} % (> 49)", exit_reason="held to expiry")
          for t, d, e, r, f in rows]
    spy = [(d, float(c)) for d, c in conn.execute("SELECT date, close FROM lseg_research.daily_history WHERE ticker = 'SPY' "
                                                  "AND date >= %s AND close > 0 ORDER BY date", (min(x["expiry"] for x in tr) - timedelta(days=60),)).fetchall()]
    s = dict(strategy_id="panic-puts-hiv", version="1", name="Panic puts, high IV", family="options-income", instrument="option",
             status="live", study_ref="S049/S054",
             summary="After a ≥ 2σ 5-day drop, sell the ~0.20Δ monthly put next day, only when the stock's IV30 > 49.",
             rules_md=("Event: 5-day log return ÷ (60-day σ·√5) ≤ −2 (one per name per 10 days). Filter: IV30 > 48.7 at entry "
                       "(fear priced in). Sell the monthly put nearest 0.20Δ, ~30 DTE (15–45), at the LSEG mid; hold to expiry."),
             caveats_md=("- Found on 2026 Jan–Jun; confirmed on 2026 Jul–Oct (+4.05 % vs +0.26 % skipped) and on 2025 "
                         "(+3.15 % vs +1.63 % normal-week puts, p 0.002, worst decile −6.2 % vs −13.3 %).\n"
                         "- Mid fills, no fees; exit = intrinsic at the expiry close. ~265 LSEG names.\n"
                         "- Conditions grid (S049_grid.md): no single regime/sector cell passes Holm yet; stressed-vol regimes "
                         "lift all put selling."),
             price_source="real_quote", holdout_start=None)
    eq, _ = SL.equity(tr, spy, None)
    SL.write_rows(conn, s, tr, eq)
    conn.commit()
    print(f"published panic-puts-hiv: {len(tr)} trades, total {eq[-1][1] - 1:+.1%} vs SPY {eq[-1][2] - 1:+.1%}, max DD {min(r[3] for r in eq):.1%}")


if __name__ == "__main__" and "--publish-rule" in sys.argv:
    publish_rule(connect())
