"""Option structures board (A192, Claude 10-19). Prices 16 structures for today's REAL Schwab ladders
(optlab.skew_survey) with realistic fills → watchlist_sync.structure_rank_daily → GET /api/options/structures.

Tiers (payload.tier):
  primary  regime-fit + EV>0 · ≤ TOP · one ticker once · forecast_ledger
  more     soft IV/RV/edge floor · leftover tickers · ≤ TOP_MORE · not ledgered
  margin   short strangle/straddle (S076 pass but ret÷risk < CSP, margin-only) · ≤ TOP_MARGIN
  study    S076-fail structures · priced shapes · ≤ TOP_STUDY each · not recommendations

Pricing input = Schwab chain ladders in optlab.skew_survey (bid/ask/IV/delta by strike) — not a
25Δ risk-reversal "skew signal". Edge for ranking CSP/jade is mainly IV/RV rich + put-edge Q (S059).

Gates: trim → no bullish; earnings before expiry → out (S018). Backtest: A192 / S076.

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
import strategy_engine as SE  # noqa: E402  (A271: gates / inputs / put ladder / rank from strategy_rules.json)

FILL = 0.23
TOP = 10        # primary (strict regime-fit)
TOP_MORE = 15   # leftover tickers, softer IV/RV / edge floor
TOP_MARGIN = 8  # strangle/straddle (pass but margin-only / below CSP)
TOP_STUDY = 8   # per fail structure — priced examples
# Soft floors for tier=more (still need capital + finite EV + no earnings)
MORE_IVRV_SELL = 1.05   # short premium (strict fit uses 1.15)
MORE_IVRV_BUY = 1.05    # long premium (strict fit uses 0.95)
MORE_EDGE_Q = 3         # CSP prefer ≥3 when put-edge known (strict fit uses ≥4)
GRID = np.linspace(-5, 5, 801)          # standard-normal grid for terminal prices
W = np.exp(-GRID ** 2 / 2); W /= W.sum()

# id: (name, family, description, when it fits, evidence badge, evidence note)
CATALOG = {
    "csp": ("Cash-secured put", "short_premium", "Sell a weekly put with cash set aside to buy 100 shares at the strike — strike from the put ladder (default 0.08–0.10Δ; every band on the row).",
            "You'd own the stock at the strike; IV rich vs realized; no earnings before expiry.", "pass",
            "S059 (Mon→Fri, net of fills): Q5 +22 bp/wk, breach 10.7 % vs ~14 %; Q1–Q3 lose after fills. S049 panic puts."),
    "covered_call": ("Covered call", "short_premium", "Sell a ~0.20Δ call against 100 shares you hold.",
                     "Flat-to-down tape on a holding you'd sell at the strike.", "fail",
                     "S076: +0.12 %/trade vs holding the shares (t 1.6), 2024→ ≈ 0; S061: lost vs holding 2024-07→."),
    "put_spread": ("Put credit spread (bull put)", "short_premium", "Sell a ~0.25Δ put, buy a ~0.10Δ put below: defined-risk CSP.",
                   "Mildly bullish, IV rich, want capped loss / less cash.", "fail",
                   "S076: +0.40 %/trade but flips negative when far-OTM puts price 10 % richer; return÷risk 0.01 vs CSP 0.15. Wing eats the premium (S020)."),
    "call_spread": ("Call credit spread (bear call)", "short_premium", "Sell a ~0.25Δ call, buy a ~0.10Δ call above.",
                    "Mildly bearish / capped upside, IV rich.", "fail", "S076: −2.2 %/trade, t −2.4, both eras negative."),
    "iron_condor": ("Iron condor", "short_premium", "Put credit spread + call credit spread: profit if the stock stays in a range.",
                    "Range-bound, IV rich vs realized, no event before expiry.", "fail", "S076: −2.4 %/trade, t −2.3, both eras negative (wings cost more than they save)."),
    "iron_fly": ("Iron butterfly", "short_premium", "Sell the ATM straddle, buy wings ~1σ away: max profit if the stock pins.",
                 "Very high IV, expect the stock to sit still.", "fail", "S076: −1.8 %/trade, both eras negative."),
    "jade_lizard": ("Jade lizard", "short_premium", "Sell a ~0.25Δ put + a call credit spread whose credit exceeds the call width.",
                    "Bullish-neutral, rich put skew; no upside risk if built right.", "pass", "S076: +0.84 %/trade, t 6.5, 70 % win, worst 5 % −8.6 %, both eras; return÷risk 0.11 (CSP 0.15)."),
    "short_strangle": ("Short strangle", "short_premium", "Sell a ~0.16Δ put and a ~0.16Δ call (undefined risk).",
                       "Range-bound, IV very rich; margin account only.", "pass",
                       "S076: +2.4 %/trade on margin, t 6.9, worst 5 % −24 %; return÷risk 0.11 < CSP 0.15 → not ranked (CSP better, margin only)."),
    "short_straddle": ("Short straddle", "short_premium", "Sell the ATM put and call (undefined risk).",
                       "Pinned stock, extreme IV; margin only.", "pass", "S076: +2.6 %/trade on margin, t 5.2, worst 5 % −33 %; return÷risk 0.11 < CSP 0.15 → not ranked (CSP better, margin only)."),
    "long_call": ("Long call", "long_premium", "Buy a ~0.40Δ monthly call.", "Strong uptrend and cheap IV (IV ≤ realized).", "untested",
                  "S076: promising +14 %/trade when IV is cheap, but t 1.1, 28 % win, mostly 2024→ (bull tape)."),
    "long_put": ("Long put", "long_premium", "Buy a ~0.40Δ monthly put.", "Downtrend / hedge, cheap IV.", "fail",
                 "S076: −6.3 %/trade, 31 % win."),
    "long_straddle": ("Long straddle", "long_premium", "Buy the ATM monthly put and call: profit on a big move either way.",
                      "IV cheap vs realized before a catalyst.", "fail",
                      "S018: earnings moves priced ~1.5× too high → buying vol into earnings loses; outside events untested."),
    "long_strangle": ("Long strangle", "long_premium", "Buy ~0.25Δ monthly put and call.", "Cheap IV, expect a large move.", "fail",
                      "S076: +3 %/trade only at cheap pricing; flips negative when options price 10 % richer."),
    "bull_call_spread": ("Bull call debit spread", "directional", "Buy a ~0.50Δ call, sell a ~0.25Δ call (monthly).",
                         "Uptrend, moderate IV; cheaper than a long call.", "fail", "S076: −0.9 %/trade; 2021–23 −8 %, 2024→ +5 % (tape-dependent), flips with pricing."),
    "bear_put_spread": ("Bear put debit spread", "directional", "Buy a ~0.50Δ put, sell a ~0.25Δ put (monthly).",
                        "Downtrend / analysts cutting estimates.", "fail", "S076: −9.6 %/trade, both eras negative."),
    "calendar": ("Call calendar", "time", "Sell the weekly ATM call, buy the monthly ATM call: front decays faster.",
                 "Front IV ≥ back IV (event in front), stock expected to sit near the strike.", "fail",
                 "S076: −7.1 %/trade, t −4.1, both eras negative."),
    "collar": ("Collar (hedge)", "hedge", "On 100 shares you hold: buy a ~0.20Δ monthly put, sell a ~0.20Δ call to pay for it.",
               "Protect a holding after a run-up / when credit is wide (S028).", "fail",
               "S076: costs 1.05 %/month vs holding, t −3.3; cuts the worst 5 % to −10 %."),
}
# calendar: back-month IV path unknown under fixed-IV pricer → never show as a pick
UNRANKED = {"calendar"}
# S076 pass on margin, but ret÷risk < CSP → show as margin tier (not primary ledger)
MARGIN = {"short_strangle", "short_straddle"}
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
        if not last:
            print("structures: skipped — no skew_survey rows"); return
        # Price off the latest Schwab ladder day (not only calendar today). Weekend / missed
        # survey days still refresh the board; API as_of = survey day so UI can show stale.
        as_of = last if isinstance(last, date) else date.fromisoformat(str(last)[:10])
        if as_of != today:
            print(f"structures: using skew survey as_of={as_of} (no survey for {today})", flush=True)
        q = rows(conn, """SELECT ticker, expiry, side, strike, spot, bid, ask, iv, delta FROM optlab.skew_survey
                          WHERE as_of = %s AND bid IS NOT NULL AND ask > 0""", (as_of,))
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
        names = sorted({r["ticker"] for r in q})
        I = SE.load_inputs(conn, names)                      # A271: the same inputs on every row
        BM, BN = SE.band_states(conn, names)                 # A277 §8: sold-put band by market × stock state (band_engine)
        for t in names:
            b, why = SE.engine_put_band(BM, BN.get(t), I.get(t, {}).get("credit"))
            I.setdefault(t, {}).update(put_band=b, put_band_why=why, market_state=BM["state"], stock_state=(BN.get(t) or {}).get("state"))
        ivs = [v["iv_pctile"] for v in I.values() if v.get("iv_pctile") is not None]
        ctx = {"iv_median": float(np.median(ivs)) if ivs else None}
        ladder = SE.ladder_picks(conn)                       # S088 put ladder (1w) — the sold-put engine
        cands = []
        for t in names:
            exps = sorted(e for (tt, e) in chains if tt == t)
            if len(exps) < 1 or t not in rv:
                continue
            for c in build_all(t, exps, chains, as_of, held, ladder.get(t), I.get(t, {})):
                c.update(evaluate(c, rv[t], as_of, hist[t]))
                if c.get("s088"):   # one engine for sold puts: show the ladder model's numbers; keep the board's own as ev_board
                    c["ev_board"], c["p_board"] = c["ev_rv_cap"], c["p_rv"]
                    c["ev_rv_cap"] = c["s088"]["expPnlBpWk"] / 1e4
                    c["ev_rv"] = round(c["ev_rv_cap"] * c["capital"], 3)
                    c["p_rv"] = c["s088"]["pKept"]
                c["earnings"] = str(er[t]) if t in er and er[t] <= c["expiry_max"] else None
                c["edge_q"] = edge.get(t)
                c["inputs"] = I.get(t, {})
                desc = regime_fit(c, rv[t], trend.get(t), edge.get(t))[1]
                if SE.strategy_of(c["structure"]) == "none":
                    c["fit"], c["fit_why"] = regime_fit(c, rv[t], trend.get(t), edge.get(t))
                else:
                    ok, why = SE.fit(c, I, ctx)
                    c["fit"], c["fit_why"] = ok, desc + ("" if ok else " · " + "; ".join(why))
                cands.append(c)
        for sid in {c["structure"] for c in cands}:       # rank score per structure (rules file); CSP = S088 expected pnl
            cs = [c for c in cands if c["structure"] == sid]
            stg = SE.strategy_of(sid)
            k = SE.rank_key(cs, stg) if sid in ("long_call", "bull_call_spread") else {}
            for c in cs:
                c["_score"] = k.get(id(c), c["ev_rv_cap"])
        board = pick_board(cands, trim)
        conn.execute("""CREATE TABLE IF NOT EXISTS watchlist_sync.structure_rank_daily (
          as_of date NOT NULL, structure text NOT NULL, rank int NOT NULL, ticker text NOT NULL, payload jsonb NOT NULL,
          PRIMARY KEY (as_of, structure, rank))""")
        conn.execute("""CREATE TABLE IF NOT EXISTS watchlist_sync.structure_catalog (
          id text PRIMARY KEY, name text, family text, description text, regime text, evidence text, evidence_note text, updated_at timestamptz DEFAULT now())""")
        conn.execute("DELETE FROM watchlist_sync.structure_rank_daily WHERE as_of = %s", (as_of,))
        for sid, (name, fam, desc, reg, ev, note) in CATALOG.items():
            conn.execute("""INSERT INTO watchlist_sync.structure_catalog (id, name, family, description, regime, evidence, evidence_note)
                            VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, family = EXCLUDED.family,
                            description = EXCLUDED.description, regime = EXCLUDED.regime, evidence = EXCLUDED.evidence,
                            evidence_note = EXCLUDED.evidence_note, updated_at = now()""", (sid, name, fam, desc, reg, ev, note))
        for sid, lst in board.items():
            for i, c in enumerate(lst, 1):
                conn.execute("INSERT INTO watchlist_sync.structure_rank_daily VALUES (%s, %s, %s, %s, %s)",
                             (as_of, sid, i, c["ticker"], json.dumps(public(c), default=str)))
        n_log = 0 if "--no-log" in sys.argv else log_ledger(conn, board, as_of)
        conn.commit()
    shown = sum(len(v) for v in board.values())
    n_pri = sum(1 for v in board.values() for c in v if c.get("tier") == "primary")
    n_more = sum(1 for v in board.values() for c in v if c.get("tier") == "more")
    n_margin = sum(1 for v in board.values() for c in v if c.get("tier") == "margin")
    n_study = sum(1 for v in board.values() for c in v if c.get("tier") == "study")
    print(f"structures: {len(cands)} priced · {shown} shown (primary {n_pri} · more {n_more} · margin {n_margin} · study {n_study}) · {n_log} ledger rows")
    for sid, lst in board.items():
        if not lst:
            continue
        print(f"  {sid:17s} " + ", ".join(
            f"{c['ticker']}[{c.get('tier', '?')[:1]}] {100 * c['ev_rv_cap']:+.1f}%" for c in lst))


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


def build_all(t, exps, chains, today, held, ladder=None, inputs=None):
    wk = next((e for e in exps if 5 <= (e - today).days <= 14), None)
    mo = next((e for e in exps if 15 <= (e - today).days <= 52), None)  # A193: 45 left calendar holes
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
            # A271: CSP strike = the S088 put-ladder pick inside the band, priced on this real chain; every band's pick rides
            # along as `ladder` (no ladder pick → the listed put nearest the band middle).
            # A277 §8: the band comes from the band engine (market × stock state); panic → None → no CSP. No listed put in the
            # band → one band farther, then one band closer (≤ 0.20Δ); nothing there → no CSP (never drift further from the pick).
            band = inputs["put_band"] if "put_band" in (inputs or {}) else SE.put_band((inputs or {}).get("credit"))
            puts, used = [], band
            if band:
                order = SE.ENGINE["strategies"]["sell_put"]["strike"]["bands"]
                i = order.index(band)
                for j in [i] + [k for k in (i - 1, i + 1) if 0 <= k < len(order) and SE.band_bounds(order[k])[1] <= 0.20 + 1e-9]:
                    lo, hi = SE.band_bounds(order[j])
                    puts = [r for r in ch if r["side"] == "put" and r["iv"] and r["delta"] is not None and lo <= abs(r["delta"]) < hi]
                    if puts:
                        used = order[j]
                        break
            lp = (ladder or {}).get(used) if used else None
            lo, hi = SE.band_bounds(used) if used else (0, 0)
            # listed put nearest the band middle — the Model List's re-strike rule (build_plan.restrike_puts), so both surfaces pick
            # the same strike (A277); S088's within-band strike choice added nothing (hi−lo t ≈ 0), its numbers still ride along
            r = min(puts, key=lambda x: abs(abs(x["delta"]) - (lo + hi) / 2)) if puts else None
            if r:
                add("csp", [_leg(r, -1, e)], {"s088": lp, "band": used, "band_target": band, "band_why": (inputs or {}).get("put_band_why"),
                                              "restruck": used != SE.put_band(None), "ladder": ladder, "ladder_model": bool(lp)})
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
        return ok, f"IV/RV {ivrv:.2f}"  # edge quintile ranks CSPs; don't paint "Q5" on every why cell
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


def _clean(c, trim) -> bool:
    if c["structure"] in UNRANKED:
        return False
    # CSP: the S088 ladder model (walk-forward, real-fill haircut) decides; the board's own EV undervalues far puts (A271)
    ev_ok = c["ev_rv"] > 0
    if c["earnings"] or c["capital"] <= 0 or not math.isfinite(c["ev_rv_cap"]) or not ev_ok:
        return False
    if c["structure"] in BULLISH and c["ticker"] in trim:
        return False
    return True


def _soft_fit(c) -> bool:
    """Quality floor for tier=more — real IV/RV / edge, looser than regime_fit."""
    fam = CATALOG[c["structure"]][1]
    ivrv = c.get("iv_rv") or 0.0
    q = c.get("edge_q")
    if fam == "short_premium":
        if ivrv < MORE_IVRV_SELL:
            return False
        if c["structure"] == "csp" and q is not None and q < MORE_EDGE_Q:
            return False
        return True
    if fam == "long_premium":
        return ivrv <= MORE_IVRV_BUY
    if fam == "directional":
        return ivrv <= 1.35
    if fam == "time":
        return ivrv >= 0.95
    return True


def _n_tier(board, sid, tier: str) -> int:
    return sum(1 for x in board[sid] if x.get("tier") == tier)


def pick_board(cands, trim):
    """Primary → more → margin (strangle/straddle) → study (per fail structure). One ticker once."""
    board: dict[str, list] = {sid: [] for sid in CATALOG}
    used: set[str] = set()

    # —— primary: pass/untested, strict fit (not margin alts)
    primary_pool = [c for c in cands if _clean(c, trim) and c["structure"] not in MARGIN
                    and CATALOG[c["structure"]][4] in ("pass", "untested")]
    # CSP claims a ticker before other structures (S076 return÷risk 0.15 vs jade 0.11; its EV comes from the put ladder, a different model)
    primary_pool.sort(key=lambda c: (not c["fit"], c["structure"] != "csp", -(c["edge_q"] or 0) if c["structure"] == "csp" else 0, -c.get("_score", c["ev_rv_cap"])))
    for c in primary_pool:
        if not c["fit"] or c["ticker"] in used or _n_tier(board, c["structure"], "primary") >= TOP:
            continue
        board[c["structure"]].append({**c, "tier": "primary"})
        used.add(c["ticker"])

    # —— more: soft gate on leftover tickers, same pass/untested structures
    more_pool = [c for c in primary_pool if c["ticker"] not in used and _soft_fit(c)]
    more_pool.sort(key=lambda c: (-(c["edge_q"] or 0) if c["structure"] == "csp" else 0, -c.get("_score", c["ev_rv_cap"])))
    for c in more_pool:
        if c["ticker"] in used or _n_tier(board, c["structure"], "more") >= TOP_MORE:
            continue
        board[c["structure"]].append({**c, "tier": "more", "fit_why": (c.get("fit_why") or "") + " · soft gate"})
        used.add(c["ticker"])

    # —— margin: short strangle/straddle (S076 pass, below CSP on ret÷risk)
    margin_pool = [c for c in cands if _clean(c, trim) and c["structure"] in MARGIN and (c["fit"] or _soft_fit(c))]
    margin_pool.sort(key=lambda c: -c["ev_rv_cap"])
    for c in margin_pool:
        if c["ticker"] in used or _n_tier(board, c["structure"], "margin") >= TOP_MARGIN:
            continue
        board[c["structure"]].append({**c, "tier": "margin", "fit_why": (c.get("fit_why") or "") + " · margin (below CSP ret÷risk)"})
        used.add(c["ticker"])

    # —— study: each fail structure gets its own top names (may reuse tickers already on primary —
    #    so the lab shows many structure types, not only CSP/jade leftovers)
    for sid, meta in CATALOG.items():
        if meta[4] != "fail" or sid in UNRANKED:
            continue
        pool = [c for c in cands if c["structure"] == sid and _clean(c, trim)]
        pool.sort(key=lambda c: (c["ticker"] in used, -c["ev_rv_cap"]))
        seen_here: set[str] = set()
        for c in pool:
            if _n_tier(board, sid, "study") >= TOP_STUDY:
                break
            if c["ticker"] in seen_here:
                continue
            board[sid].append({**c, "tier": "study", "fit_why": (c.get("fit_why") or "priced") + " · study only (S076 fail)"})
            seen_here.add(c["ticker"])

    return board


def public(c):
    return {k: v for k, v in c.items() if k not in ("fit",)} | {"fit": c["fit"], "tier": c.get("tier") or "primary",
            "legs": [{k: lg[k] for k in ("side", "strike", "expiry", "qty", "px", "bid", "ask", "iv")} for lg in c["legs"]]}


def log_ledger(conn, board, today):
    from forecast_ledger import UPSERT
    # a re-run replaces today's picks: drop today's unresolved rows first so only what the board shows gets graded
    # scoped to this board's rows (question_id struct:…): the S081/S086/S088 paper arms share qtype sim_structure
    conn.execute("DELETE FROM watchlist_sync.forecast_ledger WHERE qtype = 'sim_structure' AND made_on = %s AND outcome IS NULL "
                 "AND question_id LIKE 'struct:%%'", (today,))
    n = 0
    for sid, lst in board.items():
        for c in lst:
            if c.get("tier", "primary") != "primary":
                continue  # grade only strict-fit primary picks
            qid = f"struct:{sid}:{c['ticker']}:{c['expiry']}:{today}"
            meta = json.dumps({"structure": sid, "legs": public(c)["legs"], "credit": c["credit"], "spot": c["spot"],
                               "from": str(today), "stock": bool(c.get("stock")), "tier": "primary"}, default=str)
            for fc, p in (("market_iv", c["p_mkt"]), ("realized_vol", c["p_rv"])):
                conn.execute(UPSERT, (qid, f"Will the {CATALOG[sid][0]} on {c['ticker']} (exp {c['expiry']}) make money at expiry?",
                                      "sim_structure", c["ticker"], fc, round(p, 4), datetime.now(), today, c["expiry"], meta))
                n += 1
    return n


if __name__ == "__main__":
    main()
