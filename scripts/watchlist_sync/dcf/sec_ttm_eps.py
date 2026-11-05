"""Shared SEC TTM diluted EPS (A329 seg3 r5) — sec_gold_fields + stock-db-audit-l2."""
from __future__ import annotations

from datetime import date

import financials as F

EPS_DILUTED = [
    "EarningsPerShareDiluted",
    "EarningsPerShareBasicAndDiluted",
    "EarningsPerShareBasic",
]


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
            continue
        mags = sorted(abs(q["val"]) for q in chain)
        if mags[1] > 0.05 and mags[-1] > 6 * mags[1]:
            return None
        derived = sum(1 for q in chain if q.get("derived"))
        return {
            "value": sum(q["val"] for q in chain),
            "end": chain[0]["end"],
            "how": f"4Q diluted {c}" + (f" (Q4=FY−9M ×{derived})" if derived else ""),
            "concept": c,
        }
    return None
