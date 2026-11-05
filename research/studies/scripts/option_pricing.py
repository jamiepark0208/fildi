"""Shared option marks for S152 / S154 — RH entry fills, BS exit (years, entry IV per leg)."""
from __future__ import annotations

import math
from datetime import date

FILL_FRAC = 0.23
MIN_PREMIUM = 0.10
TRADING_MINUTES_PER_DAY = 390.0
TRADING_DAYS_PER_YEAR = 252.0


def norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def normalize_iv(iv: float | None) -> float:
    """Chain history mixes decimal vol (~0.5) and percent points (>3 → ÷100), cf. s135."""
    if iv is None or iv <= 0 or not math.isfinite(iv):
        return 0.35
    if iv > 3.0:
        return iv / 100.0
    return iv


def bs_price(side: str, S: float, K: float, T_years: float, sig: float) -> float:
    sig = normalize_iv(sig)
    if T_years <= 0 or sig <= 0 or S <= 0 or K <= 0:
        return max(S - K, 0.0) if side == "call" else max(K - S, 0.0)
    v = sig * math.sqrt(T_years)
    d1 = (math.log(S / K) + 0.5 * sig * sig * T_years) / v
    d2 = d1 - v
    if side == "call":
        return S * norm_cdf(d1) - K * norm_cdf(d2)
    return K * norm_cdf(-d2) - S * norm_cdf(-d1)


def implied_vol(side: str, S: float, K: float, T_years: float, mid: float) -> float:
    """Invert BS to the vol that reproduces quote mid at entry (falls back to stored IV band)."""
    if T_years <= 0 or S <= 0 or K <= 0 or mid <= 0:
        return 0.35
    intrinsic = max(S - K, 0.0) if side == "call" else max(K - S, 0.0)
    target = max(mid, intrinsic + 1e-4)
    lo, hi = 1e-4, 3.0
    for _ in range(60):
        m = (lo + hi) / 2
        if bs_price(side, S, K, T_years, m) > target:
            hi = m
        else:
            lo = m
    return (lo + hi) / 2


def _bid_ask(L: dict) -> tuple[float, float]:
    bid = float(L["bid"])
    ask = L.get("ask")
    if ask is None or float(ask) <= bid:
        ask = bid * 1.05
    return bid, float(ask)


def quote_mid(L: dict) -> float:
    bid, ask = _bid_ask(L)
    return (bid + ask) / 2.0


def quote_spread(L: dict) -> float:
    bid, ask = _bid_ask(L)
    return ask - bid


def rh_fill(bid: float, ask: float | None, buy: bool) -> float:
    if ask is None or ask <= bid:
        ask = bid * 1.05
    spr = ask - bid
    return bid + FILL_FRAC * spr if buy else ask - FILL_FRAC * spr


def rh_fill_leg(L: dict, buy: bool) -> float:
    bid, ask = _bid_ask(L)
    return rh_fill(bid, ask, buy)


def leg_entry(L: dict, buy: bool, spot: float, dte: int) -> tuple[float, float]:
    """RH fill + IV inverted from that fill so BS exit marks are consistent with entry."""
    T0 = hold_T(dte, 0.0)
    px = rh_fill_leg(L, buy)
    side = L["side"]
    K = float(L["strike"])
    iv = implied_vol(side, spot, K, T0, px)
    if not math.isfinite(iv) or iv <= 0:
        iv = normalize_iv(L.get("iv"))
    return px, iv


def hold_T(dte: int, hold_min: float) -> float:
    """Time to expiry in years after holding hold_min RTH minutes."""
    hold_days = hold_min / TRADING_MINUTES_PER_DAY
    rem_days = max(float(dte) - hold_days, 0.02)
    return rem_days / TRADING_DAYS_PER_YEAR


def strike_step(strikes: list[float]) -> float:
    strikes = sorted(set(strikes))
    if len(strikes) < 2:
        return 5.0
    diffs = [strikes[i + 1] - strikes[i] for i in range(len(strikes) - 1) if strikes[i + 1] > strikes[i]]
    return min(diffs) if diffs else 5.0


def nearest_strike(strikes: list[float], spot: float) -> float:
    return min(strikes, key=lambda k: abs(k - spot))


def find_leg(legs: list[dict], side: str, strike: float) -> dict | None:
    for L in legs:
        if L["side"] == side and abs(L["strike"] - strike) < 1e-6:
            return L
    return None


def nearest_leg(legs: list[dict], side: str, spot: float) -> dict | None:
    cands = [L for L in legs if L["side"] == side]
    if not cands:
        return None
    return min(cands, key=lambda L: abs(L["strike"] - spot))


def atm_straddle_strike(legs: list[dict], spot: float) -> float | None:
    """Strike nearest spot with both a call and a put quote."""
    strikes = sorted({L["strike"] for L in legs})
    best_k: float | None = None
    best_d = float("inf")
    for k in strikes:
        if find_leg(legs, "call", k) and find_leg(legs, "put", k):
            d = abs(k - spot)
            if d < best_d:
                best_d = d
                best_k = k
    return best_k


def delta_strike(legs: list[dict], side: str, target: float) -> dict | None:
    cands = [L for L in legs if L["side"] == side and L.get("delta") is not None]
    if not cands:
        return None
    if side == "call":
        return min(cands, key=lambda L: abs(L["delta"] - target))
    return min(cands, key=lambda L: abs(L["delta"] + target))


def debit_pnl(cost: float, exit_val: float, spot: float = 0) -> float | None:
    floor = max(MIN_PREMIUM, 0.0025 * spot) if spot > 0 else MIN_PREMIUM
    if cost < floor:
        return None
    return (exit_val - cost) / cost * 100.0


def credit_pnl(credit: float, width: float, exit_cost: float) -> float | None:
    risk = width - credit
    if risk < MIN_PREMIUM or credit < MIN_PREMIUM:
        return None
    return (credit - exit_cost) / risk * 100.0


def put_call_parity_gap(spot: float, call_leg: dict, put_leg: dict, K: float) -> float:
    """|C_mid − P_mid − (S − K)|; should be within combined spread at entry."""
    c_mid = quote_mid(call_leg)
    p_mid = quote_mid(put_leg)
    return abs(c_mid - p_mid - (spot - K))


def straddle_legs(legs: list[dict], spot: float) -> tuple[dict, dict, float | None]:
    """Same strike when both quoted; else nearest OTM call + put to spot (OTM-only chain)."""
    k = atm_straddle_strike(legs, spot)
    if k is not None:
        cL, pL = find_leg(legs, "call", k), find_leg(legs, "put", k)
        if cL and pL:
            return cL, pL, k
    cL = nearest_leg(legs, "call", spot)
    pL = nearest_leg(legs, "put", spot)
    if not cL or not pL:
        raise LookupError("no straddle legs")
    return cL, pL, None


def short_put_max_risk(strike: float, credit: float, spot: float) -> float:
    """Cash-secured put: max loss ≈ strike − premium (floor vs spot)."""
    return max(strike - credit, max(MIN_PREMIUM, 0.05 * spot))


def short_call_max_risk(strike: float, credit: float, spot: float) -> float:
    return max(strike * 0.15, max(MIN_PREMIUM, 0.05 * spot))


def credit_pnl_short_put(credit: float, strike: float, exit_cost: float, spot: float) -> float | None:
    risk = short_put_max_risk(strike, credit, spot)
    if credit < MIN_PREMIUM:
        return None
    return (credit - exit_cost) / risk * 100.0


def credit_pnl_short_call(credit: float, strike: float, exit_cost: float, spot: float) -> float | None:
    risk = short_call_max_risk(strike, credit, spot)
    if credit < MIN_PREMIUM:
        return None
    return (credit - exit_cost) / risk * 100.0


def straddle_round_trip_spread(legs: list[dict], spot: float) -> float | None:
    """RH buy + RH sell on straddle legs ≈ round-trip spread cost ($)."""
    try:
        cL, pL, _k = straddle_legs(legs, spot)
    except LookupError:
        return None
    buy = rh_fill_leg(cL, True) + rh_fill_leg(pL, True)
    sell = rh_fill_leg(cL, False) + rh_fill_leg(pL, False)
    return buy - sell


def price_structure(
    name: str,
    side_signal: str,
    spot: float,
    snap,
    exp: date,
    dte: int,
    exit_spot: float,
    hold_min: float,
    iv_mult: float = 1.0,
) -> float | None:
    legs = snap.by_expiry.get(exp)
    if not legs:
        return None
    strikes = sorted({L["strike"] for L in legs})
    step = strike_step(strikes)
    atm = nearest_strike(strikes, spot)
    T = hold_T(dte, hold_min)
    bull = side_signal == "buy"

    def pack(side: str, K: float, buy: bool) -> tuple[float, float] | None:
        L = find_leg(legs, side, K)
        if not L:
            return None
        return leg_entry(L, buy, spot, dte)

    if name == "long_outright":
        side = "call" if bull else "put"
        e = pack(side, atm, True)
        if not e:
            return None
        cost, iv = e
        ex = bs_price(side, exit_spot, atm, T, iv * iv_mult)
        return debit_pnl(cost, ex, spot)

    if name == "debit_vertical":
        if bull:
            lo, hi = pack("call", atm, True), pack("call", atm + step, False)
        else:
            lo, hi = pack("put", atm, True), pack("put", atm - step, False)
        if not lo or not hi:
            return None
        cost = lo[0] - hi[0]
        ex = bs_price("call" if bull else "put", exit_spot, atm, T, lo[1] * iv_mult) - bs_price(
            "call" if bull else "put", exit_spot, atm + (step if bull else -step), T, hi[1] * iv_mult
        )
        return debit_pnl(cost, ex, spot) if cost > 0 else None

    if name == "credit_far":
        if bull:
            sellK, buyK = atm - step, atm - 2 * step
            s, b = pack("put", sellK, False), pack("put", buyK, True)
        else:
            sellK, buyK = atm + step, atm + 2 * step
            s, b = pack("call", sellK, False), pack("call", buyK, True)
        if not s or not b:
            return None
        credit = s[0] - b[0]
        ex_cost = bs_price("put" if bull else "call", exit_spot, sellK, T, s[1] * iv_mult) - bs_price(
            "put" if bull else "call", exit_spot, buyK, T, b[1] * iv_mult
        )
        return credit_pnl(credit, step, ex_cost)

    if name in ("long_straddle", "short_straddle"):
        try:
            cL, pL, k = straddle_legs(legs, spot)
        except LookupError:
            return None
        if name == "long_straddle":
            c, p = leg_entry(cL, True, spot, dte), leg_entry(pL, True, spot, dte)
            cost = c[0] + p[0]
            if k is not None:
                ex = bs_price("call", exit_spot, k, T, c[1] * iv_mult) + bs_price(
                    "put", exit_spot, k, T, p[1] * iv_mult
                )
            else:
                ex = bs_price("call", exit_spot, cL["strike"], T, c[1] * iv_mult) + bs_price(
                    "put", exit_spot, pL["strike"], T, p[1] * iv_mult
                )
            return debit_pnl(cost, ex, spot)
        c, p = leg_entry(cL, False, spot, dte), leg_entry(pL, False, spot, dte)
        credit = c[0] + p[0]
        if k is not None:
            ex_cost = bs_price("call", exit_spot, k, T, c[1] * iv_mult) + bs_price(
                "put", exit_spot, k, T, p[1] * iv_mult
            )
        else:
            ex_cost = bs_price("call", exit_spot, cL["strike"], T, c[1] * iv_mult) + bs_price(
                "put", exit_spot, pL["strike"], T, p[1] * iv_mult
            )
        width = max(credit * 2, step * 2)
        return credit_pnl(credit, width, ex_cost)

    if name == "long_strangle":
        cL = delta_strike(legs, "call", 0.25)
        pL = delta_strike(legs, "put", 0.25)
        if not cL or not pL:
            return None
        c, p = leg_entry(cL, True, spot, dte), leg_entry(pL, True, spot, dte)
        cost = c[0] + p[0]
        ex = bs_price("call", exit_spot, cL["strike"], T, c[1] * iv_mult) + bs_price(
            "put", exit_spot, pL["strike"], T, p[1] * iv_mult
        )
        return debit_pnl(cost, ex, spot)

    if name == "iron_condor":
        cS = delta_strike(legs, "call", 0.25)
        pS = delta_strike(legs, "put", 0.25)
        if not cS or not pS:
            return None
        cw = find_leg(legs, "call", cS["strike"] + step)
        pw = find_leg(legs, "put", pS["strike"] - step)
        if not cw or not pw:
            return None
        sc, bc = leg_entry(cS, False, spot, dte), leg_entry(cw, True, spot, dte)
        sp, bp = leg_entry(pS, False, spot, dte), leg_entry(pw, True, spot, dte)
        credit = sc[0] - bc[0] + sp[0] - bp[0]
        ex = (
            bs_price("call", exit_spot, cS["strike"], T, sc[1] * iv_mult)
            - bs_price("call", exit_spot, cw["strike"], T, bc[1] * iv_mult)
            + bs_price("put", exit_spot, pS["strike"], T, sp[1] * iv_mult)
            - bs_price("put", exit_spot, pw["strike"], T, bp[1] * iv_mult)
        )
        return credit_pnl(credit, 2 * step, ex)

    return None


def straddle_dollar_pnls(
    spot: float,
    snap,
    exp: date,
    dte: int,
    exit_spot: float,
    hold_min: float,
) -> tuple[float, float, float] | None:
    """Returns (long_dollar, short_dollar, round_trip_spread) or None."""
    legs = snap.by_expiry.get(exp)
    if not legs:
        return None
    try:
        cL, pL, k = straddle_legs(legs, spot)
    except LookupError:
        return None
    T = hold_T(dte, hold_min)
    lc, lp = leg_entry(cL, True, spot, dte), leg_entry(pL, True, spot, dte)
    sc, sp = leg_entry(cL, False, spot, dte), leg_entry(pL, False, spot, dte)
    cost = lc[0] + lp[0]
    credit = sc[0] + sp[0]
    if k is not None:
        ex = bs_price("call", exit_spot, k, T, lc[1]) + bs_price("put", exit_spot, k, T, lp[1])
    else:
        ex = bs_price("call", exit_spot, cL["strike"], T, lc[1]) + bs_price(
            "put", exit_spot, pL["strike"], T, lp[1]
        )
    long_d = ex - cost
    short_d = credit - ex
    rt = straddle_round_trip_spread(legs, spot)
    if rt is None:
        return None
    return long_d, short_d, rt
