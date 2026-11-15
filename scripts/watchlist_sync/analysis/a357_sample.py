"""A357 sampled backfill — tercile picks (same RNG as a357_regrade._tercile_book)."""
from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import asdict, dataclass
from datetime import date
from pathlib import Path
from typing import Any

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SAMPLE_PATH = ROOT / "logs" / "a357-sample-selection.json"
WEEK_FLOOR = date(2025, 10, 20)
MIN_GROUP = 20


def event_key(t: str, d: date, expiry: date) -> tuple[str, str, str]:
    return (t.upper(), d.isoformat(), expiry.isoformat())


def _key_tuple(key: tuple[str, str, str]) -> tuple[str, date, date]:
    return key[0], date.fromisoformat(key[1]), date.fromisoformat(key[2])


def pick_tercile_tags(g: list[dict], d: date) -> dict[tuple[str, date, date], str]:
    """champion / random / both — mirrors _tercile_book index picks on full group `g`."""
    ranked = sorted(g, key=lambda x: (-x["score"], x["t"]))
    n = max(1, len(g) // 3)
    top_keys = {(e["t"], e["d"], e["expiry"]) for e in ranked[:n]}
    rng = np.random.default_rng(int(d.strftime("%Y%m%d")))
    pick = rng.choice(len(g), size=n, replace=False)
    rand_keys = {(g[i]["t"], g[i]["d"], g[i]["expiry"]) for i in pick}
    out: dict[tuple[str, date, date], str] = {}
    for key in top_keys | rand_keys:
        in_top, in_rand = key in top_keys, key in rand_keys
        if in_top and in_rand:
            out[key] = "both"
        elif in_top:
            out[key] = "champion"
        else:
            out[key] = "random"
    return out


@dataclass(frozen=True)
class SampleEvent:
    t: str
    d: str
    expiry: str
    book: str
    score: float

    def entry(self) -> date:
        return date.fromisoformat(self.d)

    def expiry_date(self) -> date:
        return date.fromisoformat(self.expiry)


def build_sample_plan(scored_rows: list[dict]) -> tuple[list[SampleEvent], dict[str, Any]]:
    by_d: dict[date, list[dict]] = defaultdict(list)
    for e in scored_rows:
        if e["d"] >= WEEK_FLOOR:
            by_d[e["d"]].append(e)

    events: list[SampleEvent] = []
    qualifying_days: list[str] = []
    for d in sorted(by_d):
        g = by_d[d]
        if len(g) < MIN_GROUP:
            continue
        qualifying_days.append(d.isoformat())
        tags = pick_tercile_tags(g, d)
        by_key = {(e["t"], e["d"], e["expiry"]): e for e in g}
        for key, book in tags.items():
            e = by_key[key]
            events.append(
                SampleEvent(
                    t=e["t"],
                    d=d.isoformat(),
                    expiry=e["expiry"].isoformat(),
                    book=book,
                    score=float(e["score"]),
                )
            )

    unique_pairs = len({(e.t.upper(), e.expiry) for e in events})
    meta = {
        "version": 1,
        "week_floor": WEEK_FLOOR.isoformat(),
        "qualifying_days": qualifying_days,
        "n_days": len(qualifying_days),
        "n_events": len(events),
        "n_unique_ticker_expiry": unique_pairs,
        "estimated_lse_calls": unique_pairs + len(events),
    }
    return events, meta


def save_sample_plan(events: list[SampleEvent], meta: dict[str, Any]) -> None:
    SAMPLE_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {**meta, "events": [asdict(e) for e in events]}
    SAMPLE_PATH.write_text(json.dumps(payload, indent=2))


def load_sample_plan() -> tuple[list[SampleEvent], dict[str, Any]] | None:
    if not SAMPLE_PATH.is_file():
        return None
    raw = json.loads(SAMPLE_PATH.read_text())
    events = [SampleEvent(**row) for row in raw.get("events", [])]
    meta = {k: v for k, v in raw.items() if k != "events"}
    return events, meta


def scored_rows_by_day(scored_rows: list[dict]) -> dict[date, list[dict]]:
    by_d: dict[date, list[dict]] = defaultdict(list)
    for e in scored_rows:
        if e["d"] >= WEEK_FLOOR:
            by_d[e["d"]].append(e)
    return by_d
