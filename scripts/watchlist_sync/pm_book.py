"""PM book risk (Claude, portfolio-manager role, user 2026-10-14). Read-only: what the book can survive, per account and position.

Built on S015 (out/mistakes/report.md): picks are fine and assignment is EV-neutral, but breaches cluster by expiry, so the risk
that matters is the BOOK, not any single put. Three questions, answered from the latest Robinhood snapshot:

  1. Expiry    For each short put: P(finish OTM) from its own implied vol (risk-neutral: a fair coin, not a forecast), cost to buy
               back now, cash needed if assigned.
  2. Stress    Each account under a crash week: every stock held and every put underlying falls by CRASH_MOVE (default −30%, the
               typical worst 5-day move of the book's names in prices_historical). Equity after = equity − stock loss − put loss.
  3. Margin    (margin accounts) Maintenance is estimated from the snapshot itself: requirement = equity − excess, where Robinhood's
               buying power ≈ excess. Ratio = requirement ÷ long stock value. Headroom after crash/assignment = equity − ratio × longs.
               Negative headroom = margin call.

Status per account: RED = margin call under assignment alone, or crash equity drop > CRASH_BUDGET; AMBER = margin call only in the
crash, or assignment need > cash; GREEN otherwise. Thresholds are the user's to set (PM_RULES); defaults are labeled as such.

    .venv/bin/python pm_book.py            # → out/pm/book-latest.json + book-latest.md
"""
from __future__ import annotations

import json
import math
from datetime import date, datetime
from pathlib import Path

from build_plan import connect, rows

OUT = Path(__file__).resolve().parent / "out" / "pm"
ACCOUNTS = {"772445425": "IRA", "5QU47796": "FILDI"}
PM_RULES = {  # defaults pending user choice (2026-10-14); see S015 + state.md
    "crash_move": -0.30,     # typical worst 5-day move of the book's names (−25% … −52% observed)
    "crash_budget": 0.25,    # max equity drop tolerated in that crash week
    "bad_week_itm": 0.53,    # S015: 1 in 10 expiries ends with ~53% of puts ITM
}
N = lambda x: 0.5 * (1 + math.erf(x / math.sqrt(2)))  # noqa: E731


def p_otm(spot: float, k: float, iv: float | None, days: float) -> float | None:
    if not iv or iv <= 0 or spot <= 0:
        return None
    t = max(days, 0.5) / 252
    d2 = (math.log(spot / k) - 0.5 * iv * iv * t) / (iv * math.sqrt(t))
    return N(d2)


def trading_days(a: date, b: date) -> int:
    n, d = 0, a
    while d < b:
        d = date.fromordinal(d.toordinal() + 1)
        n += d.weekday() < 5
    return n


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    conn = connect()
    snap = conn.execute("SELECT MAX(id) FROM portfolio_snapshots").fetchone()[0]
    taken = conn.execute("SELECT imported_at FROM portfolio_snapshots WHERE id = %s", (snap,)).fetchone()[0]
    accts = {r["account"]: r for r in rows(conn, """SELECT account, nickname, type, total_value::float8 AS equity, cash::float8 AS cash,
                    buying_power::float8 AS bp FROM portfolio_account_summaries WHERE snapshot_id = %s""", (snap,))}
    longs = rows(conn, """SELECT account, UPPER(symbol) AS t, SUM(quantity)::float8 AS q, SUM(market_value)::float8 AS mv
                          FROM portfolio_positions WHERE snapshot_id = %s GROUP BY 1, 2""", (snap,))
    puts = rows(conn, """SELECT o.account, UPPER(o.symbol) AS t, o.strike::float8 AS k, o.expiration AS exp, o.qty::float8 AS q,
                                o.iv::float8 AS iv, o.mark_price::float8 AS mark, o.avg_premium::float8 AS prem,
                                (SELECT close::float8 FROM prices_historical p WHERE p.ticker = UPPER(o.symbol) ORDER BY date DESC LIMIT 1) AS spot
                         FROM portfolio_options o WHERE o.snapshot_id = %s AND o.direction = 'short' AND o.option_type = 'put'
                           AND o.expiration >= CURRENT_DATE""", (snap,))
    today = date.today()
    positions, books = [], {}
    for p in puts:
        iv = p["iv"]
        iv = iv / 100 if iv and iv > 5 else iv
        days = trading_days(today, p["exp"])
        po = p_otm(p["spot"], p["k"], iv, days)
        itm = p["spot"] < p["k"]
        positions.append({
            "account": ACCOUNTS.get(p["account"], p["account"]), "ticker": p["t"], "strike": p["k"], "expiry": str(p["exp"]),
            "qty": p["q"], "spot": p["spot"], "itm": itm, "move_needed": p["k"] / p["spot"] - 1, "p_otm": po, "iv": iv,
            "close_cost": (p["mark"] or 0) * 100 * p["q"], "assign_cash": p["k"] * 100 * p["q"], "days_left": days,
            "status": "red" if itm and days <= 3 else "amber" if itm or (po is not None and po < 0.6) else "green",
        })
    crash = PM_RULES["crash_move"]
    for acct, a in accts.items():
        name = ACCOUNTS.get(acct, acct)
        lg = [x for x in longs if x["account"] == acct]
        ps = [x for x in positions if x["account"] == name]
        long_mv = sum(x["mv"] or 0 for x in lg)
        assign_all = sum(x["assign_cash"] for x in ps)
        assign_itm = sum(x["assign_cash"] for x in ps if x["itm"])
        margin = "margin" in (a["type"] or "").lower()
        # crash: stocks −30%; each put loses max(K − S·(1+crash), 0) minus what its mark already prices
        put_loss = sum(max(x["strike"] - x["spot"] * (1 + crash), 0) * 100 * x["qty"] - x["close_cost"] for x in ps)
        stock_loss = -crash * long_mv
        eq = a["equity"]
        crash_eq = eq - stock_loss - put_loss
        b = {"account": name, "type": a["type"], "equity": eq, "cash": a["cash"], "buying_power": a["bp"], "long_value": long_mv,
             "short_puts": len(ps), "itm_puts": sum(x["itm"] for x in ps), "assign_if_itm_now": assign_itm, "assign_if_all": assign_all,
             "assign_bad_week": PM_RULES["bad_week_itm"] * assign_all,
             "crash_equity": crash_eq, "crash_drop_pct": 1 - crash_eq / eq if eq else None, "close_itm_cost": sum(x["close_cost"] for x in ps if x["itm"])}
        if margin:
            req = max(eq - (a["bp"] or 0), 0)
            ratio = req / long_mv if long_mv else 0.5
            b["maint_ratio_est"] = ratio
            b["headroom_now"] = eq - ratio * long_mv
            b["headroom_if_assigned"] = eq - ratio * (long_mv + assign_itm)          # assignment: buy shares with borrowed cash
            b["headroom_crash"] = crash_eq - ratio * (long_mv * (1 + crash))
            red = b["headroom_if_assigned"] < 0 or (b["crash_drop_pct"] or 0) > PM_RULES["crash_budget"]
            amber = b["headroom_crash"] < 0
        else:
            red = (b["crash_drop_pct"] or 0) > PM_RULES["crash_budget"]
            amber = assign_itm > max(a["cash"] or 0, 0) + 1
        b["status"] = "red" if red else "amber" if amber else "green"
        books[name] = b
    out = {"generated": datetime.now().isoformat(timespec="seconds"), "snapshot_id": snap, "snapshot_at": taken.isoformat(),
           "rules": PM_RULES, "accounts": books, "positions": sorted(positions, key=lambda x: (x["expiry"], x["account"], -x["move_needed"]))}
    (OUT / "book-latest.json").write_text(json.dumps(out, indent=1, default=str))

    f = lambda v: f"${v:,.0f}"  # noqa: E731
    L = [f"# Book — snapshot {snap} ({taken:%Y-%m-%d %H:%M})", ""]
    for b in books.values():
        L.append(f"**{b['account']}** {b['status'].upper()} · equity {f(b['equity'])} · cash {f(b['cash'])} · {b['itm_puts']}/{b['short_puts']} puts ITM · "
                 f"assign if ITM now {f(b['assign_if_itm_now'])} · crash ({crash:.0%}) equity {f(b['crash_equity'])} ({-b['crash_drop_pct']:.0%})")
        if "maint_ratio_est" in b:
            L.append(f"  margin: est. maintenance {b['maint_ratio_est']:.0%} of longs · headroom now {f(b['headroom_now'])} · "
                     f"if assigned {f(b['headroom_if_assigned'])} · in crash {f(b['headroom_crash'])}")
    L += ["", "| acct | ticker | strike | exp | spot | needs | P(OTM) | close now | if assigned | status |", "|---|---|---|---|---|---|---|---|---|---|"]
    for x in out["positions"]:
        po = "—" if x["p_otm"] is None else f"{x['p_otm']:.0%}"
        L.append(f"| {x['account']} | {x['ticker']} | {x['strike']:g} | {x['expiry']} | {x['spot']:.2f} | {x['move_needed']:+.1%} | {po} | "
                 f"{f(x['close_cost'])} | {f(x['assign_cash'])} | {x['status']} |")
    (OUT / "book-latest.md").write_text("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
