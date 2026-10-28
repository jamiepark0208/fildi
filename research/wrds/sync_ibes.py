#!/usr/bin/env python3
"""
Incremental IBES → wrds_research (academic research only).

TTL: skip if last_ok_at within 28 days unless --force.
Watermark: MAX(statpers) / MAX(anndats) already stored.
"""
from __future__ import annotations

import argparse
import sys
from datetime import date, datetime, timedelta, timezone

import pandas as pd

from _auth import connect
from db import (
    connect_local,
    ensure_schema,
    execute_values,
    get_last_ok,
    get_watermark,
    log_pull,
    source_key,
    upsert_sync_state,
)
from universe import add_universe_args, load_earnings_watch, resolve_universe


def oftic_for_tickers(local, tickers: list[str]) -> list[str]:
    """Map app tickers → IBES oftic via security_map; fall back to ticker itself.

    GOOGL and GOOG stay distinct when W1 has filled ibes_oftic per row.
    """
    rows = local.execute(
        """
        SELECT ticker, ibes_oftic FROM research_common.security_map
        WHERE ticker = ANY(%s)
        """,
        (tickers,),
    ).fetchall()
    m = {str(t).upper(): (str(o).upper() if o else None) for t, o in rows}
    out: list[str] = []
    seen: set[str] = set()
    for t in tickers:
        o = m.get(t) or t
        if o not in seen:
            seen.add(o)
            out.append(o)
    return out


def _int(v):
    if v is None or (isinstance(v, float) and pd.isna(v)) or pd.isna(v):
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _float(v):
    if v is None or (isinstance(v, float) and pd.isna(v)) or pd.isna(v):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None

TTL_DAYS = 28
DATASET_STAT = "ibes_statsum"
DATASET_SURP = "ibes_surpsum"


def _skip_ttl(conn, dataset: str, force: bool) -> bool:
    if force:
        return False
    last = get_last_ok(conn, dataset)
    if not last:
        return False
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) - last < timedelta(days=TTL_DAYS)


def _upsert_statsum_df(local, df: pd.DataFrame, tickers: list[str], start: str, notes: str) -> int:
    if df is None or df.empty:
        return 0
    rows = []
    for r in df.itertuples(index=False):
        oftic = str(r.oftic).upper() if r.oftic else None
        if not oftic or r.statpers is None:
            continue
        measure = str(r.measure) if r.measure else "EPS"
        fiscalp = str(r.fiscalp) if r.fiscalp is not None else None
        fpi = str(r.fpi) if r.fpi is not None else None
        sk = source_key(oftic, measure, fiscalp, fpi, r.statpers, r.fpedats)
        rows.append((
            sk, oftic,
            None if pd.isna(r.ticker) else str(r.ticker),
            measure, fiscalp, fpi, r.statpers,
            None if pd.isna(r.fpedats) else r.fpedats,
            _int(r.numest), _int(r.numup), _int(r.numdown),
            _float(r.medest), _float(r.meanest), _float(r.stdev),
            _float(r.highest), _float(r.lowest),
        ))
    sql = """
        INSERT INTO wrds_research.ibes_statsum (
          source_key, oftic, ticker, measure, fiscalp, fpi, statpers, fpedats,
          numest, numup, numdown, medest, meanest, stdev, highest, lowest, fetched_at
        ) VALUES (
          %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s, now()
        )
        ON CONFLICT (source_key) DO UPDATE SET
          numest = EXCLUDED.numest, numup = EXCLUDED.numup, numdown = EXCLUDED.numdown,
          medest = EXCLUDED.medest, meanest = EXCLUDED.meanest, stdev = EXCLUDED.stdev,
          highest = EXCLUDED.highest, lowest = EXCLUDED.lowest, fetched_at = now()
    """
    return execute_values(local, sql, rows)


def sync_statsum(
    db,
    local,
    tickers: list[str],
    force: bool,
    since: str | None = None,
    *,
    sal_eps_fpi12: bool = False,
) -> int:
    if _skip_ttl(local, DATASET_STAT, force):
        print(f"skip {DATASET_STAT}: within {TTL_DAYS}d TTL (use --force)")
        log_pull(local, dataset=DATASET_STAT, status="skipped", tickers=tickers)
        local.commit()
        return 0

    wm = None if since else get_watermark(local, DATASET_STAT)
    start = since or wm or (date.today() - timedelta(days=730)).isoformat()
    oftics = oftic_for_tickers(local, tickers)
    ticker_sql = ",".join(repr(t) for t in oftics)
    print(f"{DATASET_STAT}: since={start} n={len(tickers)} oftic={len(oftics)}", flush=True)

    if sal_eps_fpi12:
        eps = db.raw_sql(f"""
            SELECT oftic, ticker, measure, fiscalp, fpi, statpers, fpedats,
                   numest, numup, numdown, medest, meanest, stdev, highest, lowest
            FROM tr_ibes.statsumu_epsus
            WHERE UPPER(oftic) IN ({ticker_sql})
              AND measure = 'EPS' AND fiscalp = 'ANN' AND fpi IN ('1', '2')
              AND statpers >= '{start}'
        """)
        sal = db.raw_sql(f"""
            SELECT oftic, ticker, measure, fiscalp, fpi, statpers, fpedats,
                   numest, numup, numdown, medest, meanest, stdev, highest, lowest
            FROM ibes.statsum_xepsus
            WHERE UPPER(oftic) IN ({ticker_sql})
              AND measure = 'SAL' AND fiscalp = 'ANN' AND fpi IN ('1', '2', '3')
              AND statpers >= '{start}'
        """)
        df = pd.concat([eps, sal], ignore_index=True) if (eps is not None and sal is not None) else (eps or sal)
    else:
        df = db.raw_sql(f"""
            SELECT oftic, ticker, measure, fiscalp, fpi, statpers, fpedats,
                   numest, numup, numdown, medest, meanest, stdev, highest, lowest
            FROM tr_ibes.statsumu_epsus
            WHERE UPPER(oftic) IN ({ticker_sql})
              AND measure = 'EPS'
              AND statpers >= '{start}'
        """)
    if df is None or df.empty:
        log_pull(
            local, dataset=DATASET_STAT, status="ok", tickers=tickers,
            rows=0, watermark_from=start, watermark_to=start,
        )
        local.commit()
        print("  0 rows")
        return 0

    n = _upsert_statsum_df(local, df, tickers, start, "statsum")
    max_stat = str(max(df["statpers"]))[:10]
    note = "statsumu_epsus+statsum_xepsus SAL fpi1-3 EPS fpi1-2" if sal_eps_fpi12 else "tr_ibes.statsumu_epsus EPS"
    upsert_sync_state(
        local, dataset=DATASET_STAT, watermark=max_stat, rows=n, tickers=tickers,
        notes=note,
    )
    log_pull(
        local, dataset=DATASET_STAT, status="ok", tickers=tickers, rows=n,
        watermark_from=start, watermark_to=max_stat,
    )
    local.commit()
    print(f"  upserted {n} → watermark {max_stat}")
    return n


def sync_surpsum(db, local, tickers: list[str], force: bool, since: str | None = None) -> int:
    if _skip_ttl(local, DATASET_SURP, force):
        print(f"skip {DATASET_SURP}: within {TTL_DAYS}d TTL")
        log_pull(local, dataset=DATASET_SURP, status="skipped", tickers=tickers)
        local.commit()
        return 0

    wm = None if since else get_watermark(local, DATASET_SURP)
    start = since or wm or (date.today() - timedelta(days=730)).isoformat()
    oftics = oftic_for_tickers(local, tickers)
    ticker_sql = ",".join(repr(t) for t in oftics)
    print(f"{DATASET_SURP}: since={start} oftic={len(oftics)}", flush=True)

    # WRDS tr_ibes.surpsum schema varies by vintage — never assume pends exists
    # (that column is local-only; querying it on Cloud caused UndefinedColumn and
    # poisoned pull_log as ibes_statsum via a shared except). Discover columns.
    cols_df = db.raw_sql(
        """
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'tr_ibes' AND table_name = 'surpsum'
        """
    )
    remote_cols = (
        {str(c).lower() for c in cols_df["column_name"].tolist()}
        if cols_df is not None and not cols_df.empty
        else set()
    )
    # Core fields that exist on academic surpsum; optional extras when present.
    select_cols = ["oftic", "ticker", "measure", "fiscalp", "pyear", "pmon", "anndats",
                   "actual", "surpmean", "surpstdev", "suescore"]
    if "pends" in remote_cols:
        select_cols.insert(5, "pends")
    # Prefer anndats watermark; if missing fall back to pends only when it exists.
    if "anndats" in remote_cols or not remote_cols:
        where_date = f"anndats >= '{start}'"
    elif "pends" in remote_cols:
        where_date = f"pends >= '{start}'"
    else:
        where_date = "TRUE"

    df = db.raw_sql(f"""
        SELECT {", ".join(select_cols)}
        FROM tr_ibes.surpsum
        WHERE UPPER(oftic) IN ({ticker_sql})
          AND {where_date}
    """)
    if df is None or df.empty:
        log_pull(local, dataset=DATASET_SURP, status="ok", tickers=tickers, rows=0,
                 watermark_from=start, watermark_to=start)
        local.commit()
        print("  0 rows")
        return 0

    rows = []
    for r in df.itertuples(index=False):
        if pd.isna(r.oftic):
            continue
        oftic = str(r.oftic).upper()
        measure = None if pd.isna(r.measure) else str(r.measure)
        fiscalp = None if pd.isna(r.fiscalp) else str(r.fiscalp)
        anndats = None if pd.isna(getattr(r, "anndats", None)) else r.anndats
        pends = None
        if hasattr(r, "pends") and not pd.isna(r.pends):
            pends = r.pends
        elif getattr(r, "pyear", None) is not None and not pd.isna(r.pyear) and getattr(r, "pmon", None) is not None and not pd.isna(r.pmon):
            try:
                pends = date(int(r.pyear), int(r.pmon), 1)
            except (TypeError, ValueError):
                pends = None
        pyear = None if pd.isna(r.pyear) else int(r.pyear)
        pmon = None if pd.isna(r.pmon) else int(r.pmon)
        sk = source_key(oftic, measure, fiscalp, pyear, pmon, anndats or pends)
        rows.append((
            sk, oftic,
            None if pd.isna(r.ticker) else str(r.ticker),
            measure, fiscalp, pends, anndats,
            _float(r.actual), _float(r.surpmean), _float(r.surpstdev), _float(r.suescore),
        ))

    sql = """
        INSERT INTO wrds_research.ibes_surpsum (
          source_key, oftic, ticker, measure, fiscalp, pends, anndats,
          actual, surpmean, surpmed, suescore, fetched_at
        ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s, now())
        ON CONFLICT (source_key) DO UPDATE SET
          actual = EXCLUDED.actual, surpmean = EXCLUDED.surpmean,
          surpmed = EXCLUDED.surpmed, suescore = EXCLUDED.suescore,
          pends = COALESCE(EXCLUDED.pends, wrds_research.ibes_surpsum.pends),
          fetched_at = now()
    """
    n = execute_values(local, sql, rows)
    if "anndats" in df.columns and df["anndats"].notna().any():
        max_d = str(df["anndats"].max())[:10]
    elif "pends" in df.columns and df["pends"].notna().any():
        max_d = str(df["pends"].max())[:10]
    else:
        max_d = start
    upsert_sync_state(
        local, dataset=DATASET_SURP, watermark=max_d, rows=n, tickers=tickers,
        notes="tr_ibes.surpsum",
    )
    log_pull(
        local, dataset=DATASET_SURP, status="ok", tickers=tickers, rows=n,
        watermark_from=start, watermark_to=max_d,
    )
    local.commit()
    print(f"  upserted {n} → watermark {max_d}")
    return n


def main() -> int:
    p = argparse.ArgumentParser(description="Sync IBES → wrds_research")
    add_universe_args(p)
    p.add_argument(
        "--since",
        default=None,
        help="Force watermark start date YYYY-MM-DD (ignores sync_state watermark; use with --force)",
    )
    p.add_argument(
        "--sal-eps-fpi12",
        action="store_true",
        help="Pull SAL+EPS annual FY1–FY2 (fpi 1–2) in one statsum pass (A293 flows)",
    )
    p.add_argument(
        "--no-surpsum",
        action="store_true",
        help="Skip ibes_surpsum pull (single-purpose statsum refresh)",
    )
    args = p.parse_args()
    tickers = resolve_universe(args)
    watch: list[str] = []
    if getattr(args, "earnings_watch", False):
        watch = load_earnings_watch()
        if watch:
            tickers = list(dict.fromkeys(tickers + watch))[:50]
            # Loop C: force refresh when earnings-watch names are in play
            args.force = True
            print(f"loop C earnings_watch ({len(watch)}): {','.join(watch)}")
        else:
            print("loop C: earnings_watch.json empty/missing — continuing without force")
    if not tickers:
        print("empty universe")
        return 2

    print(f"universe ({len(tickers)}): {','.join(tickers[:12])}{'…' if len(tickers)>12 else ''}")
    db = connect()
    n1 = n2 = 0
    failed_ds = DATASET_STAT
    try:
        with connect_local() as local:
            ensure_schema(local)
            try:
                n1 = sync_statsum(
                    db, local, tickers, args.force, since=args.since,
                    sal_eps_fpi12=args.sal_eps_fpi12,
                )
            except Exception as e:
                failed_ds = DATASET_STAT
                raise
            if not args.no_surpsum:
                try:
                    n2 = sync_surpsum(db, local, tickers, args.force, since=args.since)
                except Exception as e:
                    failed_ds = DATASET_SURP
                    raise
    except Exception as e:
        print(f"error: {e}", file=sys.stderr)
        try:
            with connect_local() as local:
                log_pull(local, dataset=failed_ds, status="error", tickers=tickers, error=str(e))
                local.commit()
        except Exception:
            pass
        return 1
    finally:
        db.close()
    print(f"done statsum={n1} surpsum={n2}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
