"""A286: segment revenues / operating income from EDGAR XBRL instance (_htm.xml).

companyfacts drops dimensional facts — parse the filing instance for
`StatementBusinessSegmentsAxis` members. Store raw in vendor_raw + rows in
`watchlist_sync.dcf_segments`. Engine SOTP (when ≥2 segments cover ≥90% of
revenue) lives in `engine.inputs` / caller.

    cd scripts/watchlist_sync && .venv/bin/python -m dcf.segments [--tickers=AMZN,GOOGL]
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
import time
import urllib.request
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect, rows  # noqa: E402
from financials import UA  # noqa: E402

REV_TAGS = (
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
)
OI_TAGS = (
    "OperatingIncomeLoss",
    "OperatingIncomeLossBeforeIncomeTaxes",
)
AXIS = "StatementBusinessSegmentsAxis"

DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.dcf_segments (
  ticker text NOT NULL, period_end date NOT NULL, form text NOT NULL,
  member text NOT NULL, metric text NOT NULL, value double precision NOT NULL,
  start_date date, concept text, filing_url text, fetched_on date NOT NULL DEFAULT CURRENT_DATE,
  PRIMARY KEY (ticker, period_end, form, member, metric))"""


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def _get_json(url: str) -> dict:
    return json.loads(_get(url).decode())


def cik_for(conn, ticker: str) -> str | None:
    r = rows(conn, "SELECT cik FROM ticker_cik WHERE ticker = %s", (ticker,))
    return r[0]["cik"] if r else None


def latest_filings(cik: str, forms: tuple[str, ...] = ("10-K", "10-Q"), n_each: int = 1) -> list[dict]:
    sub = _get_json(f"https://data.sec.gov/submissions/CIK{cik}.json")
    recent = sub.get("filings", {}).get("recent", {})
    out, seen = [], {f: 0 for f in forms}
    for i, f in enumerate(recent.get("form", [])):
        if f not in forms or seen[f] >= n_each:
            continue
        seen[f] += 1
        out.append({
            "form": f,
            "accession": recent["accessionNumber"][i],
            "filingDate": recent["filingDate"][i],
            "reportDate": recent.get("reportDate", [None] * (i + 1))[i],
            "primary": recent["primaryDocument"][i],
        })
        if all(seen[x] >= n_each for x in forms):
            break
    return out


def instance_url(cik: str, accession: str) -> str | None:
    acc = accession.replace("-", "")
    cik_n = str(int(cik))
    idx = _get_json(f"https://www.sec.gov/Archives/edgar/data/{cik_n}/{acc}/index.json")
    names = [x["name"] for x in idx.get("directory", {}).get("item", [])]
    cands = [n for n in names if n.endswith("_htm.xml")]
    if not cands:
        cands = [n for n in names if n.endswith(".xml") and not any(
            s in n for s in ("_cal", "_def", "_lab", "_pre", "FilingSummary"))]
    if not cands:
        return None
    return f"https://www.sec.gov/Archives/edgar/data/{cik_n}/{acc}/{cands[0]}"


def _parse_contexts(text: str) -> dict[str, dict]:
    ctx = {}
    for m in re.finditer(r'<[^>]*context[^>]*\bid="([^"]+)"[^>]*>(.*?)</[^>]*context>', text, re.I | re.S):
        cid, body = m.group(1), m.group(2)
        if AXIS not in body:
            continue
        seg = re.search(rf'{AXIS}[^>]*>\s*([^<\s]+)', body)
        if not seg:
            continue
        start = re.search(r'<[^>]*startDate[^>]*>([^<]+)', body)
        end = re.search(r'<[^>]*endDate[^>]*>([^<]+)', body)
        instant = re.search(r'<[^>]*instant[^>]*>([^<]+)', body)
        ctx[cid] = {
            "member": seg.group(1).split(":")[-1],
            "start": start.group(1) if start else None,
            "end": end.group(1) if end else (instant.group(1) if instant else None),
        }
    return ctx


def _facts_for(text: str, tags: tuple[str, ...], ctx: dict[str, dict]) -> list[dict]:
    out = []
    for tag in tags:
        for m in re.finditer(rf'<(?:[\w.-]+:)?{tag}\b([^>]*)>([^<]+)</(?:[\w.-]+:)?{tag}>', text):
            attrs, val = m.group(1), m.group(2)
            cref = re.search(r'contextRef="([^"]+)"', attrs)
            if not cref or cref.group(1) not in ctx:
                continue
            try:
                v = float(val.replace(",", ""))
            except ValueError:
                continue
            c = ctx[cref.group(1)]
            out.append({**c, "val": v, "concept": tag})
    return out


def _period_days(start: str | None, end: str | None) -> int | None:
    if not start or not end:
        return None
    try:
        return (date.fromisoformat(end) - date.fromisoformat(start)).days
    except ValueError:
        return None


def pick_annual(facts: list[dict], prefer_end: str | None) -> dict[str, dict]:
    """One value per member: prefer ~FY period ending prefer_end (or newest FY)."""
    by: dict[str, list] = defaultdict(list)
    for x in facts:
        if x["member"].endswith("AndInternationalSegmentMember"):
            continue  # AMZN aggregate of NA+Intl — double-counts if kept
        d = _period_days(x.get("start"), x.get("end"))
        if d is None or not (80 <= d <= 400):
            continue
        by[x["member"]].append(x)
    out = {}
    for mem, xs in by.items():
        fy = [x for x in xs if 350 <= (_period_days(x["start"], x["end"]) or 0) <= 380]
        pool = fy or xs
        if prefer_end:
            hit = [x for x in pool if x.get("end") == prefer_end]
            pool = hit or pool
        out[mem] = max(pool, key=lambda x: (x.get("end") or "", abs(x["val"])))
    return out


def parse_instance(raw: bytes, prefer_end: str | None = None) -> dict:
    text = raw.decode("utf-8", errors="ignore")
    ctx = _parse_contexts(text)
    rev = pick_annual(_facts_for(text, REV_TAGS, ctx), prefer_end)
    oi = pick_annual(_facts_for(text, OI_TAGS, ctx), prefer_end)
    return {"revenue": rev, "operating_income": oi, "n_contexts": len(ctx)}


def store(conn, ticker: str, form: str, period_end: str, filing_url: str, parsed: dict, raw: bytes) -> int:
    body = json.dumps({"url": filing_url, "sha": hashlib.sha256(raw).hexdigest(), "n": len(raw)})
    conn.execute("""INSERT INTO vendor_raw (source, endpoint, key, fetched_on, payload, payload_sha)
                    VALUES ('edgar', 'xbrl-instance-segments', %s, %s, %s::jsonb, %s)
                    ON CONFLICT (source, endpoint, key, fetched_on) DO UPDATE SET payload = EXCLUDED.payload,
                    payload_sha = EXCLUDED.payload_sha""",
                 (f"{ticker}:{form}:{period_end}", date.today(), body, hashlib.sha256(raw).hexdigest()))
    n = 0
    for metric, by_mem in (("revenue", parsed["revenue"]), ("operating_income", parsed["operating_income"])):
        for mem, x in by_mem.items():
            conn.execute("""INSERT INTO watchlist_sync.dcf_segments
                (ticker, period_end, form, member, metric, value, start_date, concept, filing_url, fetched_on)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (ticker, period_end, form, member, metric) DO UPDATE SET
                  value = EXCLUDED.value, start_date = EXCLUDED.start_date, concept = EXCLUDED.concept,
                  filing_url = EXCLUDED.filing_url, fetched_on = EXCLUDED.fetched_on""",
                         (ticker, period_end, form, mem, metric, x["val"], x.get("start"),
                          x.get("concept"), filing_url, date.today()))
            n += 1
    return n


def fetch_ticker(conn, ticker: str) -> dict:
    cik = cik_for(conn, ticker)
    if not cik:
        return {"ticker": ticker, "error": "no cik"}
    filings = latest_filings(cik)
    results = []
    for fl in filings:
        time.sleep(0.15)
        url = instance_url(cik, fl["accession"])
        if not url:
            results.append({**fl, "error": "no instance xml"})
            continue
        time.sleep(0.15)
        raw = _get(url)
        prefer = fl.get("reportDate") or None
        parsed = parse_instance(raw, prefer)
        pe = prefer or max((x.get("end") for x in parsed["revenue"].values()), default=None)
        if not pe:
            results.append({**fl, "error": "no segment revenue", "url": url})
            continue
        n = store(conn, ticker, fl["form"], pe, url, parsed, raw)
        rev_sum = sum(x["val"] for x in parsed["revenue"].values())
        results.append({
            "form": fl["form"], "period_end": pe, "url": url, "rows": n,
            "members": sorted(parsed["revenue"]), "rev_sum": rev_sum,
            "rev_by": {m: round(x["val"] / 1e9, 3) for m, x in parsed["revenue"].items()},
        })
        conn.commit()
    return {"ticker": ticker, "filings": results}


def coverage(conn, ticker: str, period_end: str, total_rev: float) -> float | None:
    if not total_rev:
        return None
    r = rows(conn, """SELECT SUM(value) s FROM watchlist_sync.dcf_segments
                      WHERE ticker = %s AND period_end = %s AND metric = 'revenue' AND form = '10-K'""",
             (ticker, period_end))
    s = float(r[0]["s"] or 0) if r else 0
    return s / total_rev if total_rev else None


def main() -> None:
    only = None
    for a in sys.argv[1:]:
        if a.startswith("--tickers="):
            only = [x.strip().upper() for x in a.split("=", 1)[1].split(",") if x.strip()]
    conn = connect()
    conn.execute(DDL)
    conn.commit()
    tickers = only or ["AMZN", "GOOGL", "MSFT", "TSLA", "GEV"]
    packet = []
    for t in tickers:
        print(f"=== {t} ===")
        try:
            r = fetch_ticker(conn, t)
        except Exception as e:
            print("  error", e)
            conn.rollback()
            packet.append(f"{t}: error {e}")
            continue
        for fl in r.get("filings") or []:
            if fl.get("error"):
                print(" ", fl["form"], fl["error"])
                continue
            print(f"  {fl['form']} {fl['period_end']} sum ${fl['rev_sum']/1e9:.1f}B members={fl['members']}")
            for m, v in sorted(fl["rev_by"].items(), key=lambda kv: -kv[1]):
                print(f"    {m}: {v:.2f}B")
            packet.append(f"{t} {fl['form']} {fl['period_end']}: ${fl['rev_sum']/1e9:.1f}B · {len(fl['members'])} segs")
        time.sleep(0.2)
    out = HERE.parent / "out" / "opt" / "A286-packet.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        "# A286 packet — segment XBRL parse\n\n"
        + f"As of {date.today()}\n\n"
        + "\n".join(f"- {p}" for p in packet) + "\n"
        + "\nParser: `dcf/segments.py` → `watchlist_sync.dcf_segments`. Engine SOTP next when coverage ≥ 90%.\n"
    )
    print("wrote", out)


if __name__ == "__main__":
    main()
