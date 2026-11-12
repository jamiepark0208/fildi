"""A372 § 4 — per account: how to move from today's actual cash/put mix to the ONE shared market target (cash_target.py).

Mix = F / (F + P)  (book_accounting.py). Target T ⇒ cash wanted for the current puts: F* = T / (1 − T) · P.
Gap = F* − F  (> 0 → raise cash; < 0 → cash to deploy). F unknown → its LOWER bound is used (conservative); negative cash
(margin debt) counts as negative reserve, so clearing the debt comes first.

Moves and their effect on the gap (per contract / per lot):
  close a short put   P −= K·m        cash −= buyback·m        gap −= T/(1−T)·K·m − buyback·m
  sell free shares    cash += qty·px                           gap −= qty·px     (shares behind a short call are locked)
  sell a new put      P += K·m        cash reserved K·m − prem  gap += K·m/(1−T) − prem
Order to raise cash: puts with ≥ 50 % profit captured (little reward left) → Model List Avoid / Trim stock → other puts
(cheapest buyback per $ freed) → other stock, largest first. Order to deploy: the put engine's passing picks by rank.
Advisory only (A372): Jamie executes outside FILDI; nothing here feeds back into the market target.
"""
from __future__ import annotations

import math

MULT = 100
SELL_FIRST = ("avoid", "trim_risk")


def _gap(T: float, F: float, P: float) -> float:
    return T / (1 - T) * P - F


def plan(acct: dict, target: dict, puts: list[dict], stocks: list[dict], short_calls: dict[str, float],
         new_puts: list[dict], allow_new_puts: bool = True, max_steps: int = 8) -> dict:
    """acct = book_accounting.accounting(). puts: ticker, strike, expiry, qty, mark, prem. stocks: ticker, qty, px, folder.
    short_calls: ticker → contracts short (locks 100 shares each). new_puts: engine picks (ticker, strike, expiry, bid, rank)."""
    T = target["target"]
    if acct["F_status"] == "reconciled":
        F, basis = acct["F"], "free cash"
    elif acct["F_status"] == "unknown" and acct.get("F_bounds"):
        F, basis = acct["F_bounds"][0], "free cash, low end of what the broker shows (part of the cash is held)"
    else:
        F, basis = acct["C"] or 0.0, "cash (negative = margin debt)"
    P = acct["P"]
    F0 = F
    mix0 = F / (F + P) if F >= 0 and F + P > 0 else None
    gap0 = _gap(T, F, P)
    steps: list[dict] = []
    gap = gap0

    def add(action, what, qty, cash, collat, why):
        nonlocal F, P, gap
        F += cash + (-collat if action == "sell put" else 0)   # a new cash-secured put reserves its strike
        P += collat
        gap = _gap(T, F, P)
        steps.append({"action": action, "what": what, "qty": qty, "cash": round(cash, 2), "collateral": round(collat, 2),
                      "mix_after": round(F / (F + P), 4) if F >= 0 and F + P > 0 else None, "gap_after": round(gap, 2), "why": why})

    if gap > 1:
        def put_rank(p):
            cap = 1 - (p["mark"] or 0) / p["prem"] if p.get("prem") else 0
            cost = (p["mark"] or 0) / p["strike"]
            return (0 if cap >= 0.5 else 2, cost)
        put_q = sorted(puts, key=put_rank)
        stock_q = []
        for s in stocks:
            free = s["qty"] - MULT * short_calls.get(s["ticker"], 0)
            if free > 0 and s["px"]:
                stock_q.append({**s, "free": free})
        stock_q.sort(key=lambda s: (0 if s.get("folder") in SELL_FIRST else 1, -s["free"] * s["px"]))
        queue = [("put", p) for p in put_q if put_rank(p)[0] == 0] + [("stock", s) for s in stock_q if s.get("folder") in SELL_FIRST] \
            + [("put", p) for p in put_q if put_rank(p)[0] != 0] + [("stock", s) for s in stock_q if s.get("folder") not in SELL_FIRST]
        for kind, x in queue:
            if gap <= 1 or len(steps) >= max_steps:
                break
            if kind == "put":
                m, cost = MULT * x["qty"], (x["mark"] or 0) * MULT * x["qty"]
                cap = 1 - (x["mark"] or 0) / x["prem"] if x.get("prem") else None
                why = (f"{cap:.0%} of premium captured — ${cost:,.0f} to close, frees ${x['strike'] * m:,.0f} of collateral"
                       if cap is not None else f"${cost:,.0f} to close, frees ${x['strike'] * m:,.0f}")
                add("close put", f"{x['ticker']} {x['strike']:g}P {x['expiry']}", x["qty"], -cost, -x["strike"] * m, why)
            else:
                need = min(x["free"], math.ceil(gap / x["px"]))
                lock = x["qty"] - x["free"]
                why = ("Model List: " + {"avoid": "Avoid", "trim_risk": "Trim"}[x["folder"]] if x.get("folder") in SELL_FIRST
                       else "largest unhedged holding") + (f" · {lock:g} sh held behind short calls" if lock else "")
                add("sell stock", x["ticker"], need, need * x["px"], 0.0, why)
    elif gap < -1 and allow_new_puts:
        for c in sorted(new_puts, key=lambda c: c["rank"]):
            if len(steps) >= max_steps:
                break
            per = c["strike"] * MULT / (1 - T) - (c["bid"] or 0) * MULT   # gap used by one contract
            n = int(-gap // per) if per > 0 else 0
            if n < 1:
                continue
            n = min(n, 5)
            add("sell put", f"{c['ticker']} {c['strike']:g}P {c['expiry']}", n, n * (c["bid"] or 0) * MULT, n * c["strike"] * MULT,
                f"put engine pick #{c['rank']} · ${(c['bid'] or 0) * MULT * n:,.0f} premium at the bid")
            if gap > -1:
                break
    note = None
    if gap0 < -1 and not allow_new_puts:
        note = "Cash above target, but this account has a margin loan → no new put ideas (Jamie 10-06). Pay down the loan or buy stock."
    elif gap0 < -1 and not steps:
        note = f"${-gap0:,.0f} above target — too small for one engine put (cheapest needs ${min((c['strike'] * MULT / (1 - T) for c in new_puts), default=0):,.0f})."
    elif gap > 1 and gap0 > 1:
        note = f"Listed moves leave ${gap:,.0f} still short of target."
    alloc = max(F0, 0) + acct["P"]
    return {"target": T, "policy_version": target["policy_version"], "basis": basis, "free_now": round(F0, 2),
            "puts_now": acct["P"], "mix_now": mix0, "gap": round(gap0, 2), "direction": "raise cash" if gap0 > 1 else "deploy cash" if gap0 < -1 else "on target",
            "steps": steps, "mix_after": steps[-1]["mix_after"] if steps else mix0, "gap_after": round(gap, 2), "note": note,
            "small_allocation": bool(acct.get("E") and alloc / acct["E"] < 0.05)}
