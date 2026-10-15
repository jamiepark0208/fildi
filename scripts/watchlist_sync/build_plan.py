"""Build a watchlist plan from Fildi's data with L1 (Fildi-data) checks → watchlist_sync.plans / plan_items.

Phase 1 lists: sell_puts, sell_calls (covered only), trim_risk. Nothing is written to Robinhood here.
Every candidate is stored with all its checks (pass or fail), so rejected ideas are explainable too.

Usage: .venv/bin/python build_plan.py [--show-rejected]
"""
from __future__ import annotations

import argparse
import json
import os
import re
from datetime import date
from pathlib import Path

import psycopg
from dotenv import load_dotenv

import rules as R

ROOT = Path(__file__).resolve().parents[2]


def connect() -> psycopg.Connection:
    for p in (ROOT / ".env.local", ROOT / ".env"):
        if p.is_file():
            load_dotenv(p, override=False)
    return psycopg.connect(os.environ["DATABASE_URL"])


def ensure_schema(conn: psycopg.Connection) -> None:
    sql = re.sub(r"--[^\n]*", "", (Path(__file__).with_name("schema.sql")).read_text())
    for stmt in [s.strip() for s in sql.split(";") if s.strip()]:
        conn.execute(stmt)
    conn.commit()


def chk(name: str, ok: bool, detail: str, severity: str = "block") -> dict:
    return {"check": name, "pass": bool(ok), "severity": severity, "detail": detail}


def rows(conn, sql, params=()):
    cur = conn.execute(sql, params)
    cols = [c.name for c in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def load_context(conn) -> dict:
    ctx: dict = {}
    snap = conn.execute("SELECT MAX(snapshot_date) FROM model_recs").fetchone()[0]
    ctx["snapshot_date"] = snap
    ctx["recs"] = rows(conn, """
        SELECT ticker, side, expiry, strike::float8, spot::float8, premium::float8, bid_is_live, weekly_income_pct::float8,
               delta::float8, strike_iv::float8, dte::float8, option_score::float8, macro_regime, vol_regime
        FROM model_recs WHERE snapshot_date = %s""", (snap,))
    ctx["model_date"] = snap
    reprice_from_chains(conn, ctx)
    ctx["recs"] = [r for r in ctx["recs"] if r["expiry"] > date.today()]
    ctx["close"] = {r["ticker"]: r for r in rows(conn, """
        SELECT DISTINCT ON (UPPER(ticker)) UPPER(ticker) AS ticker, date, close::float8
        FROM prices_historical ORDER BY UPPER(ticker), date DESC""")}
    ctx["earnings"] = {r["ticker"]: r["d"] for r in rows(conn, """
        SELECT ticker, MIN(d) AS d FROM (
          SELECT ticker, event_date AS d FROM lseg_research.events WHERE event_type = 'EarningsReleases' AND event_date >= CURRENT_DATE
          UNION ALL
          SELECT UPPER(ticker), report_date::date FROM earnings_calendar WHERE report_date::date >= CURRENT_DATE
        ) x GROUP BY ticker""")}
    ctx["lseg"] = {r["ticker"]: r for r in rows(conn, """
        SELECT DISTINCT ON (ticker) ticker, credit_combined_rank, arm_rank, combined_alpha_rank, pred_surprise_pct_fq1,
               short_interest, free_float
        FROM lseg_research.signals_daily ORDER BY ticker, as_of DESC""")}
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
    return ctx


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
                 strike_iv=pick["iv"], dte=pick["dte"],
                 weekly_income_pct=100 * pick["bid"] / pick["strike"] * 7 / (pick["dte"] + _settle_offset(exp)),
                 repriced=f"{ctx['model_date']} model pick re-priced from {as_of} chain" + (" (rolled to next expiry, nearest delta)" if rolled else ""))
    ctx["snapshot_date"] = as_of


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
    c.append(chk("min_income", (rec["weekly_income_pct"] or 0) >= R.MIN_WEEKLY_INCOME_PCT,
                 f"{rec['weekly_income_pct']:.2f}%/week (min {R.MIN_WEEKLY_INCOME_PCT})"))
    cl = ctx["close"].get(t)
    if cl:
        drift = 100 * (cl["close"] / rec["spot"] - 1)
        c.append(chk("spot_drift", abs(drift) <= R.MAX_SPOT_DRIFT_PCT, f"latest close {cl['close']:.2f} ({cl['date']}) vs model spot {rec['spot']:.2f}: {drift:+.1f}%"))
    else:
        c.append(chk("spot_drift", True, "no close in prices_historical", "warn"))
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
    c.append(chk("no_earnings_before_expiry", not (er and er <= rec["expiry"]),
                 f"next earnings {er} vs expiry {rec['expiry']}" if er else "no earnings date known", "block" if er else "warn"))
    if t in ctx["short_opts"]:
        c.append(chk("existing_exposure", True, "you already have a short option on this ticker", "warn"))

    account = None
    if side == "put":
        ls = ctx["lseg"].get(t)
        cr = ls and ls["credit_combined_rank"]
        c.append(chk("credit_ok", cr is None or cr >= R.MIN_CREDIT_RANK_PUTS,
                     f"StarMine credit {cr}/100" if cr is not None else "no LSEG credit rank", "block" if cr is not None else "warn"))
        tech = ctx["tech"].get(t)
        # warn, not block: Step 4 found falling knives don't hurt put sellers; the champion's severity-weighted risk decides
        c.append(chk("not_falling_knife", not (tech and tech["falling_knife"] == 1), "falling-knife chart" if tech and tech["falling_knife"] == 1 else "ok", "warn"))
        need = rec["strike"] * 100
        fits = [a for a in ctx["accounts"] if (a["bp"] or 0) >= need]
        best = max(ctx["accounts"], key=lambda a: a["bp"] or 0)
        c.append(chk("collateral_fits", bool(fits), f"needs ${need:,.0f}; largest put capacity {best['nickname']} ${best['bp']:,.0f} (free + posted)"))
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
        flags.append(f"high distress risk (StarMine credit {ls['credit_combined_rank']}/100)")
    if (ls.get("arm_rank") or 100) <= 20:
        flags.append(f"analysts cutting estimates (ARM {ls['arm_rank']}/100)")
    if (ls.get("combined_alpha_rank") or 100) <= 10:
        flags.append(f"weak overall LSEG score ({ls['combined_alpha_rank']}/100)")
    er = ctx["earnings"].get(ticker)
    ps = ls.get("pred_surprise_pct_fq1")
    if ps is not None and ps <= -2 and er and (er - date.today()).days <= 30:
        flags.append(f"StarMine predicts a {ps:.1f}% miss on {er}")
    tech = ctx["tech"].get(ticker)
    if tech and tech["falling_knife"] == 1:
        flags.append("falling-knife chart")
    return [chk("two_independent_flags", len(flags) >= 2, f"{len(flags)} flag(s)")], flags


def build(show_rejected: bool) -> int:
    with connect() as conn:
        ensure_schema(conn)
        ctx = load_context(conn)
        close = R.last_close_date()
        inputs = {
            "model_recs_snapshot": str(ctx["model_date"]),
            "priced_from": str(ctx["snapshot_date"]),
            "portfolio_snapshot": f"#{ctx['portfolio_snapshot']['id']} {ctx['portfolio_snapshot']['imported_at']:%Y-%m-%d %H:%M}",
            "last_close": str(close),
            "regime": ctx["recs"][0]["macro_regime"] if ctx["recs"] else None,
        }
        pid = conn.execute("INSERT INTO watchlist_sync.plans (close_date, inputs) VALUES (%s, %s) RETURNING id",
                           (close, json.dumps(inputs))).fetchone()[0]

        items: list[tuple] = []
        for side, key in (("put", "sell_puts"), ("call", "sell_calls")):
            best: dict[str, dict] = {}
            for rec in sorted((r for r in ctx["recs"] if r["side"] == side), key=lambda r: -(r["option_score"] or 0)):
                checks, account = option_checks(rec, ctx)
                ok = all(c["pass"] or c["severity"] == "warn" for c in checks)
                prev = best.get(rec["ticker"])
                # One contract per ticker: the best-scoring one that passes; else keep the best failure for explanation.
                if prev is None or (ok and not prev["ok"]):
                    best[rec["ticker"]] = {"rec": rec, "checks": checks, "ok": ok, "account": account}
            ranked = sorted(best.values(), key=lambda b: (not b["ok"], -(b["rec"]["option_score"] or 0)))
            rank = 0
            for b in ranked:
                r = b["rec"]
                if b["ok"]:
                    rank += 1
                    if rank > R.MAX_ITEMS:
                        b["ok"] = False
                        b["checks"].append(chk("list_cap", False, f"beyond top {R.MAX_ITEMS}"))
                reasons = [f"Fildi option score {r['option_score']:.0f}", f"{r['weekly_income_pct']:.2f}%/week at ${r['strike']:g} ({r['dte']:.0f} DTE, Δ {r['delta']:+.2f})"]
                if r.get("repriced"):
                    reasons.append(r["repriced"])
                items.append((pid, key, r["ticker"], rank if b["ok"] else None, r["option_score"], "option", side, r["strike"], r["expiry"],
                              b["account"], r["premium"], r["spot"], r["delta"], r["strike_iv"], b["ok"], json.dumps(b["checks"], default=str),
                              json.dumps(reasons), "pending" if b["ok"] else "not_required"))

        held = sorted({s["ticker"] for s in ctx["shares"]})
        rank = 0
        for t in held:
            checks, flags = trim_checks(t, ctx)
            ok = checks[0]["pass"]
            if ok:
                rank += 1
            items.append((pid, "trim_risk", t, rank if ok else None, len(flags), "stock", None, None, None, None, None, None, None, None,
                          ok, json.dumps(checks), json.dumps(flags), "pending" if ok else "not_required"))

        with conn.cursor() as cur:
            cur.executemany("""
                INSERT INTO watchlist_sync.plan_items (plan_id, list_key, ticker, rank, score, kind, option_type, strike, expiry, account,
                  model_premium, model_spot, model_delta, model_iv, l1_pass, l1_checks, reasons, verify_status)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""", items)
        summary = {}
        for it in items:
            s = summary.setdefault(it[1], {"candidates": 0, "l1_pass": 0})
            s["candidates"] += 1
            s["l1_pass"] += 1 if it[14] else 0
        conn.execute("UPDATE watchlist_sync.plans SET summary = %s WHERE id = %s", (json.dumps(summary), pid))
        conn.commit()

        print(f"plan #{pid} for close {close} · inputs {inputs}")
        for key, s in summary.items():
            print(f"  {key:11s} {s['l1_pass']:3d} pass L1 / {s['candidates']} candidates")
        fails: dict[str, int] = {}
        for it in items:
            for c in json.loads(it[15]):
                if not c["pass"] and c["severity"] == "block":
                    fails[c["check"]] = fails.get(c["check"], 0) + 1
        print("  blocked by:", ", ".join(f"{k} {v}" for k, v in sorted(fails.items(), key=lambda x: -x[1])))
        if show_rejected:
            for it in items:
                if not it[14]:
                    bad = [c["check"] + ": " + c["detail"] for c in json.loads(it[15]) if not c["pass"] and c["severity"] == "block"]
                    print(f"    ✗ {it[1]:10s} {it[2]:6s} {'; '.join(bad)[:160]}")
        return pid


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--show-rejected", action="store_true")
    build(ap.parse_args().show_rejected)
