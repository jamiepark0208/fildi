"""Daily reflection (S014): what the market did, which of our ideas went wrong, what we missed, what the trader did, and whether
the option score ranks ideas better than chance once you hold implied volatility fixed.

Sections (one markdown per day, out/reflection/<date>.md; latest also out/reflection/report.md):
  1 market        SPY/QQQ/IWM, breadth and biggest movers across the price universe
  2 found, wrong  shown ideas (Model List sell_puts/sell_calls + top-decile option score) whose stock used ≥ half the strike cushion
  3 real, missed  top-half score ideas not shown that stayed safe, and L1/verify-blocked contracts that stayed safe
  4 trader        the day's filled Robinhood orders vs our score percentile, Model List, fit verdict and S011 setup; closes with P&L
  5 score check   per snapshot day, rank IC of option_score vs outcome, raw and with strike IV held fixed (METHODS #2/#3)
  6 tomorrow      dip (put) and rally (call) setups forming today on green/yellow names (S011 rule; display only)
  7 patterns      cumulative mistake log (out/reflection/log.csv, one row per date/kind/contract) counted by kind and trait

Outcome of an option idea before expiry = adverse stock move since the snapshot in implied-σ units (σ = strike IV · √(days/252)):
high-IV names don't "win" by construction (METHODS #1/#3). After expiry = premium kept ÷ premium. Cushion used = how much of the
entry OTM distance the stock has eaten (≥ 100% = in the money).

Read-only on DB tables. Today's prices come from the local API (Schwab live, 60s cache) when the nightly bar sync hasn't landed.
    .venv/bin/python analysis/daily_reflection.py [--date YYYY-MM-DD]
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import sys
import urllib.request
from collections import Counter, defaultdict
from datetime import date, datetime
from pathlib import Path
from statistics import mean, pstdev

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_plan import connect, rows  # noqa: E402
import setup as SU  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "out" / "reflection"
API = "http://127.0.0.1:8080/api/schwab/equity-prices"
WRONG_USED = 0.5      # stock ate ≥ half the cushion → "found but wrong"
SAFE_USED = 0.2       # stock used < 20% of the cushion (or moved away) → "stayed safe"
MIN_IC_N = 8          # ideas per (day, side) before an IC counts
BAD_SPOT = 0.15      # snapshot spot this far from that day's close → data error, not graded
LOG_FIELDS = ["date", "kind", "ticker", "side", "contract", "detail", "score", "pct", "setup", "dte", "earnings"]


# ── prices ──────────────────────────────────────────────────────────────────────────────────────────────────────────
def live_prices(tickers: list[str]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for i in range(0, len(tickers), 500):
        req = urllib.request.Request(API, data=json.dumps({"tickers": tickers[i:i + 500]}).encode(),
                                     headers={"content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                out.update(json.load(r)["prices"])
        except Exception as e:  # API down → reflection still runs on DB closes
            print(f"warn: live prices unavailable ({e}); using DB closes only")
            return {}
    return out


def price_series(conn, day: date) -> tuple[dict[str, list[tuple[date, float]]], dict[str, float], str]:
    """{ticker: [(date, close)…]} through `day` (live price appended when the DB has no bar for it), {ticker: day return}."""
    px: dict[str, list] = defaultdict(list)
    for r in rows(conn, """SELECT ticker, date, close::float8 c FROM prices_historical
                           WHERE date >= %s::date - 60 AND date <= %s AND close > 0 ORDER BY ticker, date""", (day, day)):
        px[r["ticker"]].append((r["date"], r["c"]))
    universe = sorted(t for t, s in px.items() if s[-1][0] >= day.fromordinal(day.toordinal() - 7))
    have_day = {t for t in universe if px[t][-1][0] == day}
    source = "DB closes"
    need = [t for t in universe if t not in have_day]
    if need and day == date.today():
        lp = live_prices(need)
        for t, q in lp.items():
            if q.get("price"):
                px[t].append((day, q["price"]))
                if q.get("changePercent") is not None:   # Schwab's prior close beats a missing / stale DB bar
                    _chg[t] = q["changePercent"] / 100
        source = f"DB closes + Schwab live for {len(lp)} names"
    day_ret = {}
    for t in universe:
        s = px[t]
        if s[-1][0] != day:
            continue
        day_ret[t] = _chg[t] if t in _chg else (s[-1][1] / s[-2][1] - 1 if len(s) > 1 else None)
    return px, {t: r for t, r in day_ret.items() if r is not None}, source


_chg: dict[str, float] = {}


def close_at(s: list[tuple[date, float]], d: date) -> tuple[date, float] | None:
    best = None
    for x in s:
        if x[0] <= d:
            best = x
    return best


def setup_of(s: list[tuple[date, float]]) -> dict | None:
    if len(s) < 21:
        return None
    last = s[-1][1]
    return {"ret5": last / s[-6][1] - 1, "above_low20": last / min(c for _, c in s[-20:]) - 1}


def setup_tag(side: str, c: dict | None) -> str:
    if not c:
        return "?"
    if side == "put":
        return "dip" if c["ret5"] <= SU.DIP_5D or c["above_low20"] <= SU.NEAR_LOW_20D else "no-dip"
    return "rally" if c["ret5"] >= SU.RALLY_5D else "no-rally"


# ── grading ─────────────────────────────────────────────────────────────────────────────────────────────────────────
def trading_days(s, a: date, b: date) -> int:
    return sum(1 for d, _ in s if a < d <= b)


def grade(idea: dict, s: list, day: date) -> dict | None:
    k, side, spot0 = idea["strike"], idea["side"], idea["spot"]
    end = min(day, idea["expiry"])
    c = close_at(s, end)
    if not c or c[0] <= idea["as_of"] or not spot0:
        return None
    spot = c[1]
    td = max(trading_days(s, idea["as_of"], c[0]), 1)
    sigma = (idea["iv"] or 0) * math.sqrt(td / 252)
    adverse = (spot0 - spot) / spot0 if side == "put" else (spot - spot0) / spot0
    cushion0 = (spot0 - k) / spot0 if side == "put" else (k - spot0) / spot0
    left = (spot - k) / spot if side == "put" else (k - spot) / spot
    used = 1 - left / cushion0 if cushion0 > 0 else (1.0 if left < 0 else 0.0)
    g = {"adverse_z": adverse / sigma if sigma > 0 else None, "used": used, "spot_now": spot, "itm": left < 0,
         "expired": idea["expiry"] <= day and c[0] == idea["expiry"]}
    if g["expired"] and idea["premium"]:
        intrinsic = max(k - spot, 0) if side == "put" else max(spot - k, 0)
        g["kept"] = (idea["premium"] - intrinsic) / idea["premium"]
    return g


def ranks(xs: list[float]) -> list[float]:
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    r = [0.0] * len(xs)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        for m in range(i, j + 1):
            r[order[m]] = (i + j) / 2
        i = j + 1
    return r


def corr(a: list[float], b: list[float]) -> float | None:
    if len(a) < 3:
        return None
    ma, mb = mean(a), mean(b)
    sa, sb = pstdev(a), pstdev(b)
    if sa == 0 or sb == 0:
        return None
    return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / (len(a) * sa * sb)


def ic_iv_fixed(score: list[float], iv: list[float], y: list[float]) -> tuple[float | None, float | None]:
    """Spearman IC of score vs y, and the same with IV rank partialled out of both (residual ranks)."""
    rs, ri, ry = ranks(score), ranks(iv), ranks(y)
    raw = corr(rs, ry)

    def resid(v, x):
        mx, mv = mean(x), mean(v)
        vx = sum((a - mx) ** 2 for a in x)
        b = sum((a - mx) * (c - mv) for a, c in zip(x, v)) / vx if vx else 0
        return [c - mv - b * (a - mx) for a, c in zip(x, v)]
    return raw, corr(resid(rs, ri), resid(ry, ri))


# ── data ────────────────────────────────────────────────────────────────────────────────────────────────────────────
def load(conn, day: date) -> dict:
    snaps = rows(conn, """SELECT ticker, side, as_of, strike::float8 strike, expiry, spot::float8 spot, premium::float8 premium,
                                 otm_pct::float8 otm, strike_iv::float8 iv, dte::float8 dte, option_score::float8 score,
                                 earnings_risk, earnings_days_out
                          FROM option_score_snapshots WHERE as_of < %s AND as_of >= %s::date - 30 AND option_score IS NOT NULL""",
                 (day, day))
    pct: dict[tuple, list] = defaultdict(list)
    for s in snaps:
        pct[(s["as_of"], s["side"])].append(s["score"])
    for s in snaps:
        xs = pct[(s["as_of"], s["side"])]
        s["pct"] = sum(x <= s["score"] for x in xs) / len(xs)
    # Model List: latest run of each day; idea → shown if its ticker/side sat in sell_puts / sell_calls
    shown = rows(conn, """SELECT DISTINCT ON (r.created_at::date, i.ticker, i.folder_key) r.created_at::date d, r.created_at, i.ticker,
                                 i.folder_key, i.contract FROM watchlist_sync.model_items i JOIN watchlist_sync.model_runs r ON r.id = i.run_id
                          WHERE i.folder_key IN ('sell_puts','sell_calls') AND r.created_at::date <= %s
                            AND r.id IN (SELECT MAX(id) FROM watchlist_sync.model_runs GROUP BY created_at::date)
                          ORDER BY r.created_at::date, i.ticker, i.folder_key""", (day,))
    blocked = rows(conn, """SELECT p.close_date, i.ticker, i.option_type side, i.strike::float8 strike, i.expiry, i.model_spot::float8 spot,
                                   i.model_premium::float8 premium, i.model_iv::float8 iv, i.l1_pass, i.verify_status, i.verify_checks
                            FROM watchlist_sync.plan_items i JOIN watchlist_sync.plans p ON p.id = i.plan_id
                            WHERE i.kind = 'option' AND (NOT i.l1_pass OR i.verify_status = 'fail') AND i.expiry >= %s::date - 7
                              AND p.close_date < %s""", (day, day))
    orders = rows(conn, """SELECT * FROM (SELECT DISTINCT ON (order_id) account, symbol, side, state, quantity::float8 q,
                                  avg_fill_price::float8 px, created_at, is_option, option_strike::float8 strike, option_expiration expiry,
                                  option_side, leg_effect
                           FROM portfolio_orders WHERE created_at >= %s::date - 30 ORDER BY order_id, snapshot_id DESC) o
                           WHERE state = 'filled' ORDER BY created_at""", (day,))
    fit = {r["ticker"]: r["verdict"] or "" for r in rows(conn, "SELECT ticker, verdict FROM watchlist_sync.fit_scores")}
    return {"snaps": snaps, "shown": shown, "blocked": blocked, "orders": orders, "fit": fit}


# ── report ──────────────────────────────────────────────────────────────────────────────────────────────────────────
def contract(x) -> str:
    return f"{x['strike']:g}{x['side'][0].upper()} {x['expiry']:%m/%d}"


def cushion(used: float) -> str:
    return f"moved away {-used:.0%}" if used < 0 else f"used {used:.0%}"


def fmt_pct(x, d=1):
    return "—" if x is None else f"{x:+.{d}%}"


def build(day: date) -> tuple[str, list[dict]]:
    with connect() as conn:
        px, day_ret, source = price_series(conn, day)
        D = load(conn, day)
    L: list[str] = [f"# Daily reflection — {day:%a %Y-%m-%d}", "",
                    f"Prices: {source}. Ideas: option_score_snapshots from the last 30 days, graded at today's close (or expiry). "
                    f"Method: `analysis/daily_reflection.py` header; study S014.", ""]
    _bad_note = len(L)
    log: list[dict] = []

    # 1 market
    L += ["## 1. Market", ""]
    idx = " · ".join(f"{t} {fmt_pct(day_ret.get(t), 2)}" for t in ("SPY", "QQQ", "IWM", "SMH", "IBIT") if t in day_ret)
    stocks = {t: r for t, r in day_ret.items() if t not in ("SPY", "QQQ", "IWM", "DIA")}
    up = sum(r > 0 for r in stocks.values())
    L += [f"{idx}. Breadth: {up}/{len(stocks)} up ({up / max(len(stocks), 1):.0%}); median {fmt_pct(sorted(stocks.values())[len(stocks) // 2] if stocks else None)}.", ""]
    srt = sorted(stocks.items(), key=lambda kv: kv[1])
    L += ["Biggest drops: " + ", ".join(f"{t} {r:+.1%}" for t, r in srt[:8]),
          "", "Biggest gains: " + ", ".join(f"{t} {r:+.1%}" for t, r in srt[::-1][:8]), ""]

    # grade every snapshot idea
    shown_days = defaultdict(set)
    for s in D["shown"]:
        shown_days[(s["ticker"], "put" if s["folder_key"] == "sell_puts" else "call")].add(s["d"])
    graded, bad_spot = [], {}
    for s in D["snaps"]:
        ref = close_at(px.get(s["ticker"], []), s["as_of"])
        if ref and ref[0] == s["as_of"] and s["spot"] and abs(s["spot"] / ref[1] - 1) > BAD_SPOT:   # snapshot priced off a stale / wrong spot
            bad_spot[(s["ticker"], s["as_of"])] = (s["spot"], ref[1])
            continue
        g = grade(s, px.get(s["ticker"], []), day)
        if g:
            s.update(g)
            s["shown"] = any(abs((d - s["as_of"]).days) <= 1 for d in shown_days.get((s["ticker"], s["side"]), ()))
            graded.append(s)
    latest = defaultdict(dict)   # latest snapshot per (ticker, side, expiry) → avoid counting one contract five times
    for s in graded:
        key = (s["ticker"], s["side"], s["expiry"], s["strike"])
        if key not in latest or latest[key]["as_of"] < s["as_of"]:
            latest[key] = s
    uniq = list(latest.values())

    def trait(s):
        return {"score": round(s["score"], 1), "pct": round(s["pct"], 2), "setup": setup_tag(s["side"], setup_of(
            [x for x in px.get(s["ticker"], []) if x[0] <= s["as_of"]])), "dte": round(s["dte"] or 0),
            "earnings": s.get("earnings_risk") or ""}

    for (t, d), (sp, cl) in sorted(bad_spot.items()):
        log.append({"date": day, "kind": "data_bad_spot", "ticker": t, "side": "", "contract": f"{d:%m/%d}",
                    "detail": f"snapshot spot {sp:.2f} vs close {cl:.2f}", "score": "", "pct": "", "setup": "", "dte": "", "earnings": ""})

    # 2 found, wrong
    found = [s for s in uniq if s["shown"] or s["pct"] >= 0.9]
    wrong = sorted([s for s in found if s["used"] >= WRONG_USED], key=lambda s: -s["used"])
    L += ["## 2. Found but wrong", "",
          f"{len(found)} shown or top-decile ideas still being graded; {len(wrong)} used ≥ {WRONG_USED:.0%} of the cushion "
          f"({sum(s['itm'] for s in found)} in the money).", ""]
    if wrong:
        L += ["| idea | from | score (pct) | shown | setup at entry | cushion used | move in σ | earnings |", "|---|---|---|---|---|---|---|---|"]
        for s in wrong[:15]:
            t = trait(s)
            L.append(f"| {s['ticker']} {contract(s)} | {s['as_of']:%m/%d} | {s['score']:.0f} ({s['pct']:.0%}) | {'yes' if s['shown'] else ''} | "
                     f"{t['setup']} | {s['used']:.0%} | {s['adverse_z']:+.1f} | {t['earnings'] or ''} |")
            log.append({"date": day, "kind": "found_wrong", "ticker": s["ticker"], "side": s["side"], "contract": contract(s),
                        "detail": f"used {s['used']:.0%}, {s['adverse_z']:+.1f}σ", **trait(s)})
        L.append("")

    prev = sorted({d for ser in px.values() for d, _ in ser if d < day})[-1:]
    if prev:
        n_prev = sum(1 for ser in px.values() if any(d == prev[0] for d, _ in ser))
        if n_prev < 0.9 * len(day_ret):
            L.insert(_bad_note, f"⚠ Data: only {n_prev}/{len(day_ret)} names have a {prev[0]:%m/%d} bar in prices_historical "
                                "(nightly sync gap); 5-day setups skip that day.\n")
    if bad_spot:
        L.insert(_bad_note, "⚠ Data: " + ", ".join(f"{t} {d:%m/%d} snapshot spot {a:.2f} vs close {b:.2f}" for (t, d), (a, b) in
                                                  sorted(bad_spot.items())) + f" (> {BAD_SPOT:.0%} off → not graded)\n")

    # 3 real, missed
    missed = sorted([s for s in uniq if not s["shown"] and s["pct"] >= 0.5 and s["used"] < SAFE_USED
                     and (s.get("kept", 1) >= 0.9)], key=lambda s: -s["score"])
    last_b: dict[tuple, dict] = {}   # one row per contract (it re-appears in every plan until expiry)
    for b in D["blocked"]:
        k = (b["ticker"], b["side"], b["strike"], b["expiry"])
        if k not in last_b or last_b[k]["close_date"] < b["close_date"]:
            last_b[k] = b
    safe_b, bad_b = [], []
    for b in last_b.values():
        b.update({"as_of": b["close_date"], "score": None})
        g = grade(b, px.get(b["ticker"], []), day)
        if g:
            b.update(g)
            (safe_b if g["used"] < SAFE_USED else bad_b if g["used"] >= WRONG_USED else []).append(b)
    L += ["## 3. Real but missed", "",
          f"{len(missed)} top-half ideas that weren't shown stayed safe (used < {SAFE_USED:.0%} of the cushion). Not a mistake by "
          "itself (most were never meant to be shown); it's a mistake when the shown ones did worse — see §5.", ""]
    if missed:
        L.append("Best scores not shown: " + ", ".join(f"{s['ticker']} {contract(s)} ({s['score']:.0f}, {cushion(s['used'])})" for s in missed[:10]))
        L.append("")
    L += [f"Blocked plan contracts (L1 or verify): {len(safe_b)} stayed safe, {len(bad_b)} used ≥ {WRONG_USED:.0%} "
          f"(the block was right). Expiry grades: `out/block_audit/report.md` (S013).", ""]

    # 4 trader
    todays = [o for o in D["orders"] if o["created_at"].date() == day]
    L += ["## 4. Your trades today", ""]
    if not todays:
        L += ["No filled orders loaded for this day.", ""]
    else:
        L += ["| time | acct | trade | fill | our score (pct) | Model List | fit | setup | cushion now |", "|---|---|---|---|---|---|---|---|---|"]
        snap_by = defaultdict(list)
        for s in D["snaps"]:
            snap_by[(s["ticker"], s["side"])].append(s)
        for o in todays:
            if not o["is_option"]:
                L.append(f"| {o['created_at']:%H:%M} | {o['account'][-4:]} | {o['side']} {o['q']:g} {o['symbol']} | {o['px']} | | | "
                         f"{D['fit'].get(o['symbol'], '')} | | |")
                continue
            side, t = o["option_side"], o["symbol"]
            if o["leg_effect"] == "close":
                op = [x for x in D["orders"] if x["is_option"] and x["leg_effect"] == "open" and x["symbol"] == t and x["strike"] == o["strike"]
                      and x["expiry"] == o["expiry"] and x["option_side"] == side and x["account"] == o["account"] and x["created_at"] < o["created_at"]]
                pnl = f"P&L {((op[-1]['px'] - o['px']) * 100 * o['q']):+.0f}$ (sold {op[-1]['px']})" if op else "opened > 30 d ago"
                L.append(f"| {o['created_at']:%H:%M} | {o['account'][-4:]} | close {o['q']:g} {t} {o['strike']:g}{side[0].upper()} {o['expiry']:%m/%d} | "
                         f"{o['px']} | | | | | {pnl} |")
                continue
            cand = sorted(snap_by.get((t, side), []), key=lambda s: s["as_of"])
            sc = cand[-1] if cand else None
            ser = px.get(t, [])
            st = setup_tag(side, setup_of([x for x in ser if x[0] < day]))
            spot = close_at(ser, day)
            left = None
            if spot:
                left = (spot[1] - o["strike"]) / spot[1] if side == "put" else (o["strike"] - spot[1]) / spot[1]
            score_txt = f"{sc['score']:.0f} ({sc['pct']:.0%})" if sc else "not scored"
            on_list = any(abs((d - day).days) <= 1 for d in shown_days.get((t, side), ()))
            L.append(f"| {o['created_at']:%H:%M} | {o['account'][-4:]} | sell {o['q']:g} {t} {o['strike']:g}{side[0].upper()} {o['expiry']:%m/%d} | "
                     f"{o['px']} | {score_txt} | "
                     f"{'yes' if on_list else ''} | {D['fit'].get(t, '')} | {st} | {fmt_pct(left)} OTM |")
            if sc is None or sc["pct"] < 0.5:
                log.append({"date": day, "kind": "trader_low_score" if sc else "trader_unscored", "ticker": t, "side": side,
                            "contract": f"{o['strike']:g}{side[0].upper()} {o['expiry']:%m/%d}", "detail": f"{o['account'][-4:]} @ {o['px']}",
                            "score": sc and round(sc["score"], 1), "pct": sc and round(sc["pct"], 2), "setup": st,
                            "dte": (o["expiry"] - day).days, "earnings": ""})
            if st in ("no-dip", "no-rally"):
                log.append({"date": day, "kind": f"trader_{st}", "ticker": t, "side": side,
                            "contract": f"{o['strike']:g}{side[0].upper()} {o['expiry']:%m/%d}", "detail": f"{o['account'][-4:]} @ {o['px']}",
                            "score": sc and round(sc["score"], 1), "pct": sc and round(sc["pct"], 2), "setup": st,
                            "dte": (o["expiry"] - day).days, "earnings": ""})
        L.append("")
        opens = [o for o in todays if o["is_option"] and o["leg_effect"] == "open"]
        names = Counter(o["symbol"] for o in opens)
        prem = sum(o["px"] * 100 * o["q"] for o in opens)
        L += [f"{len(opens)} opens, ${prem:,.0f} premium; concentration: " + ", ".join(f"{t} ×{n}" for t, n in names.most_common(4)) + ".", ""]

    # 5 score check
    L += ["## 5. Do the scores rank ideas? (relative check)", "",
          "Per snapshot day and side: Spearman IC of option_score vs safety (−adverse move in σ). Positive = higher scores stayed safer. "
          "“IV fixed” partials out strike IV (METHODS #2). Shown vs not: mean cushion used.", "",
          "| snapshot | side | n | IC raw | IC IV fixed | shown used | others used |", "|---|---|---|---|---|---|---|"]
    ics, ics_iv = [], []
    for (d, side) in sorted({(s["as_of"], s["side"]) for s in graded}):
        g = [s for s in graded if s["as_of"] == d and s["side"] == side and s["adverse_z"] is not None]
        if len(g) < MIN_IC_N:
            continue
        raw, ivf = ic_iv_fixed([s["score"] for s in g], [s["iv"] for s in g], [-s["adverse_z"] for s in g])
        sh = [s["used"] for s in g if s["shown"]]
        ot = [s["used"] for s in g if not s["shown"]]
        if raw is not None:
            ics.append(raw)
        if ivf is not None:
            ics_iv.append(ivf)
        L.append(f"| {d:%m/%d} | {side} | {len(g)} | {raw:+.2f} | {ivf:+.2f} | {f'{mean(sh):.0%} ({len(sh)})' if sh else '—'} | "
                 f"{mean(ot):.0%} |" if raw is not None and ivf is not None else f"| {d:%m/%d} | {side} | {len(g)} | — | — | | |")
    if ics:
        t = mean(ics_iv) / (pstdev(ics_iv) / math.sqrt(len(ics_iv))) if len(ics_iv) > 1 and pstdev(ics_iv) > 0 else None
        L += ["", f"Mean IC raw {mean(ics):+.2f}, IV fixed {mean(ics_iv):+.2f} over {len(ics_iv)} day-sides"
              + (f" (t {t:+.1f})" if t is not None else "") + ". Overlapping days share moves, so t overstates; "
              "no claim before ≥ 8 distinct expiries (METHODS #9)."]
    exp = [s for s in uniq if "kept" in s]
    if exp:
        def kept(xs):
            if not xs:
                return "—"
            return f"{mean(x > 0 for x in xs):.0%} won, median kept {sorted(xs)[len(xs) // 2]:.0%}, worst {min(xs):.0%} ({len(xs)})"
        L += ["", f"Expired so far: {len(exp)} contracts. Top-half score: {kept([s['kept'] for s in exp if s['pct'] >= 0.5])}; "
              f"bottom half: {kept([s['kept'] for s in exp if s['pct'] < 0.5])}."]
    L.append("")

    # 6 tomorrow
    L += ["## 6. Setups forming (S011 rule, display only)", ""]
    good = {t for t, v in D["fit"].items() if v in ("green", "yellow")}
    dips, rallies = [], []
    for t in sorted(good):
        c = setup_of(px.get(t, []))
        if c and px[t][-1][0] == day:
            if c["ret5"] <= SU.DIP_5D or c["above_low20"] <= SU.NEAR_LOW_20D:
                dips.append((t, c))
            elif c["ret5"] >= SU.RALLY_5D:
                rallies.append((t, c))
    L += ["Put setups (dip / near 20-day low): " + (", ".join(f"{t} {c['ret5']:+.0%} 5d, {c['above_low20']:.0%} off low"
                                                            for t, c in sorted(dips, key=lambda x: x[1]['ret5'])[:12]) or "none"), "",
          "Call setups (rally ≥ 3% in 5 days): " + (", ".join(f"{t} {c['ret5']:+.0%}" for t, c in
                                                             sorted(rallies, key=lambda x: -x[1]['ret5'])[:12]) or "none"), ""]
    return "\n".join(L), log


def update_log(day: date, new: list[dict]) -> list[dict]:
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / "log.csv"
    old = []
    if path.exists():
        with path.open() as f:
            old = [r for r in csv.DictReader(f) if r["date"] != str(day)]   # re-runs replace the day
    allr = old + [{k: ("" if r.get(k) is None else str(r.get(k))) for k in LOG_FIELDS} for r in new]
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=LOG_FIELDS)
        w.writeheader()
        w.writerows(allr)
    return allr


def patterns(log: list[dict]) -> str:
    days = sorted({r["date"] for r in log})
    L = ["## 7. Mistake patterns (cumulative)", "", f"{len(log)} logged rows over {len(days)} day(s) (`out/reflection/log.csv`).", ""]
    if not log:
        return "\n".join(L + ["Nothing logged yet."])
    by = Counter(r["kind"] for r in log)
    L += ["| kind | rows | days | top names | by setup | by side |", "|---|---|---|---|---|---|"]
    for k, n in by.most_common():
        rs = [r for r in log if r["kind"] == k]
        L.append(f"| {k} | {n} | {len({r['date'] for r in rs})} | "
                 f"{', '.join(f'{t}×{c}' for t, c in Counter(r['ticker'] for r in rs).most_common(4))} | "
                 f"{', '.join(f'{t or chr(63)} {c}' for t, c in Counter(r['setup'] for r in rs).most_common(3))} | "
                 f"{', '.join(f'{t} {c}' for t, c in Counter(r['side'] for r in rs).most_common())} |")
    fw = [r for r in log if r["kind"] == "found_wrong"]
    if fw:
        earn = sum(1 for r in fw if r["earnings"])
        nod = sum(1 for r in fw if r["setup"] in ("no-dip", "no-rally"))
        L += ["", f"Found-but-wrong traits: {nod}/{len(fw)} entered without the S011 setup; {earn}/{len(fw)} had an earnings flag."]
    L += ["", "Read a pattern only once a kind repeats on ≥ 5 different days; then pre-register a study (research/studies/README.md)."]
    return "\n".join(L)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--date", type=lambda s: datetime.strptime(s, "%Y-%m-%d").date(), default=date.today())
    a = ap.parse_args()
    body, new = build(a.date)
    log = update_log(a.date, new)
    text = body + "\n" + patterns(log) + "\n"
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{a.date}.md").write_text(text)
    (OUT / "report.md").write_text(text)
    print(text)


if __name__ == "__main__":
    main()
