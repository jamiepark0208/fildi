"""Load plan context: pool, re-pricing, engine merge, restrike."""
from __future__ import annotations

import json
import os
import sys
from datetime import date
from pathlib import Path

import rules as R

from build_plan_parts.db import rows

def load_context(conn) -> dict:
    ctx: dict = {}
    snap = conn.execute("SELECT MAX(snapshot_date) FROM model_recs").fetchone()[0]
    ctx["snapshot_date"] = snap
    ctx["recs"] = rows(conn, """
        SELECT ticker, side, expiry, strike::float8, spot::float8, premium::float8, bid_is_live, weekly_income_pct::float8,
               delta::float8, strike_iv::float8, dte::float8, option_score::float8, macro_regime, vol_regime
        FROM model_recs WHERE snapshot_date = %s""", (snap,))
    # Pool = the fresher of the weekly Friday picks (model_recs, API job; no catch-up → 10-16 never ran) and the daily universe-wide
    # option rankings (Mon–Thu). Jamie 10-20: a crash week ran on 10-09's 47 pre-crash picks, so crashed names could never enter.
    os_day = conn.execute("SELECT MAX(as_of) FROM option_score_snapshots").fetchone()[0]
    if os_day and (snap is None or os_day > snap):
        ctx["recs"] = rows(conn, """
            SELECT DISTINCT ON (ticker, side) ticker, side, expiry, strike::float8, spot::float8, premium::float8, bid_is_live,
                   weekly_income_pct::float8, delta::float8, strike_iv::float8, dte::float8, option_score::float8,
                   NULL::text AS macro_regime, NULL::text AS vol_regime
            FROM option_score_snapshots WHERE as_of = %s AND option_score IS NOT NULL ORDER BY ticker, side, computed_at DESC""", (os_day,))
        snap = os_day
        ctx["snapshot_date"] = snap
    ctx["model_date"] = snap
    for r in ctx["recs"]:
        r["spot_asof"] = snap   # spot_drift: a spot newer than the last close is a move, not staleness
    # Verdict cross-check at L1 too (10-20): the 15-slot cap used to fill with high-IV names the publish step then held back as
    # not ownable, so few real puts survived. Same rule as publish (one home: publish_model_list.held_back_reason).
    import publish_model_list as PL   # lazy: PL imports build_plan
    ctx["fit"], _, ctx["fit_params"] = PL.champion_scores(conn)
    ctx["held_back_reason"] = PL.held_back_reason
    reprice_from_chains(conn, ctx)
    ctx["recs"] = [r for r in ctx["recs"] if r["expiry"] > date.today()]
    ctx["close"] = {r["ticker"]: r for r in rows(conn, """
        SELECT DISTINCT ON (UPPER(ticker)) UPPER(ticker) AS ticker, date, close::float8
        FROM prices_historical ORDER BY UPPER(ticker), date DESC""")}
    ctx.update(put_context(conn, with_fit=False))   # fit already loaded above
    engine_pool_puts(conn, ctx)   # 10-26: every name the engine passes is a candidate here too (one pool, one gate set)
    restrike_puts(conn, ctx)   # needs earnings dates, fit (put risk / OWN) and LSEG credit: risky puts get the farther target
    ctx["tech"] = {r["ticker"].upper(): r for r in rows(conn, "SELECT ticker, falling_knife, rsi14::float8 AS rsi FROM ticker_technicals")}
    snap_id = conn.execute("SELECT MAX(id) FROM portfolio_snapshots").fetchone()[0]
    ctx["portfolio_snapshot"] = rows(conn, "SELECT id, imported_at FROM portfolio_snapshots WHERE id = %s", (snap_id,))[0]
    ctx["shares"] = rows(conn, """
        SELECT UPPER(symbol) AS ticker, account, SUM(quantity)::float8 AS qty FROM portfolio_positions
        WHERE snapshot_id = %s GROUP BY 1, 2""", (snap_id,))
    # Put capacity = free cash buying power + collateral already posted on open short puts (Robinhood's BP is net of it, and the
    # portfolio layer can free it by closing weaker puts). Matches portfolio.py; L1 only rejects what no account could ever carry.
    ctx["accounts"] = rows(conn, """
        SELECT s.account, s.nickname, s.type,
               COALESCE(s.unleveraged_bp, s.buying_power)::float8 + COALESCE((SELECT SUM(100 * o.strike * o.qty) FROM portfolio_options o
                 WHERE o.snapshot_id = s.snapshot_id AND o.account = s.account AND o.direction = 'short' AND o.option_type = 'put'
                 AND o.expiration >= CURRENT_DATE), 0)::float8 AS bp
        FROM portfolio_account_summaries s WHERE s.snapshot_id = %s""", (snap_id,))
    ctx["short_opts"] = {r["ticker"] for r in rows(conn, """
        SELECT DISTINCT UPPER(symbol) AS ticker FROM portfolio_options
        WHERE snapshot_id = %s AND direction = 'short' AND expiration >= CURRENT_DATE""", (snap_id,))}
    # Shares already committed to open short calls, per account (covered-call capacity = shares − 100 × these).
    ctx["calls_written"] = {(r["ticker"], r["account"]): r["contracts"] for r in rows(conn, """
        SELECT UPPER(symbol) AS ticker, account, SUM(qty)::float8 AS contracts FROM portfolio_options
        WHERE snapshot_id = %s AND direction = 'short' AND option_type = 'call' AND expiration >= CURRENT_DATE
        GROUP BY 1, 2""", (snap_id,))}
    ctx["closes_by_date"] = {(r["ticker"], r["date"]): r["close"] for r in rows(conn, """
        SELECT UPPER(ticker) AS ticker, date, close::float8 FROM prices_historical WHERE date >= CURRENT_DATE - 10""")}
    ctx["recs"] += panic_recs(conn)
    import put_edge
    # S059: IV/RV + vol-of-vol + put tech → simulated pnl/breach quintile; empty when the drift check demoted it (A196: enforced)
    ctx["edge_demoted"] = put_edge.is_demoted(conn)
    ctx["edge"] = {} if ctx["edge_demoted"] else put_edge.scores(conn)
    ctx["edge_min_q"] = put_edge.MIN_QUINTILE
    # A243: yesterday's published puts re-enter the pool and get chain re-struck (after edge is loaded for the weekly gate).
    if carry_forward_puts(conn, ctx):
        restrike_puts(conn, ctx)
    return ctx


PANIC_STRATEGY = "panic-puts-hiv"
PANIC_MAX_PER_GROUP = 2   # one-factor ρ≈0.6 (pm_alerts): 8 semis firing the same day are one bet, not eight


def _schwab_quotes(contracts: list[dict]) -> dict[tuple, dict]:
    import urllib.request
    out: dict[tuple, dict] = {}
    for i in range(0, len(contracts), 200):
        req = urllib.request.Request("http://127.0.0.1:8080/api/schwab/option-quotes", data=json.dumps({"contracts": contracts[i:i + 200]}).encode(),
                                     headers={"Content-Type": "application/json"})
        try:
            d = json.load(urllib.request.urlopen(req, timeout=120))
        except Exception as e:  # noqa: BLE001 — Schwab down → no panic picks today, the rest of the plan still builds
            print(f"  panic puts: Schwab quotes unavailable ({str(e)[:80]})")
            return {}
        for k, occ in d["symbols"].items():
            if d["quotes"].get(occ):
                t, e, s, _ = k.split("|")
                out[(t, e, float(s))] = d["quotes"][occ]
    return out


def panic_recs(conn) -> list[dict]:
    """Live panic-puts-hiv signals (S049/S054: ≥ 2σ 5-day drop + IV30 > 48.7 → sell the ~0.20Δ monthly put next session;
    holdout +1.47 %/trade vs normal days, 2025 confirmed) as Model List put candidates. Before 2026-10-19 they lived only on
    the Strategies tab, so the Model List showed 0 puts in the selloff the strategy was built for. Same S049 contract rule
    (monthly expiry nearest 30 DTE in 15–45, strike nearest 0.20Δ), priced live from Schwab; then the normal L1/L2 checks."""
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "analysis"))
    from s049_panic_puts import put_delta, third_friday  # lazy: s049 imports build_plan
    last = conn.execute("SELECT MAX(as_of) FROM watchlist_sync.strategy_signals WHERE strategy_id = %s", (PANIC_STRATEGY,)).fetchone()[0]
    if not last or R.trading_days_between(last, R.last_close_date()) > 1:
        return []   # S049 enters the session after the drop; older signals are not the tested trade
    sig = rows(conn, """SELECT ticker, details FROM watchlist_sync.strategy_signals WHERE strategy_id = %s AND as_of = %s
                        ORDER BY (details->>'z')::float8""", (PANIC_STRATEGY, last))
    d = date.today()
    exps = [third_friday(d.year + (d.month + k - 1) // 12, (d.month + k - 1) % 12 + 1) for k in range(3)]
    exps = [e for e in exps if 15 <= (e - d).days <= 45]
    if not exps:
        return []
    exp = min(exps, key=lambda e: abs((e - d).days - 30))
    dte = (exp - d).days
    want: list[dict] = []
    for s in sig:
        spot, iv = float(s["details"]["close"]), float(s["details"]["iv30"]) / 100
        lo, hi = spot * 0.5, spot
        for _ in range(40):
            k = (lo + hi) / 2
            lo, hi = (k, hi) if put_delta(spot, k, iv, dte / 365) > -0.20 else (lo, k)
        step = 0.5 if spot < 25 else 1 if spot < 100 else 2.5 if spot < 250 else 5 if spot < 1000 else 10
        base = round(k / step) * step
        want += [{"ticker": s["ticker"], "expiry": str(exp), "strike": round(base + j * step, 2), "type": "put"} for j in range(-5, 6)]
    q = _schwab_quotes(want)
    out, per_group = [], {}
    for s in sig:
        g = s["details"].get("peer_group") or s["ticker"]
        cands = []
        for (t, e, k), v in q.items():
            if t != s["ticker"] or not v.get("bid"):
                continue
            dl = v.get("delta")
            if dl is None or abs(dl) > 1:
                dl = put_delta(v.get("underlying") or s["details"]["close"], k, v.get("iv") or s["details"]["iv30"] / 100, dte / 365)
            cands.append((abs(dl + 0.20), k, dl, v))
        if not cands or per_group.get(g, 0) >= PANIC_MAX_PER_GROUP:
            continue
        per_group[g] = per_group.get(g, 0) + 1
        _, k, dl, v = min(cands, key=lambda c: c[0])
        spot = v.get("underlying") or float(s["details"]["close"])
        out.append({"ticker": s["ticker"], "side": "put", "expiry": exp, "strike": k, "spot": spot, "premium": v["bid"], "bid_is_live": True,
                    "weekly_income_pct": 100 * v["bid"] / k * 7 / (dte + _settle_offset(exp)), "delta": dl,
                    "strike_iv": v.get("iv") or s["details"]["iv30"] / 100, "dte": float(dte), "option_score": None,
                    "macro_regime": None, "vol_regime": None, "strategy": PANIC_STRATEGY,
                    "repriced": f"{PANIC_STRATEGY}: fell {s['details']['z']:.1f}σ in 5 days, IV {s['details']['iv30']:.0f} % (S049/S054: "
                                f"+1.5 %/trade vs normal days; in a broad Feb selloff it lost −0.15 %)"})
    print(f"  panic puts: {len(sig)} signals on {last} → {len(out)} priced (≤ {PANIC_MAX_PER_GROUP} per peer group, {exp})")
    return out


def _settle_offset(expiry: date) -> int:
    return {4: 3, 5: 2, 6: 1}.get(expiry.weekday(), 1)  # options settle T+1 business day (lib/options.ts settlementOffsetDays)


def reprice_from_chains(conn, ctx: dict) -> None:
    """model_recs is written on Fridays only, so Mon–Thu every pick failed fresh_snapshot (user approved the fix 2026-10-14).
    Keep the model's picks (the track record stays one weekly cohort) but re-price each from the latest daily chain
    (option_chain_history, saved by the noon option-score snapshot; no extra API calls): same contract if its expiry is still
    ≥ DTE min, else roll to the nearest expiry that is, at the strike with the closest delta. option_score stays the model's."""
    last = R.last_close_date()
    if R.trading_days_between(ctx["snapshot_date"], last) <= R.MAX_SNAPSHOT_AGE_TRADING_DAYS:
        return
    as_of = conn.execute("SELECT MAX(as_of) FROM option_chain_history").fetchone()[0]
    if not as_of or as_of <= ctx["snapshot_date"] or R.trading_days_between(as_of, last) > R.MAX_SNAPSHOT_AGE_TRADING_DAYS:
        return
    tickers = sorted({r["ticker"] for r in ctx["recs"]})
    chain: dict[tuple, list[dict]] = {}
    for c in rows(conn, """SELECT ticker, side, expiry, strike::float8, dte::float8, spot::float8, bid::float8, iv::float8, delta::float8
                           FROM option_chain_history WHERE as_of = %s AND ticker = ANY(%s) AND bid > 0""", (as_of, tickers)):
        chain.setdefault((c["ticker"], c["side"]), []).append(c)
    for r in ctx["recs"]:
        cs = chain.get((r["ticker"], r["side"]), [])
        exps = sorted({c["expiry"] for c in cs if c["dte"] >= R.DTE[0]})
        if not exps:
            continue
        exp = r["expiry"] if r["expiry"] in exps else exps[0]
        cs = [c for c in cs if c["expiry"] == exp and c["delta"] is not None]
        same = [c for c in cs if exp == r["expiry"] and abs(c["strike"] - r["strike"]) < 1e-6]
        pick = same[0] if same else min(cs, key=lambda c: abs(c["delta"] - (r["delta"] or 0)), default=None)
        if not pick:
            continue
        rolled = exp != r["expiry"]
        r.update(expiry=exp, strike=pick["strike"], spot=pick["spot"], premium=pick["bid"], bid_is_live=True, delta=pick["delta"],
                 strike_iv=pick["iv"], dte=pick["dte"], spot_asof=as_of,
                 weekly_income_pct=100 * pick["bid"] / pick["strike"] * 7 / (pick["dte"] + _settle_offset(exp)),
                 repriced=f"{ctx['model_date']} model pick re-priced from {as_of} chain" + (" (rolled to next expiry, nearest delta)" if rolled else ""))
    ctx["snapshot_date"] = as_of


def prior_published_puts(conn) -> list[dict]:
    """Sell-puts (ok/unfunded) from the latest *prior* ET day — any run that day, prefer newer runs.
    A single late run can be warn-only; earlier same-day runs still hold the published ideas to carry."""
    return rows(conn, """
        WITH prior_day AS (
          SELECT MAX((created_at AT TIME ZONE 'America/New_York')::date) AS d
          FROM watchlist_sync.model_runs
          WHERE (created_at AT TIME ZONE 'America/New_York')::date
                < (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date
        )
        SELECT DISTINCT ON (i.ticker) i.ticker, (i.contract->>'expiry')::date AS expiry,
               NULLIF(i.contract->>'strike', '')::float8 AS strike,
               NULLIF(i.contract->>'delta', '')::float8 AS delta,
               NULLIF(i.contract->>'premium', '')::float8 AS premium, i.status
        FROM watchlist_sync.model_items i
        JOIN watchlist_sync.model_runs r ON r.id = i.run_id
        CROSS JOIN prior_day
        WHERE (r.created_at AT TIME ZONE 'America/New_York')::date = prior_day.d
          AND i.folder_key = 'sell_puts' AND i.status IN ('ok', 'unfunded')
          AND NULLIF(i.contract->>'expiry', '') IS NOT NULL
        ORDER BY i.ticker, r.created_at DESC, i.rank NULLS LAST""")


def carry_forward_puts(conn, ctx: dict) -> int:
    """A243: re-introduce yesterday's published puts missing from today's score pool, then restrike_puts refreshes them.
    Drop only later via real L1 exits (edge gone, earnings, no chain strike) — not spot_drift alone."""
    prior = prior_published_puts(conn)
    if not prior:
        return 0
    have = {r["ticker"] for r in ctx["recs"] if r["side"] == "put"}
    for r in ctx["recs"]:
        if r["side"] == "put" and r["ticker"] in {p["ticker"] for p in prior}:
            r["carried"] = True
    as_of = conn.execute("SELECT MAX(as_of) FROM option_chain_history").fetchone()[0]
    if not as_of:
        return 0
    added = 0
    for p in prior:
        if p["ticker"] in have or p["expiry"] <= date.today():
            continue
        cl = ctx.get("close", {}).get(p["ticker"])
        spot = cl["close"] if cl else None
        ctx["recs"].append({
            "ticker": p["ticker"], "side": "put", "expiry": p["expiry"], "strike": p["strike"],
            "spot": spot or p["strike"], "premium": p["premium"] or 0.01, "bid_is_live": False,
            "weekly_income_pct": 0.0, "delta": p["delta"] or -R.PUT_TARGET_ABS_DELTA,
            "strike_iv": None, "dte": float((p["expiry"] - date.today()).days), "option_score": None,
            "macro_regime": None, "vol_regime": None, "carried": True,
            "repriced": f"carried from prior Model List ({p['status']}); awaiting chain re-strike",
        })
        have.add(p["ticker"])
        added += 1
    if added:
        print(f"  carry-forward: +{added} prior sell_puts into today's pool (will re-strike)")
    return added


def engine_pool_puts(conn, ctx: dict) -> int:
    """10-26 (Jamie: "consistency"): names the engine (put_recs_daily) passes but the option-score pool lacks — index ETFs, names
    without a snapshot row — join the pool; restrike_puts then gives them the engine contract. Before, Rankings / Live showed them
    as picks while the Model List never saw them (11 of 41 on 10-26)."""
    as_of = conn.execute("SELECT MAX(as_of) FROM option_chain_history").fetchone()[0]
    have = {r["ticker"] for r in ctx["recs"] if r["side"] == "put"}
    added = 0
    for t, e in conn.execute("""SELECT ticker, payload FROM watchlist_sync.put_recs_daily WHERE as_of = %s AND pass
                                AND payload->>'strike' IS NOT NULL ORDER BY rank""", (as_of,)).fetchall():
        if t in have:
            continue
        ctx["recs"].append({
            "ticker": t, "side": "put", "expiry": date.fromisoformat(e["expiry"]), "strike": e["strike"], "spot": e["spot"],
            "premium": e["bid"], "bid_is_live": True, "weekly_income_pct": e["income_wk_pct"], "delta": e["delta"],
            "strike_iv": e["iv"], "dte": float(e["dte"]), "option_score": None, "macro_regime": None, "vol_regime": None,
            "repriced": "engine pick (not in the option-score pool)",
        })
        added += 1
    if added:
        print(f"  engine pool: +{added} engine-passing puts not in the option-score pool")
    return added


def put_context(conn, with_fit: bool = True) -> dict:
    """What the far-strike rule needs (one loader for build_plan and put_recs.py): next earnings date, LSEG credit/alpha ranks,
    champion fit rows + params."""
    out = {
        "earnings": {r["ticker"]: r["d"] for r in rows(conn, """
            SELECT ticker, MIN(d) AS d FROM (
              SELECT ticker, event_date AS d FROM lseg_research.events WHERE event_type = 'EarningsReleases' AND event_date >= CURRENT_DATE
              UNION ALL
              SELECT UPPER(ticker), report_date::date FROM earnings_calendar WHERE report_date::date >= CURRENT_DATE
            ) x GROUP BY ticker""")},
        # 10-26: operating companies (reported revenue) — an unknown earnings date on one of these is a data gap, not "no event"
        "stocks": {r["t"] for r in rows(conn, """SELECT UPPER(ticker) t FROM ticker_fundamentals WHERE total_revenue IS NOT NULL
                                                 UNION SELECT UPPER(ticker) FROM fmp_fundamentals WHERE fmp_total_revenue IS NOT NULL""")},
        "lseg": {r["ticker"]: r for r in rows(conn, """
            SELECT DISTINCT ON (ticker) ticker, credit_combined_rank, arm_rank, combined_alpha_rank, pred_surprise_pct_fq1,
                   short_interest, free_float
            FROM lseg_research.signals_daily WHERE combined_alpha_rank IS NOT NULL OR as_of < CURRENT_DATE - 7
            ORDER BY ticker, as_of DESC""")},   # skip a day LSEG served empty ranks (10-19)
    }
    if with_fit:
        import publish_model_list as PL   # lazy: PL imports build_plan
        out["fit"], _, out["fit_params"] = PL.champion_scores(conn)
    return out


def put_far_reason(ticker: str, expiry, ctx: dict) -> str | None:
    """Why a sold put on `ticker` expiring `expiry` gets the farther strike (Jamie 10-20: farther, not smaller): earnings before
    expiry (S066/S069), StarMine credit < MIN_CREDIT_RANK_PUTS, or the fit's put-risk / low-OWN note (S069). None = normal."""
    er = ctx.get("earnings", {}).get(ticker)
    if er and expiry and er <= expiry:
        return "earnings before expiry"
    if not er and ticker in ctx.get("stocks", ()):
        return "earnings date unknown"   # 10-26: 39 names had none (feed gap) — treat as possibly inside the week
    cr = (ctx.get("lseg", {}).get(ticker) or {}).get("credit_combined_rank")
    if cr is not None and cr < R.MIN_CREDIT_RANK_PUTS:
        return f"StarMine credit {cr} < {R.MIN_CREDIT_RANK_PUTS}"
    if "fit" in ctx:
        sn = __import__("publish_model_list").put_size_note(ctx["fit"].get(ticker), ctx["fit_params"])
        if sn:
            return sn
        if (ctx["fit"].get(ticker) or {}).get("verdict") == "red":   # 10-26: red no longer blocks puts (S069) → farther + small
            return "risk flag red (S069)"
    return None


def restrike_puts(conn, ctx: dict) -> None:
    """Every model put (strategy puts only when above the Δ cap) takes the engine's pick for its name from
    watchlist_sync.put_recs_daily — put_recs.py is the one sold-put picker (A277: expiry, market × stock band, far rule, strike),
    so the Model List, Structures, Rankings and Live show the same contract. Same as_of as the latest saved chain.
    No engine strike → blocked by engine_pick (carried: carry_restrike); panic → market_not_panic. The name's income is still
    measured at PUT_NAME_INCOME_ABS_DELTA on that expiry (min_income eligibility, S088-vs-ML)."""
    as_of = conn.execute("SELECT MAX(as_of) FROM option_chain_history").fetchone()[0]
    if not as_of:
        return
    eng = {r["ticker"]: r["payload"] for r in rows(conn, "SELECT ticker, payload FROM watchlist_sync.put_recs_daily WHERE as_of = %s",
                                                   (as_of,))}
    if not eng:
        print("  restrike: no put_recs_daily rows for the chain day — run put_recs.py first; puts keep their model strikes")
        return
    ctx["band_market"] = next(iter(eng.values()))["market_state"]
    for r in ctx["recs"]:
        # 11-09: names where S054 fires carry their own band from put_recs (s054) — the panic pause is for everyone else
        if r["side"] == "put" and ctx["band_market"] == "panic" and not (eng.get(r["ticker"]) or {}).get("s054"):
            r["engine_pause"] = next((e["why"] for e in eng.values() if not e.get("s054")), next(iter(eng.values()))["why"])
    hot = [r for r in ctx["recs"] if r["side"] == "put" and not r.get("restruck") and (
        r.get("carried") or not r.get("strategy") or (r["delta"] is not None and -r["delta"] > -R.PUT_DELTA[0]))]
    cs = rows(conn, """SELECT ticker, expiry, strike::float8, dte::float8, bid::float8, delta::float8
                       FROM option_chain_history WHERE as_of = %s AND side = 'put' AND ticker = ANY(%s) AND bid > 0 AND delta < 0""",
              (as_of, sorted({r["ticker"] for r in hot})))
    for r in hot:
        e = eng.get(r["ticker"])
        if not e or e.get("strike") is None:
            r["engine_none"] = "; ".join((e or {}).get("gates") or ["no saved chain for this name"])
            if r.get("carried"):
                r["carry_no_strike"] = True
            continue
        exp = date.fromisoformat(e["expiry"])
        r["far_why"], r["band_why"], r["engine_market"] = e.get("far"), e["why"], e.get("market_state")
        r["engine_rank"] = e.get("rank")
        r["engine_gates"] = list(e.get("gates") or [])   # 10-26: the engine's gate set is the only one (put-edge, income, stale chain)
        r["engine_edge_q"] = e.get("put_edge_q")
        note = f"engine pick {e['strike']:g} {exp:%m-%d} ({-e['delta']:.2f}Δ, was {-(r.get('delta') or 0):.2f}Δ): {e['why']}"
        ref = [c for c in cs if c["ticker"] == r["ticker"] and c["expiry"] == exp]
        if e.get("name_income_pct") is not None:   # 10-27: the engine's number (one home; a second copy read NVDA 0.27 vs 0.31)
            r["name_income_pct"] = e["name_income_pct"]
        elif ref:
            ref = min(ref, key=lambda c: abs(-c["delta"] - R.PUT_NAME_INCOME_ABS_DELTA))   # the name's income at the tested Δ
            r["name_income_pct"] = 100 * ref["bid"] / ref["strike"] * 7 / (ref["dte"] + _settle_offset(ref["expiry"]))
        r["restruck"], r["spot_asof"] = True, as_of
        r.update(strike=e["strike"], spot=e["spot"], premium=e["bid"], bid_is_live=True, delta=e["delta"], strike_iv=e["iv"],
                 expiry=exp, dte=e["dte"], weekly_income_pct=e["income_wk_pct"],
                 repriced=f"{r['repriced']}; {note}" if r.get("repriced") else note)
