"""Step 7: portfolio layer. Turns individually-good ideas into a book that fits, and watches what's already open.

All limits are learnable params (params.py "portfolio"). Uses the latest Robinhood snapshot (positions, open options, buying power).

Collateral (v2, user review 2026-10-05):
  Robinhood's buying power is *net* of collateral already posted on open short puts. So per account:
    posted    = Σ strike × 100 × qty of open short puts (cash-secured)
    capacity  = cash buying power + posted        (all the cash that can back puts; IRA: $23.1k free + $15.0k posted ≈ its $38.1k cash)
  Funding order for a new put, best idea first (by realistic weekly yield):
    1. free cash buying power
    2. close open short puts that are a *worse use of the same collateral* (their remaining weekly yield = mark ÷ strike per week
       left, below the new idea's), cheapest-to-close first. Each closure is listed: "close ONDS 7P ×10: frees $7,000, costs $55".
  C1 (fit-1.4.3, user 2026-10-05): open-put collateral counts as closable. `fund_by_closing_any_put` lets any open put fund an idea
  (closures that give up a better yield or lock in an in-the-money loss are flagged, not skipped); `budget_counts_open_puts: false`
  measures the budget on new ideas only. The user decides; the list shows the opportunity and its cost.
  Feasibility (fits after closures) is the only hard limit. Concentration limits are SOFT: the idea is kept, with a warning:
    position > max_position_pct of capacity · total puts > budget_pct of capacity · sector > max_per_sector ideas or > sector_pct
    of capacity · adding to a name you're already short a put on.
  Covered calls: a strike below your average cost is held back (being called away locks in a loss) unless the verdict is red.
manage(): open short options → take profit (kept ≥ take_profit) · in the money / at risk (within at_risk_pct) · expiring soon,
  plus any closure the allocator suggested to fund a better trade.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date

from build_plan import rows

DEFAULTS = {"budget_pct": 0.60, "use_margin": False, "max_position_pct": 0.35, "max_per_sector": 2, "sector_pct": 0.50,
            "take_profit": 0.50, "at_risk_pct": 0.03, "expiry_days": 2, "allow_below_cost_if_red": True, "min_yield_edge": 0.10}


def snapshot(conn) -> dict:
    sid = rows(conn, "SELECT MAX(id) m FROM portfolio_snapshots")[0]["m"]
    accts = rows(conn, """SELECT account, nickname, type, COALESCE(unleveraged_bp, buying_power)::float8 cash_bp, buying_power::float8 bp,
                                 COALESCE(margin_used, 0)::float8 margin_used, total_value::float8 total_value,
                                 COALESCE(crypto_value, 0)::float8 crypto_value, COALESCE(cash, 0)::float8 cash
                          FROM portfolio_account_summaries WHERE snapshot_id = %s""", (sid,))
    pos = rows(conn, """SELECT account, UPPER(symbol) ticker, quantity::float8 qty, avg_cost::float8 avg_cost, last_price::float8 last
                        FROM portfolio_positions WHERE snapshot_id = %s""", (sid,))
    opts = rows(conn, """SELECT account, UPPER(symbol) ticker, option_type, strike::float8 strike, expiration, direction, qty::float8 qty,
                         avg_premium::float8 avg_premium, mark_price::float8 mark FROM portfolio_options WHERE snapshot_id = %s""", (sid,))
    peer = {r["ticker"]: r["name"] for r in rows(conn, """SELECT t2.ticker, g.name FROM (SELECT ticker, group_id FROM peer_group_overrides UNION ALL
        SELECT DISTINCT ON (ticker) ticker, group_id FROM peer_group_members m WHERE removed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM peer_group_overrides o WHERE o.ticker = m.ticker)) t2 JOIN peer_groups g ON g.id = t2.group_id""")}
    px = {r["ticker"]: r["c"] for r in rows(conn, """SELECT DISTINCT ON (ticker) ticker, close::float8 c FROM prices_historical ORDER BY ticker, date DESC""")}
    return {"snapshot_id": sid, "accounts": accts, "positions": pos, "options": opts, "peer": peer, "px": px}


def open_puts(snap: dict, today: date) -> list[dict]:
    """Open short puts with the collateral they lock and what that collateral is still earning."""
    out = []
    for o in snap["options"]:
        if o["direction"] != "short" or o["option_type"] != "put":
            continue
        days = max((o["expiration"] - today).days, 1)
        mark = o["mark"] or 0.0
        out.append({**o, "collateral": 100 * o["strike"] * o["qty"], "close_cost": 100 * mark * o["qty"],
                    "remaining_weekly_pct": 100 * mark / o["strike"] * 7 / days, "days_left": days})
    return out


def allocate(puts: list[dict], calls: list[dict], snap: dict, P: dict, today: date | None = None) -> tuple[list[dict], list[dict], dict]:
    """puts/calls: ideas with ticker, verdict, contract{strike, type, expiry, account}, live{realistic_weekly_pct}.
    Returns (kept, held, summary); kept ideas carry allocation{account, contracts, collateral, funding[], warnings[]}."""
    today = today or date.today()
    acct = {a["account"]: a for a in snap["accounts"]}
    nick = {a: x["nickname"] for a, x in acct.items()}
    shorts = open_puts(snap, today)
    posted = defaultdict(float)
    for o in shorts:
        posted[o["account"]] += o["collateral"]
    free = {a: (x["bp"] if P["use_margin"] else x["cash_bp"]) for a, x in acct.items()}
    if P.get("no_new_puts_on_margin", True):  # user YES 2026-10-06: an account carrying a margin loan writes no new puts
        free = {a: (0.0 if (acct[a].get("margin_used") or 0) > 0 else v) for a, v in free.items()}
    capacity = {a: free[a] + posted[a] for a in acct}
    committed = dict(posted)  # collateral backing puts after this plan (existing + new − closed)
    new_coll = defaultdict(float)  # collateral of this plan's new ideas only (C1: the budget can ignore closable open puts)
    closable = {a: sorted((o for o in shorts if o["account"] == a), key=lambda o: o["remaining_weekly_pct"]) for a in acct}
    closed: set[int] = set()
    short_names = {o["ticker"] for o in shorts}
    sector_n, sector_coll = defaultdict(int), defaultdict(float)
    for o in shorts:
        s = snap["peer"].get(o["ticker"]) or "unclassified"
        sector_coll[s] += o["collateral"]
    kept, held = [], []
    for it in sorted(puts, key=lambda x: -((x.get("live") or {}).get("realistic_weekly_pct") or 0)):
        t, c = it["ticker"], it["contract"]
        need = 100 * c["strike"]
        y = (it.get("live") or {}).get("realistic_weekly_pct") or 0
        sector = snap["peer"].get(t) or "unclassified"
        best = None
        for a in acct:  # cheapest way to fund one contract in each account
            plan, avail, cost = [], free[a], 0.0
            for o in closable[a]:
                if avail >= need:
                    break
                if id(o) in closed:
                    continue
                if o["remaining_weekly_pct"] > y * (1 - P["min_yield_edge"]) and not P.get("fund_by_closing_any_put"):
                    continue  # only close positions that earn clearly less on their collateral than the new idea
                plan.append(o)
                avail += o["collateral"] - o["close_cost"]
                cost += o["close_cost"]
            if avail >= need:
                # fewest closures, then fewest soft-limit breaches (position size, total budget), then cheapest, then the account where
                # it fits most comfortably (lowest share of capacity used). Breaches were ignored before 2026-10-05, which sent DVN to
                # FILDI at 43% of its capacity (limit 35%) when the IRA only crossed the budget.
                after = committed[a] - sum(o["collateral"] for o in plan) + need
                budget_base = after if P.get("budget_counts_open_puts", True) else new_coll[a] + need
                load = after / max(capacity[a], 1)
                breaches = int(need > P["max_position_pct"] * capacity[a]) + int(budget_base > P["budget_pct"] * capacity[a])
                key = (len(plan), breaches, round(cost), load)
                if best is None or key < best[3]:
                    best = (a, plan, cost, key)
        if best is None:
            top = max(acct, key=lambda a: free[a] + sum(o["collateral"] for o in closable[a] if id(o) not in closed))
            # collateral that comes back on its own when open puts expire before this idea's expiry
            soon = sorted((o for o in closable[top] if id(o) not in closed and o["expiration"] < date.fromisoformat(c["expiry"])),
                          key=lambda o: o["expiration"])
            freed, when = free[top], None
            for o in soon:
                freed += o["collateral"]
                if freed >= need:
                    when = o["expiration"]
                    break
            wait = (f"; ${freed:,.0f} frees up in {nick[top]} when your open puts expire on {when}, so re-check then"
                    if when else "")
            held.append({**it, "why_held": f"can't fund ${need:,.0f} of collateral now: {nick[top]} has ${free[top]:,.0f} free, and closing open "
                                           f"puts early would earn less than holding them{wait}"})
            continue
        a, plan, cost, _ = best
        for o in plan:
            closed.add(id(o))
            free[a] += o["collateral"] - o["close_cost"]
            committed[a] -= o["collateral"]
            sector_coll[snap["peer"].get(o["ticker"]) or "unclassified"] -= o["collateral"]
        free[a] -= need
        committed[a] += need
        new_coll[a] += need
        sector_n[sector] += 1
        sector_coll[sector] += need
        warn = []
        if need > P["max_position_pct"] * capacity[a]:
            warn.append(f"position ${need:,.0f} = {need / capacity[a]:.0%} of {nick[a]}'s ${capacity[a]:,.0f} put capacity (limit {P['max_position_pct']:.0%})")
        if P.get("budget_counts_open_puts", True):
            if committed[a] > P["budget_pct"] * capacity[a]:
                warn.append(f"{nick[a]} puts would total ${committed[a]:,.0f} = {committed[a] / capacity[a]:.0%} of capacity (limit {P['budget_pct']:.0%})")
        elif new_coll[a] > P["budget_pct"] * capacity[a]:   # C1: open puts count as closable, so only new ideas use the budget
            warn.append(f"new {nick[a]} puts would total ${new_coll[a]:,.0f} = {new_coll[a] / capacity[a]:.0%} of capacity (limit {P['budget_pct']:.0%})")
        tot_cap = sum(capacity.values())
        if sector_n[sector] > P["max_per_sector"] or sector_coll[sector] > P["sector_pct"] * tot_cap:
            warn.append(f"{sector}: {sector_n[sector]} new ideas, ${sector_coll[sector]:,.0f} = {sector_coll[sector] / tot_cap:.0%} of capacity "
                        f"(limits {P['max_per_sector']} ideas / {P['sector_pct']:.0%})")
        if t in short_names:
            warn.append(f"adds to an existing short put on {t}")
        def note(o):
            spot = snap["px"].get(o["ticker"])
            bits = []
            if o["remaining_weekly_pct"] > y:
                bits.append(f"gives up a better yield ({o['remaining_weekly_pct']:.2f}%/wk vs {y:.2f}%/wk here)")
            if spot and spot < o["strike"]:
                bits.append(f"in the money (${spot:.2f} < ${o['strike']:g}): closing locks in the loss")
            return f"; ⚠ {'; '.join(bits)}" if bits else ""
        funding = [f"close {o['ticker']} {o['strike']:g}P ×{o['qty']:.0f} ({nick[a]}): frees ${o['collateral']:,.0f}, costs ${o['close_cost']:,.0f} "
                   f"(earning {o['remaining_weekly_pct']:.2f}%/wk on its collateral vs {y:.2f}%/wk here){note(o)}" for o in plan]
        kept.append({**it, "allocation": {"account": nick[a], "contracts": 1, "collateral": need, "free_after": round(free[a]),
                                          "funding": funding, "warnings": warn, "sector": sector}})
        for o in plan:
            o["funds"] = f"{t} {c['strike']:g}P"
    cost_basis = {(p["account"], p["ticker"]): p["avg_cost"] for p in snap["positions"]}
    by_nick = {x["nickname"]: a for a, x in acct.items()}
    for it in calls:
        t, c = it["ticker"], it["contract"]
        a = by_nick.get(c.get("account"), c.get("account"))
        basis = cost_basis.get((a, t))
        if basis and c["strike"] < basis and not (P["allow_below_cost_if_red"] and it.get("verdict") == "red"):
            held.append({**it, "why_held": f"strike ${c['strike']:g} is below your average cost ${basis:.2f}: being called away would lock in a loss"})
        else:
            kept.append({**it, "allocation": {"account": c.get("account"), "contracts": 1, "cost_basis": basis, "funding": [], "warnings": []}})
    summary = {nick[a]: {"free": round(acct[a]["cash_bp"]), "posted": round(posted[a]), "capacity": round(capacity[a]),
                         "committed_after": round(committed[a]), "free_after": round(free[a])} for a in acct}
    summary["closures"] = [{"account": nick[o["account"]], "ticker": o["ticker"], "strike": o["strike"], "qty": o["qty"], "funds": o.get("funds")}
                           for o in shorts if id(o) in closed]
    return kept, held, summary


def manage(snap: dict, P: dict, today: date | None = None, closures: list[dict] | None = None,
           put_actions: dict | None = None) -> list[dict]:
    """put_actions: (account, ticker, strike, expiry iso) → put_manage_daily payload. A372 11-11: short PUTS take their
    take-profit alert from put_manage (S103 rule: weekly, ≥ 25 % captured at ≥ 4× pace; 2+ week puts never — every early
    exit lost on real quotes), not the flat 50 % rule below, which stays for short calls and puts put_manage hasn't scored."""
    today = today or date.today()
    nick = {a["account"]: a["nickname"] for a in snap["accounts"]}
    fund = {(c["account"], c["ticker"], c["strike"]): c["funds"] for c in (closures or [])}
    out = []
    for o in snap["options"]:
        if o["direction"] != "short":
            continue
        t, k, typ = o["ticker"], o["strike"], o["option_type"]
        spot = snap["px"].get(t)
        days = (o["expiration"] - today).days
        prem = o["avg_premium"] / 100 if o["avg_premium"] else None  # snapshot: avg_premium is $ per contract, mark_price is per share
        alerts = []
        f = fund.get((nick.get(o["account"], o["account"]), t, k))
        if f:
            alerts.append(f"close to fund {f}: its collateral earns more there")
        pa = (put_actions or {}).get((o["account"], t, float(k), str(o["expiration"]))) if typ == "put" else None
        if pa is not None:
            if pa.get("action") == "take + re-sell":
                alerts.append(f"take profit + re-sell: {pa.get('why', '')} (put manager, S103)")
        elif prem and o["mark"] is not None and o["mark"] <= P["take_profit"] * prem:
            alerts.append(f"take profit: worth ${o['mark']:.2f} vs ${prem:.2f} collected (kept {1 - o['mark'] / prem:.0%})")
        if spot:
            itm = spot < k if typ == "put" else spot > k
            if itm:
                alerts.append(f"in the money: {t} ${spot:.2f} vs strike ${k:g} (assignment likely)")
            elif abs(spot / k - 1) <= P["at_risk_pct"]:
                alerts.append(f"at risk: {t} ${spot:.2f} within {P['at_risk_pct']:.0%} of strike ${k:g}")
        if 0 <= days <= P["expiry_days"]:
            alerts.append(f"expires in {days}d ({o['expiration']}): let expire, roll, or close")
        if alerts:
            out.append({"ticker": t, "account": nick.get(o["account"], o["account"]), "contract": {"type": typ, "strike": k, "expiry": str(o["expiration"]),
                        "qty": o["qty"], "mark": o["mark"], "premium": prem}, "alerts": alerts})
    rank = lambda m: (0 if any(a.startswith("in the money") for a in m["alerts"]) else 1 if any(a.startswith("at risk") for a in m["alerts"])
                      else 2 if any(a.startswith("close to fund") for a in m["alerts"]) else 3)
    return sorted(out, key=rank)
