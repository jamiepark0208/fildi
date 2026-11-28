#!/usr/bin/env python3
"""S213 today: which structures FIT a $10k cash account per name, from real Schwab quotes (out/s213/leaps, out/s213/short).
Fill = bid + 23 % of spread (sell) / ask − 23 % (buy) — study contract rule 1. Whole contracts only. → out/s213/today.json

    .venv/bin/python analysis/s213_today.py
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "out" / "s213"
CASH = 10_000.0


def legs(t, kind):
    f = OUT / kind / f"{t}.json"
    if not f.exists():
        return None, []
    d = json.loads(f.read_text())
    rows = [o for o in d["rows"] if o.get("bid") is not None and o.get("ask") and o["ask"] >= o["bid"] >= 0 and o.get("delta") is not None]
    return d.get("spot"), rows


def buy(o):
    return o["ask"] - 0.23 * (o["ask"] - o["bid"])


def sell(o):
    return o["bid"] + 0.23 * (o["ask"] - o["bid"])


def near(rows, side, delta, expiry=None):
    c = [o for o in rows if o["side"] == side and (expiry is None or o["expiry"] == expiry) and (o.get("oi") or 0) >= 10]
    return min(c, key=lambda o: abs(abs(o["delta"]) - abs(delta))) if c else None


def far_expiry(rows):
    ex = sorted({o["expiry"] for o in rows})
    return ex[-1] if ex else None


def one(t):
    S, L = legs(t, "leaps")
    S2, Sh = legs(t, "short")
    S = S or S2
    if not S:
        return None
    r = {"ticker": t, "spot": S, "shares_whole": int(CASH // S), "shares_fits": True}
    E = far_expiry(L)
    if E:
        yrs = (date.fromisoformat(E) - date.today()).days / 365
        r["leaps_expiry"] = E
        c80 = near(L, "call", 0.80, E)
        if c80:
            px = buy(c80)
            ext = px - max(S - c80["strike"], 0)
            r["leaps80"] = {"strike": c80["strike"], "delta": c80["delta"], "cost_1": round(px * 100), "fits": px * 100 <= CASH,
                            "exposure_1": round(c80["delta"] * S * 100), "extrinsic_pct_spot": round(ext / S, 4), "extrinsic_pct_yr": round(ext / S / yrs, 4),
                            "breakeven_vs_spot": round((c80["strike"] + px) / S - 1, 4), "spread_pct": round((c80["ask"] - c80["bid"]) / ((c80["ask"] + c80["bid"]) / 2), 3), "oi": c80.get("oi")}
        ca = near(L, "call", 0.50, E)
        cal = [o for o in L if o["side"] == "call" and o["expiry"] == E and (o.get("oi") or 0) >= 10]
        atm = min(cal, key=lambda o: abs(o["strike"] - S)) if cal else None
        cu = [o for o in L if o["side"] == "call" and o["expiry"] == E and o["strike"] >= S * 1.30 and (o.get("oi") or 0) >= 10]
        if atm and cu:
            cu = min(cu, key=lambda o: o["strike"])
            deb = buy(atm) - sell(cu)
            r["call_spread"] = {"long": atm["strike"], "short": cu["strike"], "debit_1": round(deb * 100), "max_1": round((cu["strike"] - atm["strike"]) * 100),
                                "payoff_x": round((cu["strike"] - atm["strike"]) / deb, 2) if deb > 0 else None, "n_fit": int(CASH // (deb * 100)) if deb > 0 else 0}
        p25 = near(L, "put", 0.25, E)
        if ca and p25:
            net = buy(ca) - sell(p25)
            r["risk_rev"] = {"put": p25["strike"], "call": ca["strike"], "net_1": round(net * 100), "collateral_1": round(p25["strike"] * 100),
                             "fits_cash": p25["strike"] * 100 + max(net, 0) * 100 <= CASH, "exposure_1": round((ca["delta"] - p25["delta"]) * S * 100)}
    if Sh:
        E1 = sorted({o["expiry"] for o in Sh}, key=lambda e: abs((date.fromisoformat(e) - date.today()).days - 45))[0]
        dte = (date.fromisoformat(E1) - date.today()).days
        p30 = near(Sh, "put", 0.30, E1)
        c30 = near(Sh, "call", 0.30, E1)
        if p30:
            prem = sell(p30)
            r["csp"] = {"expiry": E1, "strike": p30["strike"], "delta": p30["delta"], "collateral_1": round(p30["strike"] * 100), "fits": p30["strike"] * 100 <= CASH,
                        "premium_1": round(prem * 100), "yield_pct_mo": round(prem / p30["strike"] * 30 / dte, 4), "spread_pct": round((p30["ask"] - p30["bid"]) / max((p30["ask"] + p30["bid"]) / 2, 0.01), 3)}
        if c30:
            prem = sell(c30)
            r["buy_write"] = {"expiry": E1, "strike": c30["strike"], "cost_1": round(S * 100 - prem * 100), "fits": S * 100 - prem * 100 <= CASH,
                              "yield_pct_mo": round(prem / S * 30 / dte, 4), "cap_vs_spot": round(c30["strike"] / S - 1, 4)}
    return r


def main():
    names = sorted({f.stem for f in (OUT / "leaps").glob("*.json")} | {f.stem for f in (OUT / "short").glob("*.json")})
    rows = [x for x in (one(t) for t in names) if x]
    (OUT / "today.json").write_text(json.dumps({"asof": date.today().isoformat(), "rows": rows}, indent=1))
    for r in rows:
        l, c, k, b, rr = r.get("leaps80", {}), r.get("csp", {}), r.get("call_spread", {}), r.get("buy_write", {}), r.get("risk_rev", {})
        print(f"{r['ticker']:5s} ${r['spot']:8.2f} | LEAP80 ${l.get('cost_1','—')} fit {l.get('fits')} ext/yr {l.get('extrinsic_pct_yr')} | CSP K{c.get('strike')} coll ${c.get('collateral_1')} fit {c.get('fits')} {c.get('yield_pct_mo')}/mo "
              f"| BW ${b.get('cost_1')} fit {b.get('fits')} | CS ${k.get('debit_1')} x{k.get('payoff_x')} | RR coll ${rr.get('collateral_1')} fit {rr.get('fits_cash')}")


if __name__ == "__main__":
    main()
