"""Download backtest side inputs into a work dir: FRED AAA + GS10 history and Yahoo split history.

Usage (from repo root, scripts/watchlist_sync venv):
  WORK=/tmp/fv && mkdir -p $WORK
  scripts/watchlist_sync/.venv/bin/python research/fair_value/fetch_inputs.py $WORK
  scripts/watchlist_sync/.venv/bin/python research/fair_value/bt_load.py $WORK          # panel.pkl
  scripts/watchlist_sync/.venv/bin/python research/fair_value/bt_methods_blends.py $WORK
  scripts/watchlist_sync/.venv/bin/python research/fair_value/bt_anchor_convergence.py $WORK
  scripts/watchlist_sync/.venv/bin/python research/fair_value/scenarios.py
(needs DATABASE_URL; bt_load needs splits for the tickers with IBES history, fetched here)
"""
import json, os, sys, time, urllib.request, psycopg

W = sys.argv[1]
for sid in ("AAA", "GS10"):
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}&cosd=2019-01-01"
    open(f"{W}/fred_{sid}.csv", "wb").write(urllib.request.urlopen(url, timeout=20).read())
c = psycopg.connect(os.environ["DATABASE_URL"])
tickers = [r[0] for r in c.execute("SELECT DISTINCT ticker FROM wrds_research.ibes_statsum WHERE fpi='1'").fetchall()]
splits = {}
for t in tickers:
    req = urllib.request.Request(
        f"https://query1.finance.yahoo.com/v8/finance/chart/{t}?range=10y&interval=1mo&events=split",
        headers={"User-Agent": "Mozilla/5.0"})
    try:
        d = json.load(urllib.request.urlopen(req, timeout=15))
        ev = (d["chart"]["result"][0].get("events") or {}).get("splits") or {}
        splits[t] = [(v["date"], v["numerator"] / v["denominator"]) for v in ev.values()]
    except Exception:
        pass
    time.sleep(0.35)
json.dump(splits, open(f"{W}/splits.json", "w"))
print(f"fred AAA/GS10 + splits for {len(splits)} tickers → {W}")
