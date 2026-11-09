#!/usr/bin/env python3
"""One sold-put recommendation per name per day — the table every surface reads (A277 §1, Jamie 10-26: "consistency").

Before: four engines picked four NVDA puts (Model List 0.09Δ, Rankings/Live TS option score, Structures on the skew survey).
Now this writer is the only picker; Model List (build_plan.restrike_puts), Structures (CSP), Rankings › Sell Puts and Live ›
Best strikes read `watchlist_sync.put_recs_daily` and only re-price the chosen contract.

Per name, on the latest saved chain (option_chain_history, ~445 names):
  expiry  listed expiry nearest 7 calendar days out, rules.DTE[0]–14 days (S088/S101: 1-week puts earn the most per week);
          one ending before the next earnings wins over a nearer-to-7 one that crosses it
  band    strategy_engine.engine_put_band (band_engine table: market state × stock state; panic → none;
          market state is per name: SPY's, or sector_drop when the name's sector ETF is ≥ 15 % off its high)
          + build_plan.put_far_reason (earnings before expiry · credit < 20 · put-risk / low-OWN) → never closer than 0.06–0.08Δ
  strike  listed put nearest the band middle, bid ≥ rules.PUT_MIN_RESTRIKE_BID, OI/volume as verify_plan's liquidity; empty band → one band farther, then one closer
  gates   strategy_rules.json sell_put gates (verdict not red · put-edge Q ≥ 4, unknown = blocked · IV/RV ≥ 1.15) via
          strategy_engine.fit, plus the Model List's market-wide floors (10-26, one gate set for every surface):
          name pays ≥ rules.MIN_WEEKLY_INCOME_PCT at rules.PUT_NAME_INCOME_ABS_DELTA · chain spot within rules.MAX_SPOT_DRIFT_PCT of
          the latest close (else stale chain). Account checks (collateral, trim list, open positions) stay in build_plan.
  rank    strategy_rules.json sell_put rank (put-edge Q · ev_rv_cap = bid − realized-vol value, % of strike per week)
  rich    second lane (rules lanes.rich_put, S109 real quotes, Jamie 10-27): every name's best put paying ≥ 0.9 %/wk at ≥ 10 % OTM,
          ranked by confidence (income + OTM percentiles) → payload.rich; Model List folder rich_puts (shadow, graded per name/sector)

    .venv/bin/python put_recs.py            # writes today's rows (idempotent per as_of)
    .venv/bin/python put_recs.py --print    # no write
"""
from __future__ import annotations

import json
import math
import os
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

import build_plan as BP
import rules as R
import strategy_engine as SE
from build_plan import connect, rows

FAR_BAND = "0.06-0.08"   # far rule (rules.PUT_EARNINGS_ABS_DELTA 0.10 cap / 0.07 target) as a band


def _ncdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def bs_put(S, K, v, t):
    if v <= 0 or t <= 0:
        return max(K - S, 0.0)
    sd = v * math.sqrt(t)
    d1 = (math.log(S / K) + 0.5 * sd * sd) / sd
    return K * _ncdf(-(d1 - sd)) - S * _ncdf(-d1)


def pick_expiry(exps: list[date], as_of: date, earnings: date | None = None):
    """Nearest 7 days out; one that ends before the next earnings wins (10-27: on a Tuesday 11-06 crossed earnings for most
    names → far band → untraded strikes, while 10-30 was clean)."""
    ok = sorted((e for e in exps if R.DTE[0] <= (e - as_of).days <= 14), key=lambda e: abs((e - as_of).days - 7))
    clean = [e for e in ok if not (earnings and earnings <= e)]   # the band history is 1-week puts; monthlies only → none
    return (clean or ok or [None])[0]


def liquid(p: dict) -> bool:
    """verify_plan's liquidity check on the saved chain (10-27: 19 of 23 picks failed it live — far strikes nobody trades)."""
    return (p.get("open_interest") or 0) >= R.MIN_OPEN_INTEREST or (p.get("volume") or 0) >= R.MIN_VOLUME_IF_LOW_OI


def pick_strike(puts: list[dict], band: str):
    """Listed put nearest the band middle; empty band → one band farther (never below the 0.05Δ floor band), then one closer
    (≤ 0.20Δ). (row, band used)."""
    order = SE.ENGINE["strategies"]["sell_put"]["strike"]["bands"]
    i, lo = order.index(band), SE.put_band_floor(order)
    for j in [i] + [k for k in (i - 1, i + 1) if lo <= k < len(order) and SE.band_bounds(order[k])[1] <= 0.20 + 1e-9]:
        lo, hi = SE.band_bounds(order[j])
        inb = [p for p in puts if max(lo, -R.PUT_DELTA[1]) <= -p["delta"] < hi and p["bid"] >= R.PUT_MIN_RESTRIKE_BID and liquid(p)]
        if inb:
            return min(inb, key=lambda p: abs(-p["delta"] - (lo + hi) / 2)), order[j]
    return None, None


WIDEN_MAX_DELTA = 0.15   # Jamie 10-28: "~0.05–0.15Δ for 1–2 wks" — the farthest-in a put may move to reach the income floor


def widen_for_income(puts: list[dict], used: str, ms: str, ns: str, days: float):
    """Below the income floor at the band's strike → the nearest closer band (≤ WIDEN_MAX_DELTA) whose strike pays the floor,
    while that band's 5-year worst-5 % week in this market × stock state stays ≥ the risk floor (S101 table; −200 standard).
    Jamie 10-28: widen rather than drop the name. (row, band) or (None, reason it stopped)."""
    import band_engine as BE
    order = SE.ENGINE["strategies"]["sell_put"]["strike"]["bands"]
    floor = BE.FLOORS[SE.ENGINE["strategies"]["sell_put"]["strike"].get("risk", "standard")]
    for b in order[order.index(used) + 1:]:
        lo, hi = SE.band_bounds(b)
        if hi > WIDEN_MAX_DELTA + 1e-9:
            return None, f"no strike ≤ {WIDEN_MAX_DELTA}Δ pays it"
        h = SE.band_table().get(f"{ms}|{ns}|{b}")
        if h and h["w5"] < floor:
            return None, f"next band {b}Δ: worst 5 % week {h['w5']:+.0f} bp in this market × stock state (floor {floor:+.0f})"
        inb = [p for p in puts if lo <= -p["delta"] < hi and p["bid"] >= R.PUT_MIN_RESTRIKE_BID and liquid(p)]
        ok = [p for p in inb if 100 * p["bid"] / p["strike"] * 7 / days >= R.MIN_WEEKLY_INCOME_PCT]
        if ok:
            return min(ok, key=lambda p: -p["delta"]), b   # the farthest strike in that band that pays the floor
    return None, f"no strike ≤ {WIDEN_MAX_DELTA}Δ pays it"


LANE = SE.ENGINE["lanes"]["rich_put"]


def rich_pick(puts: list[dict], as_of: date, hi52: float | None, earnings: date | None, low63: float | None = None
) -> dict | None:
    """Rich-crash lane (rules lanes.rich_put, S107/S109): the name's best put by confidence among income ≥ 0.9 %/wk, ≥ 10 % OTM,
    2–14 days, liquid, bid ≥ $0.05. Confidence = mean of income and OTM percentiles vs S109's real rule puts → tier + its record.
    Earnings inside the expiry are allowed (S109: +110 vs +96 bp/wk without, both halves) — when the pick crosses them, the best
    pre-earnings contract rides along as `pre_earnings` (Jamie avoids them by choice).
    No rule put → a 5–10 % OTM put at ≥ 0.9 %/wk (S110): tier "near-low" when the stock is within 5 % of its 63-day low, else
    "closer" (weakest record; support zones don't separate these, so they're shown, not required)."""
    if earnings:
        pre = rich_pick([p for p in puts if p["expiry"] < earnings], as_of, hi52, None, low63)
    NL = LANE["near_low"]
    C = LANE["confidence"]
    qs = np.linspace(0, 1, len(C["income_q"]))
    best, near = None, None
    for p in puts:
        days = (p["expiry"] - as_of).days
        if not LANE["dte"][0] <= days <= LANE["dte"][1] or p["bid"] < LANE["min_bid"] or not liquid(p) or not p["spot"]:
            continue
        otm = 100 * (p["spot"] - p["strike"]) / p["spot"]
        inc = 100 * p["bid"] / p["strike"] * 7 / (days + BP._settle_offset(p["expiry"]))
        at_low = bool(low63 and p["spot"] <= low63 * (1 + NL["within_low_pct"] / 100))
        if inc < LANE["min_income_wk_pct"] or otm < NL["min_otm_pct"]:
            continue
        sc = (float(np.interp(inc, C["income_q"], qs)) + float(np.interp(otm, C["otm_q"], qs))) / 2
        cur = near if otm < LANE["min_otm_pct"] else best
        if cur is near and near and near["path"] == "near-low" and not at_low:
            continue   # a near-low candidate beats a plain closer one (stronger record)
        if cur is None or sc > cur["score"] or (cur is near and at_low and cur["path"] != "near-low"):
            cur = {"strike": p["strike"], "expiry": str(p["expiry"]), "bid": p["bid"], "ask": p["ask"], "delta": p["delta"],
                    "spot": p["spot"], "days": days, "oi": p.get("open_interest"), "iv": (p["iv"] / 100 if p["iv"] > 3 else p["iv"]) if p["iv"] else None, "income_wk_pct": round(inc, 3),
                    "otm_pct": round(otm, 2), "score": round(sc, 3), "path": "near-low" if at_low else "closer"}
            if otm < LANE["min_otm_pct"]:
                near = cur
            else:
                best = cur
    if best:
        tier = C["tiers"][sum(best["score"] > c for c in C["cuts"])]
    elif near:
        best, tier = near, (NL if near["path"] == "near-low" else LANE["closer"])["record"]
    else:
        return None
    gap = 1 - LANE["gap_loss_pct"] / 100
    best.update(tier=tier["name"], tier_record=tier, earnings=str(earnings) if earnings else None,
                earnings_in=bool(earnings and earnings <= date.fromisoformat(best["expiry"])),
                off_high_pct=round(100 * (best["spot"] / hi52 - 1), 1) if hi52 else None,
                gap_loss=round(100 * max(best["strike"] - gap * best["spot"], 0.0) - 100 * best["bid"], 0), premium=round(100 * best["bid"], 0))
    best["crash"] = best["off_high_pct"] is not None and best["off_high_pct"] <= -LANE["crash_off_high_pct"]
    best["low63"] = round(low63, 2) if low63 else None
    if best["earnings_in"] and pre:
        best["pre_earnings"] = {k: pre[k] for k in ("strike", "expiry", "bid", "income_wk_pct", "otm_pct", "score", "tier", "gap_loss", "premium")}
    return best


def move_groups(conn, names: list[str], days: int = 126, min_corr: float = 0.5) -> dict[str, dict]:
    """Names that actually move together (Jamie 10-27: semis ↔ data centers ↔ rare earths cut across sector labels): average-linkage
    clusters on 6-month daily-return correlation, cut at corr ≥ min_corr. {ticker: {id, size, with: [top co-movers]}}."""
    from scipy.cluster.hierarchy import fcluster, linkage
    from scipy.spatial.distance import squareform
    px = defaultdict(dict)
    for t, d, c in conn.execute("""SELECT UPPER(ticker), date, close::float8 FROM prices_historical WHERE UPPER(ticker) = ANY(%s)
                                   AND date >= CURRENT_DATE - %s AND close > 0""", (names, int(days * 1.5))):
        px[t][d] = c
    ds = sorted({d for v in px.values() for d in v})[-days - 1:]
    ok = [t for t in names if sum(d in px[t] for d in ds) >= 0.8 * len(ds)]
    if len(ok) < 3:
        return {}
    M = np.array([[px[t].get(d, np.nan) for d in ds] for t in ok])
    R = np.diff(np.log(M), axis=1)
    C = np.ma.corrcoef(np.ma.masked_invalid(R)).filled(0.0)
    np.fill_diagonal(C, 1.0)
    lab = fcluster(linkage(squareform(1 - C, checks=False), "average"), 1 - min_corr, "distance")
    out = {}
    for i, t in enumerate(ok):
        mates = sorted((j for j in range(len(ok)) if lab[j] == lab[i] and j != i), key=lambda j: -C[i, j])
        out[t] = {"id": int(lab[i]), "size": len(mates) + 1, "with": [ok[j] for j in mates[:4]],
                  "corr": round(float(np.mean([C[i, j] for j in mates])), 2) if mates else None}
    return out


def book_groups(conn, recs: list[dict]) -> list[dict]:
    """Book-level theme exposure (Jamie 10-29: awareness only — never a cap or gate; a sector-only crash SHOULD bias the list).
    Published puts + held stocks clustered by move_groups; each published rec gets book_group = the other published names and
    held names that move with it, and how many of them share its expiry. Returns the groups with ≥ 2 published names."""
    pub = [r for r in recs if r["pass_"] and r.get("strike") is not None]
    held = {t for (t,) in conn.execute("""SELECT DISTINCT UPPER(symbol) FROM portfolio_positions
                                         WHERE snapshot_id = (SELECT MAX(id) FROM portfolio_snapshots)""")}
    names = sorted({r["ticker"] for r in pub} | held)
    g = move_groups(conn, names)
    by_id: dict[int, list[str]] = defaultdict(list)
    for t, x in g.items():
        by_id[x["id"]].append(t)
    exp = {r["ticker"]: r.get("expiry") for r in pub}
    out = []
    for r in pub:
        x = g.get(r["ticker"])
        if not x:
            continue
        mates = by_id[x["id"]]
        lst = [t for t in mates if t in exp]
        r["book_group"] = {"list": lst, "held": sorted(t for t in mates if t in held), "corr": x["corr"],
                           "same_expiry": sum(1 for t in lst if exp[t] == r.get("expiry")), "of_list": len(pub)}
        if len(lst) >= 2 and r["ticker"] == min(lst):
            out.append(r["book_group"])
    return out


NEWS_GAP_SIGMA, NEWS_GAP_MIN_PCT = 3.0, 5.0   # move vs prior close that reads as news, not drift
NEWS_8K = {"merger_agreement", "acquisition_agreement", "tender_offer", "going_private_transaction", "control_acquisition",
           "deal_termination", "guidance_issuance_or_update", "guidance_withdrawal", "preliminary_results", "regulatory_investigation",
           "material_litigation", "class_action_filing", "cybersecurity_incident", "ceo_departure", "cfo_departure",
           "restructuring_plan", "asset_impairment", "public_offering", "private_placement"}


def news_flags(conn, recs: list[dict], as_of: date, rv: dict) -> None:
    """News check (10-29 MRVL −12 % on Lumentum deal news, no 8-K yet): awareness only, never a gate — S025/S031 found gap
    drops recover no worse than other drops. rec['news'] = today's move vs the prior close when it is ≥ 3σ (21-day RV) and
    ≥ 5 %, plus material 8-Ks filed in the last 7 days (corporate_events)."""
    names = [r["ticker"] for r in recs]
    prev = {t: (c, d) for t, c, d in conn.execute("""SELECT DISTINCT ON (UPPER(ticker)) UPPER(ticker), close::float8, date
                                                     FROM prices_historical WHERE UPPER(ticker) = ANY(%s) AND date < %s
                                                     ORDER BY UPPER(ticker), date DESC""", (names, as_of)).fetchall()}
    k8 = defaultdict(list)
    for t, f, c in conn.execute("""SELECT UPPER(ticker), filed, category FROM public.corporate_events
                                   WHERE UPPER(ticker) = ANY(%s) AND filed >= %s::date - 7 AND category = ANY(%s)
                                   ORDER BY filed DESC""", (names, as_of, sorted(NEWS_8K))).fetchall():
        k8[t].append(f"{f} {c.replace('_', ' ')}")
    for r in recs:
        t, s = r["ticker"], r.get("spot")
        cl, cd = prev.get(t) or (None, None)
        gap = None
        if s and cl and rv.get(t):
            mv = 100 * (s / cl - 1)
            sig = abs(mv) / (100 * rv[t] / math.sqrt(252))
            if sig >= NEWS_GAP_SIGMA and abs(mv) >= NEWS_GAP_MIN_PCT:
                gap = {"move_pct": round(mv, 1), "sigma": round(sig, 1), "vs_close": str(cd)}
        if gap or k8.get(t):
            r["news"] = {"gap": gap, "filings_8k": k8.get(t, [])[:3],
                         "note": "check the news before selling (awareness, not a gate)"}


def rich_context(conn, recs: list[dict]) -> None:
    """Display facts per rich-lane pick (S110: shown, not scored): street target upside, fair value, nearest ≥ 2-method support
    zone below spot and where the strike sits vs it (S088 zones on LSEG daily bars, bars ≤ today)."""
    if not recs:
        return
    names = [r["ticker"] for r in recs]
    groups = move_groups(conn, names)
    pt = dict(conn.execute("""SELECT DISTINCT ON (ticker) ticker, median_pt::float8 FROM street_pt_daily WHERE ticker = ANY(%s)
                              AND as_of >= CURRENT_DATE - 60 ORDER BY ticker, as_of DESC""", (names,)).fetchall())
    fv = dict(conn.execute("""SELECT DISTINCT ON (ticker) ticker, COALESCE(adjusted_fair_value, fair_value)::float8 FROM fair_value_snapshots
                              WHERE ticker = ANY(%s) AND fair_value IS NOT NULL ORDER BY ticker, as_of DESC""", (names,)).fetchall())
    sys.path.insert(0, str(Path(__file__).resolve().parent / "analysis"))
    import s088_sr_zones as Z
    bars = Z.load(conn, set(names))
    for r in recs:
        x = r["rich"]
        S, K = x["spot"], x["strike"]
        x["group"] = groups.get(r["ticker"])
        if pt.get(r["ticker"]):
            x["pt"], x["pt_upside_pct"] = round(pt[r["ticker"]], 2), round(100 * (pt[r["ticker"]] / S - 1), 1)
            x["pt_flag"] = x["pt_upside_pct"] >= LANE["flags"]["pt_upside_pct"]
        if fv.get(r["ticker"]):
            x["fair_value"], x["fv_gap_pct"] = round(fv[r["ticker"]], 2), round(100 * (fv[r["ticker"]] / S - 1), 1)
        b = bars.get(r["ticker"])
        if b and len(b["d"]) >= 301:
            zs, _ = Z.zones(b, len(b["d"]) - 1)
            sup = [z for z in zs if z["score"] >= 2 and z["hi"] < S]   # nearest support below spot; where the strike sits vs it
            x["support"] = {"lo": round(sup[-1]["lo"], 2), "hi": round(sup[-1]["hi"], 2), "methods": sup[-1]["score"],
                            "strike": "below" if K <= sup[-1]["lo"] else "inside" if K <= sup[-1]["hi"] else "above"} if sup else None


S054_BAND = "0.15-0.20"   # panic-puts-hiv sells the ~0.20Δ put (strategy_signals default delta)


def compute(conn) -> tuple[date, list[dict], dict]:
    as_of = conn.execute("SELECT MAX(as_of) FROM option_chain_history").fetchone()[0]
    chain = rows(conn, """SELECT ticker, expiry, strike::float8, dte, spot::float8, bid::float8, ask::float8, iv::float8, delta::float8,
                                 open_interest, volume
                          FROM option_chain_history WHERE as_of = %s AND side = 'put' AND bid > 0 AND delta < 0""", (as_of,))
    by = defaultdict(list)
    for r in chain:
        by[r["ticker"]].append(r)
    names = sorted(by)
    I = SE.load_inputs(conn, names)
    # live prices for the states (10-29 B16): chain spot per name, SPY from the Schwab 1-min poll if < 30 min old
    spot = {t: next((p["spot"] for p in by[t] if p.get("spot")), None) for t in names}
    spy = conn.execute("""SELECT c::float8 FROM watchlist_sync.intraday_bars_1m WHERE ticker = 'SPY' AND ts > now() - interval '30 minutes'
                          ORDER BY ts DESC LIMIT 1""").fetchone()
    if spy:
        spot["SPY"] = spy[0]
    market, states = SE.band_states(conn, names, spot)
    pref = SE.band_pref(conn)
    ctx = BP.put_context(conn)
    rv = {}
    for t, cl in conn.execute("""SELECT ticker, array_agg(close::float8 ORDER BY date DESC) FROM lseg_research.daily_history
                                 WHERE ticker = ANY(%s) AND date >= CURRENT_DATE - 45 AND close > 0 GROUP BY 1""", (names,)).fetchall():
        if len(cl) >= 21:
            rv[t] = float(np.std(np.diff(np.log(cl[:21][::-1]))) * math.sqrt(252))
    close = {t: (c, d) for t, c, d in conn.execute("""SELECT DISTINCT ON (UPPER(ticker)) UPPER(ticker), close::float8, date FROM prices_historical
                                               WHERE UPPER(ticker) = ANY(%s) ORDER BY UPPER(ticker), date DESC""", (names,)).fetchall()}
    hi52 = dict(conn.execute("""SELECT UPPER(ticker), MAX(COALESCE(high, close))::float8 FROM prices_historical
                                 WHERE UPPER(ticker) = ANY(%s) AND date >= CURRENT_DATE - 365 GROUP BY 1""", (names,)).fetchall())
    low63 = {t: v for t, v in conn.execute("""SELECT t, MIN(lo) FROM (SELECT UPPER(ticker) t, COALESCE(low, close)::float8 lo,
                                                  ROW_NUMBER() OVER (PARTITION BY UPPER(ticker) ORDER BY date DESC) k FROM prices_historical
                                                  WHERE UPPER(ticker) = ANY(%s) AND date >= CURRENT_DATE - 120) x WHERE k <= 63 GROUP BY t""",
                                           (names,)).fetchall()}
    tech = {t: x for t, x in conn.execute("""SELECT DISTINCT ON (ticker) ticker, payload FROM watchlist_sync.indicators_daily
                                             WHERE ticker = ANY(%s) ORDER BY ticker, as_of DESC""", (names,)).fetchall()} if conn.execute(
        "SELECT to_regclass('watchlist_sync.indicators_daily')").fetchone()[0] else {}   # display only (S102: no put edge)
    # 11-09: market panic (VIX ÷ VIX3M ≥ 1, S101) blocked every put while S054 fired on 176 names — the one rule built for
    # these days (panic drop + IV30 > 48.7: kept +4.05 % vs +0.26 %; S054 grid: stressed SPY vol lifted all puts). S101 panic
    # cells ≈ 0 bp 2023→. → names with an open/priced panic-puts-hiv signal (last 3 sessions) keep S054's own 0.15–0.20Δ band;
    # every other gate still applies. Everyone else stays blocked in panic.
    s054 = {t for (t,) in conn.execute("""SELECT DISTINCT UPPER(ticker) FROM watchlist_sync.strategy_signals
                                         WHERE strategy_id = 'panic-puts-hiv' AND status IN ('open', 'priced')
                                           AND as_of IN (SELECT DISTINCT as_of FROM watchlist_sync.strategy_signals
                                                         WHERE strategy_id = 'panic-puts-hiv' ORDER BY as_of DESC LIMIT 3)""").fetchall()}
    out = []
    for t in names:
        exp = pick_expiry(sorted({p["expiry"] for p in by[t]}), as_of, ctx.get("earnings", {}).get(t))
        ms = (states.get(t) or {}).get("market_state", market["state"])
        rec = {"ticker": t, "as_of": str(as_of), "market_state": ms, "stock_state": (states.get(t) or {}).get("state"),
               "sector": (states.get(t) or {}).get("sector"), "tech": tech.get(t),
               "expiry": str(exp) if exp else None}
        rich = rich_pick(by[t], as_of, hi52.get(t), ctx.get("earnings", {}).get(t), low63.get(t))
        if rich:
            rich["credit"] = (ctx.get("lseg", {}).get(t) or {}).get("credit_combined_rank")
            rec["rich"] = rich
        band, why = SE.engine_put_band(market, states.get(t), pref=pref)
        if band is None and ms == "panic" and t.upper() in s054:
            band, why = S054_BAND, (f"market panic (VIX ÷ VIX3M {market['vix_ratio']:.2f}) blocks other puts; S054 panic put fires on {t} "
                                   f"(≥ 2σ 5-day drop, IV30 > 48.7) → its own {S054_BAND}Δ band")
            rec["s054"] = True
        far = BP.put_far_reason(t, exp, ctx) if exp else None
        if band and far and SE.band_bounds(band)[0] >= SE.band_bounds(FAR_BAND)[1]:
            band, why = FAR_BAND, f"{why} · {far} → {FAR_BAND}Δ (farther, not smaller)"
        rec.update(band_target=band, why=why, far=far)
        if not band or not exp:
            rec.update(pass_=False, gates=["panic: no new puts" if not band else "no weekly expiry 2–14 days out"])
            out.append(rec)
            continue
        pe = I.get(t, {}).get("put_edge_q")
        for g in SE.ENGINE["strategies"]["sell_put"]["gates"]:   # gate relaxed in this state → capped band (S102)
            rl = g.get("relax") or {}
            v = pe if g["input"] == "put_edge_q" else None
            if ms in rl.get("market_state", []) and (v is None or v < g["min"]) and \
                    SE.band_bounds(band)[0] >= SE.band_bounds(rl["max_band"])[1]:
                band, why = rl["max_band"], f"{why} · put-edge {f'Q{v}' if v else 'unknown'} in a sector drop → {rl['max_band']}Δ (S102)"
                rec.update(band_target=band, why=why)
        p, used = pick_strike([x for x in by[t] if x["expiry"] == exp], band)
        if not p:   # 10-28 (RGTI/ONDS/MP: $7–40 names bid < $0.10 at 0.06–0.10Δ) → widen like the income case, don't drop
            days0 = (exp - as_of).days + BP._settle_offset(exp)
            p, how = widen_for_income([x for x in by[t] if x["expiry"] == exp], band, ms, rec["stock_state"] or "normal", days0)
            if p:
                used, why = how, f"{why} · no ≥ ${R.PUT_MIN_RESTRIKE_BID:.2f} bid near {band}Δ → {how}Δ"
                rec.update(why=why)
        if not p:
            rec.update(pass_=False, gates=[f"no listed put with bid ≥ {R.PUT_MIN_RESTRIKE_BID} and OI ≥ {R.MIN_OPEN_INTEREST} "
                                           f"(or volume ≥ {R.MIN_VOLUME_IF_LOW_OI}) within one band of {band}; widening: {how}"])
            out.append(rec)
            continue
        days = (exp - as_of).days + BP._settle_offset(exp)
        widen_why = None
        if 100 * p["bid"] / p["strike"] * 7 / days < R.MIN_WEEKLY_INCOME_PCT:
            w, how = widen_for_income([x for x in by[t] if x["expiry"] == exp], used, ms, rec["stock_state"] or "normal", days)
            if w:
                why = f"{why} · {used}Δ pays {100 * p['bid'] / p['strike'] * 7 / days:.2f} %/wk < {R.MIN_WEEKLY_INCOME_PCT} → {how}Δ"
                p, used = w, how
                rec.update(why=why)
            else:
                widen_why = how
        iv = p["iv"] / 100 if p["iv"] > 3 else p["iv"]
        rec.update(band=used, strike=p["strike"], delta=p["delta"], bid=p["bid"], ask=p["ask"], spot=p["spot"], iv=iv, dte=p["dte"],
                   income_wk_pct=100 * p["bid"] / p["strike"] * 7 / days, iv_rv=iv / rv[t] if rv.get(t) else None)
        if rv.get(t):
            fair = bs_put(p["spot"], p["strike"], rv[t], max(p["dte"], 1) / 365)
            rec["ev_rv_cap"] = (p["bid"] - fair) / p["strike"] * 7 / days
        h = SE.band_table().get(f"{ms}|{rec['stock_state'] or 'normal'}|{used}")
        if h:
            rec.update(hist_bp=h["bp"], hist_w5=h["w5"], hist_kept=h["kept"])
        ok, gates = SE.fit({"ticker": t, "structure": "csp", "iv_rv": rec["iv_rv"], "market_state": ms}, I, {})
        ref = min((x for x in by[t] if x["expiry"] == exp), key=lambda x: abs(-x["delta"] - R.PUT_NAME_INCOME_ABS_DELTA))
        rec["name_income_pct"] = 100 * ref["bid"] / ref["strike"] * 7 / days   # the name's income at the tested Δ (display)
        # Jamie 10-28: the floor judges the put we sell, not the name at 0.15Δ — GOOGL/PLTR/NVDA passed paying 0.19–0.27 %/wk.
        if rec["income_wk_pct"] < R.MIN_WEEKLY_INCOME_PCT:
            ok = False
            gates.append(f"pays {rec['income_wk_pct']:.2f} %/wk at the {p['strike']:g} strike (min {R.MIN_WEEKLY_INCOME_PCT})"
                         + (f"; {widen_why}" if widen_why else ""))
        if far == "earnings before expiry":   # Jamie 10-28 (GOOGL 10-28): no new put across the print by default
            ok = False
            gates.append(f"earnings before the {exp} expiry")
        cl, cd = close.get(t) or (None, None)   # only a close as new as the chain can call it stale (10-27: a +4 % day was gated)
        if cl and cd >= as_of and abs(100 * (cl / p["spot"] - 1)) > R.MAX_SPOT_DRIFT_PCT:
            ok = False
            gates.append(f"stale chain: spot {p['spot']:.2f} on {as_of} vs close {cl:.2f} ({100 * (cl / p['spot'] - 1):+.1f} %)")
        rec.update(pass_=ok, gates=gates, put_edge_q=I.get(t, {}).get("put_edge_q"), verdict=I.get(t, {}).get("verdict"))
        out.append(rec)
    ranked = [r for r in out if r.get("strike") is not None]
    score = SE.rank_key(ranked, "sell_put")
    ranked.sort(key=lambda r: (not r["pass_"], -score.get(id(r), 0.0)))
    for i, r in enumerate(ranked, 1):
        r["rank"] = i
    rich_context(conn, [r for r in out if r.get("rich")])
    for bg in book_groups(conn, out):
        print(f"  book group: {len(bg['list'])} of {bg['of_list']} published move together ({', '.join(bg['list'])}; corr {bg['corr']}); "
              f"held {', '.join(bg['held']) or 'none'}")
    news_flags(conn, [r for r in out if r.get("strike") is not None], as_of, rv)
    for r in out:
        if (r.get("news") or {}).get("gap") and r["pass_"]:
            g = r["news"]["gap"]
            print(f"  news gap: {r['ticker']} {g['move_pct']:+.1f} % vs {g['vs_close']} close ({g['sigma']}σ) — published, check the news")
    last = {LANE["near_low"]["record"]["name"]: 1, LANE["closer"]["record"]["name"]: 2}   # S110 paths rank after the rule's tiers
    for i, r in enumerate(sorted((r for r in out if r.get("rich")), key=lambda r: (last.get(r["rich"]["tier"], 0), -r["rich"]["score"])), 1):
        r["rich"]["rank"] = i
    return as_of, out, market


def write(conn, as_of, recs):
    conn.execute("""CREATE TABLE IF NOT EXISTS watchlist_sync.put_recs_daily (
                      as_of date NOT NULL, ticker text NOT NULL, rank int, pass boolean NOT NULL, payload jsonb NOT NULL,
                      computed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (as_of, ticker))""")
    conn.execute("DELETE FROM watchlist_sync.put_recs_daily WHERE as_of = %s", (as_of,))
    for r in recs:
        conn.execute("INSERT INTO watchlist_sync.put_recs_daily (as_of, ticker, rank, pass, payload) VALUES (%s,%s,%s,%s,%s)",
                     (as_of, r["ticker"], r.get("rank"), r["pass_"], json.dumps({k: v for k, v in r.items() if k != "pass_"}, default=str)))
    conn.commit()


def main():
    with connect() as conn:
        as_of, recs, market = compute(conn)
        top = sorted((r for r in recs if r.get("rank")), key=lambda r: r["rank"])
        n_pass = sum(r["pass_"] for r in recs)
        print(f"put_recs {as_of}: market {market['state']} · {len(recs)} names · {n_pass} pass gates · "
              f"{sum(1 for r in recs if r.get('strike'))} with a strike")
        for r in top[:12]:
            print(f"  #{r['rank']:>3} {r['ticker']:6s} {r['expiry']} {r['strike']:>8g} {-r['delta']:.3f}Δ {r['income_wk_pct']:.2f}%/wk "
                  f"{'PASS' if r['pass_'] else 'gated: ' + '; '.join(r['gates'])} | {r['why']}")
        if "--print" not in sys.argv[1:]:
            write(conn, as_of, recs)
            print("→ watchlist_sync.put_recs_daily")
            score_picks()


def score_picks():
    """Option score of each pick's own contract, on the chain it was picked from (Jamie 10-28: every surface showed a score from
    a different strike, or 0). Runs on every write so no caller can publish unscored picks; put_consistency fails on a gap."""
    import subprocess
    api = Path(__file__).resolve().parents[2] / "artifacts" / "api-server"
    try:
        p = subprocess.run(["pnpm", "exec", "tsx", "src/scripts/snapshot-option-scores.ts", "--engine-pins"], cwd=api,
                           capture_output=True, text=True, timeout=180, env={**os.environ, "PATH": f"/opt/homebrew/bin:{os.environ.get('PATH', '')}"})
        line = next((l for l in p.stdout.splitlines() if l.startswith("engine pins")), (p.stderr or p.stdout).strip()[-300:])
        print(("" if p.returncode == 0 else "WARN put recs: ") + line)
    except (OSError, subprocess.TimeoutExpired) as e:
        print(f"WARN put recs: option scores not written ({e})")


if __name__ == "__main__":
    main()
