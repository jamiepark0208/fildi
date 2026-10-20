"""Option structures board (A192, Claude 10-19). Prices 16 structures for ~120 names from today's REAL Schwab ladders
(optlab.skew_survey) with your realistic fills, ranks ≤ 5 names per structure, and logs every shown candidate to the forecast ledger
(qtype sim_structure) so each structure is graded at expiry. → watchlist_sync.structure_rank_daily → GET /api/options/structures.

Per candidate:
  fill      sell = bid + 23 % of spread, buy = ask − 23 % (RH median fill, state.md); net credit (+) / debit (−) per share
  capital   defined risk = max loss · CSP = strike · covered call / collar = spot · naked (strangle/straddle) = Reg-T 20 % rule
  p_mkt     P(profit at expiry) at the market's ATM IV (lognormal, zero drift)
  ev_rv     expected pnl at the stock's 20-day realized vol (same lognormal) — the S059 IV/RV edge in dollar form
  rank      regime-fit first, then ev_rv ÷ capital. A ticker appears in one structure only (its best), trim names get no bullish
            structure, earnings before expiry → excluded (S018: gap risk, edge not persistent per name).
Evidence badges come from the studies (S059, S020, S061, S018, S049); untested structures say so. Backtest: A192 Phase 2.

    .venv/bin/python structures.py [--no-log]
"""
from __future__ import annotations

import json
import math
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from build_plan import connect, rows  # noqa: E402

FILL = 0.23
TOP = 5
GRID = np.linspace(-5, 5, 801)          # standard-normal grid for terminal prices
W = np.exp(-GRID ** 2 / 2); W /= W.sum()

# id: (name, family, description, when it fits, evidence badge, evidence note)
CATALOG = {
    "csp": ("Cash-secured put", "short_premium", "Sell a ~0.20Δ put with cash set aside to buy 100 shares at the strike.",
            "You'd own the stock at the strike; IV rich vs realized; no earnings before expiry.", "pass",
            "S059 (Mon→Fri, net of fills): Q5 +22 bp/wk, breach 10.7 % vs ~14 %; Q1–Q3 lose after fills. S049 panic puts."),
    "covered_call": ("Covered call", "short_premium", "Sell a ~0.20Δ call against 100 shares you hold.",
                     "Flat-to-down tape on a holding you'd sell at the strike.", "fail",
                     "S061/S005: lost vs just holding in every 2024-07→ quintile (calls cap upside in a rising tape)."),
    "put_spread": ("Put credit spread (bull put)", "short_premium", "Sell a ~0.25Δ put, buy a ~0.10Δ put below: defined-risk CSP.",
                   "Mildly bullish, IV rich, want capped loss / less cash.", "fail",
                   "S020: on your 342 entries the wing cost ~55 % of the premium → −$17.5k vs plain CSPs."),
    "call_spread": ("Call credit spread (bear call)", "short_premium", "Sell a ~0.25Δ call, buy a ~0.10Δ call above.",
                    "Mildly bearish / capped upside, IV rich.", "untested", "No study yet (A192 Phase 2)."),
    "iron_condor": ("Iron condor", "short_premium", "Put credit spread + call credit spread: profit if the stock stays in a range.",
                    "Range-bound, IV rich vs realized, no event before expiry.", "untested", "No study yet (A192 Phase 2)."),
    "iron_fly": ("Iron butterfly", "short_premium", "Sell the ATM straddle, buy wings ~1σ away: max profit if the stock pins.",
                 "Very high IV, expect the stock to sit still.", "untested", "No study yet (A192 Phase 2)."),
    "jade_lizard": ("Jade lizard", "short_premium", "Sell a ~0.25Δ put + a call credit spread whose credit exceeds the call width.",
                    "Bullish-neutral, rich put skew; no upside risk if built right.", "untested", "No study yet (A192 Phase 2)."),
    "short_strangle": ("Short strangle", "short_premium", "Sell a ~0.16Δ put and a ~0.16Δ call (undefined risk).",
                       "Range-bound, IV very rich; margin account only.", "fail",
                       "S020: −$3.7k vs CSP on your entries, worst week −$3.2k."),
    "short_straddle": ("Short straddle", "short_premium", "Sell the ATM put and call (undefined risk).",
                       "Pinned stock, extreme IV; margin only.", "fail", "S020: −$46.9k vs CSP on your entries."),
    "long_call": ("Long call", "long_premium", "Buy a ~0.40Δ monthly call.", "Strong uptrend and cheap IV (IV ≤ realized).", "untested",
                  "No study yet. Prior: options usually overpriced (S057/S059) → negative on average."),
    "long_put": ("Long put", "long_premium", "Buy a ~0.40Δ monthly put.", "Downtrend / hedge, cheap IV.", "untested",
                 "No study yet. Prior: negative on average."),
    "long_straddle": ("Long straddle", "long_premium", "Buy the ATM monthly put and call: profit on a big move either way.",
                      "IV cheap vs realized before a catalyst.", "fail",
                      "S018: earnings moves priced ~1.5× too high → buying vol into earnings loses; outside events untested."),
    "long_strangle": ("Long strangle", "long_premium", "Buy ~0.25Δ monthly put and call.", "Cheap IV, expect a large move.", "untested",
                      "No study yet. Prior: negative on average."),
    "bull_call_spread": ("Bull call debit spread", "directional", "Buy a ~0.50Δ call, sell a ~0.25Δ call (monthly).",
                         "Uptrend, moderate IV; cheaper than a long call.", "untested", "No study yet (A192 Phase 2)."),
    "bear_put_spread": ("Bear put debit spread", "directional", "Buy a ~0.50Δ put, sell a ~0.25Δ put (monthly).",
                        "Downtrend / analysts cutting estimates.", "untested", "No study yet (A192 Phase 2)."),
    "calendar": ("Call calendar", "time", "Sell the weekly ATM call, buy the monthly ATM call: front decays faster.",
                 "Front IV ≥ back IV (event in front), stock expected to sit near the strike.", "untested",
                 "S059: IV term slope didn't predict put pnl; calendars untested."),
    "collar": ("Collar (hedge)", "hedge", "On 100 shares you hold: buy a ~0.20Δ monthly put, sell a ~0.20Δ call to pay for it.",
               "Protect a holding after a run-up / when credit is wide (S028).", "untested",
               "Judge by drawdown cut, not pnl (no study yet)."),
}
# calendar value depends on where back-month IV goes after the front expires; a fixed-IV pricer showed +155 % (IBM) → not ranked
UNRANKED = {"calendar"}
BULLISH = {"csp", "put_spread", "jade_lizard", "long_call", "bull_call_spread"}
BEARISH = {"long_put", "bear_put_spread", "call_spread"}


def ndtr(x):
    """Vectorized standard normal CDF (Abramowitz-Stegun 7.1.26, |err| < 1.5e-7); avoids a scipy dependency."""
    x = np.asarray(x, float)
    z = np.abs(x) / math.sqrt(2)
    t = 1 / (1 + 0.3275911 * z)
    y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * np.exp(-z * z)
    return 0.5 * (1 + np.sign(x) * y)


def leg_value(S, leg, t_left):
    k, iv = leg["strike"], max(leg["iv"] or 0.3, 0.05)
    if t_left <= 1e-6:
        return np.maximum(S - k, 0) if leg["side"] == "call" else np.maximum(k - S, 0)
    sd = iv * math.sqrt(t_left)
    d1 = (np.log(S / k) + 0.5 * sd * sd) / sd
    c = S * ndtr(d1) - k * ndtr(d1 - sd)
    return c if leg["side"] == "call" else c - S + k


def outcome(S0, legs, credit, sigma, t_front, back_left):
    """Distribution of pnl per share at the front expiry for a lognormal with vol sigma (zero drift)."""
    sd = sigma * math.sqrt(t_front)
    ST = S0 * np.exp(-0.5 * sd * sd + sd * GRID)
    v = np.zeros_like(ST)
    for lg in legs:
        left = back_left if lg["expiry"] != legs[0]["front"] else 0.0
        v += lg["qty"] * leg_value(ST, lg, left)
    return v + credit, ST   # qty: +1 long, −1 short; credit already net of fills


def main():
    today = date.today()
    with connect() as conn:
        last = conn.execute("SELECT MAX(as_of) FROM optlab.skew_survey").fetchone()[0]
        if last != today:   # Schwab down / survey skipped: keep yesterday's board (API shows its date) rather than re-stamp old quotes
            print(f"structures: skipped — latest skew survey is {last}, not today"); return
        q = rows(conn, """SELECT ticker, expiry, side, strike, spot, bid, ask, iv, delta FROM optlab.skew_survey
                          WHERE as_of = %s AND bid IS NOT NULL AND ask > 0""", (today,))
        rv, hist = {}, {}
        for t, cl in rows_closes(conn):
            if len(cl) >= 260:
                lr = np.diff(np.log(cl[-21:]))
                rv[t] = float(np.std(lr) * math.sqrt(252))
                hist[t] = np.log(np.asarray(cl[-505:], float))
        er = {r["ticker"]: r["d"] for r in rows(conn, """SELECT ticker, MIN(d) d FROM (
              SELECT ticker, event_date d FROM lseg_research.events WHERE event_type = 'EarningsReleases' AND event_date >= CURRENT_DATE
              UNION ALL SELECT UPPER(ticker), report_date::date FROM earnings_calendar WHERE report_date::date >= CURRENT_DATE) x GROUP BY 1""")}
        # 10-19: 32/120 survey names had no future date (IBM reports this week) → last report + 91 d, widened ±7 d at use
        for r in rows(conn, """SELECT ticker, MAX(report_date)::date d FROM lseg_research.earnings_moves GROUP BY 1"""):
            if r["ticker"] not in er and r["d"]:
                nxt = r["d"] + timedelta(days=91)
                while nxt < today - timedelta(days=7):
                    nxt += timedelta(days=91)
                er[r["ticker"]] = nxt - timedelta(days=7)   # conservative: treat the window as starting a week early
        held = {r["t"] for r in rows(conn, """SELECT UPPER(symbol) t FROM portfolio_positions WHERE snapshot_id = (SELECT MAX(id) FROM portfolio_snapshots)
                                             GROUP BY 1 HAVING SUM(quantity) >= 100""")}
        trim = {r["ticker"] for r in rows(conn, """SELECT ticker FROM watchlist_sync.plan_items WHERE plan_id = (SELECT MAX(id) FROM watchlist_sync.plans)
                                                  AND list_key = 'trim_risk' AND l1_pass""")}
        edge = {r["ticker"]: r["quintile"] for r in rows(conn, """SELECT ticker, quintile FROM watchlist_sync.put_edge_daily
                                                                 WHERE as_of = (SELECT MAX(as_of) FROM watchlist_sync.put_edge_daily)""")}
        trend = {r["ticker"]: r for r in rows(conn, "SELECT UPPER(ticker) ticker, price_vs_ma50_atr::float8 m50 FROM ticker_technicals")}
        chains = defaultdict(list)
        for r in q:
            chains[(r["ticker"], r["expiry"])].append(r)
        cands = []
        for t in sorted({r["ticker"] for r in q}):
            exps = sorted(e for (tt, e) in chains if tt == t)
            if len(exps) < 1 or t not in rv:
                continue
            for c in build_all(t, exps, chains, today, held):
                c.update(evaluate(c, rv[t], today, hist[t]))
                c["earnings"] = str(er[t]) if t in er and er[t] <= c["expiry_max"] else None
                c["edge_q"] = edge.get(t)
                c["fit"], c["fit_why"] = regime_fit(c, rv[t], trend.get(t), edge.get(t))
                cands.append(c)
        board = pick_board(cands, trim)
        conn.execute("""CREATE TABLE IF NOT EXISTS watchlist_sync.structure_rank_daily (
          as_of date NOT NULL, structure text NOT NULL, rank int NOT NULL, ticker text NOT NULL, payload jsonb NOT NULL,
          PRIMARY KEY (as_of, structure, rank))""")
        conn.execute("""CREATE TABLE IF NOT EXISTS watchlist_sync.structure_catalog (
          id text PRIMARY KEY, name text, family text, description text, regime text, evidence text, evidence_note text, updated_at timestamptz DEFAULT now())""")
        conn.execute("DELETE FROM watchlist_sync.structure_rank_daily WHERE as_of = CURRENT_DATE")
        for sid, (name, fam, desc, reg, ev, note) in CATALOG.items():
            conn.execute("""INSERT INTO watchlist_sync.structure_catalog (id, name, family, description, regime, evidence, evidence_note)
                            VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, family = EXCLUDED.family,
                            description = EXCLUDED.description, regime = EXCLUDED.regime, evidence = EXCLUDED.evidence,
                            evidence_note = EXCLUDED.evidence_note, updated_at = now()""", (sid, name, fam, desc, reg, ev, note))
        for sid, lst in board.items():
            for i, c in enumerate(lst, 1):
                conn.execute("INSERT INTO watchlist_sync.structure_rank_daily VALUES (CURRENT_DATE, %s, %s, %s, %s)",
                             (sid, i, c["ticker"], json.dumps(public(c), default=str)))
        n_log = 0 if "--no-log" in sys.argv else log_ledger(conn, board, today)
        conn.commit()
    shown = sum(len(v) for v in board.values())
    print(f"structures: {len(cands)} priced · {shown} shown across {sum(1 for v in board.values() if v)} structures · {n_log} ledger rows")
    for sid, lst in board.items():
        print(f"  {sid:17s} " + ", ".join(f"{c['ticker']} ev/cap {100 * c['ev_rv_cap']:+.1f}% p {c['p_mkt']:.0%}" for c in lst))


def rows_closes(conn):
    by = defaultdict(list)
    for t, c in conn.execute("""SELECT ticker, close::float8 FROM lseg_research.daily_history WHERE date >= CURRENT_DATE - 740 AND close > 0
                                ORDER BY ticker, date""").fetchall():
        by[t].append(c)
    return by.items()


def _pick(chain, side, target, below=None, above=None):
    xs = [r for r in chain if r["side"] == side and r["iv"]]
    if below is not None:
        xs = [r for r in xs if r["strike"] < below]
    if above is not None:
        xs = [r for r in xs if r["strike"] > above]
    if not xs:
        return None
    def dl(r):
        if r["delta"] is not None:
            return abs(r["delta"])
        return None
    xs = [r for r in xs if dl(r) is not None]
    return min(xs, key=lambda r: abs(dl(r) - target)) if xs else None


def _atm(chain, side):
    xs = [r for r in chain if r["side"] == side and r["iv"]]
    return min(xs, key=lambda r: abs(r["strike"] - r["spot"])) if xs else None


def _leg(r, qty, front):
    spr = r["ask"] - r["bid"]
    px = r["bid"] + FILL * spr if qty < 0 else r["ask"] - FILL * spr
    return {"side": r["side"], "strike": float(r["strike"]), "expiry": r["expiry"], "qty": qty, "iv": float(r["iv"]), "px": float(px),
            "bid": float(r["bid"]), "ask": float(r["ask"]), "front": front}


def build_all(t, exps, chains, today, held):
    wk = next((e for e in exps if 5 <= (e - today).days <= 14), None)
    mo = next((e for e in exps if 15 <= (e - today).days <= 45), None)
    out = []

    def add(sid, legs, extra=None):
        if not legs or any(lg is None for lg in legs):
            return
        front = min(lg["expiry"] for lg in legs)
        for lg in legs:
            lg["front"] = front
        spot = float(chains[(t, legs[0]["expiry"])][0]["spot"])
        out.append({"structure": sid, "ticker": t, "spot": spot, "legs": legs, "expiry": front,
                    "expiry_max": max(lg["expiry"] for lg in legs), **(extra or {})})

    for e, tag in ((wk, "weekly"), (mo, "monthly")):
        if not e:
            continue
        ch = chains[(t, e)]
        L = lambda side, d, q, **kw: (lambda r: _leg(r, q, e) if r else None)(_pick(ch, side, d, **kw))  # noqa: E731
        A = lambda side, q: (lambda r: _leg(r, q, e) if r else None)(_atm(ch, side))  # noqa: E731
        if tag == "weekly":
            sp = L("put", 0.20, -1); add("csp", [sp])
            if t in held:
                add("covered_call", [L("call", 0.20, -1)])
            s25p, s25c = L("put", 0.25, -1), L("call", 0.25, -1)
            if s25p:
                add("put_spread", [s25p, L("put", 0.10, +1, below=s25p["strike"])])
            if s25c:
                add("call_spread", [s25c, L("call", 0.10, +1, above=s25c["strike"])])
            if s25p and s25c:
                add("iron_condor", [s25p, L("put", 0.10, +1, below=s25p["strike"]), s25c, L("call", 0.10, +1, above=s25c["strike"])])
                add("jade_lizard", [s25p, s25c, L("call", 0.10, +1, above=s25c["strike"])])
            ap, ac = A("put", -1), A("call", -1)
            if ap and ac:
                add("short_straddle", [ap, ac])
                add("iron_fly", [ap, ac, L("put", 0.16, +1, below=ap["strike"]), L("call", 0.16, +1, above=ac["strike"])])
            add("short_strangle", [L("put", 0.16, -1), L("call", 0.16, -1)])
        else:
            add("long_call", [L("call", 0.40, +1)])
            add("long_put", [L("put", 0.40, +1)])
            add("long_straddle", [A("put", +1), A("call", +1)])
            add("long_strangle", [L("put", 0.25, +1), L("call", 0.25, +1)])
            b50c = L("call", 0.50, +1)
            if b50c:
                add("bull_call_spread", [b50c, L("call", 0.25, -1, above=b50c["strike"])])
            b50p = L("put", 0.50, +1)
            if b50p:
                add("bear_put_spread", [b50p, L("put", 0.25, -1, below=b50p["strike"])])
            if t in held:
                add("collar", [L("put", 0.20, +1), L("call", 0.20, -1)], {"stock": True})
    if wk and mo:
        fc, bc = _atm(chains[(t, wk)], "call"), _atm(chains[(t, mo)], "call")
        if fc and bc:
            same = min(chains[(t, mo)], key=lambda r: abs(r["strike"] - fc["strike"]) if r["side"] == "call" else 1e9)
            add("calendar", [_leg(fc, -1, wk), _leg(same, +1, mo)])
    return out


def empirical(S, logc, h):
    """Terminal prices from the stock's own h-day log returns over the last ~2 years (every window, de-meaned): keeps jumps and
    earnings gaps that a lognormal at realized vol misses (10-19 hand check: lognormal made short straddles look +15 %, S020 = −$46.9k)."""
    r = logc[h:] - logc[:-h]
    r = r - r.mean()
    return S * np.exp(r)


def evaluate(c, rv20, today, logc):
    legs = c["legs"]
    credit = -sum(lg["qty"] * lg["px"] for lg in legs)
    t_front = max((c["expiry"] - today).days, 1) / 365
    back_left = max((c["expiry_max"] - c["expiry"]).days, 0) / 365
    atm_iv = float(np.median([lg["iv"] for lg in legs]))
    S = c["spot"]
    pnl_m, ST = outcome(S, legs, credit, atm_iv, t_front, back_left)
    h = max(1, round((c["expiry"] - today).days * 5 / 7))
    SH = empirical(S, logc, h)
    pnl_r = credit + sum(lg["qty"] * leg_value(SH, lg, back_left if lg["expiry"] != c["expiry"] else 0.0) for lg in legs)
    if c.get("stock"):   # collar: include the shares
        pnl_m = pnl_m + (ST - S); pnl_r = pnl_r + (SH - S)
    # capital at risk per share
    sid = c["structure"]
    wide = np.linspace(S * 0.2, S * 3, 2000)
    pay = credit + sum(lg["qty"] * (np.maximum(wide - lg["strike"], 0) if lg["side"] == "call" else np.maximum(lg["strike"] - wide, 0))
                       for lg in legs if lg["expiry"] == c["expiry"])
    if sid == "csp":
        cap = legs[0]["strike"]
    elif sid in ("covered_call", "collar"):
        cap = S
    elif sid in ("short_strangle", "short_straddle"):
        cap = max(0.2 * S, 0.1 * S) + max(credit, 0)
    elif sid == "calendar":
        cap = max(-credit, 0.01)
    else:
        cap = max(-float(pay.min()), 0.01)
    return {"credit": round(credit, 3), "capital": round(cap, 2), "max_loss": round(float(-pay.min()), 2) if sid not in ("short_strangle", "short_straddle", "covered_call", "collar", "calendar", "csp") else None,
            "max_gain": round(float(pay.max()), 2) if sid not in ("long_call", "long_strangle", "long_straddle") else None,
            "p_mkt": float((W * (pnl_m > 0)).sum()), "p_rv": float(np.mean(pnl_r > 0)),
            "ev_mkt": round(float((W * pnl_m).sum()), 3), "ev_rv": round(float(np.mean(pnl_r)), 3),
            "ev_rv_cap": float(np.mean(pnl_r)) / cap, "worst5": round(float(np.percentile(pnl_r, 5)) / cap, 4), "atm_iv": round(atm_iv, 3), "rv20": round(rv20, 3), "iv_rv": round(atm_iv / max(rv20, 0.01), 2),
            "dte": (c["expiry"] - today).days}


def regime_fit(c, rv20, tech, q):
    fam = CATALOG[c["structure"]][1]
    ivrv = c["iv_rv"]
    up = tech and tech["m50"] is not None and tech["m50"] > 0
    if fam == "short_premium":
        ok = ivrv >= 1.15 and (q is None or q >= 4)   # A196: Q1–Q3 lose after fills
        return ok, f"IV/RV {ivrv:.2f}" + (f", put edge Q{q}" if q else "")
    if fam == "long_premium":
        ok = ivrv <= 0.95
        return ok, f"IV/RV {ivrv:.2f} ({'cheap' if ok else 'not cheap'})"
    if fam == "directional":
        bull = c["structure"] == "bull_call_spread"
        ok = (up if bull else (tech is not None and not up)) and ivrv <= 1.3
        return ok, f"{'above' if up else 'below'} 50-day, IV/RV {ivrv:.2f}"
    if fam == "time":
        return ivrv >= 1.0, f"IV/RV {ivrv:.2f}"
    return True, "hedge on a holding"


def pick_board(cands, trim):
    # evidence "fail" (S020 / S061 on your own trades) → described, never ranked as a recommendation
    ok = [c for c in cands if c["structure"] not in UNRANKED and CATALOG[c["structure"]][4] != "fail" and not c["earnings"] and not (c["structure"] in BULLISH and c["ticker"] in trim)
          and c["capital"] > 0 and math.isfinite(c["ev_rv_cap"])]
    # CSPs use the tested ranking (S059 put edge quintile) first; untested structures use EV from the stock's own history
    ok.sort(key=lambda c: (not c["fit"], -(c["edge_q"] or 0) if c["structure"] == "csp" else 0, -c["ev_rv_cap"]))
    board, used = {sid: [] for sid in CATALOG}, set()
    # best structure per ticker wins; a ticker shows once (Jamie: lists were confusing)
    for c in ok:
        if c["ticker"] in used or len(board[c["structure"]]) >= TOP or not c["fit"] or c["ev_rv"] <= 0:
            continue
        board[c["structure"]].append(c)
        used.add(c["ticker"])
    return board


def public(c):
    return {k: v for k, v in c.items() if k not in ("fit",)} | {"fit": c["fit"],
            "legs": [{k: lg[k] for k in ("side", "strike", "expiry", "qty", "px", "bid", "ask", "iv")} for lg in c["legs"]]}


def log_ledger(conn, board, today):
    from forecast_ledger import UPSERT
    # a re-run replaces today's picks: drop today's unresolved rows first so only what the board shows gets graded
    conn.execute("DELETE FROM watchlist_sync.forecast_ledger WHERE qtype = 'sim_structure' AND made_on = %s AND outcome IS NULL", (today,))
    n = 0
    for sid, lst in board.items():
        for c in lst:
            qid = f"struct:{sid}:{c['ticker']}:{c['expiry']}:{today}"
            meta = json.dumps({"structure": sid, "legs": public(c)["legs"], "credit": c["credit"], "spot": c["spot"],
                               "from": str(today), "stock": bool(c.get("stock"))}, default=str)
            for fc, p in (("market_iv", c["p_mkt"]), ("realized_vol", c["p_rv"])):
                conn.execute(UPSERT, (qid, f"Will the {CATALOG[sid][0]} on {c['ticker']} (exp {c['expiry']}) make money at expiry?",
                                      "sim_structure", c["ticker"], fc, round(p, 4), datetime.now(), today, c["expiry"], meta))
                n += 1
    return n


if __name__ == "__main__":
    main()
