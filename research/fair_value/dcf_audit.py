"""DCF v2 mechanics audit (A283): does the engine's year-1 cash flow match the company's actual TTM cash flow, and how
does the median value split into explicit years, terminal value and the equity bridge? Stored SEC base only (no fetch).
Actual FCFF = OCF + interest·(1 − t) − capex (OCF already carries ΔAR, ΔAP, deferred revenue, accruals, D&A, SBC add-back);
"ex-SBC" subtracts SBC so it matches the model, where SBC is an operating cost.
Usage: scripts/watchlist_sync/.venv/bin/python research/fair_value/dcf_audit.py AAPL MSFT ..."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/watchlist_sync"))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/watchlist_sync/dcf"))
from build_plan import connect, rows
from engine import BaseRates, inputs, simulate

br = BaseRates()
B = 1e9
with connect() as c:
    for t in sys.argv[1:]:
        b = rows(c, "SELECT base FROM watchlist_sync.dcf_ttm_base WHERE ticker = %s ORDER BY as_of DESC LIMIT 1", (t,))[0]["base"]
        v = lambda k: (b.get(k) or {}).get("value") or 0.0
        x = inputs(c, t, b)
        pr = x["cma"]["pairs"]["base"]
        r = simulate(x, br, n=1, fixed={"u_g": .5, "u_m": .5, "u_r": .5, "u_s": .5, "erp": pr["erp"], "g_T": pr["g_dist"]["mode"]})
        p = r["parts"]
        oi, tax = x["m0"] * x["rev"], x["tax0"]
        nopat0 = oi * (1 - tax)
        fcff_act = v("ocf") + v("interest_expense") * (1 - tax) - v("capex")
        fcff_ex = fcff_act - v("sbc")
        eq = p["ev"] - x["debt"] + x["cash"] - x["minority"]
        print(f"\n{t}  price {x['price']:.0f}  cap ${x['price']*x['shares']/B:,.0f}B  rev ${x['rev']/B:.1f}B  NOPAT0 ${nopat0/B:.1f}B  (price/NOPAT {x['price']*x['shares']/nopat0:.0f}×)")
        print(f"  actual TTM: OCF {v('ocf')/B:.1f}  capex {v('capex')/B:.1f}  D&A {v('da')/B:.1f}  SBC {v('sbc')/B:.1f}  → FCFF {fcff_act/B:.1f} (ex-SBC {fcff_ex/B:.1f}) "
              f"= reinvests {1 - fcff_ex / nopat0:.0%} of NOPAT")
        print(f"  model yr1:  NOPAT {p['nopat1']/B:.1f}  reinvest {p['reinv1']/B:.1f} ({p['reinv1']/p['nopat1']:.0%})  FCFF {p['fcff1']/B:.1f}   [g1 {x['g1'] if x['g1'] is None else round(x['g1'],3)}, WACC {r['path']['wacc1']:.1%}→{r['path']['waccT']:.1%}]")
        print(f"  value:      PV yrs1-10 {p['pv_explicit']/B:,.0f}  + PV TV {p['pv_tv']/B:,.0f} (TV = {p['tv_mult_nopat11']:.1f}× NOPAT₁₁, ÷{p['disc10']:.2f})  = EV {p['ev']/B:,.0f}"
              f"  − debt {x['debt']/B:.0f} + cash {x['cash']/B:.0f} − minority {x['minority']/B:.1f} = equity {eq/B:,.0f}  → ${eq/x['shares']:.0f}/sh")
        if x.get("flags"):
            print("  flags:", x["flags"])
