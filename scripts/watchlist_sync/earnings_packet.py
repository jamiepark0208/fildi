"""Post-earnings packet v2 (Jamie 10-29 → 10-30): the facts behind a report from its source documents, so the auto notes reach the
level of a hand analysis (GOOGL Q3: operating income fine, EPS miss = SpaceX mark-to-market; AMZN FCF hit partly the EC fine).

Per report (ticker, report_date) one packet in watchlist_sync.earnings_packets:
  release   SEC 8-K item 2.02 ex-99.1 (raw → vendor_raw, rule 4c), its tables parsed with the stdlib HTML parser
  bridge    deterministic EPS bridge: revenue / operating income / non-operating (pretax − operating) / tax rate / net income /
            diluted EPS / operating cash flow − capex = FCF, current quarter vs the same quarter a year ago
  one_offs  release sentences that name a $ amount next to gain / loss / charge / fine / impairment / mark-to-market / settlement …
  street    EPS estimate (earnings_calendar) + revenue estimate (Finnhub calendar) — never blocks when missing
  reaction  close before → first close after the report (earnings_notes._reaction)
  call      stored transcript summary when it is in (AV); the packet is built without it and refreshed when it lands
  briefs    Jamie's tradedash-brief newsletters (Gmail label → Drive → desk_commentaries): sentences naming the company in the
            2 days after the 8-K — what the street read into the print beyond the table numbers
Used by earnings_notes.py (numbers + bridge notes) and any agent writing an earnings read (`--print T`).

    .venv/bin/python earnings_packet.py --print GOOGL [--date 2026-10-28]   # build + show (no notes written)
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
import urllib.request
from datetime import date, timedelta
from html.parser import HTMLParser
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "dcf"))
from build_plan import connect, rows  # noqa: E402
from segments import _get, _get_json, cik_for  # noqa: E402  (EDGAR via vendor_gate, SEC user agent)
import vendor_gate  # noqa: E402

DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.earnings_packets (
  ticker text NOT NULL, report_date date NOT NULL, status text NOT NULL, source_url text, packet jsonb,
  tries int NOT NULL DEFAULT 1, built_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (ticker, report_date))"""

# label regexes on the lower-cased row label; first table row that matches wins (income statement comes before segment tables)
LINES = {
    "revenue": r"^(total )?(net )?(operating )?(revenues?|sales|net sales)( and other income)?$|^total (net )?(operating )?(revenues?|sales)$",
    "operating_income": r"^(total )?(income|profit) (\(loss\) )?from operations$|^operating (income|profit)( \(loss\))?$|^income \(loss\) from operations$",
    "other_income": r"^(total )?other income( \(expense\))?,? net$|^other income \(expense\)$|^non-?operating income( \(expense\))?,? net$",
    "pretax": r"^(income|earnings)( \(loss\))?( from continuing operations)? before ?(provision for |\(provision\) benefit for |benefit \(provision\) for )?income ?tax(es| expense)?|^pre-?tax (earnings|income)$|^earnings before (income )?taxes$",
    "tax": r"^(provision for|benefit \(provision\) for|\(provision\) benefit for|income tax(es)?( expense| provision)?)( income)?( taxes)?(, net)?$|^income tax (expense|provision)( \(benefit\))?$",
    "net_income": r"^net (income|earnings|loss|\(loss\) income|income \(loss\))( \(loss\))?$|^net (income|earnings) attributable to [a-z .,&']+$",
    "eps_diluted": r"^diluted( eps| (net )?(earnings|income)( \(loss\))? per (common |ordinary )?share\b.*)?$|^(net )?(earnings|income)( \(loss\))? per diluted share$|^(earnings|net income) per (common )?share[ ,–-]+diluted$",
    "cfo": r"^net cash (provided by|from|generated (by|from)) (\(used in\) )?(operating activities|operations)$|^cash flows? from operating activities$",
    "capex": r"^purchases of property and equipment|^capital expenditures|^additions to property",
    "fcf_reported": r"^free cash flow$",
}
ONE_OFF = re.compile(r"\b(gains?|loss(es)?|charges?|fines?|impairments?|mark[- ]to[- ]market|unrealized|settlements?|litigation|"
                     r"restructuring|severance|one-time|non-recurring|legal (matter|accrual)|write-?(down|off)s?|divestiture)\b", re.I)
MONEY = re.compile(r"\$\s?\d[\d,.]*\s*(billion|million|thousand)?", re.I)
YEAR = re.compile(r"\b20\d\d\b")
PERIOD = re.compile(r"\bQ([1-4])\s*(20\d\d)\b|\b([1-4])Q\s*(20\d\d)\b|\bQ([1-4])\s?['’](\d\d)\b|\b([1-4])Q\s?['’]?(\d\d)\b|\b(20\d\d)\b")


class _Tables(HTMLParser):
    """Collects every <table> as rows of cell texts, plus the release's paragraph text."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables: list[list[list[str]]] = []
        self.pre: list[str] = []   # text just before each table ('(in thousands, except per share data)')
        self.text: list[str] = []
        self._depth, self._row, self._cell, self._buf = 0, None, None, []

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self._depth += 1
            if self._depth == 1:
                self._flush()
                self.tables.append([])
                self.pre.append(" ".join(self.text[-2:])[-300:])
        elif tag == "tr" and self._depth:
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []
        elif tag in ("p", "div", "br", "li") and not self._depth:
            self._flush()

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._cell is not None and self._row is not None:
            self._row.append(" ".join("".join(self._cell).split()))
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if any(self._row):
                self.tables[-1].append([c for c in self._row])
            self._row = None
        elif tag == "table" and self._depth:
            self._depth -= 1
        elif tag in ("p", "div", "li") and not self._depth:
            self._flush()

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)
        elif not self._depth:
            self._buf.append(data)

    def _flush(self):
        s = " ".join("".join(self._buf).split())
        if s:
            self.text.append(s)
        self._buf = []


def _num_raw(cells: list[str]) -> list[tuple[float, bool]]:
    """(value, is_percent) for every number in a row; '(1,234)' → -1234, '—' → 0; '$' / ')' fragments skipped."""
    out = []
    cs = [c.strip() for c in cells]
    for i, c in enumerate(cs):
        nxt = next((x for x in cs[i + 1:] if x and x not in (")",)), "")
        pct = "%" in c or bool(re.search(r"\bbps?\b", c, re.I)) or nxt.startswith("%") or bool(re.fullmatch(r"(?i)bps?", nxt))
        c = c.replace("$", "").replace("%", "").replace("\u2014", "—").strip()
        if c in ("—", "-", "–"):
            out.append((0.0, pct))
            continue
        m = re.fullmatch(r"\(?\s*(-?[\d,]*\.?\d+)\s*\)?", c)
        if m and re.search(r"\d", c):
            v = float(m.group(1).replace(",", ""))
            out.append((-v if c.startswith("(") else v, pct))
    return out


def _num(cells: list[str], pct_mask: tuple[bool, ...] | None = None) -> list[float]:
    """Numbers in a row without percent / basis-point columns. A '% of revenue' or '% change' column read as a value shifted
    CMG/ODFL's year-ago revenue to 100.0 (10-30 audit); CMG marks '%' on the first row only → pct_mask carries the column
    positions learned from that row to the rest of the table."""
    raw = _num_raw(cells)
    if pct_mask and len(pct_mask) == len(raw):
        return [v for (v, p), m in zip(raw, pct_mask) if not (p or m)]
    return [v for v, p in raw if not p]


def _years(cells: list[str]) -> list[tuple[int, int]]:
    """Column periods of a header row: (year, quarter) — quarter 0 for year-only headers ('2025 2026 2025 2026').
    'Q3 2026' / '3Q 2026' / "Q3'26" / '3Q26' / '2026'. Comparison cells ('3Q26 vs 2Q26', '% change') are not periods (USB 10-15)."""
    out = []
    for c in cells:
        if re.search(r"\bvs\.?\b|change|chg|%", c, re.I):
            continue
        c = re.sub(r"(?i)\b(first|second|third|fourth)\s*quarter\s*", lambda m: "Q%d " % ("first second third fourth".split().index(
            m.group(1).lower()) + 1), c)   # 'ThirdQuarter2026' (BAC) → 'Q3 2026'
        for a, b, c2, d, e, f, g, h, y in PERIOD.findall(c):
            if y:
                out.append((int(y), 0))
            else:
                q, yy = next((q, yy) for q, yy in ((a, b), (c2, d), (e, f), (g, h)) if q)
                out.append((int(yy) if len(yy) == 4 else 2000 + int(yy), int(q)))
    return out


def parse_release(html: bytes, fh_revenue: float | None = None) -> dict:
    """{'lines': {name: {'cur', 'prior', 'label'}}, 'tables': compact text of every numeric table, 'text': [paragraphs]}."""
    p = _Tables()
    p.feed(html.decode("utf-8", "replace"))
    p._flush()
    blob = " ".join(p.text[:40]).lower()
    doc_scale = 1e-3 if "in thousands" in blob and "in millions" not in blob else 1.0
    per_table: list[dict[str, dict]] = []
    ffo: list[dict] = []   # REIT FFO / AFFO per share rows (the number REIT consensus is on)
    compact: list[str] = []
    for ti, tab in enumerate(p.tables):
        hdr: list[tuple[int, int]] = []
        hdr_cells: list[tuple[int, int] | None] = []   # every header cell: its period, or None for '$ change' / 'vs' / '% chg'
        block, found, section = [], {}, ""
        head = (p.pre[ti] + " " + " ".join(c for r in tab[:5] for c in r)).lower()
        scale = 1e-3 if "thousands" in head else 1.0 if "millions" in head else 1e3 if "billions" in head else doc_scale   # → $ M
        # Q3 releases often show cash flow for nine months only (CMG 10-28: '$1.9 B operating cash flow' was year-to-date)
        cells_head = " ".join(c for r in tab[:5] for c in r).lower()   # the table's own header — prose above it says 'nine months' too
        ytd = bool(re.search(r"(six|nine|twelve) months|year[- ]to[- ]date|\bytd\b", cells_head)) and not re.search(
            r"three months|3 months|13 weeks|quarter|\bq[1-4]\b|\b[1-4]q", cells_head)
        masks: dict[int, tuple[bool, ...]] = {}   # row length → percent columns, learned from mixed value/% rows only
        for r in tab:
            label = next((c for c in r if c and not _num([c]) and c not in ("$", ")", "%")), "")
            label = re.sub(r"(?<=[a-z)])\s?\(?\d\)?$", "", label)   # footnote marks: 'Diluted1', 'Revenue (2)'
            raw = _num_raw(r[1:]) if label else _num_raw(r)
            flags = tuple(p for _, p in raw)
            if any(flags) and not all(flags) and len(raw) not in masks:   # an all-% row (ROE, margins) is a ratio row, not a layout
                masks[len(raw)] = flags
            nums = _num(r[1:] if label else r, masks.get(len(raw)))
            ys = _years(r)
            if len(ys) >= 2 and (not nums or all(1990 < abs(v) < 2100 or v in (1, 2, 3, 4) for v in nums)):
                hdr = ys      # header row: year order tells which column is the current quarter
                cells = [c for c in r if c and c != "$"]
                per = [(_years([c]) or [None])[0] if len(_years([c])) <= 1 else None for c in cells]
                first = next((i for i, x in enumerate(per) if x), 0)
                hdr_cells = per[first:]
                continue
            if not label or not nums:
                if label and not nums:
                    block.append(label)   # section labels ("Earnings per share:", segment names)
                    section = label.lower()
                continue
            cur = prior = None
            if hdr_cells and len(hdr_cells) == len(raw) and sum(x is not None for x in hdr_cells) >= 2:
                # one value per header cell (CSX 'Fav / (Unfav)', USB '3Q26 vs 2Q26', RS 'Chg'): map by position
                top = max(x for x in hdr_cells if x)
                ci = hdr_cells.index(top)
                pi = next((i for i, x in enumerate(hdr_cells) if x == (top[0] - 1, top[1])), None)
                if not raw[ci][1]:
                    cur, prior = raw[ci][0], raw[pi][0] if pi is not None and not raw[pi][1] else None
            m_ = masks.get(len(raw))
            hdr_ = [h for h, m in zip(hdr, m_) if not m] if m_ and len(hdr) == len(m_) else hdr   # '% change vs 2025' header cols
            if cur is None and hdr_ and len(nums) >= 2:
                cols = hdr_ * (len(nums) // len(hdr_)) if len(nums) > len(hdr_) and len(nums) % len(hdr_) == 0 else hdr_
                top = max(cols)
                ci = cols.index(top)   # first column of the latest period (a later repeat is TTM / year-to-date)
                pi = next((i for i, y in enumerate(cols) if y == (top[0] - 1, top[1])), None)
                if len(cols) - 1 <= len(nums) <= len(cols) + 1 and ci < len(nums):   # ± one blank / unmarked change column
                    cur, prior = nums[ci], nums[pi] if pi is not None and pi < len(nums) else None
            if cur is None:   # no period header → compact text only; never guess which column is this quarter
                block.append(f"{label}: " + " / ".join(f"{v:g}" for v in nums[:6]))
                continue
            block.append(f"{label}: {cur:g}" + (f" (yr ago {prior:g})" if prior is not None else ""))
            key = label.lower().rstrip(":").strip()
            if re.search(r"\b(a?ffo|funds from operations)\b", key) and re.search(r"per (diluted |common )?(share|unit)|diluted", key) \
                    and abs(cur) < 100 and not ytd:
                ffo.append({"cur": cur, "prior": prior, "label": label,
                            "rank": 0 if re.search(r"normalized|core|as adjusted|adjusted", key) else 1 if "affo" not in key else 2})
            for name, rx in LINES.items():
                if name in found or not re.search(rx, key):
                    continue
                if name == "eps_diluted" and (abs(cur) > 500 or re.search(r"shares|average|weighted", section) and "per" not in key
                                              or key == "diluted" and abs(cur) >= 100 and not re.search(r"per share|earnings|eps", section)):
                    continue   # the 'Diluted' share-count row, not EPS
                k = 1.0 if name == "eps_diluted" else scale
                if ytd and name in ("revenue", "operating_income", "other_income", "pretax", "tax", "net_income", "eps_diluted"):
                    continue   # a year-to-date-only table never supplies the quarter's income lines (BAC 10-14: 9-month EPS)
                found[name] = {"cur": round(cur * k, 3), "prior": round(prior * k, 3) if prior is not None else None, "label": label, "t": ti, **({"ytd": True} if ytd else {})}
        per_table.append(found)
        if any(":" in b for b in block):
            compact.append(" | ".join(block))
    # Income lines from the income statement (first table with pretax or net income AND revenue/operating income) — a segment or
    # 'adjusted' table earlier in the release must not win (AT&T: segment op income 7.6 B vs consolidated 4.1 B); cash lines from the
    # first table holding both operating cash flow and capex; anything still missing from the first table that has it.
    inc = ("revenue", "operating_income", "other_income", "pretax", "tax", "net_income", "eps_diluted")
    lines: dict[str, dict] = {}
    # the income statement = the table holding the most income lines (a highlights / segment table holds 2–3; SBUX 10-27)
    cands = [f for f in per_table if ("pretax" in f or "net_income" in f) and ("revenue" in f or "operating_income" in f)]
    # with Finnhub's reported revenue in hand, the table whose revenue matches it wins (ground truth beats line counts)
    def fit(f):
        rv = (f.get("revenue") or {}).get("cur")
        ok = bool(fh_revenue and rv and any(abs(rv * 1e6 * m / fh_revenue - 1) < 0.02 for m in (1, 1e-3, 1e3)))
        return (ok, sum(k in f for k in inc))
    is_ = max(cands, key=fit, default={})
    cf = next((f for f in per_table if "cfo" in f and "capex" in f), {})
    lines.update({k: v for k, v in is_.items() if k in inc})
    if "revenue" in lines and "operating_income" in lines and lines["operating_income"]["cur"] > lines["revenue"]["cur"] * 1.001:
        lines.pop("operating_income")   # operating income above revenue = a mis-read row (AM 10-27)
    lines.update({k: v for k, v in cf.items() if k in ("cfo", "capex")})
    for f in per_table:   # still-missing lines; income lines only come from the income statement once one is found
        for k, v in f.items():
            if not (is_ and k in inc and k != "eps_diluted"):   # EPS often sits in its own per-share table
                lines.setdefault(k, v)
    if ffo:
        f = min(ffo, key=lambda x: (x["prior"] is None, x["rank"]))   # quarter rows carry a year-ago column; guidance rows don't
        lines["ffo_per_share"] = {k: f[k] for k in ("cur", "prior", "label")}
    return {"lines": lines, "tables": compact, "text": p.text, "unit": 1e6}   # lines are in $ millions (per-table scale)


def sanity_vs_street(rel: dict, fh_revenue: float | None, shares: float | None = None) -> None:
    """In place: 8-K revenue vs Finnhub's reported revenue (10-30 backfill: PCAR picked a segment table, ARE a thousands table).
    ~1000× → that one table missed '(in thousands)': rescale only its lines. > 20 % off → wrong table: drop the income lines
    (a blank beats a segment shown as the company). Checked by earnings_packet_audit.py."""
    L = rel["lines"]
    ni, eps = (L.get("net_income") or {}).get("cur"), (L.get("eps_diluted") or {}).get("cur")
    if shares and ni and eps and abs(eps) > 0.05 and not 0.5 <= abs(ni) * 1e6 / abs(eps) / shares <= 2:
        L.pop("eps_diluted")   # net income ÷ EPS ≠ share count → the EPS row is another column or section (USB 10-15)
    rv = (L.get("revenue") or {}).get("cur")
    if not (fh_revenue and rv):
        return
    r = rv * 1e6 / fh_revenue
    f = 1 / 1000 if 900 < r < 1100 else 1000 if 0.0009 < r < 0.0011 else None   # missed '(in thousands)' / '(in billions)'
    if f:
        t_rev = rel["lines"]["revenue"].get("t")
        for k, ln in rel["lines"].items():
            if k != "eps_diluted" and ln.get("t") == t_rev:
                ln.update(cur=ln["cur"] * f, prior=ln["prior"] * f if ln["prior"] is not None else None)
    elif abs(r - 1) > 0.2:
        for k in ("revenue", "operating_income", "other_income", "pretax", "tax", "net_income"):
            rel["lines"].pop(k, None)


def bridge(lines: dict) -> dict:
    """Operating vs non-operating, tax rate, FCF; current quarter vs a year ago. Missing lines stay None (never a stand-in 0)."""
    g = lambda k, w="cur": (lines.get(k) or {}).get(w)  # noqa: E731
    out: dict = {}
    for k in ("revenue", "operating_income", "net_income", "eps_diluted", "ffo_per_share"):
        c, p = g(k), g(k, "prior")
        out[k] = c
        y = round(100 * (c / p - 1), 1) if c is not None and p not in (None, 0) and p > 0 else None
        out[k + "_yoy_pct"] = y if y is None or abs(y) <= 500 else None   # > 5× = a mismatched prior column, not news
    oi, pt, rev = g("operating_income"), g("pretax"), g("revenue")
    out["op_margin_pct"] = round(100 * oi / rev, 1) if oi is not None and rev else None
    pm = g("operating_income", "prior"), g("revenue", "prior")
    out["op_margin_prior_pct"] = round(100 * pm[0] / pm[1], 1) if None not in pm and pm[1] else None
    if oi is not None and pt is not None:
        out["non_operating"] = round(pt - oi, 3)
        out["non_operating_share_of_pretax_pct"] = round(100 * (pt - oi) / pt, 1) if pt else None
        ppt, poi = g("pretax", "prior"), g("operating_income", "prior")
        out["non_operating_prior"] = round(ppt - poi, 3) if None not in (ppt, poi) else None
    tax = g("tax")
    tr = round(100 * abs(tax) / pt, 1) if tax is not None and pt else None
    out["tax_rate_pct"] = tr if tr is not None and pt > 0 and tr <= 60 else None   # loss years / wrong row → no rate
    cfo, capex = g("cfo"), g("capex")
    if cfo is not None and capex is not None:
        sfx = "_ytd" if (lines.get("cfo") or {}).get("ytd") else ""   # year-to-date only → never shown as the quarter
        out["fcf" + sfx] = round(cfo - abs(capex), 3)
        pc, pk = g("cfo", "prior"), g("capex", "prior")
        out["fcf" + sfx + "_prior"] = round(pc - abs(pk), 3) if None not in (pc, pk) else None
    if g("fcf_reported") is not None:   # the company's own definition (net of proceeds / leases) wins when it reports one
        out["fcf_company"], out["fcf_company_prior"] = g("fcf_reported"), g("fcf_reported", "prior")
    return out


_QWORD = {1: "first", 2: "second", 3: "third", 4: "fourth"}


def one_offs(text: list[str], quarter: int | None = None, limit: int = 12) -> list[str]:
    """Release sentences naming a $ amount next to a one-off word (the LLM picks from these; it never invents one).
    Table footnotes ('(f)Included a $4.6 billion…') belong to one column — often another quarter (JPM 10-13: the Visa gain was Q2) —
    so a footnote is kept only when it names this quarter."""
    out = []
    this_q = re.compile(rf"\b({_QWORD.get(quarter, 'x')} quarter|Q{quarter}\b|{quarter}Q\d\d)", re.I) if quarter else None
    for para in text:
        for s in re.split(r"(?<=[.;])\s+(?=[A-Z(])", para):
            if not (MONEY.search(s) and ONE_OFF.search(s) and 30 < len(s) < 600) or s in out:
                continue
            if re.match(r"^\(?[a-z\d]\)\s?", s) and not (this_q and this_q.search(s)):
                continue
            out.append(s)
    return out[:limit]


def find_release(conn, ticker: str, rd: date) -> tuple[str, bytes, date] | None:
    """The earnings 8-K (item 2.02) filed report_date − 1 … + 3 → its ex-99.1 press release."""
    cik = cik_for(conn, ticker)
    if not cik:
        return None
    sub = _get_json(f"https://data.sec.gov/submissions/CIK{cik}.json")["filings"]["recent"]
    for i, form in enumerate(sub["form"]):
        fd = date.fromisoformat(sub["filingDate"][i])
        if fd < rd - timedelta(days=1):
            break
        if form != "8-K" or "2.02" not in (sub.get("items") or [""] * (i + 1))[i] or fd > rd + timedelta(days=3):
            continue
        acc = sub["accessionNumber"][i].replace("-", "")
        base = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc}/"
        names = [x["name"] for x in _get_json(base + "index.json")["directory"]["item"]]
        ex = sorted(n for n in names if n.lower().endswith((".htm", ".html")) and re.search(r"99[._-]?0?\d(?!\d)|ex99|ex-99", n.lower()))
        if not ex:   # unnamed exhibits: every non-primary .htm
            ex = [n for n in names if n.lower().endswith(".htm") and n != sub["primaryDocument"][i] and not n.startswith("R")]
        if ex:   # 99.1 press release first, then 99.2/99.3 (AT&T keeps the consolidated statements there)
            return base + ex[0], b"\n".join(_get(base + n) for n in ex[:3]), fd
    return None


def _street_revenue(ticker: str, rd: date) -> dict:
    """Finnhub calendar row for the report: revenue estimate/actual (EPS too, as a cross-check)."""
    import transcripts
    try:
        vendor_gate.wait("Finnhub")
        r = transcripts.get_json(f"https://finnhub.io/api/v1/calendar/earnings?symbol={ticker}&from={rd - timedelta(days=3)}"
                                 f"&to={rd + timedelta(days=3)}&token={transcripts.env('FINNHUB_API_KEY')}", 20)
        x = next(iter(r.get("earningsCalendar") or []), None) or {}
        return {k: x.get(k) for k in ("epsEstimate", "epsActual", "revenueEstimate", "revenueActual", "hour", "quarter", "year")}
    except Exception as e:  # noqa: BLE001 — street numbers are optional context, never a blocker
        return {"error": str(e)[:120]}


_STOP = {"the", "bank", "first", "american", "general", "united", "international", "national", "global", "group", "holdings", "corp"}


def company_name(conn, ticker: str) -> str | None:
    """SEC registrant name ('Alphabet Inc.') — the briefs say 'Alphabet', rarely 'GOOGL'."""
    cik = cik_for(conn, ticker)
    return _get_json(f"https://data.sec.gov/submissions/CIK{cik}.json").get("name") if cik else None


_EARN = re.compile(r"\b(results?|quarter(ly)?|revenue|sales|guidance|guide[ds]?|outlook|forecast|capex|capital (spending|expenditure)|margins?|"
                   r"beat|miss(ed)?|topped|fell short|shares (fell|rose|jumped|slid|dropped|climbed|sank|surged)|"
                   r"(fell|rose|jumped|slid|dropped|climbed|sank|surged) \d|after[- ]hours|reported|earnings|profit|cloud|backlog|demand)\b", re.I)
_PREVIEW = re.compile(r"\b(will report|reports? (later|after|before|on)|ahead of|expect(s|ed)? a .{0,20}move|due (to report|out)|preview|"
                      r"set to report|on deck|to watch)\b", re.I)


def briefs_for(conn, ticker: str, name: str | None, filed: date, hour: str | None = None, limit: int = 8) -> list[dict]:
    """Post-print sentences naming the company in desk_commentaries (Jamie's tradedash-brief label), 8-K day → 2 days after.
    After-close reports start at 13:00 PT on the filing day (earlier mail is preview). Ranked by earnings words; tables,
    links and previews dropped; ≤ 2 per source."""
    stem = next((w for w in re.findall(r"[A-Za-z][A-Za-z&'.-]+", name or "") if len(w) >= 4 and w.lower() not in _STOP), None)
    alts = [re.escape(ticker)] + ([re.escape(ticker[:-1])] if ticker in ("GOOGL",) else []) + ([re.escape(stem.rstrip(".,"))] if stem else [])
    rx = re.compile(r"\b(" + "|".join(alts) + r")\b")
    start = f"{filed} 13:00" if (hour or "").lower() == "amc" else f"{filed} 04:00"
    cands = []
    for r in rows(conn, """SELECT source, subject, received_at, body_plain FROM desk_commentaries
                           WHERE received_at >= %s::timestamp AT TIME ZONE 'America/Los_Angeles' AND received_at < %s::date + 3
                             AND COALESCE(noise_score, 0) < 50 AND body_plain ~ %s ORDER BY received_at""",
                  (start, filed, rx.pattern.replace("\\b", "\\y"))):
        body = re.sub(r"<https?://[^>]*>|https?://\S+", "", r["body_plain"] or "").replace("*", "")
        sents = [x.strip(" -–") for x in re.split(r"(?<=[.!?])\s+|\s*[•·▪]\s*|\[ \]", " ".join(body.split())) if x.strip()]
        for x in sents:   # the matching sentence / bullet only — neighbours in a digest are other companies
            if not rx.search(x) or len(x) < 40 or _PREVIEW.search(x):
                continue
            if sum(ch.isdigit() for ch in x) > 0.25 * len(x):   # quote tables
                continue
            score = len(_EARN.findall(x))
            if score:
                cands.append((score, r, x[:450]))
    out, per = [], {}
    for score, r, txt in sorted(cands, key=lambda c: -c[0]):
        if per.get(r["source"], 0) >= 2 or any(txt[:80] in o["text"] or o["text"][:80] in txt for o in out):
            continue
        per[r["source"]] = per.get(r["source"], 0) + 1
        out.append({"source": r["source"], "subject": r["subject"], "at": str(r["received_at"])[:16], "text": txt})
        if len(out) >= limit:
            break
    return out


def _store_raw(conn, url: str, ticker: str, raw: bytes) -> None:
    conn.execute("""INSERT INTO vendor_raw (source, endpoint, key, fetched_on, payload, payload_sha)
                    VALUES ('edgar', '8k_ex99_1', %s, %s, %s::jsonb, %s)
                    ON CONFLICT (source, endpoint, key, fetched_on) DO UPDATE SET payload = EXCLUDED.payload, payload_sha = EXCLUDED.payload_sha""",
                 (f"{ticker}:{url.rsplit('/', 2)[-2]}", date.today(), json.dumps({"url": url, "html": raw.decode("utf-8", "replace")}),
                  hashlib.sha256(raw).hexdigest()))


def build(conn, ticker: str, rd: date) -> dict | None:
    """Fetch + parse + store one packet. None (status no_release) when no 8-K is filed yet — retried by the caller."""
    import earnings_notes
    conn.execute(DDL)
    got = find_release(conn, ticker, rd)
    if not got:
        conn.execute("""INSERT INTO watchlist_sync.earnings_packets (ticker, report_date, status) VALUES (%s, %s, 'no_release')
                        ON CONFLICT (ticker, report_date) DO UPDATE SET tries = earnings_packets.tries + 1, built_at = now()""",
                     (ticker, rd))
        conn.commit()
        return None
    url, raw, filed = got
    if rows(conn, """SELECT 1 FROM watchlist_sync.earnings_packets WHERE ticker = %s AND source_url = %s AND report_date <> %s
                     AND status = 'ok'""", (ticker, url, rd)):
        # two calendar dates for one report (stale vendor date, A317): the 8-K already has a packet under the other date
        conn.execute("""INSERT INTO watchlist_sync.earnings_packets (ticker, report_date, status, source_url) VALUES (%s, %s, 'dup', %s)
                        ON CONFLICT (ticker, report_date) DO UPDATE SET status = 'dup', source_url = EXCLUDED.source_url""", (ticker, rd, url))
        conn.commit()
        return None
    _store_raw(conn, url, ticker, raw)
    street = _street_revenue(ticker, rd)
    rel = parse_release(raw, street.get("revenueActual"))
    sh = rows(conn, "SELECT fmp_shares_outstanding::float8 s FROM fmp_fundamentals WHERE ticker = %s", (ticker,))
    sanity_vs_street(rel, street.get("revenueActual"), sh[0]["s"] if sh else None)
    cal = rows(conn, "SELECT eps_actual::float8 a, eps_estimate::float8 e FROM earnings_calendar WHERE ticker = %s AND report_date = %s",
               (ticker, rd))
    tr = rows(conn, """SELECT quarter, summary FROM watchlist_sync.earnings_transcripts
                       WHERE ticker = %s AND status = 'ok' AND fetched_at::date BETWEEN %s AND %s::date + 30
                       ORDER BY fetched_at DESC LIMIT 1""", (ticker, rd, rd))
    pk = {
        "ticker": ticker, "report_date": str(rd), "filed": str(filed), "source_url": url, "unit": rel["unit"],
        "lines": rel["lines"], "bridge": bridge(rel["lines"]), "one_offs": one_offs(rel["text"], street.get("quarter")),
        "street": {"eps_estimate": cal[0]["e"] if cal else None, "eps_actual": cal[0]["a"] if cal else None,
                   **{"finnhub_" + k: v for k, v in street.items()}},
        "reaction": earnings_notes._reaction(conn, ticker, filed),   # the 8-K date is the real report date
        "call": tr[0]["summary"] if tr else None,
        "name": (name := company_name(conn, ticker)),
        "briefs": briefs_for(conn, ticker, name, filed, street.get("hour")),
        "tables": rel["tables"][:14],
        "highlights": [s for s in rel["text"] if (MONEY.search(s) or "%" in s) and not re.match(r"^\(?[a-z\d]\)\s?", s)][:25],
    }
    conn.execute("""INSERT INTO watchlist_sync.earnings_packets (ticker, report_date, status, source_url, packet)
                    VALUES (%s, %s, 'ok', %s, %s::jsonb)
                    ON CONFLICT (ticker, report_date) DO UPDATE SET status = 'ok', source_url = EXCLUDED.source_url,
                    packet = EXCLUDED.packet, tries = earnings_packets.tries + 1, built_at = now()""",
                 (ticker, rd, url, json.dumps(pk, default=str)))
    conn.commit()
    return pk


if __name__ == "__main__":
    t = sys.argv[sys.argv.index("--print") + 1].upper()
    with connect() as c:
        if "--date" in sys.argv:
            d = date.fromisoformat(sys.argv[sys.argv.index("--date") + 1])
        else:
            d = rows(c, "SELECT max(report_date) d FROM earnings_calendar WHERE ticker = %s AND report_date <= CURRENT_DATE", (t,))[0]["d"]
        pk = build(c, t, d)
        if not pk:
            print(f"{t} {d}: no earnings 8-K yet")
        else:
            for k in ("source_url", "lines", "bridge", "one_offs", "street", "reaction"):
                print(k, "=", json.dumps(pk[k], default=str, indent=1) if k != "source_url" else pk[k])
            print("tables:", len(pk["tables"]), "· highlights:", len(pk["highlights"]), "· call:", bool(pk["call"]))
