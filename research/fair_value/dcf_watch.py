"""DCF v2 quick check on a few names (A283; Jamie 10-27: test on the watchlist before any universe run).
Per ticker: value range (P10/P50/P90, base pair), where the price sits, medians under each discount view, the growth
percentile the price implies, and the year-1 reinvestment check vs the filings. Uses the stored SEC base; --refresh
refetches the SEC facts for just these names.
--store writes each name's assumptions, range, scenarios and reverse DCF to watchlist_sync.dcf_detail
(GET /api/fair-value/:ticker/dcf → Breakdown › Assumptions, A289); unvalued names store the reason.
Usage: scripts/watchlist_sync/.venv/bin/python research/fair_value/dcf_watch.py [--refresh] [--store] [TICKERS... | default watchlist]"""
import json
import sys
from datetime import date
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/watchlist_sync"))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/watchlist_sync/dcf"))
from build_plan import connect, rows
from engine import BaseRates, inputs, reinv_rates, reverse, simulate, unvalued
from financials import ttm_base

args = [a for a in sys.argv[1:] if not a.startswith("--")]
br = BaseRates()
VERSION = "dcf-2.0-lab"
DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.dcf_detail (ticker text NOT NULL, as_of date NOT NULL, version text NOT NULL,
         valued boolean NOT NULL, detail jsonb NOT NULL, PRIMARY KEY (ticker, as_of))"""


def store(c, t: str, valued: bool, d: dict) -> None:
    if "--store" not in sys.argv:
        return
    c.execute("""INSERT INTO watchlist_sync.dcf_detail VALUES (%s, %s, %s, %s, %s)
                 ON CONFLICT (ticker, as_of) DO UPDATE SET version = EXCLUDED.version, valued = EXCLUDED.valued, detail = EXCLUDED.detail""",
              (t, date.today(), VERSION, valued, json.dumps(d)))
    c.commit()


def detail(x: dict, b: dict, sim: dict, v, sc: dict, u: float | None) -> dict:
    """Every assumption with its value and source, for the Assumptions tab."""
    P, cons = sim["path"], x.get("cons")
    implied = None
    if u is not None:  # price-implied 5-y revenue CAGR at the reverse-DCF percentile
        f = simulate(x, br, n=1, fixed={"u_g": u, "u_m": u, "u_r": .5, "u_s": .5, "erp": x["cma"]["pairs"]["base"]["erp"],
                                        "g_T": x["cma"]["pairs"]["base"]["g_dist"]["mode"]})["path"]["g"]
        implied = float(np.prod([1 + g for g in f[:5]]) ** 0.2 - 1)
    sec = f"SEC filings TTM to {x['ttm_end']}"
    a = [("revenue_ttm", "Revenue (trailing 12 m)", x["rev"], "usd_total", sec),
         ("growth_y1_3", "Revenue growth yr 1 / 2 / 3", P["g"][:3], "pct_list",
          f"LSEG consensus FY1–FY3 ({cons['n'][0]:.0f} analysts), shrunk toward base rate by coverage; as of {cons['as_of']}" if cons
          else "Consensus FY1 growth; years 2–5 base rate (S112) — no multi-year consensus"),
         ("growth_y4_10", "Revenue growth yr 5 → yr 10", [P["g"][4], P["g"][9]], "pct_list", "Yr 4–5 half consensus / half base rate; yr 6–10 base rate → terminal (S113: consensus has no signal past yr 5)"),
         ("margin_now", "Operating margin now (GAAP)", x["m0"], "pct", sec),
         ("margin_y3", "Operating margin yr 3", P["margin"][2], "pct",
          "GAAP margin + consensus margin change × S115 realized share (0.9 losses / 0.35 / 0.1 above 20 %)" if cons and cons["dm"] is not None else "Base-rate margin path (S112)"),
         ("margin_y10", "Operating margin yr 10", P["margin"][9], "pct", "75 % own yr-3 margin / 25 % sector base rate"),
         ("tax", "Tax rate now → yr 10", [x["tax0"], P["tax"][9]], "pct_list", "3-y effective rate, halfway to 25 % marginal"),
         ("s2c", "Sales-to-capital (reinvestment)", P["s2c"], "x", "Own 3-y Δrevenue ÷ reinvestment, 25 % sector anchor" if x.get("s2c_own")
          else "Near-term Δrevenue ÷ net capex (capex − D&A), 25 % sector anchor" if x.get("s2c_capex") else "Sector base rate (no own history)"),
         ("sbc", "Stock pay ÷ revenue now", x["sbc0"], "pct", "SEC filings TTM; fades to the S114 10-y median for its level (GAAP margin gains the difference)"),
         ("beta", "Beta yr 1 → terminal", [sim["b0"], sim["bT"]], "x_list", "Blume-adjusted own beta → 0.8–1.2"),
         ("rf", "Risk-free rate", sim["rf"], "pct", f"cma_monthly base pair (10-y Treasury)"),
         ("erp", "Equity risk premium", P["erp"], "pct", "cma_monthly base (Damodaran implied / Kroll range)"),
         ("wacc", "WACC yr 1 → terminal", [P["wacc1"], P["waccT"]], "pct_list", f"Cost of debt {sim['kd']:.1%} (rating {x['rating']}), debt weight {sim['wd']:.0%}"),
         ("g_T", "Terminal growth", P["g_T"], "pct", "Breakeven inflation + CBO potential real growth, ≤ risk-free"),
         ("roicT", "Terminal return on new capital", P["roicT"], "pct", "Base-rate ROIC fade × own RONIC, ≥ WACC"),
         ("p_fail", "Failure probability", sim["p_fail"], "pct", "From rating / losses when debt > cash"),
         ("net_cash", "Cash − debt", x["cash"] - x["debt"], "usd_total", sec),
         ("shares", "Shares (cover page + unvested RSUs + in-the-money options)", x["shares"], "count",
          sec + ("; " + ", ".join(f"{k} {val / 1e6:,.1f}M" for k, val in x["dilution"].items()) if x.get("dilution") else ""))]
    a += [(f"claim:{k}", f"− {k}", val, "usd_total", sec + " (balance sheet / footnote)") for k, val in (x.get("claims") or {}).items()]
    a += [(f"asset:{k}", f"+ {k}", val, "usd_total", sec + " (balance sheet / footnote)") for k, val in (x.get("assets") or {}).items()]
    return {"price": x["price"], "p10": float(np.percentile(v, 10)), "p50": float(np.percentile(v, 50)), "p90": float(np.percentile(v, 90)),
            "price_pct": float((v < x["price"]).mean()), "scenarios": sc, "reverse": {"growth_pct": u, "implied_cagr5": implied},
            "assumptions": [{"key": k, "label": l, "value": val, "unit": un, "source": src} for k, l, val, un, src in a],
            "path": {"growth": P["g"], "margin": P["margin"], "fcff": P["fcff"]}, "tv_share": sim["tv_share"],
            "consensus_fy": cons["fy"] if cons else None, "flags": x.get("flags") or [], "version": VERSION,
            "risk": {"expensive": bool(np.percentile(v, 50) / x["price"] <= 0.38), "cutoff_vp": 0.38,
                     "read": "Value/price in the dearest 20 % (≤ 0.38): 2017–23, 24 % of such names fell ≥ 20 % within 6 months vs 13 % "
                             "of the rest, beyond implied vol and earnings yield (S116). Risk flag only — it did not predict returns."},
            "inputs_asof": {"ttm_end": x["ttm_end"], "consensus": cons["as_of"] if cons else None,
                            "cma": str(x["cma"].get("as_of")) if x["cma"].get("as_of") else None}}
with connect() as c:
    if "--store" in sys.argv:
        c.execute(DDL); c.commit()
    names = [a.upper() for a in args] or [r["t"] for r in rows(c, "SELECT DISTINCT UPPER(ticker) t FROM watchlist ORDER BY 1")]
    print(f"{'':6s} {'price':>7s} | {'P10':>6s} {'P50':>6s} {'P90':>6s} {'pct':>4s} | normal  base  implied  ltcma | price needs growth | yr1 reinvest model/actual")
    for t in names:
        try:
            if "--refresh" in sys.argv:
                b = ttm_base(c, t)
                if not b or not b.get("revenue"):
                    print(f"{t:6s} no SEC base"); store(c, t, False, {"reason": "No SEC filings base (foreign filer, ETF or not loaded)"}); continue
                c.execute("""INSERT INTO watchlist_sync.dcf_ttm_base (ticker, as_of, period_end, base) VALUES (%s,%s,%s,%s)
                             ON CONFLICT (ticker, as_of) DO UPDATE SET base = EXCLUDED.base""", (t, date.today(), b["revenue"]["end"], json.dumps(b)))
                c.commit()
            r = rows(c, "SELECT base FROM watchlist_sync.dcf_ttm_base WHERE ticker = %s ORDER BY as_of DESC LIMIT 1", (t,))
            if not r:
                print(f"{t:6s} no SEC base"); store(c, t, False, {"reason": "No SEC filings base (foreign filer, ETF or not loaded)"}); continue
            b = r[0]["base"]
            x = inputs(c, t, b)
            why = unvalued(x)
            if why:
                print(f"{t:6s} {x['price']:7.2f} | {why}")
                store(c, t, False, {"reason": why, "price": x["price"]}); continue
            sim = simulate(x, br, n=3000)
            v = sim["vps"]
            sc = {k: float(np.median(simulate(x, br, n=1500, scenario=k)["vps"])) for k in ("normal", "base", "implied", "ltcma")}
            p10, p50, p90 = np.percentile(v, [10, 50, 90])
            u = reverse(x, br)
            vv = lambda k: (b.get(k) or {}).get("value") or 0.0
            nopat0 = x["m0"] * x["rev"] * (1 - x["tax0"])
            act = 1 - (vv("ocf") + vv("interest_expense") * (1 - x["tax0"]) - vv("capex") - vv("sbc")) / nopat0
            mod = sim["parts"]["reinv1"] / sim["parts"]["nopat1"]
            rates, _ = reinv_rates(b.get("history") or {}, x["tax0"], {k: vv(k) for k in ("operating_income", "ocf", "capex", "sbc", "interest_expense")})
            act_m = float(np.median(rates)) if len(rates) >= 2 else act  # one year swings with working capital (PLTR, NOW deferred revenue)
            if abs(mod - act_m) > 0.15:  # A283 it2 bar → flag, not unvalued: as a gate it unvalued 26 of 31 names (10-29)
                x["flags"] = (x.get("flags") or []) + [f"reinvestment check: year-1 model {mod:.0%} of NOPAT vs {act_m:.0%} own {len(rates)}-y median in the filings (> 15 pts)"]
            store(c, t, True, detail(x, b, sim, v, sc, u))
            print(f"{t:6s} {x['price']:7.2f} | {p10:6.0f} {p50:6.0f} {p90:6.0f} P{(v < x['price']).mean() * 100:02.0f} | "
                  f"{sc['normal']:6.0f} {sc['base']:5.0f} {sc['implied']:7.0f} {sc['ltcma']:6.0f} | "
                  f"{'> P98' if u is None else f'P{u * 100:.0f}':>18s} | {mod:5.0%} / {act_m:4.0%}" + (f"  cons y1–3 {'/'.join(f'{g:+.0%}' for g in x['cons']['g'])}" if x.get("cons") else "  no consensus") + (f"  ⚠ {x['flags']}" if x.get("flags") else ""))
        except Exception as e:
            c.rollback(); print(f"{t:6s} failed: {str(e)[:70]}")
