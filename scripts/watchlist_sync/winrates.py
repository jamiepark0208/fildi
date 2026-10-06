""""Wins historically": how often a sold option at this delta and expiry made money, 2020 → now (gate 1c, PLAN_next_session.md §7).

One small table (put | call × delta 0.15 / 0.20 / 0.30 × expiry 7 / 14 / 30 days), built by analysis/proto_c.py from reconstructed
trades on lseg_research.daily_history and stored in watchlist_sync.win_rates (one row per version, append-only). Display only:
nothing scores, ranks or sizes on it. Validated: built on 2020–23, every cell within 5 pts on 2024–26; per-stock rates added
nothing once delta is known (delta already carries the stock's volatility).

Also per contract (E1 / E2, PLAN §8): expected $ = (premium − historical payout · σ√T · strike or spot) × 100, where only the payout
(in volatility units, passed out-of-sample test C3) comes from history, shown as a range: good year / 2020–26 average / bad year (best and
worst calendar-year payouts). A single number would mislead: the all-stock average sold option roughly broke even at realistic fills
(lost in 2020–23, made money in 2024–26); the Model List's edge is in selection (PREMIUM), which a per-delta table can't see.
Payout scales by LSEG ATM IV (as history measured it), not the strike's own IV (skew would overstate it).
What-if alternatives at the other tested deltas, same expiry: strike and premium estimated with Black-Scholes at the contract's IV,
premium scaled from the real fill (no skew, so labelled estimates).

  refresh   rebuild if the newest version is ≥ 28 days old (≈ 1 min local compute, no vendor calls, no tokens); else a no-op
  show      print the current table

Usage: .venv/bin/python winrates.py refresh [--force] | show
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from datetime import date, datetime, timezone
from pathlib import Path

from build_plan import connect, rows

HERE = Path(__file__).resolve().parent
DELTAS = (0.15, 0.20, 0.30)
DTES = (7, 14, 30)
MAX_AGE_DAYS = 28
DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.win_rates (
  version text PRIMARY KEY, cells jsonb NOT NULL, verdict jsonb, built_from text, created_at timestamptz NOT NULL DEFAULT now())"""


def save(conn, version: str, cells: dict, verdict: dict, built_from: str) -> None:
    conn.execute(DDL)
    conn.execute("""INSERT INTO watchlist_sync.win_rates (version, cells, verdict, built_from) VALUES (%s, %s, %s, %s)
                    ON CONFLICT (version) DO UPDATE SET cells = EXCLUDED.cells, verdict = EXCLUDED.verdict, created_at = now()""",
                 (version, json.dumps(cells), json.dumps(verdict), built_from))
    conn.commit()


def latest(conn) -> dict | None:
    conn.execute(DDL)
    r = rows(conn, "SELECT version, cells, created_at FROM watchlist_sync.win_rates ORDER BY created_at DESC LIMIT 1")
    return r[0] if r else None


def _interp(x: float, grid: tuple) -> tuple[int, int, float]:
    if x <= grid[0]:
        return 0, 0, 0.0
    if x >= grid[-1]:
        return len(grid) - 1, len(grid) - 1, 0.0
    for i in range(len(grid) - 1):
        if grid[i] <= x <= grid[i + 1]:
            return i, i + 1, (x - grid[i]) / (grid[i + 1] - grid[i])
    return 0, 0, 0.0


def lookup(table: dict | None, side: str, delta: float | None, dte: float | None) -> dict | None:
    """Bilinear interpolation on (|delta|, days to expiry), clamped to the tested grid; `outside` marks a contract off the grid."""
    if not table or delta is None or dte is None or side not in ("put", "call"):
        return None
    d, t = abs(float(delta)), float(dte)
    C = table["cells"]
    i0, i1, wd = _interp(d, DELTAS)
    j0, j1, wt = _interp(t, DTES)

    def cell(i, j, k):
        return C[f"{side}|{DELTAS[i]:.2f}|{DTES[j]}"][k]

    def mix(k):
        a = cell(i0, j0, k) * (1 - wt) + cell(i0, j1, k) * wt
        b = cell(i1, j0, k) * (1 - wt) + cell(i1, j1, k) * wt
        return a * (1 - wd) + b * wd

    n = sum(cell(i, j, "n") for i in {i0, i1} for j in {j0, j1})
    pay = ({"payout": round(mix("payout"), 4), "payout_bad": round(mix("payout_worst_year"), 4), "payout_good": round(mix("payout_best_year"), 4)}
           if "payout_best_year" in C[f"{side}|0.20|30"] else {})
    return {"rate": round(mix("rate"), 3), "lo": round(mix("worst_year"), 3), "hi": round(mix("best_year"), 3), "n": n, **pay,
            "delta": round(d, 2), "dte": round(t), "outside": d < DELTAS[0] - 0.05 or d > DELTAS[-1] + 0.05 or t > DTES[-1] + 15,
            "version": table["version"]}


def _ncdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def _bs(side: str, S: float, K: float, T: float, s: float) -> float:
    d1 = (math.log(S / K) + s * s / 2 * T) / (s * math.sqrt(T))
    d2 = d1 - s * math.sqrt(T)
    return K * _ncdf(-d2) - S * _ncdf(-d1) if side == "put" else S * _ncdf(d1) - K * _ncdf(d2)


def _strike(side: str, S: float, T: float, s: float, delta: float) -> float:
    lo, hi = -8.0, 8.0
    target = delta if side == "call" else 1 - delta   # call Δ = N(d1); put |Δ| = N(−d1)
    for _ in range(70):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if _ncdf(mid) < target else (lo, mid)
    return S * math.exp(-mid * s * math.sqrt(T) + s * s / 2 * T)


def atm_iv(conn) -> dict[str, float]:
    """Latest LSEG 30-day ATM IV per ticker (fraction): the same volatility the historical payouts were measured against."""
    return {r["ticker"]: r["iv"] / 100 for r in rows(conn, """SELECT DISTINCT ON (ticker) ticker, iv30_put::float8 iv
        FROM lseg_research.daily_history WHERE iv30_put IS NOT NULL AND date > now() - interval '10 days' ORDER BY ticker, date DESC""")}


def money(win: dict | None, side: str, premium: float | None, iv: float | None, spot: float | None, strike: float,
          dte: float, table: dict | None, atm: float | None = None) -> dict | None:
    """Expected $ per contract (+ bad-year) for this contract and what-if alternatives at the other tested deltas (same expiry).
    `iv` (the contract's own) prices the alternatives; `atm` (LSEG ATM IV) scales the payout, matching how history measured it."""
    if not win or "payout" not in win or premium is None or not iv or not spot or iv <= 0:
        return None
    T = max(dte, 1) / 365
    ss = (atm or iv) * math.sqrt(T)

    def ev(prem, w, K):
        base = K if side == "put" else spot
        return tuple(round((prem - w[k] * ss * base) * 100, 2) for k in ("payout", "payout_bad", "payout_good"))

    e, eb, eg = ev(premium, win, strike)
    out = {"ev": e, "ev_bad": eb, "ev_good": eg, "ev_vol": "atm" if atm else "strike", "alts": []}
    fair = _bs(side, spot, strike, T, iv)
    if fair <= 0:
        return out
    for d in DELTAS:
        K = _strike(side, spot, T, iv, d)
        w = lookup(table, side, d, dte)
        p = premium * _bs(side, spot, K, T, iv) / fair
        a, ab, ag = ev(p, w, K)
        out["alts"].append({"delta": d, "strike": round(K, 2), "premium": round(p, 2), "rate": w["rate"], "ev": a, "ev_bad": ab, "ev_good": ag})
    return out


def refresh(force: bool) -> None:
    with connect() as conn:
        cur = latest(conn)
    age = (datetime.now(timezone.utc) - cur["created_at"]).days if cur else None
    if cur and not force and age < MAX_AGE_DAYS:
        print(f"win rates {cur['version']} is {age} days old: no rebuild (every {MAX_AGE_DAYS} days)")
        return
    r = subprocess.run([sys.executable, "analysis/proto_c.py", "--final", "--fresh"], cwd=HERE)
    sys.exit(r.returncode)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("cmd", choices=["refresh", "show"])
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    if a.cmd == "refresh":
        refresh(a.force)
        return
    with connect() as conn:
        t = latest(conn)
    if not t:
        print("no win-rate table yet: run `winrates.py refresh`")
        return
    print(f"{t['version']} (built {t['created_at']:%Y-%m-%d})")
    for side in ("put", "call"):
        for d in DELTAS:
            print(f"  {side:<4} Δ{d:.2f}  " + "  ".join(f"{x}d {100 * t['cells'][f'{side}|{d:.2f}|{x}']['rate']:.1f}%" for x in DTES))


if __name__ == "__main__":
    main()
