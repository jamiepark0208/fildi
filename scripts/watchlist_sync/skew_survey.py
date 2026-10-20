"""Skew + spread survey (A192 Phase 0, Claude 10-19). LSEG has ATM IV only (no 25Δ history) and option_chain_history keeps the OTM band
around picks, so wings can't be priced for spreads / condors / strangles. This stores full strike ladders daily to fit
skew(moneyness, DTE, IV level) and the per-leg fill cost by moneyness.

Universe: ~120 names with the most open interest in option_chain_history (last 5 days). Per name: next weekly expiry ≥ 5 DTE and the
monthly (3rd Friday) nearest 30 DTE; puts + calls; every real strike within ±12 % (weekly) / ±25 % (monthly). One Schwab /chains call
per ticker via the API's localhost /schwab/chain-ladder (shares the app's 100-rpm throttle). → optlab.skew_survey.

    .venv/bin/python skew_survey.py [--n 120]
"""
from __future__ import annotations

import argparse
import json
import sys
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
    mo = min((m for m in ms if 15 <= (m - d).days <= 45), key=lambda m: abs((m - d).days - 30))
    return sorted({wk, mo})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=120)
    a = ap.parse_args()
    today = date.today()
    with connect() as conn:
        conn.execute(DDL)
        # ~10k rows/day (~3 MB): keep 400 days — enough for the skew/fill fit and a year of board history
        conn.execute("DELETE FROM optlab.skew_survey WHERE as_of < CURRENT_DATE - 400")
        names = rows(conn, """SELECT ticker, MAX(spot)::float8 spot FROM option_chain_history WHERE as_of >= CURRENT_DATE - 5
                              GROUP BY 1 ORDER BY SUM(COALESCE(open_interest, 0)) DESC LIMIT %s""", (a.n,))
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
        got, fails = 0, 0
        with ThreadPoolExecutor(4) as pool:
            width = {str(e): 0.12 if (e - today).days <= 14 else 0.25 for e in exps}
            for (t, _), d in pool.map(fetch, jobs):
                if d is None:
                    fails += 1
                    continue
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
    print(f"skew_survey: {got} quotes · {len(names)} names ({fails} failed) · expiries {', '.join(map(str, exps))}")


if __name__ == "__main__":
    main()
