"""Skew + spread survey (A192 Phase 0, Claude 10-19). LSEG has ATM IV only (no 25Δ history) and option_chain_history keeps the OTM band
around picks, so wings can't be priced for spreads / condors / strangles. This stores full strike ladders daily to fit
skew(moneyness, DTE, IV level) and the per-leg fill cost by moneyness.

Universe: ~120 names with the most open interest in option_chain_history (last 5 days). Per name: next weekly expiry ≥ 5 DTE and the
monthly (3rd Friday) nearest 30 DTE; puts + calls; strikes spot × (0.75 … 1.25) on the name's increment ladder (Schwab returns only
real strikes). Quotes via the API's localhost Schwab endpoint (≤ 200 contracts per call). → optlab.skew_survey.

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


def ladder(spot: float) -> list[float]:
    step = 0.5 if spot < 25 else 1 if spot < 75 else 2.5 if spot < 200 else 5 if spot < 600 else 10
    lo, hi = spot * 0.75, spot * 1.25
    k = (int(lo / step) + 1) * step
    out = []
    while k <= hi and len(out) < 40:
        out.append(round(k, 2)); k += step
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=120)
    a = ap.parse_args()
    today = date.today()
    with connect() as conn:
        conn.execute(DDL)
        names = rows(conn, """SELECT ticker, MAX(spot)::float8 spot FROM option_chain_history WHERE as_of >= CURRENT_DATE - 5
                              GROUP BY 1 ORDER BY SUM(COALESCE(open_interest, 0)) DESC LIMIT %s""", (a.n,))
        exps = expiries(today)
        want = [{"ticker": n["ticker"], "expiry": str(e), "strike": k, "type": s}
                for n in names for e in exps for s in ("put", "call") for k in ladder(n["spot"])]
        got = 0
        for i in range(0, len(want), 200):
            req = urllib.request.Request("http://127.0.0.1:8080/api/schwab/option-quotes", data=json.dumps({"contracts": want[i:i + 200]}).encode(),
                                         headers={"Content-Type": "application/json"})
            try:
                d = json.load(urllib.request.urlopen(req, timeout=120))
            except Exception as e:  # noqa: BLE001
                print(f"skew_survey: Schwab unavailable ({str(e)[:80]}) after {got} rows"); break
            batch = []
            for key, occ in d["symbols"].items():
                q = d["quotes"].get(occ)
                if not q or q.get("bid") is None:
                    continue
                t, e, k, s = key.split("|")
                dl = q.get("delta")
                batch.append((today, t, e, s, float(k), q.get("underlying"), q.get("bid"), q.get("ask"), q.get("mark"), q.get("iv"),
                              dl if dl is not None and abs(dl) <= 1 else None, q.get("openInterest"), q.get("volume"), q.get("quoteTime")))
            with conn.cursor() as cur:
                cur.executemany("""INSERT INTO optlab.skew_survey VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                                   ON CONFLICT (as_of, ticker, expiry, side, strike) DO UPDATE SET bid = EXCLUDED.bid, ask = EXCLUDED.ask,
                                   mark = EXCLUDED.mark, iv = EXCLUDED.iv, delta = EXCLUDED.delta, oi = EXCLUDED.oi, volume = EXCLUDED.volume,
                                   spot = EXCLUDED.spot, quote_time = EXCLUDED.quote_time""", batch)
            conn.commit()
            got += len(batch)
    print(f"skew_survey: {got} quotes · {len(names)} names · expiries {', '.join(map(str, exps))} · requested {len(want)}")


if __name__ == "__main__":
    main()
