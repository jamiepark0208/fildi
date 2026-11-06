"""Shared SEC TTM diluted EPS (A329 seg3 r5) — sec_gold_fields + stock-db-audit-l2."""
from __future__ import annotations

from datetime import date

import financials as F

EPS_DILUTED = [
    "EarningsPerShareDiluted",
    "EarningsPerShareBasicAndDiluted",
    "EarningsPerShareBasic",
]


STALE_EPS_TAG_DAYS = 45
YTD_DAYS_BY_FP = {"Q1": (77, 100), "Q2": (160, 200), "Q3": (240, 290)}


def latest_filed_period_end(facts: dict, anchor: str) -> str | None:
    """Newest 10-Q/10-K period end the filer reported (net income or equity), on/before anchor."""
    ends = [u["end"] for c in ("NetIncomeLoss", "StockholdersEquity") for u in F._units(facts, c) if u["end"] <= anchor]
    return max(ends) if ends else None


def has_quarterly_eps_facts(facts: dict) -> bool:
    gaap = (facts or {}).get("facts", {}).get("us-gaap") or {}
    for c in EPS_DILUTED:
        node = gaap.get(c)
        if not node:
            continue
        for unit in node.get("units", {}).get("USD/shares", []):
            if unit.get("start") and F._days(unit["start"], unit["end"]) < 100:
                return True
    return False


def _latest_filed(units: list[dict]) -> dict[tuple[str, str], dict]:
    """One fact per (start, end): the latest filing wins (split-adjusted restatements, e.g. NOW 5:1)."""
    best: dict[tuple[str, str], dict] = {}
    for u in units:
        if not u.get("start"):
            continue
        k = (u["start"], u["end"])
        if k not in best or (u.get("filed") or "") > (best[k].get("filed") or ""):
            best[k] = u
    return best


def ttm_eps_diluted(facts: dict, anchor_end: str | None = None) -> dict | None:
    """TTM diluted EPS = four contiguous quarters ending on/before anchor.
    Q4 is rarely tagged alone (10-K reports FY only) → derive it as FY − 9M YTD."""
    anchor = anchor_end or date.today().isoformat()
    gaap = (facts or {}).get("facts", {}).get("us-gaap") or {}
    for c in EPS_DILUTED:
        node = gaap.get(c)
        if not node:
            continue
        raw = node.get("units", {}).get("USD/shares", [])
        facts_by = _latest_filed(raw)
        quarters: dict[str, dict] = {}
        for (st, en), u in facts_by.items():
            if 80 <= F._days(st, en) <= 100 and en <= anchor:
                quarters[en] = {"start": st, "end": en, "val": float(u["val"])}
        for (st, en), fy in facts_by.items():
            if not (350 <= F._days(st, en) <= 380) or en > anchor or en in quarters:
                continue
            ytd9 = [
                u
                for u in raw
                if u.get("start") == st
                and 260 <= F._days(st, u["end"]) <= 285
                and (u.get("filed") or "") <= (fy.get("filed") or "9999")
            ]
            if ytd9:
                y = max(ytd9, key=lambda u: (u["end"], u.get("filed") or ""))
                quarters[en] = {
                    "start": y["end"],
                    "end": en,
                    "val": float(fy["val"]) - float(y["val"]),
                    "derived": True,
                }
        if not quarters:
            continue
        chain = [quarters[max(quarters)]]
        while len(chain) < 4:
            prev = [
                q
                for e, q in quarters.items()
                if abs(F._days(e, chain[-1]["start"])) <= 7 and e < chain[-1]["end"]
            ]
            if not prev:
                break
            chain.append(max(prev, key=lambda q: q["end"]))
        if len(chain) < 4:
            ytd = _ttm_from_ytd(facts_by, anchor)
            if ytd and _fresh(facts, ytd["end"], anchor):
                return {**ytd, "how": f"FY + YTD − prior YTD {c}", "concept": c}
            continue
        mags = sorted(abs(q["val"]) for q in chain)
        if mags[1] > 0.05 and mags[-1] > 6 * mags[1]:
            return None
        derived = sum(1 for q in chain if q.get("derived"))
        if not _fresh(facts, chain[0]["end"], anchor):
            return None   # EPS tag stopped while the filer kept reporting (RNR → two-class tags after Q1'26)
        return {
            "value": sum(q["val"] for q in chain),
            "end": chain[0]["end"],
            "how": f"4Q diluted {c}" + (f" (Q4=FY−9M ×{derived})" if derived else ""),
            "concept": c,
        }
    return None


def _fresh(facts: dict, eps_end: str, anchor: str) -> bool:
    latest = latest_filed_period_end(facts, anchor)
    return not latest or F._days(eps_end, latest) <= STALE_EPS_TAG_DAYS


def _ttm_from_ytd(facts_by: dict, anchor: str) -> dict | None:
    """Quarter chain broken (MDB: Oct-25 10-Q untagged) → TTM = last FY + current YTD − same YTD a year earlier."""
    fys = {en: (st, u) for (st, en), u in facts_by.items() if 350 <= F._days(st, en) <= 380 and en <= anchor}
    best = None
    for (st, en), u in facts_by.items():
        n = F._days(st, en)
        # YTD length must fit its fiscal period (52/53-week calendars: KR Q2 195 d, PEP Q3 251 d);
        # a fiscal-year change is not a YTD (FDX "Q3" = 4-month transition Jun–Sep 26 → fake 35.98)
        lo_hi = YTD_DAYS_BY_FP.get(u.get("fp") or "")
        if not lo_hi or not lo_hi[0] <= n <= lo_hi[1] or en > anchor:
            continue
        fy = next(((fst, fu) for fen, (fst, fu) in fys.items() if 0 < F._days(fen, st) <= 3), None)
        if not fy:
            continue
        prior = [pu for (pst, pen), pu in facts_by.items()
                 if abs(F._days(fy[0], pst)) <= 3 and abs(F._days(pst, pen) - n) <= 7]
        if not prior:
            continue
        cand = {"value": float(fy[1]["val"]) + float(u["val"]) - float(prior[0]["val"]), "end": en}
        if not best or en > best["end"]:
            best = cand
    return best

