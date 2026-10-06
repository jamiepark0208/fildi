#!/usr/bin/env python3
"""CRSP post-earn event windows (CAR) from local wrds_research caches.

Labels earnings announcement windows for research / track-record studies.
Does not rewrite P&L. Requires sync_crsp + ibes_surpsum (+ W1 permno map).

Usage:
  cd research/wrds && .venv/bin/python event_windows.py --universe book
  .venv/bin/python event_windows.py --tickers NVDA --pre 1 --post 5 --json
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

from db import connect_local, ensure_schema, log_pull, upsert_sync_state
from universe import add_universe_args, resolve_universe

DATASET = "event_windows"


def _f(v):
    if v is None:
        return None
    try:
        x = float(v)
        return x if math.isfinite(x) else None
    except (TypeError, ValueError):
        return None


def cumret(rets: list[float]) -> float | None:
    if not rets:
        return None
    acc = 1.0
    for r in rets:
        acc *= 1.0 + r
    return acc - 1.0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    add_universe_args(p)
    p.add_argument("--pre", type=int, default=1, help="Trading days before anndats")
    p.add_argument("--post", type=int, default=5, help="Trading days after anndats")
    p.add_argument("--json", action="store_true")
    p.add_argument("--limit-events", type=int, default=8, help="Per-ticker surprise rows")
    args = p.parse_args()
    tickers = resolve_universe(args)

    events = []
    with connect_local() as conn:
        ensure_schema(conn)
        for t in tickers:
            row = conn.execute(
                """
                SELECT COALESCE(ibes_oftic, ticker), crsp_permno
                FROM research_common.security_map WHERE ticker = %s
                """,
                (t,),
            ).fetchone()
            oftic = (row[0] if row else t) or t
            permno = row[1] if row else None
            if not permno:
                # fallback from crsp_dsf ticker column
                p2 = conn.execute(
                    "SELECT permno FROM wrds_research.crsp_dsf WHERE UPPER(ticker)=%s LIMIT 1",
                    (t,),
                ).fetchone()
                permno = p2[0] if p2 else None
            if not permno:
                continue

            # CRSP lags (~year-end); only use surprises inside the local CRSP window.
            crsp_max = conn.execute(
                "SELECT MAX(date) FROM wrds_research.crsp_dsf WHERE permno = %s",
                (permno,),
            ).fetchone()[0]
            if not crsp_max:
                continue
            surps = conn.execute(
                """
                SELECT DISTINCT ON (anndats)
                       anndats, suescore, actual, surpmean
                FROM wrds_research.ibes_surpsum
                WHERE UPPER(oftic)=%s AND anndats IS NOT NULL AND anndats <= %s
                ORDER BY anndats DESC, (suescore IS NULL), abs(COALESCE(suescore,0)) DESC
                LIMIT %s
                """,
                (str(oftic).upper(), crsp_max, args.limit_events),
            ).fetchall()

            for anndats, sue, actual, surpmean in surps:
                # Pull a buffer of daily rets around the event
                days = conn.execute(
                    """
                    SELECT date, ret FROM wrds_research.crsp_dsf
                    WHERE permno = %s AND ret IS NOT NULL
                      AND date BETWEEN %s::date - 30 AND %s::date + 40
                    ORDER BY date
                    """,
                    (permno, anndats, anndats),
                ).fetchall()
                if not days:
                    continue
                dates = [d for d, _ in days]
                rets = [_f(r) for _, r in days]
                # index of first date >= anndats
                idx = next((i for i, d in enumerate(dates) if d >= anndats), None)
                if idx is None:
                    continue
                pre_slice = [r for r in rets[max(0, idx - args.pre) : idx] if r is not None]
                # include announcement day in post window
                post_slice = [r for r in rets[idx : idx + args.post] if r is not None]
                car_pre = cumret(pre_slice)
                car_post = cumret(post_slice)
                events.append({
                    "ticker": t,
                    "oftic": oftic,
                    "permno": int(permno),
                    "anndats": str(anndats)[:10],
                    "sue": _f(sue),
                    "actual": _f(actual),
                    "surpmean": _f(surpmean),
                    "car_pre": round(car_pre, 4) if car_pre is not None else None,
                    "car_post": round(car_post, 4) if car_post is not None else None,
                    "n_pre": len(pre_slice),
                    "n_post": len(post_slice),
                })

        upsert_sync_state(
            conn,
            dataset=DATASET,
            watermark=datetime.now(timezone.utc).date().isoformat(),
            rows=len(events),
            tickers=tickers,
            notes=f"pre={args.pre} post={args.post}",
        )
        log_pull(conn, dataset=DATASET, status="ok", tickers=tickers, rows=len(events))
        conn.commit()

    report = {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "pre": args.pre,
        "post": args.post,
        "n": len(events),
        "events": events,
    }
    out_path = Path(__file__).resolve().parents[1] / "common" / "out" / "event_windows.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(f"{len(events)} event windows → {out_path}")
        for e in events[:15]:
            print(
                f"  {e['ticker']:6s} {e['anndats']} sue={e['sue']} "
                f"car_pre={e['car_pre']} car_post={e['car_post']}"
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
