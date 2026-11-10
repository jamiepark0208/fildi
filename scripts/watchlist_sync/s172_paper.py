"""S172 paper + live signal — market bottom: VIX÷VIX3M un-inverts (Jamie 11-09; Tom Lee's 1m/3m-curve tell).

S172 (analysis/s172_bottom_signals.py, 2009→, 33–38 episodes): on the first close with VIX÷VIX3M < 1 after ≥ 2 sessions ≥ 1,
  0.50Δ ~30 DTE calls held to expiry beat the same call bought any day by +34 % (SPY) / +43 % (QQQ) / +39 % (IWM) per $ debit,
  both halves, placebo p ≤ 0.05; real LSEG SPY quotes at the ask on 11 episodes 2019→: mean +74 %, 7/11 win.
  0.20Δ ~30 DTE short puts: SPY 95 % / QQQ 94 % win, lift > 0 both halves, p 0.00. Early entry (ratio still ≥ 1) and VIX9D,
  VIX-drop, VVIX-peak signals failed.

On a signal day (latest macro_daily vix/vix3m close; one per 14 days):
  calls → forecast_ledger qtype long_call_ts, forecaster S172, live Schwab ask (chain-ladder), resolves at expiry
          (_r_long_call_ts: bid on the day, else intrinsic) — outcome = call P&L > same-Δ stock P&L.
  puts  → strategy_signals 'vix-uninvert-put' (SPY, QQQ) → priced on LSEG + graded at expiry by strategy_signals.py.
Runs after the `vix` step in daily.py. Entry is the session after the signal close (backtest: at the close) — say so in grading.

    cd scripts/watchlist_sync && .venv/bin/python s172_paper.py [--dry-run]
"""
from __future__ import annotations

import json
import sys
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "analysis"))
from build_plan import connect  # noqa: E402
from forecast_ledger import UPSERT  # noqa: E402

ARM = "S172"
CALLS = ("SPY", "QQQ", "IWM")
PUTS = ("SPY", "QQQ")
PUT_SID = "vix-uninvert-put"
DELTA_CALL = 0.50
DTE_LO, DTE_HI, DTE_TARGET = 20, 45, 30
CLUSTER_DAYS = 14


def curve(conn, n: int = 30) -> list[tuple[date, float]]:
    """[(date, VIX÷VIX3M)] newest last (vix_daily.py → macro_daily)."""
    rows = conn.execute("""SELECT a.date, a.value / b.value FROM watchlist_sync.macro_daily a
                           JOIN watchlist_sync.macro_daily b ON b.date = a.date AND b.series = 'vix3m'
                           WHERE a.series = 'vix' AND b.value > 0 ORDER BY a.date DESC LIMIT %s""", (n,)).fetchall()
    return [(d, float(r)) for d, r in reversed(rows)]


def signal(conn) -> tuple[date | None, dict]:
    c = curve(conn)
    if len(c) < 3:
        return None, {}
    d, r = c[-1]
    run = 0
    for _, x in reversed(c[:-1]):
        if x < 1:
            break
        run += 1
    state = {"date": str(d), "ratio": round(r, 3), "inverted_run": run, "peak": round(max((x for _, x in c[-1 - run:-1]), default=r), 3)}
    if r >= 1 or run < 2:
        return None, state
    last = conn.execute("SELECT max(made_on) FROM watchlist_sync.forecast_ledger WHERE forecaster = %s", (ARM,)).fetchone()[0]
    if last and (d - last).days <= CLUSTER_DAYS:
        return None, {**state, "clustered": str(last)}
    return d, state


def chain(t: str) -> dict | None:
    today = date.today()
    req = urllib.request.Request("http://127.0.0.1:8080/api/schwab/chain-ladder", headers={"Content-Type": "application/json"},
                                 data=json.dumps({"ticker": t, "fromDate": str(today + timedelta(days=DTE_LO)),
                                                  "toDate": str(today + timedelta(days=DTE_HI)), "strikeCount": 60}).encode())
    try:
        return json.load(urllib.request.urlopen(req, timeout=60))
    except Exception as e:  # noqa: BLE001
        print(f"  {t}: chain fetch failed: {type(e).__name__}: {e}")
        return None


def pick_call(t: str) -> dict | None:
    d = chain(t)
    if not d or not d.get("rows"):
        return None
    today = date.today()
    rows = [r for r in d["rows"] if r["side"] == "call" and r["ask"] and r["delta"] is not None]
    if not rows:
        return None
    exp = min({r["expiry"] for r in rows}, key=lambda e: abs((date.fromisoformat(e) - today).days - DTE_TARGET))
    r = min((r for r in rows if r["expiry"] == exp), key=lambda r: abs(r["delta"] - DELTA_CALL))
    if abs(r["delta"] - DELTA_CALL) > 0.10:
        return None
    return {"expiry": exp, "strike": r["strike"], "ask": r["ask"], "bid": r["bid"], "delta": r["delta"], "iv": r["iv"],
            "spot": d.get("spot"), "dte": (date.fromisoformat(exp) - today).days}


def main() -> int:
    dry = "--dry-run" in sys.argv[1:]
    conn = connect()
    d, st = signal(conn)
    print(f"S172 curve: {st}")
    if d is None:
        print("S172: no un-invert signal today")
        return 0
    entry = date.today()
    rows = []
    for t in CALLS:
        c = pick_call(t)
        if not c:
            print(f"  skip {t}: no 20–45 DTE call near 0.50Δ")
            continue
        qid = f"{ARM}:long_call_exp:{t}:{c['expiry']}:{c['strike']}:{entry}"
        meta = {"structure": "long_call", "arm": ARM, "study": "S172", "rule": "VIX÷VIX3M un-invert (≥2 inverted sessions), 0.50Δ ~30 DTE, hold to expiry",
                "signal_date": str(d), "entry_date": str(entry), "expiry": c["expiry"], "strike": c["strike"], "side": "call",
                "debit": c["ask"], "entry_bid": c["bid"], "delta": round(c["delta"], 4), "iv": c["iv"], "spot": c["spot"],
                "dte": c["dte"], "fill": "schwab ask", "curve": st}
        q = f"Will the {t} {c['strike']:g}C {c['expiry']} beat the same-Δ stock held to expiry?"
        rows.append((qid, q, "long_call_ts", t, ARM, 0.5, datetime.now(), entry, date.fromisoformat(c["expiry"]),
                     json.dumps(meta, default=str)))
        print(f"  {t} {c['strike']:g}C {c['expiry']} Δ{c['delta']:.2f} ask {c['ask']:.2f} → grade at expiry")
    trig = f"VIX÷VIX3M {st['ratio']:.2f} < 1 after {st['inverted_run']} inverted sessions (peak {st['peak']:.2f}) → sell ~0.20Δ put ~30 DTE (S172)"
    if dry:
        print(f"[dry-run] S172: {len(rows)} call pick(s), puts {', '.join(PUTS)}")
        return 0
    for r in rows:
        conn.execute(UPSERT, r)
    for t in PUTS:
        conn.execute("""INSERT INTO watchlist_sync.strategy_signals (strategy_id, as_of, ticker, trigger, details)
                        VALUES (%s, %s, %s, %s, %s) ON CONFLICT DO NOTHING""", (PUT_SID, d, t, trig, json.dumps({**st, "study": "S172"})))
    conn.commit()
    print(f"S172: signal {d} → {len(rows)} call pick(s) logged, put signals {', '.join(PUTS)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
