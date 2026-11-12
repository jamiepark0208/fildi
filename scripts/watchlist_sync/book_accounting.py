"""A372 § 1 accounting contract — one home for per-account E / C / D / P / F and the cash-vs-put-collateral mix.

  E  net liquidation value (broker total_value; checked = equity + options + crypto + cash, so cash already carries margin debt)
  C  signed broker cash ledger;  D = max(−C, 0) margin debt, shown separately (never subtract margin_used again)
  P  full assignment obligation of open short puts = Σ strike × multiplier × qty (per account, never netted vs long puts)
  F  genuinely free cash after put reservations and holds. Known only when the broker's own free-cash figure
     (unleveraged BP) reconciles with C − P within $1. Otherwise F is UNKNOWN (bounds shown), never BP or 0.
     Negative cash → no cash reserve at all: the account sits outside the cash-funded allocation.
  mix = F / (F + P) — the actual cash share of the cash-vs-put allocation; None unless F is known and F + P > 0.

Pure functions, no DB: pm_book.py feeds it the snapshot rows. Nothing here changes the shared market target (A372 § 2).
"""
from __future__ import annotations

TOL = 1.0               # $ tolerance for "reconciles"
SMALL_ALLOC_PCT = 0.05  # allocation under 5 % of NLV → say so (fixture 1: no puts but ~all invested ≠ ample reserve)
MULT = 100              # portfolio_options has no multiplier column yet → assumed, flagged


def _f(v) -> float | None:
    return None if v is None else float(v)


def accounting(acct: dict, short_puts: list[dict]) -> dict:
    """acct: total_value, equity_value, options_value, crypto_value, cash, buying_power, unleveraged_bp, type.
    short_puts: open short puts of THIS account: strike, qty (optionally multiplier)."""
    E, C = _f(acct.get("total_value")), _f(acct.get("cash"))
    parts = [_f(acct.get(k)) for k in ("equity_value", "options_value", "crypto_value")]
    e_check = None if E is None or C is None or parts[0] is None else sum(p or 0 for p in parts) + C
    D = max(-C, 0.0) if C is not None else None
    mult_assumed = any(p.get("multiplier") is None for p in short_puts)
    P = sum(float(p["strike"]) * float(p.get("multiplier") or MULT) * float(p["qty"]) for p in short_puts)
    bp = _f(acct["buying_power"] if acct.get("buying_power") is not None else acct.get("bp"))
    broker_free = _f(acct.get("unleveraged_bp"))
    if broker_free is None:
        broker_free = bp
    notes: list[str] = []
    F = F_lo = F_hi = None
    if C is None:
        f_status = "unknown"
        notes.append("no cash figure in snapshot")
    elif C < 0:
        f_status = "none"
        notes.append(f"cash is −${D:,.0f} (margin debt): no cash reserve; buying power ${bp or 0:,.0f} is borrowing, not cash")
    else:
        after_puts = C - P
        if broker_free is not None and abs(after_puts - broker_free) <= TOL:
            F, f_status = after_puts, "reconciled"
        else:
            f_status = "unknown"
            F_lo = max(min(after_puts, broker_free if broker_free is not None else after_puts), 0.0)
            F_hi = max(after_puts, 0.0)
            if broker_free is not None:
                notes.append(f"broker free cash ${broker_free:,.0f} vs cash − put collateral ${after_puts:,.0f}: "
                             f"${after_puts - broker_free:,.0f} held for something we can't see (pending orders / settlement)")
    denom = (F + P) if F is not None else None
    mix = F / denom if denom and denom > 0 else None
    if mix is not None and E and denom / E < SMALL_ALLOC_PCT:
        notes.append(f"cash + put collateral is only ${denom:,.0f} ({denom / E:.1%} of the account): "
                     f"{mix:.0%} cash here does not mean the account holds a large reserve")
    if mult_assumed and short_puts:
        notes.append("contract multiplier assumed 100 (not in the export)")
    return {
        "E": E, "E_reconciled": e_check is not None and abs(e_check - E) <= TOL, "C": C, "D": D, "P": P,
        "F": F, "F_status": f_status, "F_bounds": [F_lo, F_hi] if f_status == "unknown" and F_hi is not None else None,
        "mix_cash": mix, "mix_denominator": denom,
        "cash_of_nlv": C / E if C is not None and E else None, "puts_of_nlv": P / E if E else None,
        "free_of_nlv": F / E if F is not None and E else None,
        "multiplier_assumed": mult_assumed, "notes": notes,
    }


def after_close(acct: dict, short_puts: list[dict], idx: int, buyback: float) -> dict:
    """Fixture 3: closing a put spends its buyback cash and releases its reservation. Returns the new accounting."""
    p = short_puts[idx]
    m = float(p.get("multiplier") or MULT) * float(p["qty"])
    cost, freed = buyback * m, float(p["strike"]) * m
    # NLV unchanged at a close at the mark: cash falls by the cost, the short option's −mark leaves options_value
    new_acct = {**acct, "cash": (acct.get("cash") or 0) - cost, "options_value": (acct.get("options_value") or 0) + cost,
                "unleveraged_bp": None if acct.get("unleveraged_bp") is None else acct["unleveraged_bp"] + freed - cost}
    return accounting(new_acct, short_puts[:idx] + short_puts[idx + 1:])
