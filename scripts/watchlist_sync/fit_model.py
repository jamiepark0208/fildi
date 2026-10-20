"""Fildi Fit Model v1: which names fit a premium-seller's book, and what color should they be?

Five pillars (0–100) + independent risk flags → one color with written reasons. Colors follow Fildi's existing
semantics (option-scorer-constants TAG_BONUS; red is excluded from the options scanner):
  🟢 green  long conviction (would happily own)       🔵 blue  holding / assigned
  🟡 yellow wheel / income target                      🟣 purple market context (ETFs)
  🔴 red    avoid (excluded from scanner)              —  no tag = watch-only / candidate to drop from lists

Usage: .venv/bin/python fit_model.py [--tickers A,B] [--show all|changes]
Writes watchlist_sync.fit_scores (one row per ticker, latest run).
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from build_plan import connect, rows

ROOT = Path(__file__).resolve().parents[2]
HEX = {"green": "#22c55e", "yellow": "#eab308", "blue": "#3b82f6", "purple": "#a855f7", "red": "#ef4444", "": ""}
NAME = {v: k for k, v in HEX.items()}

# Thresholds (v1). Every color decision cites which of these fired.
GREEN_OWN, GREEN_STREET, GREEN_CREDIT = 62, 55, 40
YELLOW_PREMIUM, YELLOW_OWN, YELLOW_FIT = 55, 45, 60
RED_FLAGS, RED_BOTH = 2, 35
MODEL_VERSION = "fit-1.3"
# StarMine credit ranks leveraged-by-design financials low (GS 11, MS 24, BDC PFLT 1): not comparable → excluded for these.
LEVERED_FINANCIALS = {"Large Banks", "Regional Banks", "Asset Management & Alt Finance", "Insurance"}


def lin(x, lo, hi):
    if x is None:
        return None
    return max(0.0, min(100.0, 100 * (x - lo) / (hi - lo)))


def wavg(parts):
    parts = [(w, v) for w, v in parts if v is not None]
    if not parts:
        return None
    return sum(w * v for w, v in parts) / sum(w for w, _ in parts)


SQL = """
WITH s AS (SELECT DISTINCT ON (ticker) * FROM lseg_research.signals_daily ORDER BY ticker, as_of DESC),
-- 10-19: LSEG served empty StarMine ranks pre-open → every rank null → crash. Carry the last real ranks forward ≤ 7 days.
sm AS (SELECT DISTINCT ON (ticker) ticker, credit_combined_rank, combined_alpha_rank, arm_rank FROM lseg_research.signals_daily
       WHERE combined_alpha_rank IS NOT NULL AND as_of >= CURRENT_DATE - 7 ORDER BY ticker, as_of DESC),
er AS (SELECT ticker, MIN(d) d FROM (
        SELECT ticker, event_date d FROM lseg_research.events WHERE event_type = 'EarningsReleases' AND event_date >= CURRENT_DATE
        UNION ALL SELECT UPPER(ticker), report_date::date FROM earnings_calendar WHERE report_date::date >= CURRENT_DATE) x GROUP BY 1),
px AS (SELECT DISTINCT ON (UPPER(ticker)) UPPER(ticker) ticker, close::float8 close FROM prices_historical ORDER BY UPPER(ticker), date DESC),
pe AS (SELECT ticker, SUM(total_earned)::float8 earned, SUM(sell_put + sell_call)::float8 premium_pnl
       FROM (SELECT DISTINCT ON (ticker, account) * FROM portfolio_ticker_earnings ORDER BY ticker, account, imported_at DESC) l GROUP BY 1),
fills AS (SELECT UPPER(symbol) ticker, COUNT(*) n FROM portfolio_orders WHERE state = 'filled' GROUP BY 1),
held AS (SELECT UPPER(symbol) ticker, SUM(quantity)::float8 sh FROM portfolio_positions WHERE snapshot_id = (SELECT MAX(id) FROM portfolio_snapshots) GROUP BY 1),
pg AS (SELECT t2.ticker, g.name FROM (
         SELECT ticker, group_id FROM peer_group_overrides
         UNION ALL
         SELECT DISTINCT ON (ticker) ticker, group_id FROM peer_group_members m
         WHERE removed_at IS NULL AND NOT EXISTS (SELECT 1 FROM peer_group_overrides o WHERE o.ticker = m.ticker)
       ) t2 JOIN peer_groups g ON g.id = t2.group_id)
SELECT t.ticker, tf.fund_total_score::float8 fund, COALESCE(s.credit_combined_rank, sm.credit_combined_rank) credit,
       COALESCE(s.combined_alpha_rank, sm.combined_alpha_rank) cam, COALESCE(s.arm_rank, sm.arm_rank) arm,
       s.eps_drift_30d_pct drift, s.pred_surprise_pct_fq1 ps, s.pt_upside_pct pt_up, s.eps_num_est_fy1 n_est,
       CASE WHEN s.free_float > 0 THEN 100 * s.short_interest / s.free_float END short_float,
       CASE WHEN tt.atm_put_iv >= 5 THEN tt.atm_put_iv::float8 END fildi_iv,
       s.fetched_at iv_fetched_at,
       CASE WHEN s.imp_volt > 0 THEN (CASE WHEN s.imp_volt < 5 THEN 100 * s.imp_volt ELSE s.imp_volt END)::float8 END iv,
       CASE WHEN tt.realized_vol_20d BETWEEN 1 AND 250 THEN tt.realized_vol_20d::float8 END rv,
       tt.rsi14::float8 rsi, tt.falling_knife fk, px.close, er.d next_er, pe.earned, pe.premium_pnl, fills.n fills,
       held.sh held, pg.name peer
FROM unnest(%s::text[]) t(ticker)
LEFT JOIN ticker_fundamentals tf ON UPPER(tf.ticker) = t.ticker
LEFT JOIN s ON s.ticker = t.ticker
LEFT JOIN sm ON sm.ticker = t.ticker
LEFT JOIN ticker_technicals tt ON UPPER(tt.ticker) = t.ticker
LEFT JOIN px ON px.ticker = t.ticker
LEFT JOIN er ON er.ticker = t.ticker
LEFT JOIN pe ON pe.ticker = t.ticker
LEFT JOIN fills ON fills.ticker = t.ticker
LEFT JOIN held ON held.ticker = t.ticker
LEFT JOIN pg ON pg.ticker = t.ticker
"""


def score(r: dict, bp: dict, etfs: set[str]) -> dict:
    from datetime import date

    t = r["ticker"]
    if r["peer"] in LEVERED_FINANCIALS:
        r = {**r, "credit": None}  # credit model not comparable for levered financials
    own = wavg([(0.45, r["fund"]), (0.35, r["credit"]), (0.20, r["cam"])])
    street = wavg([(0.5, r["arm"]), (0.25, lin(r["drift"], -5, 5)), (0.25, lin(r["ps"], -5, 5))])
    # v1.2: premium uses LSEG implied vol (IMP_VOLT). Fildi's Yahoo nearest-expiry IV ran 1.45–3.4× LSEG on 7/8 v1.1
    # "rich premium" picks; ranking by it selected the noisiest readings.
    r = {**r, "iv_rv": (r["iv"] / r["rv"]) if r["iv"] and r["rv"] else None}
    premium = wavg([(0.6, lin(r["iv_rv"], 0.8, 1.5)), (0.4, lin(r["iv"], 25, 90))]) if r["iv"] else None
    iv_note = None
    import rules as R
    provisional = bool(r["iv"]) and not R.market_open(r["iv_fetched_at"])
    if r["iv"] and r["fildi_iv"]:
        ratio = r["fildi_iv"] / r["iv"]
        if ratio > 1.4 or ratio < 0.7:
            iv_note = f"Fildi IV {r['fildi_iv']:.0f}% vs LSEG {r['iv']:.0f}%: Fildi's reading unreliable, used LSEG"
    price = r["close"]
    fit, fit_why = None, None
    if price:
        need = 0.9 * price * 100  # ~10% OTM put collateral
        if need <= bp["cash"]:
            fit, fit_why = 100, f"a 10%-OTM put needs ~${need:,.0f}, fits your cash buying power (${bp['cash']:,.0f})"
        elif need <= bp["margin"]:
            fit, fit_why = 60, f"needs ~${need:,.0f}, only fits using margin (${bp['margin']:,.0f})"
        else:
            fit, fit_why = 0, f"needs ~${need:,.0f} collateral, more than any account has (max ${bp['margin']:,.0f})"
        if price < 3:
            fit, fit_why = min(fit, 40), f"${price:.2f} stock: strikes too coarse, premiums tiny"
    edge = lin(r["earned"], -500, 2000) if r["earned"] is not None else None

    flags = []
    if r["credit"] is not None and r["credit"] <= 15:
        flags.append(f"fragile balance sheet (StarMine credit {r['credit']}/100)")
    if r["arm"] is not None and r["arm"] <= 15:
        flags.append(f"analysts cutting hard (revisions {r['arm']}/100)")
    if r["fund"] is not None and r["fund"] <= 35:
        flags.append(f"weak fundamentals vs peers (fund {r['fund']:.0f})")
    if r["fk"] == 1:
        flags.append("falling-knife chart")
    if r["short_float"] is not None and r["short_float"] >= 25:
        flags.append(f"{r['short_float']:.0f}% of float short")
    if r["ps"] is not None and r["ps"] <= -2 and r["next_er"] and (r["next_er"] - date.today()).days <= 30:
        flags.append(f"StarMine predicts a {r['ps']:.1f}% miss on {r['next_er']}")
    if r["pt_up"] is not None and r["pt_up"] > 300:
        flags.append("analyst targets implausible (stale coverage)")

    why: list[str] = []
    # v1.3: verdict (judgment) is decided independently of role (held / ETF), so a held name with red flags shows red.
    role = "etf" if t in etfs else "held" if (r["held"] or 0) > 0 else None
    if role == "held":
        why.append(f"you hold {r['held']:.0f} shares")
    if t in etfs:
        color = "purple"
        why.append("ETF / market context: tracked for regime and sector moves, never peer-scored")
    elif len(flags) >= RED_FLAGS or (own is not None and street is not None and own < RED_BOTH and street < RED_BOTH):
        color = "red"
        why += flags or [f"weak to own ({own:.0f}) and analysts negative ({street:.0f})"]
    elif own is not None and street is not None and own >= GREEN_OWN and street >= GREEN_STREET and (r["credit"] is None and r["peer"] in LEVERED_FINANCIALS or (r["credit"] or 0) >= GREEN_CREDIT):
        color = "green"
        why.append(f"would happily own: OWN {own:.0f} (fund {r['fund'] or 0:.0f}, credit {r['credit'] if r['credit'] is not None else 'n/a (financial)'}), analysts supportive (STREET {street:.0f})")
    elif premium is not None and premium >= YELLOW_PREMIUM and (own or 0) >= YELLOW_OWN and (fit or 0) >= YELLOW_FIT and not flags:
        color = "yellow"
        if provisional:
            why.append("PROVISIONAL: IV captured outside market hours (both LSEG and Yahoo IV drift off-hours); re-check in session before tagging")
        why.append(f"wheel target: premium {premium:.0f} (IV {r['iv']:.0f}%, {f"{r['iv_rv']:.2f}× realized" if r['iv_rv'] is not None else 'no realized vol'}), ownable ({own:.0f}), {fit_why}")
    else:
        color = ""
        miss = []
        if own is not None and own < YELLOW_OWN:
            miss.append(f"OWN {own:.0f} < {YELLOW_OWN}")
        if premium is None:
            miss.append("no LSEG implied vol")
        elif premium < YELLOW_PREMIUM:
            miss.append(f"premium {premium:.0f} < {YELLOW_PREMIUM}")
        if fit is not None and fit < YELLOW_FIT:
            miss.append(fit_why)
        if flags:
            miss.append("flag: " + flags[0])
        why.append("watch-only: " + ("; ".join(miss) if miss else "nothing stands out"))
    if iv_note:
        why.append(iv_note)
    if r["earned"]:
        why.append(f"your history: {'+' if r['earned'] >= 0 else '−'}${abs(r['earned']):,.0f} earned over {r['fills'] or 0} fills")
    verdict = color
    return {"ticker": t, "color": "blue" if role == "held" else color, "verdict": verdict, "role": role, "inputs": r, "provisional": provisional and verdict == "yellow", "own": own, "street": street, "premium": premium, "fit": fit, "edge": edge,
            "flags": flags, "why": why, "peer": r["peer"]}


def compute(conn, tickers: list[str] | None = None) -> list[dict]:
    """Point-in-time inputs + fit-1.3 pillars for the scoring universe. fit_model_v14 (the live model) builds on this.
    Universe: Robinhood list snapshot (if present) ∪ app watchlist (user 1) ∪ holdings ∪ LSEG coverage ∪ the latest plan."""
    from datetime import datetime, timezone
    etfs = set(re.findall(r'"([A-Z.]+)"', (ROOT / "lib/db/src/etf-exclusions.ts").read_text()))
    snap = Path(__file__).with_name("out") / "rh_watchlists_20261004.json"
    rh_member: dict[str, list[str]] = {}
    if snap.exists():
        for ln, ts in json.load(open(snap))["lists"].items():
            for t in ts:
                rh_member.setdefault(t, []).append(ln)
    current = {r["ticker"]: r["color_tag"] or "" for r in rows(conn, "SELECT ticker, MAX(color_tag) color_tag FROM watchlist WHERE user_id = 1 GROUP BY 1")}
    held = {r["t"] for r in rows(conn, "SELECT DISTINCT UPPER(symbol) t FROM portfolio_positions WHERE snapshot_id = (SELECT MAX(id) FROM portfolio_snapshots)")}
    acct = rows(conn, "SELECT COALESCE(unleveraged_bp, buying_power)::float8 cash, buying_power::float8 margin FROM portfolio_account_summaries WHERE snapshot_id = (SELECT MAX(id) FROM portfolio_snapshots)")
    bp = {"cash": max(a["cash"] or 0 for a in acct), "margin": max(a["margin"] or 0 for a in acct)}
    cov = {r["ticker"] for r in rows(conn, "SELECT ticker FROM lseg_research.coverage WHERE label <> 'benchmark'")}
    planned = {r["ticker"] for r in rows(conn, "SELECT DISTINCT ticker FROM watchlist_sync.plan_items WHERE plan_id = (SELECT MAX(id) FROM watchlist_sync.plans)")}
    # 10-20: every name the option scanner can put on the Model List must be scored, else build_plan holds it back as
    # "not scored by the fit model" (29 of 133 put candidates were, e.g. TXN, ADI, DHR, UNP)
    scanned = {r["ticker"].upper() for r in rows(conn, "SELECT DISTINCT ticker FROM option_score_snapshots WHERE as_of >= CURRENT_DATE - 7")}
    universe = sorted(set(tickers) if tickers else set(rh_member) | set(current) | held | cov | planned | scanned)
    universe = [t for t in universe if t not in {"BRK.A", "NTDOY"}]
    now = datetime.now(timezone.utc)
    out = []
    for r in rows(conn, SQL, (universe,)):
        o = score(r, bp, etfs)
        out.append({**o, "computed_at": now, "current_color": NAME.get(current.get(o["ticker"], ""), current.get(o["ticker"], "")),
                    "rh_lists": rh_member.get(o["ticker"], [])})
    return out


def main() -> None:
    """Legacy fit-1.3 scoring (kept for reference/baseline). The daily pipeline runs fit_model_v14.py, which calls compute()."""
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tickers", default="")
    a = ap.parse_args()
    with connect() as conn:
        out = compute(conn, [t for t in a.tickers.split(",") if t] or None)
    from collections import Counter
    print(f"fit-1.3 (reference only, nothing written): scored {len(out)} ·", dict(Counter(o["color"] or "none" for o in out)))


if __name__ == "__main__":
    main()
