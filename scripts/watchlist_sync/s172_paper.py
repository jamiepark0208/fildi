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
HIBETA_SID, HIBETA_N, MIN_PX = "vix-uninvert-put-hibeta", 20, 5.0  # global: S173 tested the top beta fifth; top 20 graded, rest listed; $5 floor
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


LIBRARY = [  # Strategy Library rows (Breakdown › Rules today, Strategies tab); idempotent, written each run
    ("vix-uninvert-put", "Market bottom: index puts at VIX curve un-invert", "SPY/QQQ 0.20Δ ~30 DTE short put",
     "First close VIX÷VIX3M < 1 after ≥ 2 inverted sessions → sell ~0.20Δ ~30 DTE SPY/QQQ puts, hold to expiry.",
     "S172 (2009→, 33–38 episodes): 94–95 % win, lift > 0 both halves, placebo p 0.00.", "Model prices; index only.", "S172", "2009-10-01"),
    ("vix-uninvert-put-hibeta", "Market bottom: high-beta puts at VIX curve un-invert", "single-name 0.20Δ ~30 DTE short put",
     "Same signal → sell ~0.20Δ ~30 DTE puts on the top-beta fifth (60-session beta vs SPY); top 20 paper-graded, rest listed.",
     "S173 (18 episodes 2018→): +3.0 / +2.0 % per $ collateral per 30 d vs SPY put +0.9 / +0.6, both halves; S173b: 0.10Δ = safer "
     "(+1.6 / +1.1 %, worst name −24 %).", "18 episodes = underpowered; model prices (BS at own iv30); worst name −29 %; names correlate.", "S173", "2018-02-01"),
]


def ensure_library(conn) -> None:
    for sid, name, instr, rules, summary, caveats, ref, w0 in LIBRARY:
        conn.execute("""INSERT INTO watchlist_sync.strategies (strategy_id, version, name, family, instrument, status, summary, rules_md,
                        caveats_md, study_ref, window_start, window_end, price_source, updated_at)
                        VALUES (%s, '1', %s, 'options', %s, 'candidate', %s, %s, %s, %s, %s, '2026-11-09', 'model', now())
                        ON CONFLICT DO NOTHING""", (sid, name, instr, summary, rules, caveats, ref, w0))


def hibeta(conn) -> list[dict]:
    """S173: the top-beta fifth (60-session beta vs SPY, lseg daily_history; GICS stocks ≥ MIN_PX), beta-ranked, with a model
    0.20Δ / 0.10Δ ~30 DTE put credit per $ strike at the name's own iv30_put (estimate; the graded rows get a real contract)."""
    from s172_bottom_signals import bs, strike  # noqa: PLC0415
    px: dict[str, dict] = {}
    ivp: dict[str, float] = {}
    for t, d, c, iv in conn.execute("""SELECT ticker, date, close::float8, iv30_put::float8 FROM lseg_research.daily_history
                                       WHERE date >= current_date - 100 AND close > 0 ORDER BY ticker, date"""):
        px.setdefault(t, {})[d] = c
        if iv and iv > 0:
            ivp[t] = iv / 100 if iv > 3 else iv
    stocks = {r[0] for r in conn.execute("SELECT ticker FROM research_common.security_class WHERE gics_sector IS NOT NULL")}  # no ETFs / levered
    spy = px.get("SPY") or {}
    days = sorted(spy)[-61:]
    if len(days) < 41:
        return []
    out = []
    for t, p in px.items():
        if t not in stocks or max(p) < days[-1] - timedelta(days=4):
            continue
        xy = [(spy[b] / spy[a] - 1, p[b] / p[a] - 1) for a, b in zip(days, days[1:]) if a in p and b in p]
        if len(xy) < 40:
            continue
        mx = sum(x for x, _ in xy) / len(xy)
        my = sum(y for _, y in xy) / len(xy)
        vx = sum((x - mx) ** 2 for x, _ in xy)
        out.append({"t": t, "beta": sum((x - mx) * (y - my) for x, y in xy) / vx, "px": p[max(p)], "iv": ivp.get(t)})
    out.sort(key=lambda r: -r["beta"])
    top = [r for r in out[:len(out) // 5] if r["px"] >= MIN_PX]  # fifth of the whole universe, then the price floor
    T = 30 / 365
    for r in top:
        if r["iv"]:
            for dl in (0.20, 0.10):
                k = strike(r["px"], T, r["iv"], dl, call=False)
                r[f"cr{int(dl * 100)}"] = round(bs(r["px"], k, T, r["iv"], call=False) * 0.95 / k, 4)
    return top


def main() -> int:
    dry = "--dry-run" in sys.argv[1:]
    conn = connect()
    if not dry:
        ensure_library(conn)
        conn.commit()
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
    hb = hibeta(conn)
    trig_hb = trig.replace("(S172)", "on a top-beta name (S173, paper)")
    for i, r in enumerate(hb):
        det = {**st, "study": "S173", "beta60": round(r["beta"], 2), "rank": i + 1, "of": len(hb), "iv30_put": r["iv"],
               "est_credit_20d": r.get("cr20"), "est_credit_10d": r.get("cr10")}
        conn.execute("""INSERT INTO watchlist_sync.strategy_signals (strategy_id, as_of, ticker, trigger, details, status)
                        VALUES (%s, %s, %s, %s, %s, %s)
                        ON CONFLICT (strategy_id, as_of, ticker) DO UPDATE SET details = EXCLUDED.details""",
                     (HIBETA_SID, d, r["t"], trig_hb, json.dumps(det), "open" if i < HIBETA_N else "listed"))
    print(f"  S173 high-beta puts: {len(hb)} listed, top {HIBETA_N} graded: {', '.join(r['t'] for r in hb[:HIBETA_N])}")
    conn.commit()
    print(f"S172: signal {d} → {len(rows)} call pick(s) logged, put signals {', '.join(PUTS)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
