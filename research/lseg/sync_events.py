"""Forward corporate events → lseg_research.events + research/common/out/earnings_watch.json.

The JSON is the loop-C hand-off (research/LSEG_WRDS_SYNC.md §3.5): WRDS reads it to run
sync_ibes.py --tickers … --force only for names with earnings inside the horizon.

Usage: .venv/bin/python sync_events.py [--tickers … | --universe book|registry] [--days 60] [--watch-days 14]
"""
from __future__ import annotations

import argparse
import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from _session import coverage_tickers, add_lseg_universe_args, resolve_lseg_universe, RESEARCH, clean, connect_local, load_ric_map, lseg_session
from db import ensure_schema, log_pull, upsert_sync_state

DATASET = "events"
WATCH_PATH = RESEARCH / "common" / "out" / "earnings_watch.json"
EARNINGS_TYPES = {"EarningsReleases"}
WRDS_MAX = 50  # research/LSEG_WRDS_SYNC.md §3.1 narrow-pull cap for the WRDS hand-off
# Issuer-level events only. Excluded on purpose: ExDividends / StockSplits (rows come from foreign
# depositary listings, e.g. JPMC34Q.SA in BRL, AMD0.HA "1:7 split"), Conferences / SyndicateRoadshows
# (broker-hosted — JPM shows every JPMorgan conference).
KEEP_TYPES = EARNINGS_TYPES | {
    "EarningsCallsAndPresentations",
    "CorporateAnalystMeetings",
    "ShareholderAndAnnualMeetings",
    "CorporateSalesRelease",
    "SalesConferenceCall",
    "GuidanceCalls",
    "MergersAndAcquisitions",
}

UPSERT = """
INSERT INTO lseg_research.events (ticker, ric, event_date, event_type, title, fetched_at)
VALUES (%s, %s, %s, %s, %s, %s)
ON CONFLICT (ticker, event_date, event_type) DO UPDATE SET
  ric = EXCLUDED.ric, title = EXCLUDED.title, fetched_at = EXCLUDED.fetched_at
"""


def fetch(ld, rics: list[str], days: int) -> list[tuple[str, date, str, str | None]]:
    df = ld.get_data(
        rics,
        ["TR.EventStartDate", "TR.EventType", "TR.EventTitle"],
        {"SDate": date.today().isoformat(), "EDate": (date.today() + timedelta(days=days)).isoformat()},
    )
    out = []
    for _, r in df.iterrows():
        d, typ = clean(r.iloc[1]), clean(r.iloc[2])
        if d is None or typ not in KEEP_TYPES:
            continue
        out.append((r.iloc[0], d.date() if hasattr(d, "date") else d, typ, clean(r.iloc[3])))
    return out


def write_watch(events: list[dict], watch_days: int) -> dict:
    cutoff = date.today() + timedelta(days=watch_days)
    earn = sorted(
        (e for e in events if e["event_type"] in EARNINGS_TYPES and e["event_date"] <= cutoff),
        key=lambda e: (e["event_date"], e["ticker"]),
    )
    # WRDS lane caps pulls at 50: keep the highest-priority names (held > traded > watchlist > …).
    rank = {t: i for i, t in enumerate(coverage_tickers())}
    keep = sorted({e["ticker"] for e in earn}, key=lambda t: rank.get(t, 10_000))[:WRDS_MAX]
    earn = [e for e in earn if e["ticker"] in keep]
    payload = {
        "as_of": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "horizon_days": watch_days,
        "tickers": sorted({e["ticker"] for e in earn}),
        "events": [
            {"ticker": e["ticker"], "event_date": e["event_date"].isoformat(), "event_type": "Earnings"}
            for e in earn
        ],
    }
    WATCH_PATH.parent.mkdir(parents=True, exist_ok=True)
    WATCH_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return payload


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    add_lseg_universe_args(p)
    p.add_argument("--days", type=int, default=60, help="Event lookahead stored in lseg_research.events")
    p.add_argument("--watch-days", type=int, default=14, help="Earnings horizon for earnings_watch.json")
    args = p.parse_args()
    tickers = resolve_lseg_universe(args)
    ric_map = load_ric_map(tickers)
    no_ric = [t for t in tickers if t not in ric_map]
    if no_ric:
        print(f"warn: no RIC for {no_ric} — run sync_ids.py --tickers {','.join(no_ric)}")
    tickers = [t for t in tickers if t in ric_map]
    by_ric = {r: t for t, r in ric_map.items()}
    run_at = datetime.now(timezone.utc)
    horizon_end = date.today() + timedelta(days=args.days)

    with connect_local() as conn:
        ensure_schema(conn)
        try:
            with lseg_session() as ld:
                raw = fetch(ld, list(ric_map.values()), args.days)
        except Exception as e:
            log_pull(conn, dataset=DATASET, status="error", tickers=tickers, error=str(e)[:500])
            conn.commit()
            raise
        rows = [(by_ric[ric], ric, d, typ, title, run_at) for ric, d, typ, title in raw if ric in by_ric]
        with conn.cursor() as cur:
            cur.executemany(UPSERT, rows)
            # Rescheduled / cancelled: drop future in-window events not seen this run.
            cur.execute(
                """DELETE FROM lseg_research.events
                   WHERE ticker = ANY(%s) AND event_date BETWEEN %s AND %s AND fetched_at < %s""",
                (tickers, date.today(), horizon_end, run_at),
            )
            dropped = cur.rowcount
        upsert_sync_state(conn, dataset=DATASET, watermark=horizon_end.isoformat(), rows=len(rows),
                          tickers=tickers, notes=f"dropped {dropped} stale")
        log_pull(conn, dataset=DATASET, status="ok" if not no_ric else "partial", tickers=tickers,
                 rows=len(rows), watermark_from=date.today().isoformat(), watermark_to=horizon_end.isoformat())
        conn.commit()

    payload = write_watch(
        [{"ticker": r[0], "event_date": r[2], "event_type": r[3]} for r in rows], args.watch_days
    )
    print(f"{DATASET}: {len(rows)} events next {args.days}d ({dropped} stale dropped)")
    print(f"earnings_watch.json: {payload['tickers']} within {args.watch_days}d → {WATCH_PATH}")


if __name__ == "__main__":
    main()
