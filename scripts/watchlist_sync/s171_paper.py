"""A244 paper board — S171 angle: loss-maker momentum ∧ cheap vol → 30 DTE 0.30Δ call, 3-day exit.

S171 (29428f06, Claude review: UNDERPOWERED-promising) beat the same-Δ stock by +142 bp/$debit/day in TEST, both
halves, delayed entry +232, but cluster t 1.06 / placebo p 0.11. Years more backtest don't exist, so it is graded live.

Rule (frozen, no re-fit here):
  universe = loss-makers (S169 load_groups: avg operating margin < 0 and net income < 0)
  M  = S170 TRAIN cuts: ret20 ≥ 0.1661, rsi14 ≥ 63.36, ret5 ≥ 0.0778     (s171.passes_M)
  G1 = IV30/RV20 in the stock's own bottom tercile, trailing 252 obs     (s171.build_stock_gate_cache)
  trade = buy the ~30 DTE ~0.30Δ call at the real Schwab ask, sell at the day-3 bid.
Each pick goes to forecast_ledger as qtype `long_call_ts` (forecaster `S171`). The resolver
(`forecast_ledger._r_long_call_ts`) grades it on day 3: outcome = call P&L > same-Δ stock P&L (the S171 claim).
Promote trigger (A244): ≥ 100 graded picks, mean vs same-Δ stock > 0, date-clustered t ≥ 2.

    cd scripts/watchlist_sync && .venv/bin/python s171_paper.py [--dry-run]
"""
from __future__ import annotations

import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "analysis"))
from build_plan import connect  # noqa: E402
from forecast_ledger import UPSERT  # noqa: E402

ARM = "S171"
QTYPE = "long_call_ts"
HOLD_DAYS = 3          # ts3, trading days
DTE_TARGET, DTE_LO, DTE_HI = 30, 20, 45
DELTA_TARGET = 0.30
MAX_SIGNAL_AGE = 4     # calendar days between the signal bar and the chain snapshot (Fri bar → Mon entry)


def add_trading_days(d: date, n: int) -> date:
    while n > 0:
        d += timedelta(days=1)
        if d.weekday() < 5:
            n -= 1
    return d


def todays_signals(conn) -> list[dict]:
    """M ∧ G1 on each loss-maker's latest bar, computed by S170/S171's own functions."""
    from s169_lossmaker_crash_calls import load_groups
    from s170_lossmaker_call_timing import SECTOR_ETF, features_at, load_ohlcv, load_ticker_sector, load_vix_term, price_rows
    from s171_lossmaker_cheap_bigmove_calls import build_stock_gate_cache, passes_M

    groups, _ = load_groups(conn)
    loss = {t for t, g in groups.items() if g == "loss"}
    bars = load_ohlcv(conn, loss | {"SPY"} | set(SECTOR_ETF.values()))
    last_day = max((r[-1][0] for r in bars.values() if r), default=None)
    if last_day is None:
        return []
    spy = price_rows(bars.get("SPY") or [])
    spy_i = {r[0]: i for i, r in enumerate(spy)}
    vix_term = load_vix_term(conn)
    tickers = sorted(t for t in loss if len(bars.get(t) or []) >= 80 and bars[t][-1][0] == last_day)
    sectors = load_ticker_sector(conn, tickers)
    etf_rows = {e: [(r[0], r[4]) for r in (bars.get(e) or [])] for e in set(SECTOR_ETF.values())}
    out = []
    for t in tickers:
        ohlc = bars[t]
        i = len(ohlc) - 1
        sym = SECTOR_ETF.get((sectors.get(t) or "").lower())
        sect_rows = etf_rows.get(sym) if sym else None
        sect_i = {r[0]: k for k, r in enumerate(sect_rows)} if sect_rows else None
        feat = features_at(ohlc, i, spy, spy_i, vix_term, sect_rows, sect_i)
        if not feat or not passes_M(feat):
            continue
        g = build_stock_gate_cache(ohlc)
        if g["g1"][i] != 1:
            continue
        out.append({"t": t, "d": ohlc[i][0], "close": ohlc[i][4], "ivrv": g["ivrv"][i],
                    "ret20": feat.get("ret20"), "rsi14": feat.get("rsi14"), "ret5": feat.get("ret5")})
    return out


def pick_contract(conn, t: str, after: date) -> dict | None:
    """Nearest-30-DTE expiry, then the call closest to 0.30Δ, from the latest Schwab chain on/after the signal."""
    rows = conn.execute(
        """SELECT as_of, expiry, strike::float, bid::float, ask::float, delta::float, iv::float, spot::float, dte
           FROM option_chain_history
           WHERE ticker = %s AND side = 'call' AND source = 'schwab' AND ask > 0 AND delta IS NOT NULL
             AND as_of = (SELECT max(as_of) FROM option_chain_history WHERE ticker = %s AND source = 'schwab')
             AND as_of > %s AND dte BETWEEN %s AND %s""",   # strictly after the signal bar: a same-day quote predates its close
        (t, t, after, DTE_LO, DTE_HI)).fetchall()
    if not rows:
        return None
    best_exp = min({r[1] for r in rows}, key=lambda e: abs((e - rows[0][0]).days - DTE_TARGET))
    cand = [r for r in rows if r[1] == best_exp]
    r = min(cand, key=lambda r: abs(abs(r[5]) - DELTA_TARGET))
    if abs(abs(r[5]) - DELTA_TARGET) > 0.10:
        return None                                            # chain too sparse near 0.30Δ: skip, don't fake it
    return {"as_of": r[0], "expiry": r[1], "strike": r[2], "bid": r[3], "ask": r[4], "delta": abs(r[5]),
            "iv": r[6], "spot": r[7], "dte": r[8]}


def open_tickers(conn) -> set[str]:
    """Names with an ungraded S171 pick: skip them (backtest de-overlap = one trade per name until its exit)."""
    return {r[0] for r in conn.execute(
        "SELECT DISTINCT subject FROM watchlist_sync.forecast_ledger WHERE forecaster = %s AND outcome IS NULL", (ARM,))}


def rows_for(conn, sigs: list[dict]) -> tuple[list[tuple], list[str]]:
    rows, skipped = [], []
    busy = open_tickers(conn)
    for s in sigs:
        if s["t"] in busy:
            skipped.append(f"{s['t']}: open pick")
            continue
        c = pick_contract(conn, s["t"], s["d"])
        if not c:
            skipped.append(f"{s['t']}: no 20–45 DTE call near 0.30Δ in the latest chain")
            continue
        if (c["as_of"] - s["d"]).days > MAX_SIGNAL_AGE:
            skipped.append(f"{s['t']}: chain {c['as_of']} too far from signal {s['d']}")
            continue
        entry = c["as_of"]
        resolves = add_trading_days(entry, HOLD_DAYS)
        qid = f"{ARM}:long_call_ts3:{s['t']}:{c['expiry']}:{c['strike']}:{entry}"
        meta = {"structure": "long_call", "arm": ARM, "study": "S171", "rule": "M∧G1 loss-maker, 30DTE 0.30Δ, ts3",
                "signal_date": str(s["d"]), "entry_date": str(entry), "expiry": str(c["expiry"]), "strike": c["strike"],
                "side": "call", "debit": c["ask"], "entry_bid": c["bid"], "delta": round(c["delta"], 4),
                "iv": c["iv"], "spot": c["spot"], "dte": c["dte"], "hold_days": HOLD_DAYS, "fill": "schwab ask",
                "ivrv": round(s["ivrv"], 3) if s["ivrv"] else None,
                "ret20": s["ret20"], "rsi14": s["rsi14"], "ret5": s["ret5"]}
        q = f"Will the {s['t']} {c['strike']:g}C {c['expiry']} beat the same-Δ stock over {HOLD_DAYS} trading days?"
        # prob 0.5 = no calibrated forecast; the graded record (vs same-Δ stock) is the test, not Brier
        rows.append((qid, q, QTYPE, s["t"], ARM, 0.5, datetime.now(), entry, resolves, json.dumps(meta, default=str)))
    return rows, skipped


def main() -> int:
    dry = "--dry-run" in sys.argv[1:]
    conn = connect()
    sigs = todays_signals(conn)
    rows, skipped = rows_for(conn, sigs)
    for s in skipped:
        print(f"  skip {s}")
    for r in rows:
        m = json.loads(r[9])
        print(f"  {r[3]} {m['strike']:g}C {m['expiry']} Δ{m['delta']:.2f} ask {m['debit']:.2f} → grade {r[8]}")
    if dry:
        print(f"[dry-run] S171 paper: {len(sigs)} signal(s), {len(rows)} pick(s)")
        return 0
    for r in rows:
        conn.execute(UPSERT, r)
    conn.commit()
    print(f"S171 paper: {len(sigs)} signal(s), {len(rows)} pick(s) logged")
    return 0


if __name__ == "__main__":
    sys.exit(main())
