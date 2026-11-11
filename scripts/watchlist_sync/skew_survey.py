"""Skew + spread survey (A192 Phase 0, Claude 10-19). LSEG has ATM IV only (no 25Δ history) and option_chain_history keeps the OTM band
around picks, so wings can't be priced for spreads / condors / strangles. This stores full strike ladders daily to fit
skew(moneyness, DTE, IV level) and the per-leg fill cost by moneyness.

Universe: liquid OI names ∪ Model List ∪ put-edge Q4+ (default ~180). Per name: next weekly ≥ 5 DTE + monthly ~30 DTE;
puts + calls within ±12 % (weekly) / ±25 % (monthly). One Schwab /chains call per ticker via localhost
/schwab/chain-ladder (100-rpm throttle). → optlab.skew_survey.

    .venv/bin/python skew_survey.py [--n 180]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "analysis"))
from build_plan import connect, rows  # noqa: E402

DDL = """CREATE TABLE IF NOT EXISTS optlab.skew_survey (
  as_of date NOT NULL, ticker text NOT NULL, expiry date NOT NULL, side text NOT NULL, strike double precision NOT NULL,
  spot double precision, bid double precision, ask double precision, mark double precision, iv double precision, delta double precision,
  oi integer, volume integer, quote_time timestamptz, PRIMARY KEY (as_of, ticker, expiry, side, strike))"""


def expiries(d: date) -> list[date]:
    from s049_panic_puts import third_friday
    fri = d + timedelta(days=(4 - d.weekday()) % 7)
    wk = fri if (fri - d).days >= 5 else fri + timedelta(days=7)
    ms = [third_friday(d.year + (d.month + k - 1) // 12, (d.month + k - 1) % 12 + 1) for k in range(3)]
    # A193: third Fridays sit 28 or 35 days apart, so a 15–45 DTE window has holes (e.g. 2027-01-01); ≤ 52 always holds one
    mo = min((m for m in ms if 15 <= (m - d).days <= 52), key=lambda m: abs((m - d).days - 30))
    return sorted({wk, mo})


def universe(conn, n: int) -> list[dict]:
    """Model List + put-edge Q4+ first (Structures CSP fuel), then top OI names up to n (+small overshoot)."""
    oi = rows(conn, """SELECT ticker, MAX(spot)::float8 spot, SUM(COALESCE(open_interest, 0))::float8 oi
                       FROM option_chain_history WHERE as_of >= CURRENT_DATE - 5
                       GROUP BY 1 ORDER BY 3 DESC NULLS LAST LIMIT 400""")
    by = {r["ticker"]: {"ticker": r["ticker"], "spot": r["spot"], "oi": r["oi"]} for r in oi}
    # Index ETFs always first (A192 11-07: forced lists crowded them out from 10-28 → SPY/QQQ holdout n=0).
    forced: list[str] = ["SPY", "QQQ", "IWM"]
    for r in rows(conn, """SELECT DISTINCT UPPER(ticker) ticker FROM watchlist_sync.plan_items
                           WHERE plan_id = (SELECT MAX(id) FROM watchlist_sync.plans) AND l1_pass"""):
        forced.append(r["ticker"])
    # Trade funnel (11-09, trade-funnel-plan step 3): every name priced cheaply first → chains only for its shortlist
    # (top K per family, put-edge already in its short-put score). Was all put-edge Q4+ (~350 names/day). Fallback = old list.
    from trade_funnel import chain_names
    funnel = chain_names(conn)
    if funnel:
        forced += funnel
        # forecast_ledger prices earnings skew from the day-before ladder → keep names reporting within 7 days
        forced += [r["t"] for r in rows(conn, """SELECT DISTINCT UPPER(ticker) t FROM earnings_calendar
                                                 WHERE report_date::date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7""")]
    else:
        for r in rows(conn, """SELECT ticker FROM watchlist_sync.put_edge_daily
                               WHERE as_of = (SELECT MAX(as_of) FROM watchlist_sync.put_edge_daily) AND quintile >= 4"""):
            forced.append(r["ticker"])
    # 11-11 (Jamie: TEAM 'sell put' with no strike): a fired live/candidate rule needs today's chain so Live can show a
    # provisional contract the day it can be traded (graded entry still prices off the next close).
    forced += [r["ticker"] for r in rows(conn, """SELECT DISTINCT s.ticker FROM watchlist_sync.strategy_signals s
                                                  JOIN watchlist_sync.strategies g USING (strategy_id)
                                                  WHERE s.status IN ('open', 'priced') AND g.status IN ('live', 'candidate')
                                                  AND s.as_of >= CURRENT_DATE - 7""")]
    out: list[dict] = []
    seen: set[str] = set()
    for t in forced:
        if t in seen:
            continue
        out.append(by.get(t) or {"ticker": t, "spot": None, "oi": 0.0})
        seen.add(t)
    for r in sorted(by.values(), key=lambda x: (-(x["oi"] or 0), x["ticker"])):
        if r["ticker"] in seen:
            continue
        if len(out) >= n:
            break
        out.append(r)
        seen.add(r["ticker"])
    need = [r["ticker"] for r in out if r.get("spot") is None]
    if need:
        px = {r["ticker"]: r["c"] for r in rows(conn, """SELECT DISTINCT ON (ticker) ticker, close::float8 c
              FROM prices_historical WHERE ticker = ANY(%s) ORDER BY ticker, date DESC""", (need,))}
        for r in out:
            if r.get("spot") is None:
                r["spot"] = px.get(r["ticker"])
    return [r for r in out if r.get("spot")]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=180)
    a = ap.parse_args()
    today = date.today()
    with connect() as conn:
        conn.execute(DDL)
        # ~10k rows/day (~3 MB): keep 400 days — enough for the skew/fill fit and a year of board history
        conn.execute("DELETE FROM optlab.skew_survey WHERE as_of < CURRENT_DATE - 400")
        names = universe(conn, a.n)
        exps = expiries(today)
        # one /chains call per ticker (10-19 audit: per-contract quotes = 224 calls / 138 s and ~12 % guessed strikes that don't exist)
        from concurrent.futures import ThreadPoolExecutor

        def fetch(job):
            t, sc = job
            req = urllib.request.Request("http://127.0.0.1:8080/api/schwab/chain-ladder",
                                         data=json.dumps({"ticker": t, "fromDate": str(exps[0]), "toDate": str(exps[-1]), "strikeCount": sc}).encode(),
                                         headers={"Content-Type": "application/json"})
            try:
                return job, json.load(urllib.request.urlopen(req, timeout=60))
            except Exception:  # noqa: BLE001
                return job, None

        # one /chains call per ticker for both expiries (10-19 audit: per-contract quotes 224 calls / 138 s; per-expiry 240 calls / 158 s —
        # the API's shared 100-rpm Schwab throttle is the floor, so fewer calls is the only lever). 4 in flight hides response latency;
        # the throttle still caps the rate, so the app's own calls keep their turn.
        jobs = [(n["ticker"], 50) for n in names]
        spots = {n["ticker"]: n["spot"] for n in names}
        got, fails, retried = 0, 0, 0
        # A386 (11-09): a busy app starves the batch lane → 60 s timeouts per name (11-09: 219 fails, 33 min). Failed names get
        # one retry pass at the end; a 12 min budget stops the step from eating the morning chain (normal run ≈ 3.5 min).
        t_end = time.time() + 12 * 60
        failed: list = []

        def results():
            nonlocal retried
            with ThreadPoolExecutor(4) as pool:
                for job, d in pool.map(lambda j: (j, None) if time.time() > t_end else fetch(j), jobs):
                    if d is None:
                        failed.append(job)
                    yield job, d
            retried = len(failed)
            with ThreadPoolExecutor(2) as pool:
                for job, d in pool.map(lambda j: (j, None) if time.time() > t_end else fetch(j), list(failed)):
                    yield job, d

        width = {str(e): 0.12 if (e - today).days <= 14 else 0.25 for e in exps}
        done: set = set()
        for (t, _), d in results():
            if d is None:
                continue
            done.add(t)
            spot = d.get("spot") or spots[t]
            batch = [(today, t, r["expiry"], r["side"], r["strike"], spot, r["bid"], r["ask"], r["mark"], r["iv"], r["delta"],
                      r["oi"], r["volume"], None)
                     for r in d["rows"] if r["expiry"] in width and r["bid"] is not None and abs(r["strike"] / spot - 1) <= width[r["expiry"]]]
            with conn.cursor() as cur:
                cur.executemany("""INSERT INTO optlab.skew_survey VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                                   ON CONFLICT (as_of, ticker, expiry, side, strike) DO UPDATE SET bid = EXCLUDED.bid, ask = EXCLUDED.ask,
                                   mark = EXCLUDED.mark, iv = EXCLUDED.iv, delta = EXCLUDED.delta, oi = EXCLUDED.oi,
                                   volume = EXCLUDED.volume, spot = EXCLUDED.spot""", batch)
            conn.commit()
            got += len(batch)
        fails = len(names) - len(done)
    print(f"skew_survey: {got} quotes · {len(names)} names ({fails} failed, {retried} retried) · expiries {', '.join(map(str, exps))}")


if __name__ == "__main__":
    main()
