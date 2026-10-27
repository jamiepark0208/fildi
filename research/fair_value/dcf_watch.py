"""DCF v2 quick check on a few names (A283; Jamie 10-27: test on the watchlist before any universe run).
Per ticker: value range (P10/P50/P90, base pair), where the price sits, medians under each discount view, the growth
percentile the price implies, and the year-1 reinvestment check vs the filings. Uses the stored SEC base; --refresh
refetches the SEC facts for just these names.
Usage: scripts/watchlist_sync/.venv/bin/python research/fair_value/dcf_watch.py [--refresh] [TICKERS... | default watchlist]"""
import json
import sys
from datetime import date
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/watchlist_sync"))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/watchlist_sync/dcf"))
from build_plan import connect, rows
from engine import BaseRates, inputs, reverse, simulate
from financials import ttm_base

args = [a for a in sys.argv[1:] if not a.startswith("--")]
br = BaseRates()
with connect() as c:
    names = [a.upper() for a in args] or [r["t"] for r in rows(c, "SELECT DISTINCT UPPER(ticker) t FROM watchlist ORDER BY 1")]
    print(f"{'':6s} {'price':>7s} | {'P10':>6s} {'P50':>6s} {'P90':>6s} {'pct':>4s} | normal  base  implied  ltcma | price needs growth | yr1 reinvest model/actual")
    for t in names:
        try:
            if "--refresh" in sys.argv:
                b = ttm_base(c, t)
                c.execute("""INSERT INTO watchlist_sync.dcf_ttm_base (ticker, as_of, period_end, base) VALUES (%s,%s,%s,%s)
                             ON CONFLICT (ticker, as_of) DO UPDATE SET base = EXCLUDED.base""", (t, date.today(), b["revenue"]["end"], json.dumps(b)))
                c.commit()
            r = rows(c, "SELECT base FROM watchlist_sync.dcf_ttm_base WHERE ticker = %s ORDER BY as_of DESC LIMIT 1", (t,))
            if not r:
                print(f"{t:6s} no SEC base"); continue
            b = r[0]["base"]
            x = inputs(c, t, b)
            if x["sector"] in ("40", "60"):
                print(f"{t:6s} financial/REIT → sector method (not built)"); continue
            if x["m0"] <= 0:
                print(f"{t:6s} {x['price']:7.2f} | operating loss (margin {x['m0']:.0%}) → needs path-to-profit rule"); continue
            sim = simulate(x, br, n=3000)
            v = sim["vps"]
            sc = {k: float(np.median(simulate(x, br, n=1500, scenario=k)["vps"])) for k in ("normal", "base", "implied", "ltcma")}
            p10, p50, p90 = np.percentile(v, [10, 50, 90])
            u = reverse(x, br)
            vv = lambda k: (b.get(k) or {}).get("value") or 0.0
            nopat0 = x["m0"] * x["rev"] * (1 - x["tax0"])
            act = 1 - (vv("ocf") + vv("interest_expense") * (1 - x["tax0"]) - vv("capex") - vv("sbc")) / nopat0
            mod = sim["parts"]["reinv1"] / sim["parts"]["nopat1"]
            print(f"{t:6s} {x['price']:7.2f} | {p10:6.0f} {p50:6.0f} {p90:6.0f} P{(v < x['price']).mean() * 100:02.0f} | "
                  f"{sc['normal']:6.0f} {sc['base']:5.0f} {sc['implied']:7.0f} {sc['ltcma']:6.0f} | "
                  f"{'> P98' if u is None else f'P{u * 100:.0f}':>18s} | {mod:5.0%} / {act:4.0%}" + (f"  cons y1–3 {'/'.join(f'{g:+.0%}' for g in x['cons']['g'])}" if x.get("cons") else "  no consensus") + (f"  ⚠ {x['flags']}" if x.get("flags") else ""))
        except Exception as e:
            c.rollback(); print(f"{t:6s} failed: {str(e)[:70]}")
