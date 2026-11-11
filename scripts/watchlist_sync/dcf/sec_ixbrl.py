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


_PERIOD = re.compile(r"<xbrli:startDate>\s*([0-9-]{10})\s*</xbrli:startDate>\s*<xbrli:endDate>\s*([0-9-]{10})\s*</xbrli:endDate>", re.I)
NS = ("us-gaap", "ifrs-full", "dei")
_FP = {"Q1": (77, 100), "Q2": (160, 200), "Q3": (240, 290), "FY": (350, 380)}


def _unit_names(text: str) -> dict[str, str]:
    """unit id → companyfacts unit name: USD, TWD, shares, USD/shares."""
    out = {}
    for m in re.finditer(r"<xbrli:unit\b[^>]*\bid=\"([^\"]+)\"[^>]*>(.*?)</xbrli:unit>", text, re.S | re.I):
        meas = [x.split(":")[-1] for x in re.findall(r"<xbrli:measure>\s*([^<\s]+)\s*</xbrli:measure>", m.group(2), re.I)]
        if len(meas) in (1, 2):
            out[m.group(1)] = "/".join(meas)
    return out


def parse_facts(text: str) -> list[dict]:
    """Every consolidated (non-dimensional) numeric fact: {ns, concept, unit, start?, end, val}."""
    ctx = {}
    for m in _CTX.finditer(text):
        if re.search(r"<xbrli:segment|<xbrldi:", m.group(2), re.I):
            continue
        d = _PERIOD.search(m.group(2))
        i = _INSTANT.search(m.group(2))
        if d:
            ctx[m.group(1)] = (d.group(1), d.group(2))
        elif i:
            ctx[m.group(1)] = (None, i.group(1))
    units = _unit_names(text)
    out, seen = [], set()
    for m in _FACT.finditer(text):
        a = dict(_ATTR.findall(m.group(1)))
        ns, _, concept = a.get("name", "").partition(":")
        c = ctx.get(a.get("contextRef", ""))
        if ns not in NS or not c or "comma" in a.get("format", ""):   # num-comma-decimal (1.234,5) not parsed
            continue
        raw = re.sub(r"<[^>]+>", "", html.unescape(m.group(2))).strip().replace(",", "").replace(" ", "")
        if not re.fullmatch(r"[0-9]+(\.[0-9]+)?", raw or ""):
            continue
        val = float(raw) * 10 ** int(a.get("scale", "0") or 0) * (-1 if a.get("sign") == "-" else 1)
        key = (ns, concept, a.get("unitRef"), c)
        if key in seen:
            continue
        seen.add(key)
        f = {"ns": ns, "concept": concept, "unit": units.get(a.get("unitRef", ""), "?"), "end": c[1], "val": val}
        if c[0]:
            f["start"] = c[0]
        out.append(f)
    return out


def newest_filing(conn, ticker: str) -> tuple[str, dict] | None:
    """(document text, {form, filed, url}) of the newest periodic filing with a primary document."""
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
        return _doc(url), {"form": form.replace("/A", "") if form.endswith("/A") else form, "filed": rec["filingDate"][i],
                           "url": url, "accn": rec["accessionNumber"][i]}
    return None


def augment(facts: dict, parsed: list[dict], meta: dict) -> int:
    """11-11 (#53): merge a lagging filing's facts into companyfacts so ttm_flow / balance see the newest report.
    Same (start, end) already in companyfacts → replaced by the filing's value. Returns facts added."""
    n = 0
    root = facts.setdefault("facts", {})
    for f in parsed:
        if f["unit"] == "?":
            continue
        u = {"end": f["end"], "val": f["val"], "form": meta["form"], "filed": meta["filed"], "accn": meta["accn"], "src": "ixbrl"}
        if "start" in f:
            u["start"] = f["start"]
            d = F._days(f["start"], f["end"])   # sec_ttm_eps._ttm_from_ytd keys YTD length on fp
            u["fp"] = next((k for k, (lo, hi) in _FP.items() if lo <= d <= hi), "")
        lst = root.setdefault(f["ns"], {}).setdefault(f["concept"], {}).setdefault("units", {}).setdefault(f["unit"], [])
        # replace, never sit beside: F.shares sums same-date dei entries (SEIC 118.6 M → 237.2 M when appended)
        lst[:] = [x for x in lst if (x.get("start"), x["end"]) != (u.get("start"), u["end"])]
        lst.append(u)
        n += 1
    return n


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
