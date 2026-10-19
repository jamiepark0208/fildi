"""S048 / A177b — 0DTE tail lotto on SPY, pre-registered in asks/A177.md (one run, no re-tuning).

Trigger: first minute SPY's move from the open reaches k·σ, σ = prior day's SPY iv30_put ÷ √252 (VIX not stored; same
idea), k ∈ {1.5, 2} → two variants. Buy the 0DTE contract ~1 % OTM in the move's direction (down → put, up → call),
1 contract, entry = HIGHEST trade print in the 5 minutes after the trigger (no quotes on our plan → pessimistic ask).
Exit: first minute whose high ≥ 10 × entry (filled at 10×), else intrinsic at SPY's 16:00 close (cash value at expiry).
In-sample 2026-01-02 → 06-30, holdout 07-01 → latest. Fail = holdout pnl ≤ 0.

Minute bars are cached in optlab.minute_bars (Polygon 5 calls/min → only trigger days' contracts are fetched).

    cd scripts/watchlist_sync && .venv/bin/python analysis/s048_0dte.py [--write]
"""
from __future__ import annotations

import json
import math
import os
import sys
import time
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402

NY = ZoneInfo("America/New_York")
START, HOLDOUT = date(2026, 1, 2), date(2026, 7, 1)
KS = (1.5, 2.0)
OTM = 0.01
TARGET = 10.0
BANKROLL = 10_000.0  # page curve: $ pnl ÷ a fixed $10k lotto bankroll
OUT = HERE.parent / "out" / "opt" / "S048.md"


def poly(path: str) -> dict:
    import option_history as OH  # shared Polygon gate + api_usage count
    return OH.get(path)


def minute_bars(conn, ticker: str, d0: date, d1: date):
    """Cached 1-minute bars (regular session only) keyed by ticker; fetched once per (ticker, range)."""
    have = conn.execute("SELECT 1 FROM optlab.minute_fetched WHERE ticker = %s AND d0 <= %s AND d1 >= %s",
                        (ticker, d0, d1)).fetchone()
    if not have:
        rows, nxt = [], f"/v2/aggs/ticker/{ticker}/range/1/minute/{d0}/{d1}?limit=50000&sort=asc"
        while nxt:
            r = poly(nxt.replace("https://api.polygon.io", ""))
            rows += r.get("results", [])
            nxt = r.get("next_url")
        with conn.cursor() as cur:
            cur.executemany("INSERT INTO optlab.minute_bars VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                            [(ticker, datetime.fromtimestamp(b["t"] / 1000, NY), b["o"], b["h"], b["l"], b["c"], b["v"])
                             for b in rows])
        conn.execute("INSERT INTO optlab.minute_fetched VALUES (%s,%s,%s)", (ticker, d0, d1))
        conn.commit()
    return conn.execute("""SELECT ts, o, h, l, c, v FROM optlab.minute_bars WHERE ticker = %s AND ts >= %s AND ts < %s
                           AND (ts AT TIME ZONE 'America/New_York')::time BETWEEN '09:30' AND '15:59' ORDER BY ts""",
                        (ticker, datetime.combine(d0, datetime.min.time(), NY),
                         datetime.combine(d1 + timedelta(days=1), datetime.min.time(), NY))).fetchall()


def ensure(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS optlab.minute_bars (ticker text, ts timestamptz, o real, h real, l real,
                    c real, v real, PRIMARY KEY (ticker, ts))""")
    conn.execute("CREATE TABLE IF NOT EXISTS optlab.minute_fetched (ticker text, d0 date, d1 date)")
    conn.commit()


def occ(d: date, cp: str, k: float) -> str:
    return f"O:SPY{d:%y%m%d}{cp}{round(k * 1000):08d}"


def main(write: bool = False) -> None:
    conn = connect()
    ensure(conn)
    iv = dict(conn.execute("""SELECT date, iv30_put::float FROM lseg_research.daily_history
                              WHERE ticker = 'SPY' AND date >= %s - 10 ORDER BY date""", (START,)).fetchall())
    end = max(iv)
    spy = defaultdict(list)
    for d0, d1 in ((START, date(2026, 4, 30)), (date(2026, 5, 1), end)):
        for ts, o, h, l, c, v in minute_bars(conn, "SPY", d0, d1):
            spy[ts.astimezone(NY).date()].append((ts, o, h, l, c))
    trades = {k: [] for k in KS}
    for d in sorted(spy):
        prior = [x for x in iv if x < d]
        if not prior or not iv[max(prior)]:
            continue
        sig = iv[max(prior)] / 100 / math.sqrt(252)
        bars = spy[d]
        op, close = bars[0][1], bars[-1][4]
        for k in KS:
            # minute closes, not h/l: Polygon h/l carry bad ticks (S052: 06-26 15:59 low 716.58 vs close 729.09)
            hit = next((i for i, b in enumerate(bars) if abs(b[4] / op - 1) >= k * sig), None)
            if hit is None or hit >= len(bars) - 6:
                continue
            b = bars[hit]
            down = b[4] < op
            px = b[4]
            cp = "P" if down else "C"
            strike = round(px * (1 - OTM)) if down else round(px * (1 + OTM))
            t0 = b[0]
            ob = minute_bars(conn, occ(d, cp, strike), d, d)
            win = [x for x in ob if t0 < x[0] <= t0 + timedelta(minutes=5)]
            rec = dict(d=d, k=k, cp=cp, strike=strike, trig=t0.astimezone(NY).strftime("%H:%M"), move=b[4] / op - 1,
                       sig=sig, spot=px, close=close)
            if not win:
                rec.update(entry=None)
                trades[k].append(rec)
                continue
            entry = max(x[2] for x in win)
            after = [x for x in ob if x[0] > win[-1][0]]
            tgt = next((x for x in after if x[2] >= TARGET * entry), None)
            intr = max(0.0, strike - close) if down else max(0.0, close - strike)
            exit_px, why, exit_ts = ((TARGET * entry, f"hit {TARGET:.0f}× target", tgt[0]) if tgt
                                     else (intr, "expired at close (intrinsic)", bars[-1][0]))
            rec.update(entry=entry, exit=exit_px, why=why, exit_ts=exit_ts, entry_ts=win[-1][0],
                       pnl=(exit_px - entry) * 100, risk=entry * 100)
            trades[k].append(rec)
    import option_history as OH
    OH.flush_usage(conn)
    report(trades, end)
    if write:
        publish(conn, trades, end)


def stats(tr):
    t = [x for x in tr if x.get("entry")]
    if not t:
        return dict(n=0, pnl=0, risk=0, hits=0, big=0, share=0)
    pnl = sum(x["pnl"] for x in t)
    big = max(x["pnl"] for x in t)
    return dict(n=len(t), pnl=pnl, risk=sum(x["risk"] for x in t), hits=sum(x["pnl"] > 0 for x in t), big=big,
                share=(big / pnl if pnl > 0 else float("nan")))


def report(trades, end):
    L = [f"# S048 — 0DTE tail lotto on SPY (A177b), 2026-01-02 → {end}", "",
         "Pre-registered in asks/A177.md. Entry = highest print in 5 min after trigger (no quotes → pessimistic).", ""]
    for k, tr in trades.items():
        L.append(f"## k = {k}σ")
        for lab, sub in (("in-sample (Jan–Jun)", [x for x in tr if x["d"] < HOLDOUT]),
                         ("holdout (Jul→)", [x for x in tr if x["d"] >= HOLDOUT]), ("all", tr)):
            s = stats(sub)
            nofill = sum(1 for x in sub if not x.get("entry"))
            L.append(f"- {lab}: {len(sub)} trigger days, {s['n']} filled ({nofill} no print), hit rate "
                     f"{s['hits']}/{s['n']}, pnl ${s['pnl']:+,.0f} on ${s['risk']:,.0f} risked "
                     f"({(s['pnl'] / s['risk'] if s['risk'] else 0):+.0%}), largest win ${s['big']:+,.0f}")
        ho = stats([x for x in tr if x["d"] >= HOLDOUT])
        L.append(f"- **Verdict: {'PASS' if ho['pnl'] > 0 else 'FAIL'}** (holdout pnl ${ho['pnl']:+,.0f})")
        L.append("")
        L.append("| day | trigger | move | contract | entry | exit | pnl | why |")
        L.append("|---|---|---|---|---|---|---|---|")
        for x in tr:
            if x.get("entry"):
                L.append(f"| {x['d']} | {x['trig']} | {x['move']:+.2%} | {x['strike']}{x['cp']} | {x['entry']:.2f} | "
                         f"{x['exit']:.2f} | {x['pnl']:+,.0f} | {x['why']} |")
            else:
                L.append(f"| {x['d']} | {x['trig']} | {x['move']:+.2%} | {x['strike']}{x['cp']} | — | — | — | no print |")
        L.append("")
    OUT.write_text("\n".join(L))
    for k, tr in trades.items():
        a, h = stats(tr), stats([x for x in tr if x["d"] >= HOLDOUT])
        print(f"k={k}: {len(tr)} triggers, {a['n']} filled, hits {a['hits']}, pnl ${a['pnl']:+,.0f} / ${a['risk']:,.0f} "
              f"risked, biggest ${a['big']:+,.0f} | holdout ${h['pnl']:+,.0f} on {h['n']}")


def publish(conn, trades, end):
    import strategy_lib as SL
    spy = [(d, float(c)) for d, c in conn.execute(
        "SELECT date, close FROM prices_historical WHERE ticker = 'SPY' AND date >= %s ORDER BY date", (START,)).fetchall()]
    for k, tr in trades.items():
        rows = []
        for x in tr:
            if not x.get("entry"):
                continue
            rows.append(dict(entry_ts=x["entry_ts"], exit_ts=x["exit_ts"], ticker="SPY", instrument="option", side="long",
                             option_type=x["cp"], strike=float(x["strike"]), expiry=x["d"], dte_at_entry=0, qty=100,
                             entry_px=x["entry"], exit_px=x["exit"], capital=x["risk"], pnl=x["pnl"],
                             ret_pct=x["pnl"] / x["risk"],
                             trigger=f"SPY {x['move']:+.2%} from open by {x['trig']} (≥ {k}σ)", exit_reason=x["why"]))
        if not rows:
            continue
        ho = stats([x for x in tr if x["d"] >= HOLDOUT])
        s = dict(strategy_id=f"spy-0dte-lotto-k{str(k).replace('.', '')}", version="1",
                 name=f"SPY 0DTE tail lotto (≥ {k}σ move)", family="tail/long-option", instrument="option",
                 status="live" if ho["pnl"] > 0 else "failed", study_ref="S048",
                 summary=f"When SPY moves ≥ {k}σ from the open, buy a ~1 % OTM same-day option in that direction.",
                 rules_md=(f"σ = prior day's SPY 30-day IV ÷ √252. First minute the move from the open reaches {k}σ → buy one "
                           "0DTE contract ~1 % OTM in the move's direction (down → put). Entry = highest trade in the next "
                           "5 minutes. Exit at 10× entry if it trades there, else cash value at the close."),
                 caveats_md=("- Prices are **trade prints**, not quotes (our plan has no bid/ask) → entry uses the highest "
                             "print, a pessimistic stand-in for the ask.\n- One contract per trigger; sizing is $ risked = "
                             "premium. Curve = cumulative $ pnl ÷ a fixed $10k bankroll (no compounding).\n"
                             "- 2026 holds few true tail days; a pass is thin evidence."),
                 price_source="close", holdout_start=HOLDOUT)
        eq, _ = SL.equity(rows, spy, HOLDOUT, bankroll=BANKROLL)
        SL.write_rows(conn, s, rows, eq)
    conn.commit()


if __name__ == "__main__":
    for p in (Path(__file__).resolve().parents[3] / ".env.local",):
        if p.is_file():
            from dotenv import load_dotenv
            load_dotenv(p)
    main("--write" in sys.argv)
