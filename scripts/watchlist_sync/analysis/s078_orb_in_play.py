"""S078 — intraday momentum, the published versions S056 didn't test (A219, Jamie 10-21: "is this idea not expandable?").

S056 tested plain 5-min ORB on SPY alone, stop at the range's far side → −0.009 %/day, 82 % stop-outs. The literature's
working variants differ on exactly those points:
  A  Stocks-in-Play ORB (Zarattini, Barbon & Aziz 2024, SFI 24-98; QuantConnect replication Sharpe 2.4): each day trade
     only the 20 names with the highest relative volume in the first 5 minutes (vs their 14-day average for that bar),
     price > $5, ATR14 > $0.50; direction = first bar's colour; stop = 10 % of ATR14; risk 1 % per trade; exit at close.
  B  SPY noise-area momentum (Zarattini, Aziz & Barbon 2024 "Beat the Market", SFI 24-97: Sharpe 1.33 2007-24): enter at
     :00/:30 when SPY is outside open ± its 14-day average move-from-open at that minute; trailing stop = the boundary or
     VWAP, whichever is tighter; vol-targeted (2 % daily, ≤ 4× leverage); flat at the close.
  C  Put-book bridge: on Mondays, a watchlist name in play that breaks DOWN out of its opening range — is that week's
     ~1σ put (S059 harness) worse? → a "don't sell this one today" tag if so.

Data: Polygon 5-min aggregates, 2 years (free tier), cached in optlab.bars_5m; costs $0.0035 + $0.001 per share (papers).
Pre-registered (one run, no re-cut): A and B each pass if net annualized Sharpe ≥ 1.0, month-cluster t ≥ 2 on mean daily
return, both years > 0, and Sharpe above SPY buy-and-hold over the same days. C (descriptive → tag only if) tagged
weeks' breach ≥ 1.5× untagged with n ≥ 100 and the same sign in both years.

    cd scripts/watchlist_sync && .venv/bin/python analysis/s078_orb_in_play.py [--fetch]
"""
from __future__ import annotations

import math
import statistics as st
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402
import option_history as OH  # noqa: E402  (Polygon get(): shared 5/min gate, key, retries)

OUT = HERE.parent / "out" / "opt" / "S078.md"
START = date.today() - timedelta(days=729)
DDL = """CREATE TABLE IF NOT EXISTS optlab.bars_5m (ticker text, ts timestamptz, o real, h real, l real, c real, v real,
  PRIMARY KEY (ticker, ts));
CREATE TABLE IF NOT EXISTS optlab.bars_5m_fetched (ticker text PRIMARY KEY, lo date, hi date, n int, fetched_at timestamptz DEFAULT now())"""


N_NAMES = 150   # most-traded by 60-day dollar volume (free Polygon pages ~12k bars → ~8 calls per name for 2 years)


def universe(conn) -> list[str]:
    names = [t for (t,) in conn.execute("""SELECT ticker FROM lseg_research.daily_history WHERE date >= current_date - 60
                                         AND close > 5 GROUP BY 1 ORDER BY AVG(close * volume) DESC NULLS LAST LIMIT %s""", (N_NAMES,))]
    return ["SPY", "QQQ"] + [t for t in names if t not in ("SPY", "QQQ")]


def fetch(conn) -> None:
    for s in DDL.split(";"):
        conn.execute(s)
    conn.commit()
    names = universe(conn)
    for i, t in enumerate(names):
        got = conn.execute("SELECT hi FROM optlab.bars_5m_fetched WHERE ticker = %s", (t,)).fetchone()
        frm = (got[0] + timedelta(days=1)) if got else START
        if frm >= date.today():
            continue
        n, to = 0, date.today() - timedelta(days=1)
        path = f"/v2/aggs/ticker/{t}/range/5/minute/{frm}/{to}?adjusted=true&sort=asc&limit=50000"
        while path:   # free tier pages at ~12k bars → follow next_url
            d = OH.get(path)
            res = d.get("results") or []
            with conn.cursor() as c:
                c.executemany("INSERT INTO optlab.bars_5m VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                              [(t, datetime.fromtimestamp(r["t"] / 1000, timezone.utc), r.get("o"), r.get("h"), r.get("l"),
                                r.get("c"), r.get("v")) for r in res])
            conn.commit()
            n += len(res)
            nxt = d.get("next_url")
            path = nxt[len(OH.API):] if nxt and res else None
        conn.execute("INSERT INTO optlab.bars_5m_fetched (ticker, lo, hi, n) VALUES (%s,%s,%s,%s) ON CONFLICT (ticker) DO UPDATE "
                     "SET hi = EXCLUDED.hi, n = optlab.bars_5m_fetched.n + EXCLUDED.n, fetched_at = now()",
                     (t, frm, to, n))
        conn.commit()
        if i % 25 == 0:
            print(f"  {i + 1}/{len(names)} {t}: {n} bars", flush=True)
    OH.flush_usage(conn)


ET = ZoneInfo("America/New_York")
COST = 2 * (0.0035 + 0.001)   # $/share round trip (commission + slippage, both papers)


def load_days(conn, t: str) -> list[dict]:
    """Regular-session 5-min bars per ET day: [{d, bars: [(min_from_open, o, h, l, c, v)], o, h, l, c}]."""
    days: dict = defaultdict(list)
    for ts, o, h, l, c, v in conn.execute("SELECT ts, o, h, l, c, v FROM optlab.bars_5m WHERE ticker = %s ORDER BY ts", (t,)):
        e = ts.astimezone(ET)
        m = e.hour * 60 + e.minute - 570
        if 0 <= m < 390 and None not in (o, h, l, c):
            days[e.date()].append((m, o, h, l, c, v or 0))
    out = []
    for d in sorted(days):
        b = days[d]
        if len(b) < 60 or b[0][0] != 0:   # half days / missing open bar
            continue
        out.append({"d": d, "bars": b, "o": b[0][1], "h": max(x[2] for x in b), "l": min(x[3] for x in b), "c": b[-1][4]})
    for i, x in enumerate(out):   # ATR14 + 14-day mean first-bar volume, both from prior days only
        if i >= 14:
            tr = [max(out[j]["h"], out[j - 1]["c"]) - min(out[j]["l"], out[j - 1]["c"]) for j in range(i - 14, i)]
            x["atr"] = sum(tr) / 14
            x["v0"] = sum(out[j]["bars"][0][5] for j in range(i - 14, i)) / 14
            x["pc"] = out[i - 1]["c"]
    return out


def orb_trade(x: dict, stop_mode: str = "atr") -> float | None:
    """One Stocks-in-Play ORB trade → pnl in $/share net of costs per $ of risk-unit shares (returns (pnl, shares))."""
    b = x["bars"]
    o0, h0, l0, c0 = b[0][1:5]
    if c0 == o0:
        return None
    side = 1 if c0 > o0 else -1
    lvl = h0 if side > 0 else l0
    risk = 0.10 * x["atr"] if stop_mode == "atr" else (h0 - l0)
    if risk <= 0:
        return None
    entry = stop = None
    for m, o, h, l, c, v in b[1:]:
        if entry is None:
            if (side > 0 and h >= lvl) or (side < 0 and l <= lvl):
                entry = max(lvl, o) if side > 0 else min(lvl, o)
                stop = entry - side * risk
                if (side > 0 and l <= stop) or (side < 0 and h >= stop):   # same bar: assume the stop (conservative)
                    return (-risk - COST, risk, entry)
            continue
        if (side > 0 and l <= stop) or (side < 0 and h >= stop):
            ex = min(stop, o) if side > 0 else max(stop, o)
            return (side * (ex - entry) - COST, risk, entry)
    if entry is None:
        return None
    return (side * (b[-1][4] - entry) - COST, risk, entry)


def stats(daily: dict, split: date) -> dict:
    ds = sorted(daily)
    r = [daily[d] for d in ds]
    if len(r) < 40:
        return {}
    mu, sd = st.mean(r), st.pstdev(r)
    mon = defaultdict(list)
    for d in ds:
        mon[d.strftime("%Y-%m")].append(daily[d])
    mm = [st.mean(v) for v in mon.values()]
    t = st.mean(mm) / (st.stdev(mm) / math.sqrt(len(mm))) if len(mm) > 2 and st.stdev(mm) else float("nan")
    y1 = [daily[d] for d in ds if d < split]
    y2 = [daily[d] for d in ds if d >= split]
    cum, peak, dd = 1.0, 1.0, 0.0
    for x in r:
        cum *= 1 + x
        peak = max(peak, cum)
        dd = min(dd, cum / peak - 1)
    return {"days": len(r), "mean_bp": mu * 1e4, "sharpe": mu / sd * math.sqrt(252) if sd else 0, "t": t,
            "y1_bp": st.mean(y1) * 1e4 if y1 else float("nan"), "y2_bp": st.mean(y2) * 1e4 if y2 else float("nan"),
            "total": cum - 1, "maxdd": dd}


def strat_a(panel: dict, top: int = 20, rv_filter: bool = True, stop_mode: str = "atr") -> tuple[dict, list]:
    """Daily portfolio return: each trade risks 1 % of equity; notional per trade ≤ 4 / top of equity."""
    byday = defaultdict(list)
    for t, days in panel.items():
        if t in ("SPY", "QQQ"):
            continue
        for x in days:
            if "atr" in x and x["o"] > 5 and x["atr"] > 0.5 and x["v0"] > 0:
                byday[x["d"]].append((x["bars"][0][5] / x["v0"], t, x))
    daily, trades = {}, []
    for d, cands in byday.items():
        pick = sorted(cands, reverse=True, key=lambda z: z[0])
        pick = [z for z in pick if z[0] >= 1.0][:top] if rv_filter else pick[:top] if top else pick
        ret = 0.0
        for rv, t, x in pick:
            tr = orb_trade(x, stop_mode)
            if not tr:
                continue
            pnl, risk, entry = tr
            shares = min(0.01 / risk, (4 / top) / entry)   # per $1 of equity
            ret += shares * pnl
            trades.append((d, t, pnl / risk, rv))
        daily[d] = ret
    return daily, trades


def strat_b(days: list[dict]) -> dict:
    """SPY noise-area momentum on 5-min bars (checks at :00/:30), trailing stop = boundary/VWAP, vol target 2 % (≤ 4×)."""
    daily = {}
    for i in range(15, len(days)):
        x, prev = days[i], days[i - 14:i]
        mv = defaultdict(list)
        for p in prev:
            for m, o, h, l, c, v in p["bars"]:
                mv[m].append(abs(c / p["o"] - 1))
        rets = [days[j]["c"] / days[j - 1]["c"] - 1 for j in range(i - 14, i)]
        lev = min(4.0, 0.02 / st.pstdev(rets)) if st.pstdev(rets) else 1.0
        up_ref, dn_ref = max(x["o"], days[i - 1]["c"]), min(x["o"], days[i - 1]["c"])
        pos, entry, ret, pv, vv = 0, None, 0.0, 0.0, 0.0
        for m, o, h, l, c, v in x["bars"]:
            pv += c * v
            vv += v
            vwap = pv / vv if vv else c
            if (m + 5) % 30 or m < 25:     # decide on the bar closing at :00 / :30, from 10:00
                continue
            sig = st.mean(mv[m]) if mv.get(m) else None
            if sig is None:
                continue
            ub, lb = up_ref * (1 + sig), dn_ref * (1 - sig)
            if pos > 0 and c < max(ub, vwap) or pos < 0 and c > min(lb, vwap):
                ret += lev * pos * (c / entry - 1) - lev * COST / c
                pos, entry = 0, None
            if pos == 0:
                if c > ub:
                    pos, entry = 1, c
                elif c < lb:
                    pos, entry = -1, c
        if pos:
            c = x["bars"][-1][4]
            ret += lev * pos * (c / entry - 1) - lev * COST / c
        daily[x["d"]] = ret
    return daily


def bridge(conn, panel: dict) -> list[str]:
    """C: Monday weekly ~1σ puts (S059 harness) on names in play that broke down in the first 30 min vs the rest."""
    from s059_option_factors import aligned_events
    tag = {}
    for t, days in panel.items():
        for x in days:
            if "v0" in x and x["v0"] > 0:
                b = x["bars"]
                rv = b[0][5] / x["v0"]
                c30 = b[5][4] if len(b) > 5 else b[-1][4]
                tag[(t, x["d"])] = rv >= 2.0 and c30 < b[0][3]   # 2× normal opening volume and below the first bar's low at 10:00
    ev = [e for e in aligned_events(conn) if (e["t"], e["d"]) in tag]
    if not ev:
        return ["C: no overlap between the S059 trades and the bar panel"]
    split = START + timedelta(days=365)
    L = []
    for lab, f in (("all", lambda e: True), ("year 1", lambda e: e["d"] < split), ("year 2", lambda e: e["d"] >= split)):
        a = [e for e in ev if f(e) and tag[(e["t"], e["d"])]]
        z = [e for e in ev if f(e) and not tag[(e["t"], e["d"])]]
        if a and z:
            L.append(f"| {lab} | {len(a)} | {st.mean(e['breach'] for e in a):.1%} | {st.mean(e['pnl'] for e in a) * 1e4:+.1f} | "
                     f"{len(z)} | {st.mean(e['breach'] for e in z):.1%} | {st.mean(e['pnl'] for e in z) * 1e4:+.1f} |")
    return ["| slice | tagged n | tagged breach | tagged pnl bp | other n | other breach | other pnl bp |", "|---|---|---|---|---|---|---|"] + L


def main() -> None:
    conn = connect()
    if "--fetch" in sys.argv:
        fetch(conn)
        return
    names = [t for (t,) in conn.execute("SELECT ticker FROM optlab.bars_5m_fetched WHERE n > 0 ORDER BY ticker")]
    only = next((a.split("=", 1)[1].split(",") for a in sys.argv if a.startswith("--tickers=")), None)
    if only:
        names = [t for t in names if t in only]
    panel = {t: load_days(conn, t) for t in names}
    split = START + timedelta(days=365)
    fmt = lambda s: (f"{s['days']} d · {s['mean_bp']:+.1f} bp/day · Sharpe {s['sharpe']:.2f} · month-t {s['t']:+.2f} · "
                     f"yr1 {s['y1_bp']:+.1f} / yr2 {s['y2_bp']:+.1f} bp · total {s['total']:+.1%} · max DD {s['maxdd']:.1%}") if s else "n/a"
    spy = panel.get("SPY", [])
    bh = {spy[i]["d"]: spy[i]["c"] / spy[i - 1]["c"] - 1 for i in range(1, len(spy))}
    L = ["# S078 — intraday momentum variants S056 didn't test (Stocks-in-Play ORB, SPY noise area, put-book bridge)", "",
         f"{len(panel)} names · Polygon 5-min bars {START} → · costs ${COST:.4f}/share round trip · pre-registered: Sharpe ≥ 1, "
         "month-t ≥ 2, both years > 0, Sharpe above SPY buy-and-hold.", ""]
    s_bh = stats(bh, split)
    L += [f"**SPY buy-and-hold:** {fmt(s_bh)}", "", "## A — Stocks-in-Play ORB (top 20 by opening relative volume, ATR stop)"]
    da, tr = strat_a(panel)
    sa = stats({d: da.get(d, 0.0) for d in bh}, split)
    ok_a = bool(sa) and sa["sharpe"] >= 1 and sa["t"] >= 2 and sa["y1_bp"] > 0 and sa["y2_bp"] > 0 and sa["sharpe"] > s_bh.get("sharpe", 0)
    L += [f"- {fmt(sa)} · trades {len(tr)} · mean R {st.mean(x[2] for x in tr):+.3f} · win {st.mean(x[2] > 0 for x in tr):.0%}" if tr else "- no trades",
          f"- **Verdict A: {'PASS' if ok_a else 'FAIL'}**", "", "Ablations (descriptive — which ingredient carries it):"]
    for lab, kw in (("top 10", {"top": 10}), ("no relative-volume filter (top 20 by RV, incl. < 1)", {"rv_filter": False}),
                    ("range stop instead of ATR stop (≈ S056 rule)", {"stop_mode": "range"})):
        d2, t2 = strat_a(panel, **kw)
        L.append(f"- {lab}: {fmt(stats({d: d2.get(d, 0.0) for d in bh}, split))}")
    rv_b = defaultdict(list)
    for d, t, r, rv in tr:
        rv_b["RV 1–2" if rv < 2 else "RV 2–4" if rv < 4 else "RV ≥ 4"].append(r)
    L.append("- by relative volume: " + " · ".join(f"{k} mean R {st.mean(v):+.3f} (n {len(v)})" for k, v in sorted(rv_b.items())))
    L += ["", "## B — SPY noise-area momentum (VWAP / boundary trailing stop, vol-targeted)"]
    sb = stats(strat_b(spy), split) if spy else {}
    ok_b = bool(sb) and sb["sharpe"] >= 1 and sb["t"] >= 2 and sb["y1_bp"] > 0 and sb["y2_bp"] > 0 and sb["sharpe"] > s_bh.get("sharpe", 0)
    L += [f"- {fmt(sb)}", f"- **Verdict B: {'PASS' if ok_b else 'FAIL'}**"]
    if "QQQ" in panel:
        L.append(f"- QQQ (same rules, descriptive): {fmt(stats(strat_b(panel['QQQ']), split))}")
    L += ["", "## C — put-book bridge: in play + broke below the first 5-min low by 10:00 on the put's entry day"] + bridge(conn, panel)
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
