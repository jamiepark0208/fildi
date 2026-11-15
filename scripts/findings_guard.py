#!/usr/bin/env python3
"""Findings can't vanish; verdicts can't outrun open bugs (Jamie 11-15).

11-07: Muse filed A374/A375 (High engine bugs). Claude marked them "declined (merged into A359 fix)" — the
rows left every queue and nothing was built for 8 days, while BOARD kept verdicts from the buggy engine.

Rules (exit 1 = blocked when run with --strict, from scripts/asks-check.sh):
  F1  A "(High)" row may leave the open states (declined / done / verified / archived) only with a fix
      commit SHA in its status cell or a "**Fixed in:** <sha>" line in its file. "merged into X" is not a fix.
  F2  (advisory) A BOARD row that cites an ask with an OPEN "(High)" REVIEW row must be marked
      framing? / void / pending — else the verdict is printed as unsafe.
  F3  (advisory) Open "(High)" rows older than 3 days with no SHA → listed for the owner.
  F1 also fires on "done (… uncommitted)": 11-15 audit found A363/A364/A377 fixes marked done but left
      uncommitted for 8 days — every clean checkout (Muse, CI) still ran the bugs.

  python3 scripts/findings_guard.py            # report
  python3 scripts/findings_guard.py --strict   # exit 1 on F1
"""
from __future__ import annotations

import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASKS = ROOT / "research" / "common" / "ASKS.md"
BOARD = ROOT / "research" / "studies" / "BOARD.md"
SHA = re.compile(r"\b[0-9a-f]{7,40}\b")
OPEN = ("open", "planned", "revise", "accepted", "blocked", "needs", "sign-off")
SINCE = "2026-11-15"   # F1 applies to rows closed after this rule shipped; older closures are reported only


def rows():
    for ln in ASKS.read_text().splitlines():
        m = re.match(r"\|\s*\[(A\d+)\]\([^)]*\)\s*\|\s*([\d-]+)\s*\|[^|]*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*$", ln)
        if m:
            yield m.group(1), m.group(2), m.group(3), m.group(4)


def file_has_fix(aid: str) -> bool:
    p = ROOT / "research" / "common" / "asks" / f"{aid}.md"
    if not p.exists():
        return False
    t = p.read_text()
    return bool(re.search(r"\*\*Fixed in:\*\*\s*\S*[0-9a-f]{7,40}", t))


def main(strict: bool) -> int:
    f1, f3, open_high = [], [], {}
    for aid, date, title, status in rows():
        if "(High)" not in title:
            continue
        st = status.lower()
        is_open = st.startswith(OPEN)
        has_sha = bool(SHA.search(status)) or file_has_fix(aid)
        if is_open:
            open_high[aid] = title
            age = time.time() - time.mktime(time.strptime(date, "%Y-%m-%d"))
            if age > 3 * 86400 and not has_sha:
                f3.append(f"{aid} ({date}) {title[:70]}")
        elif not has_sha or "uncommitted" in st:
            f1.append(f"{aid} '{status[:60]}' — {title[:60]}")
    # F2: BOARD rows citing an ask that has an open High review naming it
    cited_by_open = {}
    for aid, title in open_high.items():
        p = ROOT / "research" / "common" / "asks" / f"{aid}.md"
        head = p.read_text()[:1500] if p.exists() else title
        for tgt in set(re.findall(r"\bA\d{2,4}\b", title + " " + head)) - {aid}:
            cited_by_open.setdefault(tgt, []).append(aid)
    f2 = []
    for ln in BOARD.read_text().splitlines():
        if not ln.startswith("|"):
            continue
        for tgt in set(re.findall(r"\bA\d{2,4}\b", ln)):
            if tgt in cited_by_open and not re.search(r"framing\?|void|pending|suspended", ln, re.I):
                f2.append(f"BOARD '{ln[2:60]}…' cites {tgt}; open High: {', '.join(cited_by_open[tgt])}")
    for name, xs, hint in (
        ("F1 High row closed without a fix SHA", f1, "add the fix SHA to the status or a **Fixed in:** line; 'merged' is not a fix"),
        ("F2 verdict on code with an open High finding", f2, "mark the BOARD row framing? until the fix lands"),
        ("F3 open High > 3 d, no fix yet", f3, "owner builds it or re-routes today"),
    ):
        if xs:
            print(f"{name}: {len(xs)} → {hint}")
            for x in xs[:12]:
                print("   ", x)
    if not (f1 or f2 or f3):
        print("findings_guard: ok")
    return 1 if (strict and f1) else 0


if __name__ == "__main__":
    sys.exit(main("--strict" in sys.argv))
