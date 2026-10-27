"""DCF v2 §A: long-term capital market assumptions, refreshed monthly → watchlist_sync.cma_monthly (A283).
Market-wide inputs every DCF uses, each with its source and date, plus the rf/ERP pairs the scenarios run on.
  FRED (no key): DGS10/20/30, T10YIE breakeven, DFII10 real yield, ICE BofA OAS by rating (cost of debt)
  Damodaran monthly implied-ERP workbook (pc/implprem/ERP<Mon><YY>.xlsx): implied ERP vs the 10-y, implied S&P 500
    expected return, 10-y average implied ERP, historical ERP
  Kroll recommended US ERP (page checked for a newer recommendation; 5.0 % since 2024-06-05, normalised rf 3.5 %)
Every response is kept whole in vendor_raw (AGENTS rule 4c).
Pairs (an ERP is only valid with the rf it was estimated on):
  implied  : 10-y spot + Damodaran implied ERP (default: consistent with today's market level)
  kroll    : max(20-y spot, 3.5 %) + Kroll ERP
  normal   : 10-y spot + Damodaran 10-y average implied ERP (market at its usual pricing)
  base     : 10-y spot + ERP distribution triangular(min = implied, mode = 1960–now average implied, max = max(normal,
             Kroll)) — the DCF draws from it; P50 ≈ the long-run average
Usage: .venv/bin/python dcf/cma.py [--dry-run]"""
from __future__ import annotations

import hashlib
import io
import json
import re
import sys
import urllib.request
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_plan import connect, rows  # noqa: E402

FRED = {"GDPPOT": "gdppot", "DGS10": "ust10", "DGS20": "ust20", "DGS30": "ust30", "T10YIE": "breakeven10", "DFII10": "real10",
        "BAMLC0A1CAAA": "oas_aaa", "BAMLC0A2CAA": "oas_aa", "BAMLC0A3CA": "oas_a", "BAMLC0A4CBBB": "oas_bbb",
        "BAMLH0A1HYBB": "oas_bb", "BAMLH0A2HYB": "oas_b", "BAMLH0A3HYC": "oas_ccc"}
# Published long-term capital market assumptions, US large-cap equity, 10–15-y annualised (forecasts from today's prices;
# they include expected valuation change). Reviewed by hand when a house publishes (JPM each October).
LTCMA = {"jpm_2027": (0.075, "JPM 2027 LTCMA (Oct 2026): +80 bp on margins > 15 %"),
         "jpm_2026": (0.067, "JPM 2026 LTCMA: 6.0 rev + 3.0 buybacks + 1.7 div − 1.5 dilution − 2.0 valuation − 0.5 margins"),
         "northern_trust_2026": (0.068, "Northern Trust 10-y outlook 2026"),
         "house_median": (0.063, "median of 14 houses (Portfolio Lab, 2026)"),
         "vanguard_mid": (0.052, "Vanguard 4.2–6.2 % range (Jun 2026)")}
KROLL_URL = "https://www.kroll.com/en/reports/cost-of-capital/recommended-us-equity-risk-premium-and-corresponding-risk-free-rates"
KROLL_DEFAULT = {"erp": 0.050, "rf_floor": 0.035, "since": "2024-06-05"}
DAMO_LABELS = {
    "erp_implied": "implied equity risk premium (with us treasury rate as riskfree rate)",
    "exp_return": "implied expected return on s&p 500",
    "ust10_damodaran": "us 10-year treasury rate",
    "erp_avg10": "average implied erp (last decade)",
    "erp_hist": "historical equity risk premium (us)",
    "erp_long": "average implied erp (1960-current)",
    "index_level": "enter current level of index",
}
DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.cma_monthly (
  as_of date PRIMARY KEY, values jsonb NOT NULL, pairs jsonb NOT NULL, sources jsonb NOT NULL, computed_at timestamptz DEFAULT now())"""


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 fildi-research"})
    return urllib.request.urlopen(req, timeout=30).read()


def _raw(conn, source: str, endpoint: str, key: str, payload: dict) -> None:
    body = json.dumps(payload)
    conn.execute("""INSERT INTO vendor_raw (source, endpoint, key, fetched_on, payload, payload_sha)
                    VALUES (%s, %s, %s, %s, %s::jsonb, %s)
                    ON CONFLICT (source, endpoint, key, fetched_on) DO UPDATE SET payload = EXCLUDED.payload,
                    payload_sha = EXCLUDED.payload_sha""",
                 (source, endpoint, key, date.today(), body, hashlib.sha256(body.encode()).hexdigest()))


def fred(conn) -> tuple[dict, dict]:
    vals, src = {}, {}
    for sid, name in FRED.items():
        start = "2020-01-01" if sid == "GDPPOT" else date.today().replace(day=1).isoformat()
        text = _get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}&cosd={start}").decode()
        _raw(conn, "fred", "fredgraph.csv", sid, {"csv": text})
        obs = [ln.split(",") for ln in text.strip().splitlines()[1:]]
        obs = [(d, v) for d, v in obs if v not in (".", "")]
        if sid == "GDPPOT":  # CBO real potential GDP incl. projections → 10-y forward annual growth
            now = [x for x in obs if x[0] <= date.today().isoformat()][-1]
            fwd = [x for x in obs if x[0] <= f"{date.today().year + 10}-12-31"][-1]
            yrs = (date.fromisoformat(fwd[0]) - date.fromisoformat(now[0])).days / 365.25
            if yrs > 3:
                vals["real_potential"] = (float(fwd[1]) / float(now[1])) ** (1 / yrs) - 1
                src["real_potential"] = f"FRED GDPPOT (CBO) {now[0]}→{fwd[0]}"
            continue
        if obs:
            vals[name] = float(obs[-1][1]) / 100
            src[name] = f"FRED {sid} {obs[-1][0]}"
    return vals, src


def damodaran(conn) -> tuple[dict, dict]:
    import openpyxl
    today = date.today()
    for back in range(3):  # current month's workbook, else the previous ones
        y, m = today.year, today.month - back
        while m <= 0:
            y, m = y - 1, m + 12
        name = f"ERP{date(y, m, 1).strftime('%b')}{str(y)[2:]}.xlsx"
        url = f"https://pages.stern.nyu.edu/~adamodar/pc/implprem/{name}"
        try:
            data = _get(url)
        except Exception:
            continue
        wb = openpyxl.load_workbook(io.BytesIO(data), data_only=True, read_only=True)
        ws = wb[wb.sheetnames[0]]
        vals, cells = {}, []
        for row in ws.iter_rows(values_only=True):
            cells.append(list(row))
            for i, c in enumerate(row):
                if not isinstance(c, str):
                    continue
                low = c.strip().lower().rstrip("= ").strip()
                for key, label in DAMO_LABELS.items():
                    if key not in vals and low.startswith(label):
                        nxt = next((x for x in row[i + 1:] if isinstance(x, (int, float))), None)
                        if nxt is not None:
                            vals[key] = float(nxt)
        _raw(conn, "damodaran", "implprem", name, {"url": url, "cells": [[c if isinstance(c, (int, float, str)) or c is None else str(c) for c in r] for r in cells[:120]]})
        return vals, {k: f"Damodaran {name}" for k in vals}
    return {}, {}


def kroll(conn) -> tuple[dict, dict]:
    try:
        text = _get(KROLL_URL).decode("utf-8", "ignore")
    except Exception:
        return {"kroll_erp": KROLL_DEFAULT["erp"], "kroll_rf_floor": KROLL_DEFAULT["rf_floor"]}, {"kroll_erp": f"Kroll {KROLL_DEFAULT['since']} (page unreachable)"}
    _raw(conn, "kroll", "recommended-us-erp", "page", {"html_len": len(text), "titles": re.findall(r"Kroll[^<\"]{0,160}(?:ERP|Equity Risk Premium|Risk-Free)[^<\"]{0,80}", text)[:20]})
    # newest announcement that names a percentage for the ERP wins; else the known 2024-06 recommendation
    m = re.search(r"(?:Lowers|Raises|Increases|Decreases|Lowers its)[^<\"]{0,60}Equity Risk Premium to (\d\.\d)%", text)
    erp = float(m.group(1)) / 100 if m else KROLL_DEFAULT["erp"]
    return {"kroll_erp": erp, "kroll_rf_floor": KROLL_DEFAULT["rf_floor"]}, {"kroll_erp": "Kroll recommended US ERP page", "kroll_rf_floor": "Kroll normalised rf"}


def pairs(v: dict) -> dict:
    out = {}
    if "ust10" in v and "erp_implied" in v:
        out["implied"] = {"rf": v["ust10"], "erp": v["erp_implied"], "basis": "10-y spot + Damodaran implied ERP"}
    if "ust20" in v and "kroll_erp" in v:
        out["kroll"] = {"rf": max(v["ust20"], v["kroll_rf_floor"]), "erp": v["kroll_erp"], "basis": "max(20-y, 3.5 %) + Kroll ERP"}
    if "ust10" in v and "erp_avg10" in v:
        out["normal"] = {"rf": v["ust10"], "erp": v["erp_avg10"], "basis": "10-y spot + 10-y average implied ERP"}
    if "ust10" in v:  # market-consistent view: published expected return at today's prices (JPM 2027) − rf
        mr, why = LTCMA["jpm_2027"]
        out["ltcma"] = {"rf": v["ust10"], "erp": round(mr - v["ust10"], 4), "basis": f"{why}; ERP = 7.5 % − 10-y",
                        "houses": {k: x[0] for k, x in LTCMA.items()}}
    if "ust10" in v and {"erp_implied", "erp_long", "erp_avg10"} <= v.keys():
        lo, mode = v["erp_implied"], v["erp_long"]
        hi = max(v["erp_avg10"], v.get("kroll_erp", 0))
        lo, mode, hi = sorted((lo, mode, hi))[0], mode, sorted((lo, mode, hi))[2]
        out["base"] = {"rf": v["ust10"], "erp": mode, "erp_dist": {"type": "triangular", "min": lo, "mode": mode, "max": hi},
                       "basis": "10-y spot + ERP triangular(implied, 1960–now avg implied, max(10-y avg, Kroll))"}
    # terminal (stable) nominal growth: expected inflation + CBO potential real growth, never above rf (Damodaran)
    if {"breakeven10", "real_potential", "ust10"} <= v.keys():
        mode = v["breakeven10"] + v["real_potential"]
        g = {"type": "triangular", "min": round(mode - 0.01, 4), "mode": round(min(mode, v["ust10"]), 4), "max": round(v["ust10"], 4),
             "basis": "breakeven inflation + CBO potential real growth (mode) − 1 pt … rf (cap)"}
        for p in out.values():
            p["g_dist"] = g
    for p in out.values():
        p["market_return"] = round(p["rf"] + p["erp"], 4)
    return out


def main(dry: bool) -> None:
    with connect() as conn:
        conn.execute(DDL)
        v, s = {}, {}
        for fn in (fred, damodaran, kroll):
            a, b = fn(conn)
            v.update(a); s.update(b)
        pr = pairs(v)
        print(json.dumps({"values": v, "pairs": pr}, indent=1))
        if not dry:
            conn.execute("""INSERT INTO watchlist_sync.cma_monthly (as_of, values, pairs, sources) VALUES (%s, %s, %s, %s)
                            ON CONFLICT (as_of) DO UPDATE SET values = EXCLUDED.values, pairs = EXCLUDED.pairs,
                            sources = EXCLUDED.sources, computed_at = now()""",
                         (date.today(), json.dumps(v), json.dumps(pr), json.dumps(s)))
        conn.commit()


if __name__ == "__main__":
    main("--dry-run" in sys.argv)
