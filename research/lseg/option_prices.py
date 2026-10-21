"""LSEG daily option history (bid/ask/mid/last/OI/IV) for any listed US equity option, live or expired, cached in
optlab.lseg_opt_daily. Probed 10-19: expired contracts keep their full life (e.g. SPY Sep-26 650P 2025-06-17 → 2026-09-18).

OPRA RIC = ROOT + month letter (calls A–L, puts M–X) + DD + YY + strike×100 (5 digits) + ".U"; once expired LSEG appends
"^" + A–L month letter + YY (contracts expired in the last few days may not be renamed yet → both forms are tried).
Runs in research/lseg/.venv (lseg.data); use inside `with lseg_session() as ld`.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any

import pandas as pd

DDL = """
CREATE TABLE IF NOT EXISTS optlab.lseg_opt_daily (ric text, date date, bid real, ask real, mid real, last real, oi real,
  iv real, PRIMARY KEY (ric, date));
CREATE TABLE IF NOT EXISTS optlab.lseg_opt_fetched (ric text PRIMARY KEY, n int, fetched_at timestamptz DEFAULT now());
"""
FIELDS = ["BID", "ASK", "MID_PRICE", "TRDPRC_1", "OPINT_1", "IMP_VOLT"]


def ensure(conn) -> None:
    conn.execute(DDL)
    conn.commit()


def rics(root: str, expiry: date, cp: str, strike: float) -> list[str]:
    if strike >= 1000:
        return []
    m = expiry.month - 1
    letter = chr(ord("A") + m) if cp == "C" else chr(ord("M") + m)
    base = f"{root}{letter}{expiry:%d%y}{round(strike * 100):05d}.U"
    exp_suffix = f"^{chr(ord('A') + m)}{expiry:%y}"
    if expiry >= date.today():
        return [base]
    # renamed with ^ a few days after expiry; only recent expiries need the bare form too (each miss = 1 request)
    return [base + exp_suffix, base] if expiry >= date.today() - timedelta(days=7) else [base + exp_suffix]


def history(ld: Any, conn, root: str, expiry: date, cp: str, strike: float) -> list[tuple] | None:
    """[(date, bid, ask, mid, last, oi, iv)] for the contract, from cache or LSEG; None if no such contract."""
    for ric in rics(root, expiry, cp, strike):
        got = conn.execute("SELECT n, fetched_at::date < current_date FROM optlab.lseg_opt_fetched WHERE ric = %s",
                           (ric,)).fetchone()
        if got is None or (got[1] and expiry >= date.today()):  # live contracts: refresh once a day
            try:
                h = ld.get_history(universe=ric, fields=FIELDS, interval="daily",
                                   start=str(expiry - timedelta(days=400)), end=str(expiry))
            except Exception:  # "universe is not found" → contract never existed under this RIC
                h = None
            rows = []
            if h is not None and len(h):
                for d, r in h.iterrows():
                    v = [None if (x is None or pd.isna(x)) else float(x) for x in
                         (r.get("BID"), r.get("ASK"), r.get("MID_PRICE"), r.get("TRDPRC_1"), r.get("OPINT_1"), r.get("IMP_VOLT"))]
                    rows.append((ric, d.date(), *v))
            with conn.cursor() as cur:
                cur.executemany("INSERT INTO optlab.lseg_opt_daily VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING", rows)
                cur.execute("INSERT INTO optlab.lseg_opt_fetched (ric, n) VALUES (%s,%s) ON CONFLICT (ric) DO UPDATE SET "
                            "n = excluded.n, fetched_at = now()", (ric, len(rows)))
            conn.commit()
            got = (len(rows), False)
        if got[0]:
            return conn.execute("SELECT date, bid, ask, mid, last, oi, iv FROM optlab.lseg_opt_daily WHERE ric = %s "
                                "ORDER BY date", (ric,)).fetchall()
    return None


CHAIN_FETCH_CAP = 150  # Polygon reference is 5/min (12 s per chain) → ≤ ~30 min per run; beyond it, plain ladder
_chain_fetches = 0


def candidates(conn, root: str, expiry: date, cp: str, target: float, fetch_chain: Any = None) -> list[float]:
    """strike_ladder(target), minus strikes the listed chain says don't exist (10-20: 55 % of fetched RICs were misses —
    10,912 of 19,870 — each a wasted LSEG request). Listed chain = optlab.contracts (Polygon reference, free, cached); pass
    fetch_chain=option_history.chain to fetch it when missing. Order unchanged and cached hits always kept, so the chosen
    contract is the same as before; only the would-be misses are skipped. Unknown chain → plain ladder."""
    ladder = strike_ladder(target)
    lo, hi = min(ladder) * 0.8, max(ladder) * 1.2
    have = conn.execute("SELECT n, lo, hi FROM optlab.chains_fetched WHERE underlying = %s AND expiry = %s",
                        (root, expiry)).fetchone()
    covered = have is not None and have[0] and (have[1] is None or (have[1] <= lo and have[2] >= hi))
    global _chain_fetches
    if not covered and fetch_chain is not None and _chain_fetches < CHAIN_FETCH_CAP:
        _chain_fetches += 1
        try:
            fetch_chain(conn, root, expiry, target)
        except Exception:  # Polygon down / budget: fall back to the plain ladder
            return ladder
        have = conn.execute("SELECT n, lo, hi FROM optlab.chains_fetched WHERE underlying = %s AND expiry = %s",
                            (root, expiry)).fetchone()
        covered = have is not None and have[0] and (have[1] is None or (have[1] <= lo and have[2] >= hi))
    if not covered:
        return ladder
    kind = "put" if cp == "P" else "call"
    listed = {round(float(k), 2) for (k,) in conn.execute(
        "SELECT strike FROM optlab.contracts WHERE underlying = %s AND expiry = %s AND type = %s", (root, expiry, kind))}
    if not listed:
        return ladder
    hits = {r for (r,) in conn.execute("SELECT ric FROM optlab.lseg_opt_fetched WHERE ric = ANY(%s) AND n > 0",
                                       ([x for k in ladder for x in rics(root, expiry, cp, k)],))}
    return [k for k in ladder if round(k, 2) in listed or any(x in hits for x in rics(root, expiry, cp, k))]


def strike_ladder(target: float) -> list[float]:
    """Plausible listed strikes nearest the target first (increments vary by price and by name)."""
    steps = [0.5, 1.0] if target < 25 else [1.0, 2.5, 5.0] if target < 200 else [5.0, 2.5, 10.0]
    cands = set()
    for s in steps:
        k = round(target / s) * s
        for j in (-1, 0, 1):
            cands.add(round(k + j * s, 2))
    return sorted(cands, key=lambda k: abs(k - target))[:6]
