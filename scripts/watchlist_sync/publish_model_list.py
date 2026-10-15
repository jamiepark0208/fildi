"""Publish the Fildi Model List: latest plan (L1/L2) + latest fit scores → one append-only run of folders.

Shown in the app under Watchlist → Model List. Writes only watchlist_sync.model_runs / model_items:
never the user's watchlist.color_tag, never Robinhood.

Scores come from the champion parameter version (watchlist_sync.model_params → fit_score_history), falling back to
fit-1.3's fit_scores if the champion hasn't been scored yet.

Verdict cross-check (gap #1: lists and tags must not contradict each other):
  sell_puts   needs an ownable name: verdict not red, severity-weighted risk < thresholds.put_block_risk, effective OWN
              (after the STREET reward/penalty) ≥ thresholds.yellow_own, and no regime pause. Otherwise → Needs Review.
  sell_calls  any verdict (writing calls on a flagged holding reduces risk); unscored → Needs Review.
  L2 'pass_after_hours' → status provisional (re-verify on live quotes in session before acting).

Usage: .venv/bin/python publish_model_list.py [--dry-run]
"""
from __future__ import annotations

import argparse
import json
from datetime import date, datetime
from collections import defaultdict

from build_plan import connect, rows
import fit_model as F13
import fit_model_v14 as FV
import params as PM
import portfolio as PF
import rebalance as RB
import rules as R
import setup as SU
import wheel as WH
import winrates as W

VERIFIED = {"pass", "pass_after_hours"}


def pillars(f: dict) -> dict:
    return {k: f[k] for k in ("own", "street", "premium", "fit", "edge")}


def item(folder, f, *, score=None, status="ok", why=None, contract=None, ticker=None):
    return {"folder_key": folder, "ticker": ticker or f["ticker"], "verdict": (f or {}).get("verdict") or "",
            "role": (f or {}).get("role"), "status": status, "score": score, "pillars": pillars(f) if f else None,
            "flags": (f or {}).get("flags") or [], "why": why if why is not None else (f or {}).get("why") or [], "contract": contract,
            "_f": f}


def champion_scores(conn) -> tuple[dict, str, dict]:
    """{ticker: score row} for the champion version's latest scoring run, in fit_scores' shape (own = effective OWN)."""
    version, P = PM.champion(conn)
    S = rows(conn, """SELECT * FROM watchlist_sync.fit_score_history WHERE model_version = %s
                      AND computed_at = (SELECT MAX(computed_at) FROM watchlist_sync.fit_score_history WHERE model_version = %s)""", (version, version))
    if not S:  # champion never scored: fall back to fit-1.3 so the Model List still publishes
        return {r["ticker"]: {**r, "risk": len(r["flags"] or []) * 0.5} for r in rows(conn, "SELECT * FROM watchlist_sync.fit_scores")}, F13.MODEL_VERSION, P
    out = {}
    for r in S:
        v = (r["inputs"] or {}).get("_v14", {})
        prov = r["verdict"] == "yellow" and not R.market_open(datetime.fromisoformat(r["inputs"]["iv_fetched_at"])) if (r["inputs"] or {}).get("iv_fetched_at") else False
        why = (["PROVISIONAL: IV captured outside market hours; re-check in session"] if prov else []) + list(r["why"] or [])
        out[r["ticker"]] = {**r, "own": v.get("eff", r["own"]), "own_raw": r["own"], "risk": v.get("risk", 0), "why": why}
    return out, version, P


def spy_20d(conn, live: float | None = None) -> float | None:
    """SPY 20-session return. With a live intraday price (intraday.py), today counts as session 0 vs the close 20 sessions back."""
    if live:
        prev = [r["c"] for r in rows(conn, """SELECT close::float8 c FROM prices_historical
                                              WHERE ticker = 'SPY' AND date < CURRENT_DATE ORDER BY date DESC LIMIT 20""")]
        return live / prev[-1] - 1 if len(prev) == 20 else None
    spy = [r["c"] for r in rows(conn, "SELECT close::float8 c FROM prices_historical WHERE ticker = 'SPY' ORDER BY date DESC LIMIT 21")]
    return spy[0] / spy[-1] - 1 if len(spy) == 21 else None


def held_back_reason(list_key: str, f: dict | None, P: dict, spy20: float | None) -> str | None:
    """The verdict cross-check, shared by publish and by verify_plan's pre-check (so quotes are only fetched for survivors)."""
    if f is None:
        return "not scored by the fit model"
    if list_key != "sell_puts":
        return None
    pause_at = P["regime"]["pause_puts_spy20"]  # Step 4 #8: no dip-buying puts while the whole market sells off
    if spy20 is not None and spy20 < pause_at:
        return f"regime pause: SPY {100 * spy20:+.1f}% over 20 days (pause below {100 * pause_at:.0f}%)"
    if f["verdict"] == "red":
        return "verdict is red (avoid)"
    if (f["risk"] or 0) >= P["thresholds"]["put_block_risk"]:
        return f"risk {f['risk']:.1f} ≥ {P['thresholds']['put_block_risk']}: " + "; ".join(f["flags"])
    if f["own"] is None or f["own"] < P["thresholds"]["yellow_own"]:
        return f"not ownable enough to risk assignment (OWN {f['own'] or 0:.1f} < {P['thresholds']['yellow_own']})"
    return None


def fair_values(conn) -> dict[str, dict]:
    """Latest blended fair value per ticker (display only — never scores or sizes)."""
    try:
        return {r["ticker"]: r for r in rows(conn, """
            SELECT DISTINCT ON (ticker) ticker, fair_value::float8 AS fair_value, price::float8 AS fv_price,
                   confidence, value_trap, cyclical
            FROM fair_value_snapshots
            WHERE fair_value IS NOT NULL
            ORDER BY ticker, as_of DESC""")}
    except Exception:
        return {}


def ma200_gap(conn) -> dict[str, float]:
    """Close vs its 200-day average (the trend part of the stock score that passed gate 1); needs 200 stored closes."""
    return {r["ticker"]: r["gap"] for r in rows(conn, """
        SELECT ticker, (array_agg(close ORDER BY date DESC))[1] / avg(close) - 1 AS gap FROM (
          SELECT ticker, date, close::float8 close, row_number() OVER (PARTITION BY ticker ORDER BY date DESC) n
          FROM prices_historical WHERE date > now() - interval '400 days') x
        WHERE n <= 200 GROUP BY ticker HAVING count(*) = 200""")}


def contract_context(conn) -> tuple[dict, dict, dict]:
    """Per-ticker context for option ideas: 20-day realized vol (prices_historical), next earnings date (LSEG), and the user's own
    Robinhood realized closes by (ticker, side) since 2025 (portfolio_transactions; small n, descriptive only)."""
    rv = {r["ticker"]: r["rv"] for r in rows(conn, """
        SELECT ticker, stddev_samp(lr) * sqrt(252) rv FROM (
          SELECT ticker, ln(close / lag(close) OVER (PARTITION BY ticker ORDER BY date)) lr,
                 row_number() OVER (PARTITION BY ticker ORDER BY date DESC) n
          FROM prices_historical WHERE date > now() - interval '60 days') x
        WHERE n <= 20 GROUP BY ticker HAVING count(lr) >= 15""")}
    er = {r["ticker"]: r["d"] for r in rows(conn, """
        SELECT ticker, min(d) d FROM (SELECT ticker, event_date d FROM lseg_research.events WHERE event_type = 'EarningsReleases'
          UNION ALL SELECT ticker, report_date FROM lseg_research.earnings_moves) x WHERE d >= current_date GROUP BY ticker""")}
    rec = {(r["t"], r["side"]): {"n": r["n"], "wins": r["wins"], "pnl": round(float(r["pnl"]), 2), "since": "2025-01-01"} for r in rows(conn, """
        SELECT upper(symbol) t, CASE category WHEN 'Sell Puts' THEN 'put' ELSE 'call' END side, count(*) n,
               count(*) FILTER (WHERE amount > 0) wins, sum(amount) pnl
        FROM portfolio_transactions WHERE txn_type = 'realized_close' AND category IN ('Sell Puts', 'Sell Calls')
          AND amount IS NOT NULL AND txn_date::date >= '2025-01-01' GROUP BY 1, 2""")}
    return rv, er, rec


def portfolio_context(puts: list[dict], snap: dict, fit: dict, P: dict) -> None:
    """Display only (doesn't change which ideas are kept): for a put idea over the soft budget, show (a) the account's put share after
    open puts that expire first and are out of the money now, and (b) red / risk-flagged holdings in that account that could fund it."""
    PP, today = P["portfolio"], datetime.now().date()
    shorts = PF.open_puts(snap, today)
    acct = {a["account"]: a for a in snap["accounts"]}
    by_nick = {x["nickname"]: a for a, x in acct.items()}   # ideas carry the account nickname
    posted = defaultdict(float)
    for o in shorts:
        posted[o["account"]] += o["collateral"]
    cap = {a: x["cash_bp"] + posted[a] for a, x in acct.items()}
    committed = dict(posted)
    for o in puts:
        c = o["contract"] or {}
        a = by_nick.get(c.get("account"), c.get("account"))
        if a in cap and c.get("collateral"):
            committed[a] = committed.get(a, 0) + c["collateral"]
    for o in puts:
        c = o["contract"] or {}
        a = by_nick.get(c.get("account"), c.get("account"))
        if a not in cap or not any("puts would total" in str(w) for w in o["why"]):
            continue
        exp = date.fromisoformat(c["expiry"])
        early = [s for s in shorts if s["account"] == a and s["expiration"] < exp
                 and (snap["px"].get(s["ticker"]) or 0) > s["strike"] * (1 + PP["at_risk_pct"])]
        lines = []
        if early:
            after = committed[a] - sum(s["collateral"] for s in early)
            days = sorted({s["expiration"] for s in early})
            lines.append(f"ℹ {len(early)} open put(s) expire {', '.join(f'{d:%m/%d}' for d in days)} and are out of the money now: if they expire, "
                         f"{acct[a]['nickname']} puts drop to {after / cap[a]:.0%} of capacity (limit {PP['budget_pct']:.0%}) before this idea expires")
        hold = []
        for h in snap["positions"]:
            f = fit.get(h["ticker"]) or {}
            if h["account"] != a or not h["qty"] or h["qty"] <= 0 or not h["last"]:
                continue
            if f.get("verdict") == "red" or (f.get("risk") or 0) >= P["thresholds"]["put_block_risk"]:
                hold.append((f.get("risk") or 0, h, f))
        hold.sort(key=lambda x: (-x[0], -x[1]["qty"] * x[1]["last"]))
        if hold:
            taxable = "ira" not in (acct[a].get("type") or "").lower()
            parts = []
            for _, h, f in hold[:3]:
                val, pnl = h["qty"] * h["last"], h["qty"] * (h["last"] - (h["avg_cost"] or h["last"]))
                tag = "red" if f.get("verdict") == "red" else "risk-flagged"
                parts.append(f"{h['ticker']} ${val:,.0f} ({tag}" + (f", {'loss' if pnl < 0 else 'gain'} ${abs(pnl):,.0f}" if taxable else "") + ")")
            lines.append("ℹ could fund instead by selling flagged holdings in this account: " + ", ".join(parts)
                         + (" (taxable: losses can offset gains)" if taxable else " (IRA: no tax on the sale)") + ". Your call; not automatic")
        o["why"] = [o["why"][0]] + lines + o["why"][1:] if o["why"] else lines


def adjustments(o: dict) -> list[dict]:
    """Every adjustment applied to an item, for the UI: what, from → to, and why."""
    adj, p, c = [], o.get("pillars") or {}, o.get("contract") or {}
    f = o.get("_f") or {}
    if f.get("own_raw") is not None and p.get("own") is not None and abs(f["own_raw"] - p["own"]) >= 0.5:
        line = next((str(w) for w in o["why"] if str(w).startswith("STREET")), "analyst view (STREET reward / penalty)")
        adj.append({"what": "OWN", "from": round(f["own_raw"], 1), "to": round(p["own"], 1), "why": line})
    if p.get("premium_30d") is not None:
        adj.append({"what": "Prem", "from": round(p["premium_30d"], 1), "to": round(p["premium"], 1),
                    "why": (c.get("premium_score") or {}).get("basis", "contract IV") + " (P2)"})
    w = c.get("win") or {}
    if w.get("extrapolated"):
        adj.append({"what": "Wins", "from": "Δ 0.15–0.30 table", "to": f"{100 * w['rate']:.0f}% at Δ{w['delta']:.2f}",
                    "why": "delta outside the tested range: extrapolated on the end segment (≈)"})
    held = next((str(x) for x in o["why"] if "idea held back" in str(x)), None)
    if held:
        adj.append({"what": "List", "from": held.split(" idea held back")[0], "to": "Needs Review", "why": held.split(": ", 1)[-1]})
    if c.get("within_limits") is False:
        adj.append({"what": "Limits", "from": "fits", "to": "over limit", "why": "taking it after the ideas above exceeds your soft portfolio limits (P3)"})
    return adj


def precheck(conn, plan_id: int) -> tuple[set[int], list[str]]:
    """Plan items worth a live Robinhood quote: pass the verdict cross-check, (calls) strike ≥ cost basis, (puts) fundable at all."""
    fit, _, P = champion_scores(conn)
    spy20 = spy_20d(conn)
    snap = PF.snapshot(conn)
    shorts = PF.open_puts(snap, __import__("datetime").date.today())
    capacity = max((a["cash_bp"] + sum(o["collateral"] for o in shorts if o["account"] == a["account"]) for a in snap["accounts"]
                    if not (a.get("margin_used") or 0) > 0), default=0)   # margin accounts write no new puts (portfolio.allocate)
    basis = {(p["account"], p["ticker"]): p["avg_cost"] for p in snap["positions"]}
    by_nick = {a["nickname"]: a["account"] for a in snap["accounts"]}
    keep, skipped = set(), []
    for p in rows(conn, "SELECT * FROM watchlist_sync.plan_items WHERE plan_id = %s AND l1_pass AND kind = 'option'", (plan_id,)):
        why = held_back_reason(p["list_key"], fit.get(p["ticker"]), P, spy20)
        if not why and p["list_key"] == "sell_calls":
            b = basis.get((by_nick.get(p["account"], p["account"]), p["ticker"]))
            if b and float(p["strike"]) < b and (fit.get(p["ticker"]) or {}).get("verdict") != "red":
                why = f"strike below cost basis ${b:.2f}"
        if not why and p["list_key"] == "sell_puts" and 100 * float(p["strike"]) > capacity:
            why = f"collateral ${100 * float(p['strike']):,.0f} exceeds any account's put capacity"
        if why:
            skipped.append(f"{p['ticker']} {float(p['strike']):g}{p['option_type'][0].upper()}: {why}")
        else:
            keep.add(p["id"])
    return keep, skipped


def build(conn, live_spy: float | None = None) -> tuple[dict, list[dict]]:
    # newest plan whose trade ideas were verified on live Robinhood quotes (a fresher unverified draft has no ideas to show)
    plan = (rows(conn, "SELECT id, created_at, status FROM watchlist_sync.plans WHERE status = 'verified' ORDER BY id DESC LIMIT 1")
            or rows(conn, "SELECT id, created_at, status FROM watchlist_sync.plans ORDER BY id DESC LIMIT 1"))[0]
    fit, version, P = champion_scores(conn)
    fit_run_at = max((r["computed_at"] for r in fit.values()), default=None)
    out: list[dict] = []
    candidates: list[dict] = []
    spy20 = spy_20d(conn, live_spy)
    wr = W.latest(conn)
    atm = W.atm_iv(conn)
    rv20, next_er, record = contract_context(conn)
    today = datetime.now().date()

    for p in rows(conn, """SELECT * FROM watchlist_sync.plan_items WHERE plan_id = %s AND l1_pass
                           ORDER BY list_key, rank NULLS LAST""", (plan["id"],)):
        f = fit.get(p["ticker"])
        reasons = list(p["reasons"] or [])
        if p["list_key"] == "trim_risk":
            out.append(item("trim_risk", f, ticker=p["ticker"], score=p["score"], why=reasons + ((f or {}).get("why") or [])))
            continue
        if p["verify_status"] not in VERIFIED:
            continue  # failed or not yet verified on live quotes: never shown as an idea
        contract = {"type": p["option_type"], "strike": float(p["strike"]), "expiry": str(p["expiry"]),
                    "premium": float(p["model_premium"]) if p["model_premium"] is not None else None,
                    "account": p["account"], "verify_status": p["verify_status"]}
        live_delta = (p["live"] or {}).get("delta") if isinstance(p["live"], dict) else None
        win = W.lookup(wr, p["option_type"], live_delta if live_delta is not None else p["model_delta"], (p["expiry"] - today).days)
        if win:
            lv = p["live"] if isinstance(p["live"], dict) else {}
            fill = lv.get("realistic_fill") if lv.get("realistic_fill") is not None else p["model_premium"]
            iv = lv.get("iv") if lv.get("iv") is not None else p["model_iv"]
            spot = lv.get("spot") if lv.get("spot") is not None else p["model_spot"]
            m = W.money(win, p["option_type"], float(fill) if fill is not None else None, float(iv) if iv is not None else None,
                        float(spot) if spot is not None else None, float(p["strike"]), (p["expiry"] - today).days, wr,
                        atm.get(p["ticker"]))
            contract["win"] = {**win, **(m or {})}
        lv = p["live"] if isinstance(p["live"], dict) else {}
        if lv.get("realistic_fill") is not None:   # show what Robinhood would actually pay, not Fildi's modelled mid
            contract["model_premium"], contract["premium"] = contract["premium"], round(float(lv["realistic_fill"]), 3)
        civ, r20, a30 = lv.get("iv") or (float(p["model_iv"]) if p["model_iv"] is not None else None), rv20.get(p["ticker"]), atm.get(p["ticker"])
        if civ and r20:
            contract["vol"] = {"contract_iv": round(float(civ), 3), "atm30_iv": round(a30, 3) if a30 else None, "rv20": round(r20, 3),
                               "contract_iv_rv": round(float(civ) / r20, 2), "atm30_iv_rv": round(a30 / r20, 2) if a30 else None}
        if next_er.get(p["ticker"]):
            ed = next_er[p["ticker"]]
            contract["earnings"] = {"date": str(ed), "inside": ed <= p["expiry"], "days_after_expiry": (ed - p["expiry"]).days}
        if record.get((p["ticker"], p["option_type"])):
            contract["record"] = record[(p["ticker"], p["option_type"])]
        status = "provisional" if p["verify_status"] == "pass_after_hours" else "ok"
        held_back = held_back_reason(p["list_key"], f, P, spy20)
        v = contract.get("vol")
        if P["premium"]["contract_iv_pre_earnings"] and v and f and contract.get("earnings"):
            e = contract["earnings"]
            # P2: the 30-day ATM IV prices an earnings date this contract expires before, so it reads as richer than what is sold
            if not e["inside"] and (date.fromisoformat(e["date"]) - today).days <= 30:
                Pw = P["premium"]
                ivr = ((f.get("inputs") or {}).get("_v14") or {}).get("iv_rank")
                contract["premium_score"] = {
                    "value": round(FV.wavg0([(Pw["w_iv_rv"], F13.lin(v["contract_iv_rv"], 0.8, 1.5)),
                                             (Pw["w_iv_rank"], 100 * ivr if ivr is not None else None)]), 1),
                    "pillar_30d": f.get("premium"),
                    "basis": f"scored on this contract's own IV instead of the 30-day IV, which includes earnings on {e['date']} that this contract expires before"}
        floor = P["thresholds"]["min_contract_iv_rv"]
        if not held_back and floor and p["option_type"] == "put" and v and v["contract_iv_rv"] < floor:
            held_back = (f"this contract's IV is {v['contract_iv_rv']:.2f}× the stock's 20-day realized vol (floor {floor:.2f}): "
                         "the option is priced below recent moves, the edge the lab validated runs the other way")
        if held_back:
            out.append(item("review", f, ticker=p["ticker"], score=p["score"], status="review", contract=contract,
                            why=[f"{p['list_key'].replace('_', ' ')} idea held back: {held_back}"] + reasons))
        else:
            if status == "provisional":
                reasons.append("PROVISIONAL: verified on after-hours quotes; re-verify on live quotes before trading")
            candidates.append({"list_key": p["list_key"], "ticker": p["ticker"], "verdict": (f or {}).get("verdict") or "", "f": f,
                               "score": p["score"], "status": status, "contract": contract, "live": p["live"],
                               "why": reasons + ((f or {}).get("why") or [])})

    # Step 7: the ideas that passed every per-idea check now compete for one collateral budget (portfolio.py)
    PP = P["portfolio"]
    snap = PF.snapshot(conn)
    kept, held, budget = PF.allocate([c for c in candidates if c["list_key"] == "sell_puts"],
                                     [c for c in candidates if c["list_key"] == "sell_calls"], snap, PP)
    for c in kept:
        al = c["allocation"]
        line = (f"size: {al['contracts']} contract(s) in {al['account']} · ${al['collateral']:,.0f} collateral · ${al['free_after']:,.0f} free after"
                if "collateral" in al else f"covers shares in {al['account']}" + (f" (avg cost ${al['cost_basis']:.2f})" if al.get("cost_basis") else ""))
        notes = [f"funding: {x}" for x in al["funding"]] + [f"⚠ limit: {w}" for w in al["warnings"]]
        out.append(item(c["list_key"], c["f"], ticker=c["ticker"], score=c["score"], status="warn" if al["warnings"] and c["status"] == "ok" else c["status"],
                        contract={**c["contract"], **{k: v for k, v in al.items() if k in ("contracts", "collateral")}, "account": al["account"]},
                        why=[line] + notes + c["why"]))
    portfolio_context([o for o in out if o["folder_key"] == "sell_puts"], snap, fit, P)
    if PP["cumulative_limits"]:
        puts = [o for o in out if o["folder_key"] == "sell_puts"]
        k = next((n for n, o in enumerate(puts) if any(str(w).startswith("⚠ limit") for w in o["why"])), len(puts))
        for n, o in enumerate(puts, 1):
            o["contract"]["within_limits"] = n <= k
            first = "#1" if k == 1 else f"#1–#{k}"
            o["why"] = ([f"✓ all {len(puts)} put ideas fit inside your limits together"] if k == len(puts) else
                        [f"⚠ none fit inside your limits as they stand (existing positions): size down or skip"] if k == 0 else
                        [f"✓ within your limits: take {first} in this order"] if n <= k else
                        [f"⚠ over your limits if taken after {first}: optional, size down or skip"]) + o["why"]
    for c in held:
        out.append(item("review", c["f"], ticker=c["ticker"], score=c["score"], status="review", contract=c["contract"],
                        why=[f"{c['list_key'].replace('_', ' ')} idea held back by the portfolio: {c['why_held']}"] + c["why"]))
    for i, m in enumerate(PF.manage(snap, PP, closures=budget["closures"]), 1):
        f = fit.get(m["ticker"])
        out.append(item("manage", f, ticker=m["ticker"], score=None, status="review" if any(a.startswith(("in the money", "at risk")) for a in m["alerts"]) else "ok",
                        contract={"type": m["contract"]["type"], "strike": m["contract"]["strike"], "expiry": m["contract"]["expiry"],
                                  "premium": m["contract"]["premium"], "account": m["account"], "verify_status": "open position"},
                        why=m["alerts"] + [f"open: short {m['contract']['qty']:.0f} × {m['account']}"]))

    for r in RB.items(snap, fit, P):  # FILDI concentration + margin (display only; account line first)
        out.append(item("rebalance", r.get("f") or None, ticker=r["ticker"], score=r["score"], status=r["status"], why=r["why"]))

    for f in fit.values():
        prov = any(str(w).startswith("PROVISIONAL") for w in f["why"] or [])
        if f["role"] == "held":
            out.append(item("holdings", f, score=len(f["flags"] or [])))
        folder = {"green": "own", "yellow": "income", "red": "avoid", "purple": "context"}.get(f["verdict"] or "")
        if folder is None and f["role"] is None:
            folder = "watch"
        if folder:
            score = {"own": f["own"], "income": f["premium"], "avoid": len(f["flags"] or [])}.get(folder, f["own"])
            out.append(item(folder, f, score=score, status="provisional" if folder == "income" and prov else "ok"))

    # Rank within folder: action folders keep plan order (option score); verdict folders by score desc, then ticker.
    caps = {r["folder_key"]: r["max_items"] for r in rows(conn, "SELECT folder_key, max_items FROM watchlist_sync.model_folders")}
    by = defaultdict(list)
    for o in out:
        by[o["folder_key"]].append(o)
    final = []
    for k, items in by.items():
        if k not in ("sell_puts", "sell_calls", "trim_risk", "review", "manage", "rebalance"):
            items.sort(key=lambda o: (-(o["score"] if o["score"] is not None else -1), o["ticker"]))
        for i, o in enumerate(items[: caps.get(k) or None], 1):
            final.append({**o, "rank": i})
    gaps = ma200_gap(conn)
    fvs = fair_values(conn)
    wheel = WH.wheel_pnl(conn)
    setups = SU.context(conn, sorted({o["ticker"] for o in final if (o["contract"] or {}).get("type") in ("put", "call")}))
    for o in final:
        # New option ideas: is this the entry setup the trader's own record favours? (display only, S011)
        ctype = (o["contract"] or {}).get("type")
        if o["folder_key"] in ("sell_puts", "sell_calls", "review") and ctype in ("put", "call"):
            line = SU.why_line(ctype, setups.get(o["ticker"]))
            if line:
                o["why"] = list(o["why"]) + [line]
        # Held names: show the whole wheel (options + assigned stock), not just premium kept.
        if o["folder_key"] in ("holdings", "trim_risk", "manage", "rebalance"):
            line = WH.why_line(wheel.get(o["ticker"]))
            if line and line not in o["why"]:
                o["why"] = [line] + list(o["why"])
        ps = (o["contract"] or {}).get("premium_score")
        if ps and o["pillars"] is not None:
            o["pillars"] = {**o["pillars"], "premium": ps["value"], "premium_30d": ps["pillar_30d"]}
        if o["pillars"] is not None and o["ticker"] in gaps:
            o["pillars"] = {**o["pillars"], "ma200": round(gaps[o["ticker"]], 4)}
        # Display only: strike vs blended fair value (never gates / sizes).
        c, fv = o.get("contract"), fvs.get(o["ticker"])
        if c and fv and fv.get("fair_value"):
            strike = float(c["strike"])
            fair = float(fv["fair_value"])
            c["fair_value"] = {
                "value": round(fair, 2),
                "strike_vs_fair": round(strike / fair - 1, 4),
                "confidence": fv.get("confidence"),
                "value_trap": bool(fv.get("value_trap")),
                "cyclical": bool(fv.get("cyclical")),
            }
    for o in final:
        o["adjustments"] = adjustments(o)
        o.pop("_f", None)
    meta = {"plan_id": plan["id"], "plan_status": plan["status"], "fit_run_at": fit_run_at, "version": version}
    return meta, final


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--live-spy", type=float, help="intraday.py: live SPY price for the regime pause (else last close)")
    a = ap.parse_args()
    with connect() as conn:
        meta, items = build(conn, a.live_spy)
        summary = defaultdict(int)
        for o in items:
            summary[o["folder_key"]] += 1
        print(f"plan #{meta['plan_id']} ({meta['plan_status']}) · scores {meta['version']} @ {meta['fit_run_at']:%Y-%m-%d %H:%M}")
        for k, n in sorted(summary.items()):
            print(f"  {k:<11} {n}")
        for o in items:
            if o["folder_key"] in ("sell_puts", "sell_calls", "review"):
                c = o["contract"]
                print(f"  [{o['folder_key']}] {o['ticker']} {c['strike']:g}{c['type'][0].upper()} {c['expiry']} · {o['status']} · {o['why'][0]}")
        if a.dry_run:
            return
        conn.execute("ALTER TABLE watchlist_sync.model_items ADD COLUMN IF NOT EXISTS adjustments jsonb")   # model_list.sql, 2026-10-05
        # Unique index keys (run_id, folder_key, ticker, contract.type, contract.account).
        # PF.manage can emit the same open short twice (multi-account / duplicate rows) — keep first.
        seen: set[tuple] = set()
        deduped = []
        for o in items:
            c = o.get("contract") or {}
            uk = (o["folder_key"], o["ticker"], str(c.get("type") or ""), str(c.get("account") or ""))
            if uk in seen:
                continue
            seen.add(uk)
            deduped.append(o)
        if len(deduped) < len(items):
            print(f"  (deduped {len(items) - len(deduped)} duplicate folder/ticker/contract rows before insert)")
        items = deduped
        summary = defaultdict(int)
        for o in items:
            summary[o["folder_key"]] += 1
        run_id = rows(conn, """INSERT INTO watchlist_sync.model_runs (model_version, plan_id, fit_run_at, summary)
                               VALUES (%s, %s, %s, %s) RETURNING id""",
                      (meta["version"], meta["plan_id"], meta["fit_run_at"], json.dumps(summary)))[0]["id"]
        with conn.cursor() as cur:
            cur.executemany("""INSERT INTO watchlist_sync.model_items
                (run_id, folder_key, ticker, rank, verdict, role, status, score, pillars, flags, why, contract, adjustments)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                [(run_id, o["folder_key"], o["ticker"], o["rank"], o["verdict"], o["role"], o["status"], o["score"],
                  json.dumps(o["pillars"]), json.dumps(o["flags"]), json.dumps(o["why"], default=str),
                  json.dumps(o["contract"]) if o["contract"] else None, json.dumps(o.get("adjustments") or [], default=str)) for o in items])
        conn.commit()
        print(f"published model run #{run_id} ({len(items)} items)")


if __name__ == "__main__":
    main()
