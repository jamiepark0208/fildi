"""Monthly StarMine history → lseg_research.starmine_history (loop B input for WRDS calibration).

Only metrics with API history: Predicted Surprise (FQ1), Combined Alpha rank, and the I/B/E/S price-target mean.
ARM and Value-Momentum ranks have no history via the API (current value only, in signals_daily).
Incremental per (ticker, metric): names with no rows backfill from --start; others resume a month before their own last
observation (2026-10-05 fix: a single per-metric watermark meant newly covered tickers never got history). TTL 28d.

Usage: .venv/bin/python sync_starmine_history.py [--tickers … | --universe book] [--start 2019-01-01] [--force]
"""
from __future__ import annotations

import argparse
from datetime import date, datetime, timedelta, timezone

from _session import add_lseg_universe_args, resolve_lseg_universe, clean, connect_local, load_ric_map, lseg_session
from db import ensure_schema, get_last_ok, log_pull, record_attempts, recently_empty, upsert_sync_state

DATASET = "starmine_history"
TTL = timedelta(days=28)
METRICS = {
    "pred_surprise_pct_fq1": ("TR.EPSPreSurprisePct", {"Period": "FQ1"}),
    "combined_alpha_rank": ("TR.CombinedAlphaRegionRank", {}),
    # I/B/E/S consensus price target (not StarMine, same monthly-history shape): fair-value blend calibration —
    # target optimism bias + anchor weight are fit on this history. StarMine IV (TR.IVPriceToIntrinsicValue) has
    # no API history (current value only, in signals_daily).
    "pt_mean": ("TR.PriceTargetMean", {}),
}

UPSERT = """
INSERT INTO lseg_research.starmine_history (ticker, ric, metric, obs_date, value, fetched_at)
VALUES (%s, %s, %s, %s, %s, now())
ON CONFLICT (ticker, metric, obs_date) DO UPDATE SET value = EXCLUDED.value, fetched_at = now()
"""


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    add_lseg_universe_args(p)
    p.add_argument("--start", default="2019-01-01", help="Backfill start when a metric has no rows yet")
    args = p.parse_args()
    tickers = resolve_lseg_universe(args)

    with connect_local() as conn:
        ensure_schema(conn)
        last = get_last_ok(conn, DATASET)
        marks: dict[tuple[str, str], date] = {(t, m): d for t, m, d in conn.execute(
            "SELECT ticker, metric, MAX(obs_date) FROM lseg_research.starmine_history WHERE ticker = ANY(%s) GROUP BY 1, 2",
            (tickers,)).fetchall()}
    ric_map = load_ric_map(tickers)
    # TTL applies to names that already have history; never-fetched (ticker, metric) pairs always run.
    with connect_local() as conn:
        # negative cache per metric (e.g. ETFs have no StarMine; some names have Combined Alpha but no Predicted Surprise)
        empty = {m: recently_empty(conn, f"{DATASET}:{m}", list(ric_map), TTL.days) for m in METRICS}
    unseen = [t for t in ric_map if any((t, m) not in marks and t not in empty[m] for m in METRICS)]
    if last and not args.force and not args.tickers and datetime.now(timezone.utc) - last < TTL:
        if not unseen:
            print(f"skip: {DATASET} refreshed {last:%Y-%m-%d} (< {TTL.days}d). Use --force.")
            return
        ric_map = {t: ric_map[t] for t in unseen}  # within TTL: only backfill the new names
    by_ric = {r: t for t, r in ric_map.items()}
    end = date.today().isoformat()
    rows: list[tuple] = []
    with connect_local() as conn:
        try:
            with lseg_session() as ld:
                for metric, (field, extra) in METRICS.items():
                    groups: dict[str, list[str]] = {}  # one request per distinct start date (usually 2: new names, everyone else)
                    for t, ric in ric_map.items():
                        m = marks.get((t, metric))
                        s0 = (m - timedelta(days=31)).isoformat() if m and not args.force else args.start
                        groups.setdefault(s0, []).append(ric)
                    for start, rics in sorted(groups.items()):
                        df = ld.get_data(rics, [field, f"{field}.date"], {**extra, "SDate": start, "EDate": end, "Frq": "M"})
                        for _, r in df.iterrows():
                            v, d = clean(r.iloc[1]), clean(r.iloc[2])
                            if v is None or d is None or r.iloc[0] not in by_ric:
                                continue
                            rows.append((by_ric[r.iloc[0]], r.iloc[0], metric, d.date() if hasattr(d, "date") else d, float(v)))
        except Exception as e:
            log_pull(conn, dataset=DATASET, status="error", tickers=tickers, error=str(e)[:500])
            conn.commit()
            raise
        rows = list({(r[0], r[2], r[3]): r for r in rows}.values())  # dedupe on PK
        for m in METRICS:
            got = {t: 0 for t in ric_map}
            for r in rows:
                if r[2] == m:
                    got[r[0]] += 1
            record_attempts(conn, f"{DATASET}:{m}", got)
        with conn.cursor() as cur:
            cur.executemany(UPSERT, rows)
        upsert_sync_state(conn, dataset=DATASET, watermark=end, rows=len(rows), tickers=tickers)
        log_pull(conn, dataset=DATASET, status="ok", tickers=tickers, rows=len(rows),
                 watermark_from=args.start, watermark_to=end)
        conn.commit()
    print(f"{DATASET}: upserted {len(rows)} rows")


if __name__ == "__main__":
    main()
