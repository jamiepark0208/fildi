"""L1 option and trim checks."""
from __future__ import annotations

from datetime import date

import rules as R

from build_plan_parts.db import chk

def _edge_relax() -> list[str]:
    """Market states where strategy_rules' put-edge gate is relaxed (put_recs caps the band there)."""
    import strategy_engine as SE
    g = next((g for g in SE.ENGINE["strategies"]["sell_put"]["gates"] if g["input"] == "put_edge_q"), {})
    return (g.get("relax") or {}).get("market_state", [])


def _edge_q(ctx: dict, rec: dict) -> int:
    e = ctx.get("edge", {}).get(rec["ticker"]) if rec["side"] == "put" else None
    return e["quintile"] if e else 0


def option_checks(rec: dict, ctx: dict) -> tuple[list[dict], str | None]:
    t, side = rec["ticker"], rec["side"]
    c: list[dict] = []
    age = R.trading_days_between(ctx["snapshot_date"], R.last_close_date())
    c.append(chk("fresh_snapshot", age <= R.MAX_SNAPSHOT_AGE_TRADING_DAYS,
                 f"priced {ctx['snapshot_date']} ({age} trading day(s) before last close; model {ctx.get('model_date', ctx['snapshot_date'])})"))
    c.append(chk("live_bid", bool(rec["bid_is_live"]) and (rec["premium"] or 0) > 0, f"Fildi premium ${rec['premium']}"))
    lo, hi = R.PUT_DELTA if side == "put" else R.CALL_DELTA
    d = rec["delta"]
    c.append(chk("delta_band", d is not None and lo <= d <= hi, f"delta {d} (allowed {lo}..{hi}; 0.00 = broken greeks)"))
    c.append(chk("dte_band", R.DTE[0] <= (rec["dte"] or 0) <= R.DTE[1], f"{rec['dte']:.0f} DTE"))
    iv = rec["strike_iv"]
    c.append(chk("iv_sane", iv is not None and R.IV_SANE[0] <= iv <= R.IV_SANE[1], f"IV {iv}"))
    c.append(chk("premium_plausible", rec["premium"] <= rec["strike"] * R.MAX_PREMIUM_TO_STRIKE,
                 f"premium is {100 * rec['premium'] / rec['strike']:.1f}% of strike"))
    # Jamie 10-28: judged at the strike sold (same as put_recs' gate) — the name's 0.15Δ income let 0.19–0.27 %/wk puts through
    ni = rec.get("name_income_pct")
    wk = rec["weekly_income_pct"] or 0
    c.append(chk("min_income", wk >= R.MIN_WEEKLY_INCOME_PCT,
                 f"{wk:.2f}%/week at this strike" + (f"; name pays {ni:.2f}% at {R.PUT_NAME_INCOME_ABS_DELTA}Δ" if ni is not None else "")
                 + f" (min {R.MIN_WEEKLY_INCOME_PCT})"))
    if side == "put" and not rec.get("strategy"):   # the S088-vs-ML test only sold strikes bidding ≥ $0.10 (10-24)
        c.append(chk("min_bid", (rec["premium"] or 0) >= R.PUT_MIN_RESTRIKE_BID,
                     f"bid ${rec['premium'] or 0:.2f} (min ${R.PUT_MIN_RESTRIKE_BID:.2f})"))
    cl = ctx["close"].get(t)
    if cl:
        drift = 100 * (cl["close"] / rec["spot"] - 1)
        # A243: carried ideas were re-struck to today's chain — drift vs a stale model spot is not an exit.
        # Drop only when edge/earnings/strike fail. Strategy picks are live-priced (same warn).
        newer = rec.get("spot_asof") and cl["date"] < rec["spot_asof"]   # 10-27: today's chain spot vs yesterday's close is a move, not staleness
        c.append(chk("spot_drift", newer or abs(drift) <= R.MAX_SPOT_DRIFT_PCT, f"latest close {cl['close']:.2f} ({cl['date']}) vs model spot {rec['spot']:.2f}: {drift:+.1f}%",
                     "warn" if rec.get("strategy") or rec.get("carried") else "block"))
    else:
        c.append(chk("spot_drift", True, "no close in prices_historical", "warn"))
    if rec.get("carried") and rec.get("carry_no_strike"):
        c.append(chk("carry_restrike", False, "carried from prior list but no listed strike in delta band on today's chain", "block"))
    # Stale-spot bug (found 2026-10-04): 64/97 model_recs on 10/02 used the 10/01 close as spot.
    # L2 recomputes OTM/delta from the live Robinhood price, so this is a warning here, not a block.
    snap = ctx["snapshot_date"]
    c_today = ctx["closes_by_date"].get((t, snap))
    prev = [v for (tk, d), v in ctx["closes_by_date"].items() if tk == t and d < snap]
    if c_today and abs(rec["spot"] / c_today - 1) >= 0.002:
        stale = any(abs(rec["spot"] / v - 1) < 0.002 for v in prev)
        c.append(chk("spot_is_current", False,
                     f"model spot {rec['spot']:.2f} ≠ {snap} close {c_today:.2f}" + (" (= an earlier close: stale)" if stale else ""), "warn"))
    er = ctx["earnings"].get(t)
    inside = bool(er and er <= rec["expiry"])
    far = False   # Jamie 10-28 (GOOGL): no new put across earnings, at any Δ — same as put_recs' gate
    c.append(chk("no_earnings_before_expiry", not inside or far,   # puts: allowed at ≤ 0.12Δ (S066/S069; Jamie 10-20), calls unchanged
                 (f"next earnings {er} vs expiry {rec['expiry']}" + (f": put struck at {-rec['delta']:.2f}Δ for the event" if inside and far else ""))
                 if er else "no earnings date known", "warn" if not er or (inside and far) else "block"))
    if t in ctx["short_opts"]:
        c.append(chk("existing_exposure", True, "you already have a short option on this ticker", "warn"))

    account = None
    if side == "put":
        ls = ctx["lseg"].get(t)
        cr = ls and ls["credit_combined_rank"]
        e = ctx.get("edge", {}).get(t)
        if not rec.get("strategy") and rec.get("restruck"):   # 10-26: engine pick → put-edge already judged by the engine's gates
            q = rec.get("engine_edge_q")
            c.append(chk("put_edge", True, f"put edge {f'Q{q}' if q else 'unknown'} · judged by the engine (strategy_rules sell_put gates)"))
        elif not rec.get("strategy"):   # panic puts are their own tested lane (S049/S054); put edge ranks the weekly lane
            relaxed = rec.get("engine_market") in _edge_relax()   # sector drop: Q1–Q3 earn (S102), engine already capped the band
            c.append(chk("put_edge", (e["quintile"] >= ctx.get("edge_min_q", 4) or relaxed) if e else bool(ctx.get("edge_demoted")),
                         (f"put edge Q{e['quintile']}: allowed in a sector drop at ≤ 0.15Δ (S102: Q1–Q3 +51…+89 bp/wk both periods)"
                          if relaxed and e["quintile"] < ctx.get("edge_min_q", 4) else
                          f"put edge Q{e['quintile']}: simulated {e['pnl_bp']:+.1f} bp/wk net of fills, breach {100 * e['breach']:.0f} % (S059, Q1–Q3 lose after fills)")
                         if e else "no put-edge inputs (or demoted by drift check)",
                         # 10-20 (Jamie OK): no inputs = unknown edge, and S059 says most weekly puts lose after fills → block;
                         # the old warn fallback applies only when the drift check has demoted put edge for everyone
                         "block" if e or not ctx.get("edge_demoted") else "warn"))
        c.append(chk("market_not_panic", not rec.get("engine_pause"), rec.get("engine_pause") or "vol curve normal (VIX < VIX3M)"))   # S101
        if rec.get("engine_gates"):   # A277 consistency: the engine's own gates (verdict, IV/RV) block here too
            c.append(chk("engine_gates", False, "engine gates: " + "; ".join(rec["engine_gates"])))
        if rec.get("engine_none") and not rec.get("carried"):   # A277: no engine put for this name → not on the list
            c.append(chk("engine_pick", False, f"no engine put: {rec['engine_none']}"))
        c.append(chk("not_on_trim", t not in ctx.get("trim", ()), "on your trim list today: no new puts" if t in ctx.get("trim", ()) else "ok"))
        hb = ctx["held_back_reason"]("sell_puts", ctx["fit"].get(t), ctx["fit_params"], None) if "fit" in ctx else None
        c.append(chk("verdict_ok", hb is None, hb or "scored, not red"))
        # S069/S063 (Jamie 10-20): high put risk, low OWN or low credit earn as much or more but with a fatter tail → the strike moves
        # farther OTM (restrike_puts, ≤ PUT_EARNINGS_ABS_DELTA cap); warn only if no listed strike got it there
        sn = __import__("publish_model_list").put_size_note(ctx["fit"].get(t), ctx["fit_params"]) if "fit" in ctx else None
        far = rec["delta"] is not None and -rec["delta"] <= R.PUT_EARNINGS_ABS_DELTA[0]
        c.append(chk("risk_strike", sn is None or far, (sn + (f": struck at {-rec['delta']:.2f}Δ" if far else ": no listed strike ≤ "
                     f"{R.PUT_EARNINGS_ABS_DELTA[0]}Δ")) if sn else "normal strike", "warn"))
        c.append(chk("credit_ok", cr is None or cr >= R.MIN_CREDIT_RANK_PUTS or far,
                     f"StarMine credit {cr}/100: distress tail — worst 1 % weeks lose ~25 % more (S063)"
                     + (f"; struck at {-rec['delta']:.2f}Δ" if far else "; no farther strike listed") if cr is not None else "no LSEG credit rank",
                     "warn"))
        tech = ctx["tech"].get(t)
        # warn, not block: Step 4 found falling knives don't hurt put sellers; the champion's severity-weighted risk decides
        c.append(chk("not_falling_knife", not (tech and tech["falling_knife"] == 1), "falling-knife chart" if tech and tech["falling_knife"] == 1 else "ok", "warn"))
        need = rec["strike"] * 100
        fits = [a for a in ctx["accounts"] if (a["bp"] or 0) >= need]
        best = max(ctx["accounts"], key=lambda a: a["bp"] or 0)
        # warn, not block (Jamie 10-19): cash decides whether you can take a trade, not whether it is a good one → the idea goes on and
        # publish shows it in Sell Puts as "unfunded" with what it needs
        c.append(chk("collateral_fits", bool(fits), f"needs ${need:,.0f}; largest put capacity {best['nickname']} ${best['bp']:,.0f} (free + posted)", "warn"))
        account = (max(fits, key=lambda a: a["bp"])["nickname"] if fits else None)
    else:
        free = [
            {**s, "free": s["qty"] - 100 * ctx["calls_written"].get((t, s["account"]), 0)}
            for s in ctx["shares"] if s["ticker"] == t
        ]
        held = [s for s in free if s["free"] >= R.MIN_COVERED_SHARES]
        detail = ", ".join(f"{s['qty']:.0f} sh − {100 * ctx['calls_written'].get((t, s['account']), 0):.0f} already covering calls" for s in free) or "0 shares"
        c.append(chk("covered", bool(held), f"{detail} (need {R.MIN_COVERED_SHARES} free in one account)"))
        acct_names = {a["account"]: a["nickname"] for a in ctx["accounts"]}
        account = acct_names.get(held[0]["account"], held[0]["account"]) if held else None
    return c, account


def trim_checks(ticker: str, ctx: dict) -> tuple[list[dict], list[str]]:
    ls = ctx["lseg"].get(ticker) or {}
    flags: list[str] = []
    if (ls.get("credit_combined_rank") or 100) <= 10:
        flags.append(f"high distress risk (StarMine credit {ls['credit_combined_rank']}/100; untested: no credit history)")
    if (ls.get("arm_rank") or 100) <= 20:
        flags.append(f"analysts cutting estimates (ARM {ls['arm_rank']}/100; S060: down-revisions −0.9 %/month vs peers)")
    if (ls.get("combined_alpha_rank") or 100) <= 10:
        flags.append(f"weak overall LSEG score ({ls['combined_alpha_rank']}/100; S058: ~−1 %/month vs peers, borderline)")
    er = ctx["earnings"].get(ticker)
    ps = ls.get("pred_surprise_pct_fq1")
    if ps is not None and ps <= -2 and er and (er - date.today()).days <= 30:
        flags.append(f"StarMine predicts a {ps:.1f}% miss on {er} (S060: −1.7 %/month vs peers)")
    # S058 (10-19): a falling-knife chart is not a trim reason: +0.15 % next-month excess overall, and inside weak-alpha names
    # it is +1.46 pp BETTER (they bounce). Counting it made the model sell lows (RKLB, RGTI). Shown as context only.
    n = len(flags)
    tech = ctx["tech"].get(ticker)
    if tech and tech["falling_knife"] == 1:
        flags.append("falling-knife chart (context only, not counted: S058)")
    return [chk("two_independent_flags", n >= 2, f"{n} flag(s)")], flags
