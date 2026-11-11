"""11-11: read balance-sheet facts straight from a filing's inline XBRL when SEC companyfacts lags the filing
(TSM 20-F FY25 filed 2026-04-16 but companyfacts stops FY24; C/DUK/PLD 10-Q Q3 filed, facts stop Q4/Q1).

latest_instant(conn, ticker, concepts) → {value, end, unit, form, filed, concept} for the newest periodic filing,
non-dimensional context only (consolidated total, not a segment), the latest instant date in that document.
One EDGAR call per filing (vendor_gate 'EDGAR'); the raw document is not stored (5–20 MB), the parsed fact is.
"""
from __future__ import annotations

import html
import re
import urllib.request

import financials as F
from build_plan import rows

PERIODIC = ("10-K", "10-Q", "20-F", "40-F", "10-K/A", "20-F/A")
_CTX = re.compile(r"<xbrli:context\b[^>]*\bid=\"([^\"]+)\"[^>]*>(.*?)</xbrli:context>", re.S | re.I)
_INSTANT = re.compile(r"<xbrli:instant>\s*([0-9-]{10})\s*</xbrli:instant>", re.I)
_FACT = re.compile(r"<ix:nonFraction\b([^>]*)>(.*?)</ix:nonFraction>", re.S | re.I)
_ATTR = re.compile(r"(\w[\w:.-]*)=\"([^\"]*)\"")


def _doc(url: str) -> str:
    F.vendor_gate.wait("EDGAR")
    req = urllib.request.Request(url, headers={"User-Agent": F.UA})
    return urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "replace")


def _units(text: str) -> dict[str, str]:
    out = {}
    for m in re.finditer(r"<xbrli:unit\b[^>]*\bid=\"([^\"]+)\"[^>]*>(.*?)</xbrli:unit>", text, re.S | re.I):
        meas = re.findall(r"<xbrli:measure>\s*(?:iso4217:)?([^<\s]+)\s*</xbrli:measure>", m.group(2), re.I)
        if len(meas) == 1:
            out[m.group(1)] = meas[0].split(":")[-1].upper()
    return out


def parse_instant(text: str, concepts: list[str]) -> dict | None:
    ctx = {}
    for m in _CTX.finditer(text):
        if re.search(r"<xbrli:segment|<xbrldi:", m.group(2), re.I):
            continue   # dimensional = a segment/member, not the consolidated total
        i = _INSTANT.search(m.group(2))
        if i:
            ctx[m.group(1)] = i.group(1)
    units = _units(text)
    best = None
    for m in _FACT.finditer(text):
        a = dict(_ATTR.findall(m.group(1)))
        name = a.get("name", "")
        concept = name.split(":")[-1]
        if concept not in concepts or a.get("contextRef") not in ctx:
            continue
        raw = re.sub(r"<[^>]+>", "", html.unescape(m.group(2))).strip().replace(",", "").replace(" ", "")
        if not re.fullmatch(r"[0-9]+(\.[0-9]+)?", raw or ""):
            continue
        val = float(raw) * 10 ** int(a.get("scale", "0") or 0) * (-1 if a.get("sign") == "-" else 1)
        end = ctx[a["contextRef"]]
        cand = {"value": val, "end": end, "unit": units.get(a.get("unitRef", ""), "?"), "concept": concept}
        if best is None or end > best["end"]:
            best = cand
    return best


def latest_instant(conn, ticker: str, concepts: list[str]) -> dict | None:
    r = rows(conn, """SELECT payload FROM vendor_raw WHERE source = 'sec' AND endpoint = 'submissions' AND key = %s
                      ORDER BY fetched_on DESC LIMIT 1""", (ticker.upper(),))
    if not r:
        return None
    sub = r[0]["payload"]
    rec = (sub.get("filings") or {}).get("recent") or {}
    cik = int(sub.get("cik") or 0)
    for i, form in enumerate(rec.get("form", [])):
        if form not in PERIODIC or not rec["primaryDocument"][i]:
            continue
        acc = rec["accessionNumber"][i].replace("-", "")
        url = f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc}/{rec['primaryDocument'][i]}"
        fact = parse_instant(_doc(url), concepts)
        if fact:
            fact.update(form=form, filed=rec["filingDate"][i], url=url)
        return fact   # newest periodic filing only — an older one is what companyfacts already has
    return None
