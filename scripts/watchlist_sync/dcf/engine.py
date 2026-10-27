"""DCF v2 engine prototype (A283, DCF_PLAN §A–§F): FCFF DCF with base-rate distributions, lifecycle cost of capital,
scenarios and a reverse DCF. Generic rules only (sector rules and stock overrides come later).
Per path (Monte Carlo, N draws):
  revenue  year 1 = consensus FY1 growth (LSEG, vs last FY); years 2–5 = base-rate 5-y CAGR for size × start growth at
           percentile u_g; years 6–10 = the matching 10-y base rate, fading to terminal g      (S112 base_rates_growth)
  margin   current operating margin → base-rate margin 5 y later for sector × start margin at u_m (ρ 0.5 with u_g)
  reinvest Δrevenue ÷ sales-to-capital (sector P25–P75)                                        (S112 base_rates_roic)
  tax      effective → 25 % marginal by year 10
  discount Ke = rf + β·ERP; β = Blume(own) for years 1–5 → clamp(β, 0.8, 1.2) by year 10; ERP ~ cma base triangular;
           Kd = rf + OAS(rating; synthetic from interest coverage when unrated); WACC on market weights
  terminal NOPAT₁₁ · (1 − g/ROIC_T) / (WACC_T − g); g ~ cma g_dist (breakeven + CBO potential real growth, ≤ rf); ROIC_T = base-rate ROIC 5 y
           later for sector × current ROIC, never below WACC_T
  failure  value × (1 − p): p from rating / losses when debt > cash; net-cash and profitable → 0.2 % (equity distress value = 0)
Usage: .venv/bin/python dcf/engine.py PLTR MU KO ..."""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_plan import connect, rows  # noqa: E402
from financials import ttm_base  # noqa: E402

BR = Path(__file__).resolve().parents[3] / "research/fair_value/out"
GICS = {"technology": "45", "fintech": "45", "healthcare": "35", "consumer_discretionary": "25", "consumer_staples": "30",
        "industrials": "20", "materials": "15", "energy": "10", "utilities": "55", "real_estate": "60",
        "financials": "40", "telecom": "50", "communication": "50"}
COMM_GROUPS = {"technology.consumer_internet_digital_media", "technology.big_tech_platforms"}
RATING_OAS = [("AAA", "oas_aaa"), ("AA", "oas_aa"), ("A", "oas_a"), ("BBB", "oas_bbb"), ("BB", "oas_bb"), ("B", "oas_b"), ("CCC", "oas_ccc")]
MOODY = {"Aaa": "AAA", "Aa": "AA", "A": "A", "Baa": "BBB", "Ba": "BB", "B": "B", "Caa": "CCC", "Ca": "CCC", "C": "CCC"}
# Damodaran synthetic rating from interest coverage (large firms)
COVERAGE = [(8.5, "AAA"), (6.5, "AA"), (4.25, "A"), (2.5, "BBB"), (2.0, "BB"), (1.25, "B"), (-1e9, "CCC")]
P_FAIL = {"AAA": 0.0, "AA": 0.002, "A": 0.004, "BBB": 0.01, "BB": 0.04, "B": 0.10, "CCC": 0.25}  # ~5–10-y default rates, rounded


PROBS = {9: [.02, .05, .1, .25, .5, .75, .9, .95, .98], 5: [.1, .25, .5, .75, .9], 3: [.25, .5, .75]}


def _q(points: list[float], probs: list[float] | None = None):
    v = np.array(points)
    p = np.array(probs or PROBS[len(points)])
    return lambda u: np.interp(u, p, v)


def _bucket(x: float, edges: list[float], labels: list[str]) -> str:
    for e, lab in zip(edges, labels):
        if x < e:
            return lab
    return labels[-1]


class BaseRates:
    def __init__(self):
        self.g = pd.read_pickle(BR / "base_rates_growth.pkl")
        self.m = pd.read_pickle(BR / "base_rates_margin.pkl")
        self.r = pd.read_pickle(BR / "base_rates_roic.pkl")

    def growth(self, size: float, g_start: float):
        sz = _bucket(size / 1e6, [2000, 10000, 50000, 1e18], ["1: $0.5-2B", "2: $2-10B", "3: $10-50B", "4: >$50B"])
        st = _bucket(g_start, [0, .05, .10, .20, .30, .50, 1e9], ["1: <0%", "2: 0-5%", "3: 5-10%", "4: 10-20%", "5: 20-30%", "6: 30-50%", "7: >50%"])
        row = self.g[(self.g["size"] == sz) & (self.g.start_growth == st)].iloc[0]
        return _q(json.loads(row.g5)), _q(json.loads(row.g10)), f"{sz} × {st}"

    def margin(self, sector: str, m0: float):
        """m5 = m0 × ratio (sector × margin bucket, ≥ 30 firms else the next bucket down); level-based below 5 % margin."""
        labels = ["1: <0%", "2: 0-5%", "3: 5-10%", "4: 10-20%", "5: 20-30%", "6: 30-40%", "7: 40-50%", "8: >50%"]
        st = _bucket(m0, [0, .05, .10, .20, .30, .40, .50, 1e9], labels)
        sec = self.m[self.m.gsector == sector]
        if m0 > 0.05:
            for lab in labels[labels.index(st)::-1]:
                row = sec[(sec.start_margin == lab) & (sec.n >= 30)]
                if not row.empty and isinstance(row.iloc[0].ratio5, str):
                    q = _q(json.loads(row.iloc[0].ratio5))
                    return (lambda u, q=q: np.minimum(m0 * q(u), 0.8)), f"sector {sector} × {lab} ratio"
        row = sec[sec.start_margin == st]
        if row.empty:
            return (lambda u: np.full_like(u, m0)), f"no base rate ({sector} {st}) → hold"
        return _q(json.loads(row.iloc[0].m5)), f"sector {sector} × {st} level"

    def roic_and_s2c(self, sector: str, roic0: float):
        st = _bucket(roic0, [0, .05, .10, .15, .25, .40, 1e9], ["1: <0%", "2: 0-5%", "3: 5-10%", "4: 10-15%", "5: 15-25%", "6: 25-40%", "7: >40%"])
        sec = self.r[self.r.gsector == sector]
        r1 = sec[sec.start_roic == st]
        tot = sec[sec.start_roic.isna()]
        roic = _q(json.loads(r1.iloc[0].roic5), [.25, .5, .75]) if not r1.empty else (lambda u: np.full_like(u, max(roic0, .08)))
        s2c = _q(json.loads(tot.iloc[0].sales_to_capital), [.25, .5, .75]) if not tot.empty else (lambda u: np.full_like(u, 1.0))
        return roic, s2c, f"sector {sector} × ROIC {st}"


def rating_letter(raw: str | None, coverage: float | None) -> tuple[str, str]:
    if raw:
        r = raw.strip()
        for k, v in sorted(MOODY.items(), key=lambda kv: -len(kv[0])):
            if r.startswith(k) and (len(r) == len(k) or r[len(k)] in "123"):
                return v, f"Moody's {r}"
        for letter in ("AAA", "AA", "A", "BBB", "BB", "B", "CCC"):
            if r.rstrip("+-") == letter:
                return letter, f"S&P/Fitch {r}"
    if coverage is None:
        return "AA", "no debt cost data → AA (net-cash default)"
    for edge, letter in COVERAGE:
        if coverage >= edge:
            return letter, f"synthetic from interest coverage {coverage:.1f}×"
    return "CCC", "synthetic"


def inputs(conn, t: str, base: dict | None = None) -> dict:
    if base is None:
        base = ttm_base(conn, t)
        conn.commit()
    v = lambda k: (base.get(k) or {}).get("value") or 0.0
    sig = rows(conn, """SELECT revenue_mean_fy1, fy1_period_end, issuer_rating FROM lseg_research.signals_daily
                        WHERE ticker = %s ORDER BY as_of DESC LIMIT 1""", (t,))
    tf = rows(conn, """SELECT f.beta, r.primary_peer_group_id g, (SELECT price FROM fair_value_snapshots s WHERE s.ticker = f.ticker
                       ORDER BY as_of DESC LIMIT 1) price FROM ticker_fundamentals f JOIN ticker_registry r ON r.ticker = f.ticker WHERE f.ticker = %s""", (t,))
    cma = rows(conn, "SELECT values, pairs FROM watchlist_sync.cma_monthly ORDER BY as_of DESC LIMIT 1")[0]
    s, f = (sig[0] if sig else {}), tf[0]
    rev = v("revenue")
    rev_fy = (base.get("revenue") or {}).get("fy_value") or rev
    fy1 = float(s["revenue_mean_fy1"]) if s.get("revenue_mean_fy1") else None
    g1 = (fy1 / rev_fy - 1) if fy1 and rev_fy > 0 and 0.3 < fy1 / rev_fy < 4 else None
    oi = v("operating_income") or (v("pretax_income") + v("interest_expense"))
    debt = v("debt_lt") + v("debt_current") + v("st_borrowings") + v("op_leases")
    cash = v("cash") + v("st_investments")
    ic = v("equity") + debt - cash
    pre = v("pretax_income")
    eff = v("tax") / pre if pre > 0 else 0.21
    gid = f["g"] or "unknown.x"
    sec = "50" if gid in COMM_GROUPS else GICS.get(gid.split(".")[0], "45")
    ie = v("interest_expense")
    if debt > 0 and (ie <= 0 or ie / debt < 0.015):  # tag mismatch (CHTR 13.7× coverage): vendor interest expense
        alt = rows(conn, "SELECT interest_expense FROM ticker_fundamentals WHERE ticker = %s", (t,))
        ie = float(alt[0]["interest_expense"] or 0) if alt else 0
    cov = oi / ie if ie > 0 else None
    ltg = rows(conn, """SELECT meanest FROM wrds_research.ibes_statsum WHERE UPPER(oftic) = %s AND measure = 'EPS' AND fpi = '0'
                        AND statpers >= CURRENT_DATE - 180 ORDER BY statpers DESC LIMIT 1""", (t,))
    letter, why = rating_letter(s.get("issuer_rating"), cov)
    return {"ticker": t, "price": float(f["price"]), "shares": v("shares"), "rev": rev, "rev_fy": rev_fy, "g1": g1,
            "fy1_end": str(s.get("fy1_period_end")), "ttm_end": (base.get("revenue") or {}).get("end"),
            "m0": oi / rev if rev else 0.0, "tax0": min(max(eff, 0.05), 0.30), "debt": debt, "cash": cash,
            "minority": v("minority"), "roic0": (oi * (1 - min(max(eff, 0.05), 0.30))) / ic if ic > 0 else 0.3,
            "beta": float(f["beta"] or 1.0), "sector": sec, "group": gid, "rating": letter, "rating_why": why,
            "ltg": float(ltg[0]["meanest"]) / 100 if ltg and ltg[0]["meanest"] is not None else None, "cma": cma}


def simulate(x: dict, br: BaseRates, n: int = 4000, seed: int = 0, fixed: dict | None = None, scenario: str = "base") -> dict:
    rng = np.random.default_rng(seed)
    fx = fixed or {}
    from scipy.stats import norm
    g1_ = x["g1"] if x["g1"] is not None else 0.05
    q5_, _, _ = br.growth(x["rev"], g1_)
    center = 0.5
    if x.get("ltg") is not None:  # analysts' long-term growth → its base-rate percentile, shrunk halfway (LTG optimism)
        grid = np.linspace(0.01, 0.99, 99)
        center = 0.5 + 0.5 * (float(np.interp(x["ltg"], q5_(grid), grid)) - 0.5)
    u_g = np.full(n, fx["u_g"]) if "u_g" in fx else np.clip(norm.cdf(norm.ppf(center) + rng.standard_normal(n)), 0.01, 0.99)
    z = rng.standard_normal(n)
    u_m = np.full(n, fx["u_m"]) if "u_m" in fx else norm.cdf(0.5 * norm.ppf(u_g) + math.sqrt(0.75) * z)
    u_r = np.full(n, fx.get("u_r", 0.5)) if "u_r" in fx else rng.uniform(0.02, 0.98, n)
    u_s = np.full(n, fx.get("u_s", 0.5)) if "u_s" in fx else rng.uniform(0.02, 0.98, n)
    pair = x["cma"]["pairs"][scenario if scenario in x["cma"]["pairs"] else "base"]
    rf = pair["rf"]
    if "erp" in fx:
        erp = np.full(n, fx["erp"])
    elif scenario == "base":
        d = pair["erp_dist"]; erp = rng.triangular(d["min"], d["mode"], d["max"], n)
    else:
        erp = np.full(n, pair["erp"])
    gd = pair["g_dist"]
    g_T = np.full(n, fx["g_T"]) if "g_T" in fx else rng.triangular(gd["min"], gd["mode"], gd["max"], n)

    g1 = x["g1"] if x["g1"] is not None else 0.05
    q5, q10, gwhy = br.growth(x["rev"], g1)
    qm, mwhy = br.margin(x["sector"], x["m0"])
    qr, qs, rwhy = br.roic_and_s2c(x["sector"], x["roic0"])
    r25, r10 = q5(u_g), q10(u_g)
    r610 = ((1 + r10) ** 10 / (1 + r25) ** 5) ** (1 / 5) - 1
    years = np.arange(1, 11)
    gr = np.zeros((n, 10))
    gr[:, 0] = g1 + (0 if fx else rng.normal(0, 0.2 * abs(g1) + 0.02, n))
    gr[:, 1:5] = r25[:, None]
    for k in range(5, 10):
        gr[:, k] = r610 + (g_T - r610) * ((k - 4) / 5)
    rev = x["rev"] * np.cumprod(1 + gr, axis=1)
    m_t = qm(u_m)
    w = np.clip(years / 5, 0, 1)
    margin = x["m0"] + (m_t[:, None] - x["m0"]) * w[None, :]
    tax = x["tax0"] + (0.25 - x["tax0"]) * (years / 10)
    nopat = rev * margin * (1 - tax)
    s2c = np.maximum(qs(u_s), 0.2)
    prev = np.c_[np.full(n, x["rev"]), rev[:, :-1]]
    reinv = (rev - prev) / s2c[:, None]
    fcff = nopat - reinv

    b0 = float(np.clip(0.67 * x["beta"] + 0.33, 0.6, 2.5))
    bT = float(np.clip(b0, 0.8, 1.2))
    beta = np.where(years <= 5, b0, b0 + (bT - b0) * (years - 5) / 5)
    oas = x["cma"]["values"].get(dict(RATING_OAS)[x["rating"]], 0.01)
    kd = rf + oas
    E = x["price"] * x["shares"]
    wd = min(x["debt"] / (x["debt"] + E), 0.6) if E > 0 else 0
    ke = rf + beta[None, :] * erp[:, None]
    wacc = (1 - wd) * ke + wd * kd * (1 - 0.25)
    disc = np.cumprod(1 + wacc, axis=1)
    pv = (fcff / disc).sum(axis=1)
    wT = wacc[:, -1]
    roicT = np.maximum(qr(u_r), wT)
    nopat11 = nopat[:, -1] * (1 + g_T)
    tv = nopat11 * (1 - g_T / roicT) / np.maximum(wT - g_T, 0.01)
    pv_tv = tv / disc[:, -1]
    ev = pv + pv_tv
    if x["cash"] >= x["debt"] and x["m0"] > 0:
        p_fail = 0.002
    else:
        p_fail = P_FAIL[x["rating"]] if x["m0"] > 0 else max(P_FAIL[x["rating"]], 0.15)
    equity = (ev - x["debt"] + x["cash"] - x["minority"]) * (1 - p_fail)
    vps = equity / x["shares"]
    return {"vps": vps, "tv_share": float(np.median(pv_tv / ev)), "why": {"growth": gwhy, "margin": mwhy, "roic": rwhy},
            "b0": b0, "bT": bT, "kd": kd, "wd": wd, "p_fail": p_fail, "rf": rf,
            "path": {"rev10": float(np.median(rev[:, -1])), "m_target": float(np.median(m_t)), "g25": float(np.median(r25)),
                     "wacc1": float(np.median(wacc[:, 0])), "waccT": float(np.median(wT))}}


def reverse(x: dict, br: BaseRates) -> float | None:
    """Growth percentile u_g the price implies, everything else at its median."""
    f = lambda u: float(simulate(x, br, n=1, fixed={"u_g": u, "u_m": u, "u_r": .5, "u_s": .5, "erp": x["cma"]["pairs"]["base"]["erp"],
                                                    "g_T": x["cma"]["pairs"]["base"]["g_dist"]["mode"]})["vps"][0]) - x["price"]
    lo, hi = 0.02, 0.98
    if f(lo) > 0:
        return lo
    if f(hi) < 0:
        return None  # price above our P98 growth outcome
    for _ in range(40):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if f(mid) < 0 else (lo, mid)
    return (lo + hi) / 2


def report(t: str, conn, br: BaseRates) -> None:
    x = inputs(conn, t)
    r = simulate(x, br)
    v = r["vps"]
    p10, p50, p90 = np.percentile(v, [10, 50, 90])
    pct = float((v < x["price"]).mean())
    g5 = br.growth(x["rev"], x["g1"] if x["g1"] is not None else 0.05)[0]
    scen = {s: float(np.median(simulate(x, br, n=2000, scenario=s)["vps"])) for s in ("implied", "normal", "kroll")}
    u = reverse(x, br)
    print(f"\n{t}  price {x['price']:.2f}  TTM rev ${x['rev']/1e9:.1f}B (to {x['ttm_end']})  FY1 growth "
          f"{'—' if x['g1'] is None else f'{x[chr(103)+chr(49)]:+.0%}'} (FY1 ends {x['fy1_end']})  op margin {x['m0']:.0%}  ROIC {x['roic0']:.0%}")
    if x.get("ltg") is not None:
        print(f"  analyst LTG {x['ltg']:+.0%} → growth draws centred on P{50 + 50 * (float(np.interp(x['ltg'], g5(np.linspace(.01, .99, 99)), np.linspace(.01, .99, 99))) - .5):.0f}")
    print(f"  value P10/P50/P90  {p10:.0f} / {p50:.0f} / {p90:.0f}   price sits at P{pct*100:.0f} of our distribution   TV {r['tv_share']:.0%} of EV")
    print(f"  scenarios (median): implied ERP {scen['implied']:.0f} · normal ERP {scen['normal']:.0f} · Kroll {scen['kroll']:.0f}")
    print(f"  path (median): years 2–5 growth {r['path']['g25']:+.1%} [{r['why']['growth']}], margin → {r['path']['m_target']:.0%} "
          f"[{r['why']['margin']}], WACC {r['path']['wacc1']:.1%} → {r['path']['waccT']:.1%} (β {r['b0']:.2f} → {r['bT']:.2f}; "
          f"debt {r['wd']:.0%} at {r['kd']:.1%}, {x['rating']} {x['rating_why']}), failure p {r['p_fail']:.1%}")
    from datetime import date as _d
    if x["ttm_end"] and (_d.today() - _d.fromisoformat(x["ttm_end"])).days > 150:
        print(f"  ⚠ newest SEC period ends {x['ttm_end']} (> 150 days): filings missing from companyfacts")
    if u is None:
        print("  reverse DCF: price needs more than our P98 growth path")
    else:
        print(f"  reverse DCF: price implies growth at P{u*100:.0f} of the base rate (years 2–5 ≈ {float(g5(np.array([u]))[0]):+.0%}/yr)")


DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.dcf_valuations (
  ticker text NOT NULL, as_of date NOT NULL, price double precision, p10 double precision, p50 double precision,
  p90 double precision, price_pct double precision, implied_growth_pct double precision, tv_share double precision,
  detail jsonb, PRIMARY KEY (ticker, as_of))"""
SKIP_SECTORS = {"40", "60"}  # banks/insurers/REITs → sector methods (DCF_PLAN §G), not FCFF


def universe(conn, br: BaseRates) -> None:
    from datetime import date as _d
    conn.execute(DDL)
    bases = rows(conn, """SELECT DISTINCT ON (ticker) ticker, base FROM watchlist_sync.dcf_ttm_base ORDER BY ticker, as_of DESC""")
    out = []
    for b in bases:
        t = b["ticker"]
        try:
            x = inputs(conn, t, b["base"])
            if x["sector"] in SKIP_SECTORS or x["rev"] <= 0 or x["shares"] <= 0 or not x["price"]:
                continue
            v = simulate(x, br, n=1000)["vps"]
            u = reverse(x, br)
        except Exception as e:
            print(t, "failed:", str(e)[:80]); conn.rollback(); continue
        p10, p50, p90 = np.percentile(v, [10, 50, 90])
        pct = float((v < x["price"]).mean())
        out.append({"ticker": t, "sector": x["sector"], "group": x["group"], "price": x["price"], "p50": p50, "pct": pct,
                    "u": u, "g1": x["g1"], "rev": x["rev"], "stale": bool(x["ttm_end"] and (_d.today() - _d.fromisoformat(x["ttm_end"])).days > 150)})
        conn.execute("""INSERT INTO watchlist_sync.dcf_valuations VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NULL, %s)
                        ON CONFLICT (ticker, as_of) DO UPDATE SET price = EXCLUDED.price, p10 = EXCLUDED.p10, p50 = EXCLUDED.p50,
                        p90 = EXCLUDED.p90, price_pct = EXCLUDED.price_pct, implied_growth_pct = EXCLUDED.implied_growth_pct, detail = EXCLUDED.detail""",
                     (t, _d.today(), x["price"], p10, p50, p90, pct, u, json.dumps({"g1": x["g1"], "ltg": x["ltg"], "m0": x["m0"], "rating": x["rating"]})))
        conn.commit()
    d = pd.DataFrame(out)
    d["vp"] = d.p50 / d.price
    print(f"\nvalued {len(d)} (financials/REITs skipped); stale filings {int(d.stale.sum())}")
    print(f"median value/price {d.vp.median():.2f}; price inside our P10–P90 {((d.pct > .1) & (d.pct < .9)).mean():.0%}; "
          f"above P90 {(d.pct >= .9).mean():.0%}; below P10 {(d.pct <= .1).mean():.0%}; reverse DCF > P98 {d.u.isna().mean():.0%}")
    d["gb"] = pd.cut(d.g1.fillna(0), [-9, 0, .1, .2, .5, 99], labels=["<0", "0-10%", "10-20%", "20-50%", ">50%"])
    d["sz"] = pd.cut(d.rev, [0, 2e9, 1e10, 5e10, 1e14], labels=["<$2B", "$2-10B", "$10-50B", ">$50B"])
    for k in ("sector", "gb", "sz"):
        g = d.groupby(k, observed=True).agg(n=("vp", "size"), vp=("vp", "median"), price_pct=("pct", "median"),
                                           above_p90=("pct", lambda s: (s >= .9).mean()))
        print(g.round(2).to_string())
    d.to_csv(Path(__file__).resolve().parents[3] / "research/fair_value/out/dcf_universe.csv", index=False)


if __name__ == "__main__":
    br = BaseRates()
    if "--universe" in sys.argv:
        with connect() as conn:
            universe(conn, br)
        sys.exit(0)
    with connect() as conn:
        for t in sys.argv[1:]:
            try:
                report(t.upper(), conn, br)
            except Exception as e:
                print(t, "failed:", e)
