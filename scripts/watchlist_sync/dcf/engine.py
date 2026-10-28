"""DCF v2 engine prototype (A283, DCF_PLAN §A–§F): FCFF DCF with base-rate distributions, lifecycle cost of capital,
scenarios and a reverse DCF. Generic rules only (sector rules and stock overrides come later).
Per path (Monte Carlo, N draws):
  revenue  with consensus (LSEG FY1–FY3, consensus_annual; 10-27 assessment fix a): years 1–3 = consensus revenue path
           interpolated to our TTM dates, ± analyst high/low, shrunk toward the base-rate path by n/(n + 3k);
           years 4–5 = half consensus year-3 growth, half base rate; years 6–10 = the 10-y base rate fading to terminal g
           (S113: consensus narrows years 1–3 spread ~9 %, years 4–10 not at all → ranges stay base-rate wide).
           Without: year 1 = FY1 growth, years 2–5 = base-rate 5-y CAGR for size × start growth at percentile u_g;
           years 6–10 = the matching 10-y base rate, fading to terminal g      (S112 base_rates_growth)
  margin   with consensus: GAAP margin + the consensus street-EBIT margin change from FY0 (street EBIT excludes SBC → only
           the change is used) × S115 pass-through (0.9 losses / 0.35 for 0–20 % / 0.1 above), rest base-rate path;
           then 75 % own year-3 margin / 25 % base rate from the year-3 level by year 10 (fix b).
           Without: current operating margin → base-rate margin 5 y later for sector × start margin at u_m (ρ 0.5 with u_g)
  reinvest Δrevenue ÷ sales-to-capital: the company's own 3-y Δrevenue ÷ Σ reinvestment (NOPAT − FCFF ex-SBC) from its
           filings, capped 0.3–8, blended with the sector P25–P75 when own history is missing or noisy  (audit 10-27:
           sector-only S2C made AAPL reinvest 80 % of NOPAT vs 1 % actual)
  tax      effective → halfway to 25 % marginal by year 10 (above 25 % → 25 %; fix c)
  discount Ke = rf + β·ERP; β = Blume(own) for years 1–5 → clamp(β, 0.8, 1.2) by year 10; ERP ~ cma base triangular;
           Kd = rf + OAS(rating; synthetic from interest coverage when unrated); WACC on market weights
  terminal NOPAT₁₁ · (1 − g/ROIC_T) / (WACC_T − g); g ~ cma g_dist (breakeven + CBO potential real growth, ≤ rf); ROIC_T = base-rate ROIC 5 y
           later for sector × current ROIC, never below WACC_T
  failure  value × (1 − p): p from rating / losses when debt > cash; net-cash and profitable → 0.2 %; net-cash loss-maker →
           2 % (FCF ≥ 0) / 5 % (≥ 3 y runway) / 15 % (equity distress value = 0)
  SBC      stock pay ÷ revenue fades to the S114 10-y median for its starting bucket; the saving lifts the GAAP margin
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
# S114 (Compustat 2006–19): median SBC ÷ revenue 10 y later by starting share — stock pay shrinks with scale
SBC_10Y = [(0.02, None), (0.05, 0.026), (0.10, 0.055), (0.20, 0.09), (9.0, 0.063)]
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
        self.mg = pd.read_pickle(BR / "base_rates_margin_gross.pkl")

    def growth(self, size: float, g_start: float):
        sz = _bucket(size / 1e6, [2000, 10000, 50000, 1e18], ["1: $0.5-2B", "2: $2-10B", "3: $10-50B", "4: >$50B"])
        st = _bucket(g_start, [0, .05, .10, .20, .30, .50, 1e9], ["1: <0%", "2: 0-5%", "3: 5-10%", "4: 10-20%", "5: 20-30%", "6: 30-50%", "7: >50%"])
        row = self.g[(self.g["size"] == sz) & (self.g.start_growth == st)].iloc[0]
        return _q(json.loads(row.g5)), _q(json.loads(row.g10)), f"{sz} × {st}"

    def margin(self, sector: str, m0: float, gm: float | None = None, fast: bool = False):
        """Tech/health/comm under 20 % margin with a gross margin: level by start margin × gross margin × growth (room to
        scale: 0–10 % margin at GM > 75 % → median 11–12 % in 5 y vs 4–5 % at GM < 40 %). Else m5 = m0 × ratio"""
        if gm is not None and sector in ("45", "35", "50") and m0 < 0.20:
            sm = _bucket(m0, [0, .10, .20], ["1: <0%", "2: 0-10%", "3: 10-20%"])
            gb = _bucket(gm, [.40, .60, .75, 9], ["1: GM<40%", "2: GM 40-60%", "3: GM 60-75%", "4: GM>75%"])
            row = self.mg[(self.mg.start_margin == sm) & (self.mg.gross == gb) & (self.mg.growth == ("fast" if fast else "slow"))]
            if not row.empty and row.iloc[0].n >= 25:
                q = _q(json.loads(row.iloc[0].m5))
                return (lambda u, q=q: np.maximum(q(u), m0 if m0 > 0 else -1)), f"{sm} × {gb} × {'fast' if fast else 'slow'}"
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


def own_s2c(h: dict, tax: float, ttm: dict | None = None) -> float | None:
    """Own sales-to-capital: Δrevenue over the last 3 fiscal years ÷ (median yearly reinvestment rate × NOPAT), with the
    TTM year included in the median. Reinvestment = NOPAT − FCFF ex-SBC (net capex + working capital, from the filings).
    Yearly rates swing with working capital and tax timing (AAPL), hence the median; < 15 % of NOPAT = asset-light → 8."""
    rev = h.get("revenue") or {}
    ends = sorted(rev)
    if len(ends) < 4:
        return None
    rates, nopats = [], []
    periods = [{k: (h.get(k) or {}).get(e) for k in ("operating_income", "ocf", "capex", "sbc", "interest_expense")} for e in ends[-3:]]
    if ttm:
        periods.append(ttm)
    for g in periods:
        if g["operating_income"] is None or g["ocf"] is None or g["capex"] is None or g["operating_income"] <= 0:
            continue
        nopat = g["operating_income"] * (1 - tax)
        fcff = g["ocf"] + (g["interest_expense"] or 0) * (1 - tax) - g["capex"] - (g["sbc"] or 0)
        rates.append((nopat - fcff) / nopat); nopats.append(nopat)
    if len(rates) < 2:
        return None
    rr = float(np.median(rates))
    d_rev = (rev[ends[-1]] - rev[ends[-4]]) / 3
    if rr < 0.15 or d_rev <= 0:
        return 8.0 if rr < 0.15 else None
    return float(np.clip(d_rev / (rr * float(np.mean(nopats))), 0.3, 8.0))


def _ibes_rows(conn, t: str, asof) -> list[dict]:
    """Point-in-time consensus (S116 backtest): IBES SAL/EBI FY1–FY3 at the last statpers ≤ asof, FY0 street actual
    announced by asof (wrds_research, research only). Same shape as consensus_annual rows; units cancel (ratios only)."""
    act = rows(conn, """SELECT pends, MAX(value) FILTER (WHERE measure = 'SAL') sal, MAX(value) FILTER (WHERE measure = 'EBI') ebi
                        FROM wrds_research.ibes_act_x WHERE oftic = %s AND anndats <= %s GROUP BY pends ORDER BY pends DESC LIMIT 1""", (t, asof))
    est = rows(conn, """SELECT DISTINCT ON (measure, fpi) measure, fpi, fpedats, meanest, highest, lowest, numest, statpers
                        FROM wrds_research.ibes_statsum WHERE oftic = %s AND measure IN ('SAL', 'EBI') AND fiscalp = 'ANN'
                        AND fpi IN ('1', '2', '3') AND statpers <= %s AND statpers > %s::date - 45 ORDER BY measure, fpi, statpers DESC""", (t, asof, asof))
    if not act or act[0]["sal"] is None:
        return []
    out = [{"fiscal_end": act[0]["pends"], "actual": True, "rev_avg": act[0]["sal"], "rev_low": None, "rev_high": None,
            "ebit_avg": act[0]["ebi"], "ebit_low": None, "ebit_high": None, "n_rev": None, "as_of": asof}]
    for f in ("1", "2", "3"):
        sa = next((e for e in est if e["measure"] == "SAL" and e["fpi"] == f), None)
        eb = next((e for e in est if e["measure"] == "EBI" and e["fpi"] == f), None)
        if sa:
            out.append({"fiscal_end": sa["fpedats"], "actual": False, "rev_avg": sa["meanest"], "rev_low": sa["lowest"], "rev_high": sa["highest"],
                        "ebit_avg": eb["meanest"] if eb else None, "ebit_low": eb["lowest"] if eb else None,
                        "ebit_high": eb["highest"] if eb else None, "n_rev": sa["numest"], "as_of": asof})
    return sorted(out, key=lambda q: q["fiscal_end"])


def consensus(conn, t: str, ttm_end: str | None, asof=None) -> dict | None:
    """Consensus revenue/margin path at our TTM dates (years 0–3): log-revenue and street margin interpolated in time
    between FY0 actual and FY1–FY3 means, extrapolated past FY3 at the FY2→FY3 rate. None without FY0 + 2 estimates.
    asof → IBES history instead of today's LSEG pull (backtest)."""
    r = _ibes_rows(conn, t, asof) if asof else rows(conn, """SELECT fiscal_end, actual, rev_avg, rev_low, rev_high, ebit_avg, ebit_low, ebit_high, n_rev, as_of
                      FROM watchlist_sync.consensus_annual WHERE ticker = %s AND source = 'lseg'
                      AND as_of = (SELECT max(as_of) FROM watchlist_sync.consensus_annual WHERE ticker = %s AND source = 'lseg')
                      ORDER BY fiscal_end""", (t, t))
    if not r:
        return None
    a = [q for q in r if q["actual"]]
    e = [q for q in r if not q["actual"] and q["rev_avg"] and q["rev_avg"] > 0 and (not a or q["fiscal_end"] > a[-1]["fiscal_end"])]
    if not a or not a[-1]["rev_avg"] or a[-1]["rev_avg"] <= 0 or len(e) < 2 or not ttm_end:
        return None
    pts = [a[-1]] + e
    ts = np.array([pd.Timestamp(q["fiscal_end"]).toordinal() for q in pts], float)
    lr = np.log([q["rev_avg"] for q in pts])
    have_m = all(q["ebit_avg"] is not None for q in pts)
    sm = np.array([q["ebit_avg"] / q["rev_avg"] for q in pts]) if have_m else None
    sd_r = np.array([0.0] + [math.log(q["rev_high"] / q["rev_low"]) / 4 if q["rev_low"] and q["rev_high"] and q["rev_low"] > 0 else 0.1 for q in e])
    sd_m = np.array([0.0] + [(q["ebit_high"] - q["ebit_low"]) / q["rev_avg"] / 4 if q["ebit_high"] is not None and q["ebit_low"] is not None else 0.03 for q in e])
    nn = np.array([0] + [q["n_rev"] or 1 for q in e], float)
    t0 = pd.Timestamp(ttm_end).toordinal()
    at = lambda arr, tt: float(np.interp(tt, ts, arr)) if tt <= ts[-1] else float(arr[-1] + (arr[-1] - arr[-2]) * (tt - ts[-1]) / (ts[-1] - ts[-2]))
    yrs = [t0 + 365.25 * k for k in range(4)]
    lv = np.array([at(lr, tt) for tt in yrs])
    out = {"g": np.exp(np.diff(lv)) - 1, "sd": np.array([max(at(sd_r, tt), 0.03 * k) for k, tt in enumerate(yrs)][1:]),
           "n": np.array([max(float(np.interp(min(tt, ts[-1]), ts, nn)), 1.0) for tt in yrs[1:]]),
           "dm": None, "sdm": None, "fy": [str(q["fiscal_end"]) for q in pts], "as_of": str(r[0]["as_of"])}
    out["n"][0] = max(out["n"][0], float(nn[1]))  # year 1 sits between FY0 (actual) and FY1 → FY1's coverage
    if have_m:
        m = np.array([at(sm, tt) for tt in yrs])
        out["dm"] = m[1:] - m[0]
        out["sm"] = m  # street-basis margin, years 0–3
        out["sdm"] = np.array([max(at(sd_m, tt), 0.01 * k) for k, tt in enumerate(yrs)][1:])
    return out


def inputs(conn, t: str, base: dict | None = None, pit: dict | None = None) -> dict:
    """pit = {"asof", "price", "beta", "rf"} → point-in-time inputs for the S116 backtest (IBES consensus, no LSEG
    signals / vendor sanity checks, which are today's); base must then be the as-of SEC base."""
    if base is None:
        base = ttm_base(conn, t)
        conn.commit()
    v = lambda k: (base.get(k) or {}).get("value") or 0.0
    sig = [] if pit else rows(conn, """SELECT revenue_mean_fy1, fy1_period_end, issuer_rating FROM lseg_research.signals_daily
                        WHERE ticker = %s ORDER BY as_of DESC LIMIT 1""", (t,))
    tf = rows(conn, """SELECT f.beta, r.primary_peer_group_id g, (SELECT price FROM fair_value_snapshots s WHERE s.ticker = f.ticker
                       ORDER BY as_of DESC LIMIT 1) price FROM ticker_registry r LEFT JOIN ticker_fundamentals f ON r.ticker = f.ticker WHERE r.ticker = %s""", (t,))
    cma = rows(conn, "SELECT as_of, values, pairs FROM watchlist_sync.cma_monthly ORDER BY as_of DESC LIMIT 1")[0]
    s, f = (sig[0] if sig else {}), dict(tf[0])
    if pit:
        f.update(price=pit["price"], beta=pit["beta"])
        cma = json.loads(json.dumps(cma, default=str))
        b = cma["pairs"]["base"]
        b["rf"] = pit["rf"]
        if pit.get("erp") is not None:  # shift the ERP triangle to the as-of implied ERP
            dlt = pit["erp"] - b["erp_dist"]["mode"]
            b["erp_dist"] = {k: v + dlt if isinstance(v, (int, float)) else v for k, v in b["erp_dist"].items()}
            b["erp"] = pit["erp"]
        b["g_dist"] = {k: min(v, pit["rf"]) if isinstance(v, (int, float)) else v for k, v in b["g_dist"].items()}  # terminal growth ≤ risk-free (DCF_PLAN §C)
    rev = v("revenue")
    rev_fy = (base.get("revenue") or {}).get("fy_value") or rev
    fy1 = float(s["revenue_mean_fy1"]) if s.get("revenue_mean_fy1") else None
    g1 = (fy1 / rev_fy - 1) if fy1 and rev_fy > 0 and 0.3 < fy1 / rev_fy < 4 else None
    oi = v("operating_income") or (v("pretax_income") + v("interest_expense"))
    # sanity vs vendor gold: one mis-scaled XBRL tag (BWXT operating leases $44.2B vs ~$44M) wipes out the equity
    gold = [] if pit else rows(conn, "SELECT total_debt FROM ticker_fundamentals WHERE ticker = %s", (t,))
    gold_debt = float(gold[0]["total_debt"] or 0) if gold else 0.0
    leases = v("op_leases") if v("op_leases") <= rev else 0.0
    debt_sec = v("debt_lt") + v("debt_current") + v("st_borrowings")
    flags = [] if v("op_leases") <= rev else ["leases > revenue → dropped"]
    if gold_debt > 0 and debt_sec > 3 * gold_debt + 1e9:
        debt_sec, flags = gold_debt, flags + ["SEC debt > 3× vendor → vendor"]
    debt = debt_sec + leases
    cash = v("cash") + v("st_investments") + v("lt_investments")  # non-operating assets in the equity bridge
    ic = v("equity") + debt - cash
    pre = v("pretax_income")
    eff = v("tax") / pre if pre > 0 else 0.21
    s2c_own = own_s2c(base.get("history") or {}, min(max(eff, 0.05), 0.30),
                      {k: v(k) for k in ("operating_income", "ocf", "capex", "sbc", "interest_expense")})
    gid = f["g"] or "unknown.x"
    sec = "50" if gid in COMM_GROUPS else GICS.get(gid.split(".")[0], "45")
    ie = v("interest_expense")
    if debt > 0 and (ie <= 0 or ie / debt < 0.015) and not pit:  # tag mismatch (CHTR 13.7× coverage): vendor interest expense
        alt = rows(conn, "SELECT interest_expense FROM ticker_fundamentals WHERE ticker = %s", (t,))
        ie = float(alt[0]["interest_expense"] or 0) if alt else 0
    cov = oi / ie if ie > 0 else None
    ltg = [] if pit else rows(conn, """SELECT meanest FROM wrds_research.ibes_statsum WHERE UPPER(oftic) = %s AND measure = 'EPS' AND fpi = '0'
                        AND statpers >= CURRENT_DATE - 180 ORDER BY statpers DESC LIMIT 1""", (t,))
    letter, why = rating_letter(s.get("issuer_rating"), cov)
    cons = consensus(conn, t, (base.get("revenue") or {}).get("end"), pit["asof"] if pit else None)
    if pit and cons:
        g1 = float(cons["g"][0])
    s2c_capex = None
    if s2c_own is None and rev > 0:  # loss years / no history: Δrevenue at the near-term growth rate ÷ net capex (no working capital)
        g_near = float(cons["g"][0]) if cons else g1
        if g_near is not None and g_near > 0 and v("capex"):
            net_capex = v("capex") - v("da")
            s2c_capex = 8.0 if net_capex <= 0.01 * rev else float(np.clip(g_near * rev / net_capex, 0.3, 8.0))
    fcf = v("ocf") - v("capex")
    return {"ticker": t, "price": float(f["price"]), "shares": v("shares"), "rev": rev, "rev_fy": rev_fy, "g1": g1,
            "fy1_end": str(s.get("fy1_period_end")), "ttm_end": (base.get("revenue") or {}).get("end"),
            "m0": oi / rev if rev else 0.0,
            "gm": (v("gross_profit") or (rev - v("cost_of_revenue") if v("cost_of_revenue") else 0)) / rev if rev and (v("gross_profit") or v("cost_of_revenue")) else None, "tax0": min(max(eff, 0.05), 0.30), "debt": debt, "cash": cash,
            "minority": v("minority"), "roic0": (oi * (1 - min(max(eff, 0.05), 0.30))) / ic if ic > 0 else 0.3,
            "beta": float(f["beta"] or 1.0), "sector": sec, "group": gid, "rating": letter, "rating_why": why,
            "s2c_own": s2c_own, "s2c_capex": s2c_capex, "sbc0": v("sbc") / rev if rev else 0.0, "fcf": fcf, "flags": flags, "cons": cons, "ltg": float(ltg[0]["meanest"]) / 100 if ltg and ltg[0]["meanest"] is not None else None, "cma": cma}


def unvalued(x: dict) -> str | None:
    """Why a cash-flow DCF does not apply (None = value it). One home for the live run (dcf_watch) and the S116 backtest."""
    if x["sector"] in ("40", "60"):
        return "Bank / insurer / REIT — cash-flow DCF does not apply (sector method not built)"
    if x["m0"] > 0:
        return None
    sm = x["cons"].get("sm") if x.get("cons") else None
    gap_ok = sm is not None and abs(x["m0"] - sm[0]) <= x["sbc0"] + 0.25  # filings vs street margin must reconcile (ASTS −2 % vs −406 %)
    if sm is not None and sm[3] > 0 and x["rev"] >= 1e8 and x["m0"] > -1.0 and gap_ok:
        return None
    why = ("pre-revenue / deep loss — option-like, cash-flow DCF does not apply" if x["rev"] < 1e8 or x["m0"] <= -1.0
           else "filings vs street margin don't reconcile — data check" if sm is not None and not gap_ok
           else "street sees no profit by year 3" if sm is not None else "no multi-year consensus")
    return f"Operating loss (margin {x['m0']:.0%}): {why}"


def simulate(x: dict, br: BaseRates, n: int = 4000, seed: int = 0, fixed: dict | None = None, scenario: str = "base") -> dict:
    rng = np.random.default_rng(seed)
    fx = fixed or {}
    from scipy.stats import norm
    g1_ = x["g1"] if x["g1"] is not None else 0.05
    q5_, _, _ = br.growth(x["rev"], g1_)
    center = 0.5
    cons = x.get("cons")
    if x.get("ltg") is not None and cons is None:  # consensus path replaces LTG (EPS growth, wrong unit for revenue)  # analysts' long-term growth → its base-rate percentile, shrunk halfway (LTG optimism)
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
    g_T = (np.full(n, fx["g_T"]) if "g_T" in fx else np.full(n, gd["mode"]) if gd["max"] - gd["min"] < 1e-9
           else rng.triangular(gd["min"], gd["mode"], gd["max"], n))  # degenerate when all capped at a low rf (2020)

    g1 = x["g1"] if x["g1"] is not None else 0.05
    q5, q10, gwhy = br.growth(x["rev"], g1)
    qm, mwhy = br.margin(x["sector"], x["m0"], x.get("gm"), (x["g1"] or 0) > 0.20)
    qr, qs, rwhy = br.roic_and_s2c(x["sector"], x["roic0"])
    r25, r10 = q5(u_g), q10(u_g)
    r610 = ((1 + r10) ** 10 / (1 + r25) ** 5) ** (1 / 5) - 1
    years = np.arange(1, 11)
    gr = np.zeros((n, 10))
    gr[:, 0] = g1 + (0 if fx else rng.normal(0, 0.2 * abs(g1) + 0.02, n))
    gr[:, 1:5] = r25[:, None]
    for k in range(5, 10):
        gr[:, k] = r610 + (g_T - r610) * ((k - 4) / 5)
    if cons is not None:  # consensus years 1–3, shrunk toward the base-rate path by coverage; 4–5 half/half; 6–10 fade
        zg = norm.ppf(u_g)
        k = np.arange(1, 4)
        w = cons["n"] / (cons["n"] + 3 * k)
        dsd = np.maximum(np.diff(np.r_[0.0, cons["sd"]]), 0.03)  # analyst range on the level → per-year increment
        lg = w[None, :] * (np.log1p(cons["g"])[None, :] + zg[:, None] * dsd[None, :]) + (1 - w[None, :]) * np.log1p(r25)[:, None]
        gr[:, 0:3] = np.expm1(lg)  # blend each year's growth (blending levels piled all shrinkage into year 3)
        gr[:, 3:5] = (0.5 * gr[:, 2] + 0.5 * r25)[:, None]
        # years 6–10 keep the size × start-growth 10-y base rate (set above): S113 — realized growth in years 6–10 is
        # 3–6 % in every consensus decile (ρ ≈ 0.05), so consensus says nothing about them
    if "analyst_g" in fx:  # analyst-style path: years 2–5 at the given growth, then linear fade to terminal by year 10
        ga = fx["analyst_g"]
        gr[:, 1:5] = ga
        for k in range(5, 10):
            gr[:, k] = ga + (g_T - ga) * ((k - 4) / 6)
    rev = x["rev"] * np.cumprod(1 + gr, axis=1)
    m_t = np.full(n, x["m0"]) if fx.get("hold_margin") else qm(u_m)
    w = np.clip(years / 5, 0, 1)
    margin = x["m0"] + (m_t[:, None] - x["m0"]) * w[None, :]
    if cons is not None and cons["dm"] is not None and not fx.get("hold_margin"):
        # S115 (Compustat × IBES 2003–19, same street basis): share of the consensus margin change that is realized by
        # yr 2 — losses ≈ 0.9–1.0, margins 0–20 % ≈ 0.25–0.5, > 20 % ≈ 0.1 (they fade regardless) → weight by level, not count
        wk = np.full(3, 0.9 if x["m0"] < 0 else 0.35 if x["m0"] < 0.20 else 0.1)
        zm = norm.ppf(np.clip(u_m, 0.01, 0.99))
        mc = x["m0"] + cons["dm"][None, :] + zm[:, None] * cons["sdm"][None, :]
        margin[:, 0:3] = wk[None, :] * mc + (1 - wk[None, :]) * margin[:, 0:3]
        m3 = margin[:, 2]
        qm3, _ = br.margin(x["sector"], float(np.median(m3)), x.get("gm"), (x["g1"] or 0) > 0.20)  # base rate from the yr-3 level
        m_t = 0.75 * m3 + 0.25 * qm3(u_m)
        margin[:, 3:] = m3[:, None] + (m_t - m3)[:, None] * ((years[3:] - 3) / 7)[None, :]
    sbc_T = next(tg for hi, tg in SBC_10Y if x.get("sbc0", 0) < hi)
    if sbc_T is not None and x.get("sbc0", 0) > sbc_T and not fx.get("hold_margin"):  # S114: stock pay shrinks → GAAP margin gains
        margin = margin + (x["sbc0"] - sbc_T) * np.minimum(years / 10, 1)[None, :]
    tax_T = 0.25 if x["tax0"] >= 0.25 else x["tax0"] + 0.5 * (0.25 - x["tax0"])
    tax = np.full(10, x["tax0"]) if fx.get("hold_tax") else x["tax0"] + (tax_T - x["tax0"]) * (years / 10)
    nopat = rev * margin * (1 - tax)
    if "s2c" in fx:
        s2c = np.full(n, fx["s2c"])
    elif (x.get("s2c_own") or x.get("s2c_capex")) is not None:  # own history (or net capex), ±30 % noise; sector rate a 25 % anchor
        s2c = np.exp(0.75 * np.log(x.get("s2c_own") or x["s2c_capex"]) + 0.25 * np.log(np.maximum(qs(u_s), 0.2)) + rng.normal(0, 0.3, n) * (0 if fx else 1))
    else:
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
    pv = (fcff / (disc / np.sqrt(1 + wacc))).sum(axis=1)  # mid-year convention: cash arrives through each year
    wT = wacc[:, -1]
    if "roicT" in fx:
        roicT = np.full(n, fx["roicT"])
    else:
        # terminal return on new capital: geometric mean of the base-rate fade and the company's own RONIC
        # (sales-to-capital × after-tax margin), never below WACC, capped at 60 %
        ronic_own = s2c * m_t * (1 - 0.25)
        roicT = np.clip(np.sqrt(np.maximum(qr(u_r), 0.01) * np.maximum(ronic_own, 0.01)), wT, 0.60)
    nopat11 = nopat[:, -1] * (1 + g_T)
    tv = nopat11 * (1 - g_T / roicT) / np.maximum(wT - g_T, 0.01)
    pv_tv = tv / disc[:, -1]
    ev = pv + pv_tv
    if x["cash"] >= x["debt"] and x["m0"] > 0:
        p_fail = 0.002
    elif x["cash"] >= x["debt"]:  # net-cash loss-maker: runway, not a synthetic rating from negative coverage (S112: ≤ 2 % / 5 y)
        burn = max(-x.get("fcf", 0.0), 0.0)
        p_fail = 0.02 if burn == 0 else 0.05 if (x["cash"] - x["debt"]) >= 3 * burn else 0.15
    else:
        p_fail = P_FAIL[x["rating"]] if x["m0"] > 0 else max(P_FAIL[x["rating"]], 0.15)
    equity = np.maximum(ev - x["debt"] + x["cash"] - x["minority"], 0) * (1 - p_fail)  # limited liability
    vps = equity / x["shares"]
    return {"vps": vps, "tv_share": float(np.median(pv_tv / ev)), "why": {"growth": gwhy, "margin": mwhy, "roic": rwhy},
            "b0": b0, "bT": bT, "kd": kd, "wd": wd, "p_fail": p_fail, "rf": rf,
            "parts": {"nopat1": float(np.median(nopat[:, 0])), "reinv1": float(np.median(reinv[:, 0])), "fcff1": float(np.median(fcff[:, 0])),
                      "pv_explicit": float(np.median(pv)), "pv_tv": float(np.median(pv_tv)), "ev": float(np.median(ev)),
                      "tv_mult_nopat11": float(np.median(tv / nopat11)), "disc10": float(np.median(disc[:, -1]))},
            "path": {"rev10": float(np.median(rev[:, -1])), "m_target": float(np.median(m_t)), "g25": float(np.median(r25)),
                     "g": np.median(gr, axis=0).tolist(), "margin": np.median(margin, axis=0).tolist(), "fcff": np.median(fcff, axis=0).tolist(),
                     "tax": tax.tolist(), "s2c": float(np.median(s2c)), "roicT": float(np.median(roicT)), "g_T": float(np.median(g_T)),
                     "erp": float(np.median(erp)),
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
            ours = rows(conn, "SELECT total_revenue FROM ticker_fundamentals WHERE ticker = %s", (t,))
            if ours and ours[0]["total_revenue"] and x["rev"] < 0.5 * float(ours[0]["total_revenue"]):
                continue  # SEC base implausible (foreign filer in local currency, odd revenue tag) → not valued here
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
