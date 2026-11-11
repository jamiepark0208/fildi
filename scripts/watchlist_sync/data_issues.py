"""Data-issue log (Jamie 11-11): a bad data point or a failed soft step never stops a job — it is skipped AND written here,
so the next agent session reviews it (agent_start step 11c) and fixes the producer / finds a better source.

  from data_issues import record
  record("structures", "bad_quote", ticker="QGEN", field="bid", detail="bid 0 / ask 4.9", value=None)

  data_issues.py digest [--days 2]   → one-line summary + top items (agent_start)
  data_issues.py list [--days 2]     → every item

One JSON line per issue in out/issues/YYYY-MM-DD.jsonl. Same (producer, kind, ticker, field) is written once per day.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path

DIR = Path(__file__).resolve().parent / "out" / "issues"
_seen: set = set()


def record(producer: str, kind: str, *, ticker: str | None = None, field: str | None = None, detail: str = "",
           value=None) -> None:
    """Never raises — logging an issue must not become the next failure."""
    try:
        key = (producer, kind, ticker, field)
        if key in _seen:
            return
        _seen.add(key)
        DIR.mkdir(parents=True, exist_ok=True)
        row = {"at": datetime.now().isoformat(timespec="seconds"), "producer": producer, "kind": kind, "ticker": ticker,
               "field": field, "value": value if isinstance(value, (int, float, str, type(None))) else str(value),
               "detail": str(detail)[:400]}
        with open(DIR / f"{date.today().isoformat()}.jsonl", "a") as f:
            f.write(json.dumps(row, default=str) + "\n")
    except Exception as e:  # noqa: BLE001
        print(f"data_issues: could not record {producer}/{kind}: {e}", file=sys.stderr)


def load(days: int = 2) -> list[dict]:
    out = []
    for i in range(days):
        p = DIR / f"{(date.today() - timedelta(days=i)).isoformat()}.jsonl"
        if p.is_file():
            for ln in p.read_text().splitlines():
                try:
                    out.append(json.loads(ln))
                except ValueError:
                    pass
    seen, uniq = set(), []
    for r in out:
        k = (r.get("producer"), r.get("kind"), r.get("ticker"), r.get("field"))
        if k not in seen:
            seen.add(k)
            uniq.append(r)
    return uniq


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["digest", "list"])
    ap.add_argument("--days", type=int, default=2)
    a = ap.parse_args()
    rows = load(a.days)
    if a.cmd == "list":
        for r in rows:
            print(json.dumps(r))
        return
    if not rows:
        print("data issues: none")
        return
    by = Counter((r["producer"], r["kind"]) for r in rows)
    top = " · ".join(f"{p}/{k} {n}" for (p, k), n in by.most_common(6))
    print(f"data issues ({a.days}d): {len(rows)} — {top} → review: data_issues.py list; fix the producer or the source, never re-run blind")


if __name__ == "__main__":
    main()
