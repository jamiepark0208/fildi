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
    .venv/bin/python pm_book.py --live     # re-price spot + put marks/IV from Schwab (API server) before scoring
"""
from __future__ import annotations

import json
import math
import sys
import urllib.request
from datetime import date, datetime
from pathlib import Path

from book_accounting import accounting
from cash_moves import mix, plan as rebalance_plan, reserve
from build_plan import connect, rows

OUT = Path(__file__).resolve().parent / "out" / "pm"
ACCOUNTS = {"772445425": "IRA", "5QU47796": "FILDI"}
PM_RULES = {  # defaults pending user choice (2026-10-14); see S015 + state.md
    "crash_move": -0.30,     # typical worst 5-day move of the book's names (−25% … −52% observed)
    "crash_budget": 0.25,    # max equity drop in that crash week → RED (user 2026-10-14: "25% is fine")
    "crash_warn": 0.20,      # → AMBER early warning (user: "maybe even lower")
    "bad_week_itm": 0.53,    # S015: 1 in 10 expiries ends with ~53% of puts ITM
}
N = lambda x: 0.5 * (1 + math.erf(x / math.sqrt(2)))  # noqa: E731


def p_otm(spot: float | None, k: float, iv: float | None, days: float) -> float | None:
    if spot is None or not iv or iv <= 0 or spot <= 0:
        return None
    t = max(days, 0.5) / 252
    d2 = (math.log(spot / k) - 0.5 * iv * iv * t) / (iv * math.sqrt(t))
    return N(d2)


API = "http://127.0.0.1:8080/api/schwab"


def _post(path: str, body: dict) -> dict:
    try:
        req = urllib.request.Request(f"{API}/{path}", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except Exception:
        return {}


def live_reprice(puts: list[dict], longs: list[dict]) -> str | None:
    """Overwrite spot/mark/iv with Schwab quotes in place; long market values rescaled to live price. Returns quote time or None."""
    tickers = sorted({p["t"] for p in puts} | {x["t"] for x in longs})
    px = _post("equity-prices", {"tickers": tickers}).get("prices", {})
    q = _post("option-quotes", {"contracts": [{"ticker": p["t"], "expiry": str(p["exp"]), "strike": p["k"], "type": "put"} for p in puts]})
    quotes, syms = q.get("quotes", {}), q.get("symbols", {})
    if not px and not quotes:
        return None
    for x in longs:
        live = (px.get(x["t"]) or {}).get("price")
        if live and x["q"]:
            x["mv"] = live * x["q"]
    t = None
    for p in puts:
        live = (px.get(p["t"]) or {}).get("price")
        if live:
            p["spot"] = live
        oq = quotes.get(syms.get(f"{p['t']}|{p['exp']}|{p['k']:g}|put", ""), {}) or quotes.get(syms.get(f"{p['t']}|{p['exp']}|{p['k']}|put", ""), {})
        if oq.get("mark") is not None:
            p["mark"], p["iv"] = oq["mark"], oq.get("iv") or p["iv"]
            t = max(t or "", oq.get("quoteTime") or "")
    return t or datetime.now().isoformat(timespec="seconds")


def trading_days(a: date, b: date) -> int:
    n, d = 0, a
    while d < b:
        d = date.fromordinal(d.toordinal() + 1)
        n += d.weekday() < 5
    return n


def cash_history(conn) -> dict:
    """A372 § 4 chart: the market target over time (issued rows win; earlier = counterfactual replay) + each account's
    cash mix F/(F+P) at every holdings snapshot, on the same reserve basis as the moves table (cash_moves.reserve).
    Debt (cash < 0) → mix None with debt $, never a fake 0 %. Last snapshot per account per day."""
    snaps = rows(conn, """SELECT DISTINCT ON (a.account, s.imported_at::date) s.id, s.imported_at::date d, a.account,
                                 a.cash::float8 cash, a.buying_power::float8 bp, a.total_value::float8 total_value,
                                 a.equity_value::float8 equity_value, a.options_value::float8 options_value,
                                 a.crypto_value::float8 crypto_value, a.unleveraged_bp::float8 unleveraged_bp
                          FROM portfolio_snapshots s JOIN portfolio_account_summaries a ON a.snapshot_id = s.id
                          ORDER BY a.account, s.imported_at::date, s.imported_at DESC""")
    if not snaps:
        return {"target": [], "accounts": {}}
    puts = rows(conn, """SELECT o.snapshot_id sid, o.account, o.strike::float8 strike, SUM(o.qty)::float8 qty
                         FROM portfolio_options o JOIN portfolio_snapshots s ON s.id = o.snapshot_id
                         WHERE o.direction = 'short' AND o.option_type = 'put' AND o.expiration >= s.imported_at::date
                           AND o.snapshot_id = ANY(%s) GROUP BY 1, 2, 3""", ([r["id"] for r in snaps],))
    accts: dict[str, list] = {}
    for r in snaps:
        a = accounting(r, [p for p in puts if p["sid"] == r["id"] and p["account"] == r["account"]])
        F, basis = reserve(a)
        m = mix(F, a["P"])
        accts.setdefault(ACCOUNTS.get(r["account"], r["account"]), []).append(
            {"d": str(r["d"]), "mix": None if m is None else round(m, 4), "F": round(F, 2), "P": round(a["P"], 2),
             "debt": a["D"] or None, "basis": basis.split(",")[0]})
    start = min(str(r["d"]) for r in snaps)
    hist = Path(__file__).resolve().parent / "out" / "cash_target" / "history.json"
    tgt = {p["d"]: {"d": p["d"], "target": p["target"], "regime": p["regime"], "issued": False}
           for p in (json.loads(hist.read_text())["points"] if hist.exists() else []) if p["d"] >= start}
    for r in rows(conn, """SELECT DISTINCT ON (as_of) as_of::text d, target, regime FROM watchlist_sync.cash_target
                           ORDER BY as_of, known_at"""):
        tgt[r["d"]] = {"d": r["d"], "target": float(r["target"]), "regime": r["regime"], "issued": True}
    return {"target": sorted(tgt.values(), key=lambda x: x["d"]), "accounts": accts,
            "note": "target before the first issued day is the same rule replayed (counterfactual)"}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    conn = connect()
    snap = conn.execute("SELECT MAX(id) FROM portfolio_snapshots").fetchone()[0]
    taken = conn.execute("SELECT imported_at FROM portfolio_snapshots WHERE id = %s", (snap,)).fetchone()[0]
    accts = {r["account"]: r for r in rows(conn, """SELECT account, nickname, type, total_value::float8 AS equity, cash::float8 AS cash,
                    buying_power::float8 AS bp, total_value::float8 AS total_value, equity_value::float8 AS equity_value,
                    options_value::float8 AS options_value, crypto_value::float8 AS crypto_value,
                    unleveraged_bp::float8 AS unleveraged_bp FROM portfolio_account_summaries WHERE snapshot_id = %s""", (snap,))}
    longs = rows(conn, """SELECT account, UPPER(symbol) AS t, SUM(quantity)::float8 AS q, SUM(market_value)::float8 AS mv
                          FROM portfolio_positions WHERE snapshot_id = %s GROUP BY 1, 2""", (snap,))
    puts = rows(conn, """SELECT o.account, UPPER(o.symbol) AS t, o.strike::float8 AS k, o.expiration AS exp, o.qty::float8 AS q,
                                o.iv::float8 AS iv, o.mark_price::float8 AS mark, o.avg_premium::float8 / 100 AS prem,   -- avg_premium is $/contract; mark is $/share
                                (SELECT close::float8 FROM prices_historical p WHERE p.ticker = UPPER(o.symbol) ORDER BY date DESC LIMIT 1) AS spot,
                                (SELECT market_value::float8 / NULLIF(quantity, 0) FROM portfolio_positions pp
                                   WHERE pp.snapshot_id = o.snapshot_id AND UPPER(pp.symbol) = UPPER(o.symbol)
                                   ORDER BY pp.id DESC LIMIT 1) AS pos_px
                         FROM portfolio_options o WHERE o.snapshot_id = %s AND o.direction = 'short' AND o.option_type = 'put'
                           AND o.expiration >= CURRENT_DATE""", (snap,))
    for p in puts:
        if p["spot"] is None and p.get("pos_px"):
            p["spot"] = p["pos_px"]
    priced = live_reprice(puts, longs) if "--live" in sys.argv else None
    today = date.today()
    positions, books, unknown_notes = [], {}, []
    for p in puts:
        try:
            iv = p["iv"]
            iv = iv / 100 if iv and iv > 5 else iv
            days = trading_days(today, p["exp"])
            spot = p["spot"]
            if spot is None or spot <= 0:
                unknown_notes.append(f"{p['t']} {p['k']:g} {p['exp']}: no spot")
                positions.append({
                    "account": ACCOUNTS.get(p["account"], p["account"]), "ticker": p["t"], "strike": p["k"], "expiry": str(p["exp"]),
                    "qty": p["q"], "spot": None, "itm": False, "move_needed": None, "p_otm": None, "iv": iv,
                    "close_cost": (p["mark"] or 0) * 100 * (p["q"] or 0), "assign_cash": p["k"] * 100 * (p["q"] or 0),
                    "days_left": days, "status": "unknown",
                })
                continue
            po = p_otm(spot, p["k"], iv, days)
            itm = spot < p["k"]
            positions.append({
                "account": ACCOUNTS.get(p["account"], p["account"]), "ticker": p["t"], "strike": p["k"], "expiry": str(p["exp"]),
                "qty": p["q"], "spot": spot, "itm": itm, "move_needed": p["k"] / spot - 1, "p_otm": po, "iv": iv,
                "close_cost": (p["mark"] or 0) * 100 * p["q"], "assign_cash": p["k"] * 100 * p["q"], "days_left": days,
                "status": "red" if itm and days <= 3 else "amber" if itm or (po is not None and po < 0.6) else "green",
            })
        except Exception as e:  # noqa: BLE001 — one bad row must not kill the book
            unknown_notes.append(f"{p.get('t')} {p.get('k')}: {e}")
            positions.append({
                "account": ACCOUNTS.get(p["account"], p["account"]), "ticker": p["t"], "strike": p["k"], "expiry": str(p["exp"]),
                "qty": p["q"], "spot": p.get("spot"), "itm": False, "move_needed": None, "p_otm": None, "iv": p.get("iv"),
                "close_cost": (p["mark"] or 0) * 100 * (p["q"] or 0), "assign_cash": (p["k"] or 0) * 100 * (p["q"] or 0),
                "days_left": 0, "status": "unknown",
            })
    crash = PM_RULES["crash_move"]
    for acct, a in accts.items():
        name = ACCOUNTS.get(acct, acct)
        lg = [x for x in longs if x["account"] == acct]
        ps_all = [x for x in positions if x["account"] == name]
        ps = [x for x in ps_all if x["status"] != "unknown"]  # exclude unknown from crash/assign math
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
             "short_puts": len(ps_all), "itm_puts": sum(x["itm"] for x in ps), "assign_if_itm_now": assign_itm, "assign_if_all": assign_all,
             "assign_bad_week": PM_RULES["bad_week_itm"] * assign_all,
             "crash_equity": crash_eq, "crash_drop_pct": 1 - crash_eq / eq if eq else None, "close_itm_cost": sum(x["close_cost"] for x in ps if x["itm"]),
             "unknown_puts": sum(1 for x in ps_all if x["status"] == "unknown"),
             # A372 § 1: E/C/D/P/F + actual cash-vs-put mix (F unknown unless broker free cash reconciles)
             "accounting": accounting(a, [{"strike": x["strike"], "qty": x["qty"]} for x in ps_all])}
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
        amber = amber or (b["crash_drop_pct"] or 0) > PM_RULES["crash_warn"]
        b["status"] = "red" if red else "amber" if amber else "green"
        books[name] = b
    # A372 § 2/§ 4: ONE market-wide cash target (cash_target.py) → per-account moves to reach it. Target never reads an account.
    tgt = rows(conn, """SELECT as_of::text, policy_version, target, lo, hi, regime, direction, reasons, known_at::text
                        FROM watchlist_sync.cash_target ORDER BY as_of DESC, known_at DESC LIMIT 1""") if conn.execute(
        "SELECT to_regclass('watchlist_sync.cash_target')").fetchone()[0] else []
    cash_target = tgt[0] if tgt else None
    if cash_target:
        folders = {r["t"]: r["f"] for r in rows(conn, """SELECT UPPER(ticker) t, (array_agg(folder_key ORDER BY CASE folder_key
                       WHEN 'avoid' THEN 0 WHEN 'trim_risk' THEN 1 ELSE 2 END))[1] f FROM watchlist_sync.model_items
                       WHERE run_id = (SELECT MAX(id) FROM watchlist_sync.model_runs) GROUP BY 1""")}
        calls = rows(conn, """SELECT account, UPPER(symbol) t, SUM(qty)::float8 q FROM portfolio_options WHERE snapshot_id = %s
                              AND option_type = 'call' AND direction = 'short' AND expiration >= CURRENT_DATE GROUP BY 1, 2""", (snap,))
        picks = [{"ticker": r["ticker"], "rank": r["rank"], "strike": float(r["k"]), "expiry": r["e"], "bid": float(r["b"] or 0)}
                 for r in rows(conn, """SELECT ticker, rank, payload->>'strike' k, payload->>'expiry' e, payload->>'bid' b
                                        FROM watchlist_sync.put_recs_daily WHERE pass AND payload->>'strike' IS NOT NULL
                                          AND as_of = (SELECT MAX(as_of) FROM watchlist_sync.put_recs_daily) ORDER BY rank LIMIT 15""")]
        for acct, a in accts.items():
            name = ACCOUNTS.get(acct, acct)
            margin_loan = "margin" in (a["type"] or "").lower() and (a["cash"] or 0) < 0
            stocks = [{"ticker": x["t"], "qty": x["q"], "px": (x["mv"] or 0) / x["q"] if x["q"] else 0, "folder": folders.get(x["t"])}
                      for x in longs if x["account"] == acct and (x["q"] or 0) > 0]
            aputs = [{"ticker": p["t"], "strike": p["k"], "expiry": str(p["exp"]), "qty": p["q"], "mark": p["mark"], "prem": p["prem"]}
                     for p in puts if p["account"] == acct]
            books[name]["rebalance"] = rebalance_plan(books[name]["accounting"], cash_target, aputs, stocks,
                                                      {c["t"]: c["q"] for c in calls if c["account"] == acct}, picks,
                                                      allow_new_puts=not margin_loan)
    try:
        hist = cash_history(conn)
    except Exception as e:  # the chart is optional; the book must still publish
        hist = {"target": [], "accounts": {}, "error": str(e)[:200]}
    out = {"generated": datetime.now().isoformat(timespec="seconds"), "snapshot_id": snap, "cash_target": cash_target,
           "cash_history": hist, "snapshot_at": taken.isoformat(), "live_priced_at": priced,
           "rules": PM_RULES, "accounts": books,
           "positions": sorted(positions, key=lambda x: (x["expiry"], x["account"], -(x["move_needed"] or -1))),
           "unknown_notes": unknown_notes}
    (OUT / "book-latest.json").write_text(json.dumps(out, indent=1, default=str))

    f = lambda v: f"${v:,.0f}"  # noqa: E731
    L = [f"# Book — snapshot {snap} ({taken:%Y-%m-%d %H:%M})" + (f" · live Schwab prices {priced}" if priced else " · snapshot prices"), ""]
    if unknown_notes:
        L += ["**Unknown / skipped spots:**", *[f"- {n}" for n in unknown_notes], ""]
    for b in books.values():
        L.append(f"**{b['account']}** {b['status'].upper()} · equity {f(b['equity'])} · cash {f(b['cash'])} · {b['itm_puts']}/{b['short_puts']} puts ITM · "
                 f"assign if ITM now {f(b['assign_if_itm_now'])} · crash ({crash:.0%}) equity {f(b['crash_equity'])} ({-(b['crash_drop_pct'] or 0):.0%})")
        if "maint_ratio_est" in b:
            L.append(f"  margin: est. maintenance {b['maint_ratio_est']:.0%} of longs · headroom now {f(b['headroom_now'])} · "
                     f"if assigned {f(b['headroom_if_assigned'])} · in crash {f(b['headroom_crash'])}")
    L += ["", "| acct | ticker | strike | exp | spot | needs | P(OTM) | close now | if assigned | status |", "|---|---|---|---|---|---|---|---|---|---|"]
    for x in out["positions"]:
        po = "—" if x["p_otm"] is None else f"{x['p_otm']:.0%}"
        spot_s = "—" if x["spot"] is None else f"{x['spot']:.2f}"
        needs_s = "—" if x["move_needed"] is None else f"{x['move_needed']:+.1%}"
        L.append(f"| {x['account']} | {x['ticker']} | {x['strike']:g} | {x['expiry']} | {spot_s} | {needs_s} | {po} | "
                 f"{f(x['close_cost'])} | {f(x['assign_cash'])} | {x['status']} |")
    (OUT / "book-latest.md").write_text("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
