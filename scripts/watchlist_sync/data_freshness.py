"""Data freshness check (Claude 10-20, Jamie: "I want to be able to trust my data"). For each table the app or the Model List reads:
how many trading days behind the last close is its newest row, vs the cadence its job promises. Also flags rows dated in the
future (10-20: UTC "today" stamped indicator_cache 10-21) and whether today's scheduled daily.py full run happened.

10-20 audit found, none of which any check caught: scheduled daily.py skipped (manual late-evening plan counted as today's),
API scheduler never ticked under tsx --watch restarts (no option scan), optlab underlying frozen since first fetch, model snapshot
stuck since 10-09. Run in agent_start (step 11); exit 1 when anything is stale.

    .venv/bin/python data_freshness.py [--all]
"""
from __future__ import annotations

import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import rules as R
from build_plan import connect

HERE = Path(__file__).resolve().parent

# (table, column, max trading days behind the last close, what reads it / which job writes it)
CHECKS = [
    ("lseg_research.daily_history", "fetched_at", 1, "Model List IV/price inputs · daily.py lseg stage"),
    ("public.prices_historical", "date", 1, "charts, scores · Schwab/Yahoo bars"),
    ("public.option_score_snapshots", "computed_at", 1, "Rankings › Options, Model List pool · daily.py option scan + API 19 UTC"),
    ("public.option_chain_history", "fetched_at", 1, "option history · same scan"),
    ("public.ticker_atm_iv_snapshots", "as_of", 1, "IV columns · option scan"),
    ("watchlist_sync.fit_scores", "computed_at", 1, "Model List fit · daily.py model stage"),
    ("watchlist_sync.put_edge_daily", "as_of", 1, "Model List put edge · daily.py"),
    ("watchlist_sync.house_view", "created_at", 1, "house view memo · daily.py publish"),
    ("watchlist_sync.forecast_ledger", "made_at", 1, "grades / drift · daily.py publish"),
    ("public.tech_score_snapshots", "computed_at", 1, "tech score · maintain post-merge"),
    ("public.fund_score_snapshots", "computed_at", 1, "fund score · maintain post-merge"),
    ("public.source_fundamentals", "fetched_at", 3, "fundamentals · maintain enrichment"),
    ("public.earnings_calendar", "fetched_at", 1, "earnings dates / earnings re-strike · API"),
    ("public.street_pt_daily", "fetched_at", 1, "street PT · API analyst feed"),
    ("public.market_breadth_daily", "date", 1, "breadth · maintain (Polygon grouped, 1-day lag on free tier)"),
    ("optlab.underlying", "date", 1, "Breakdown › Options history · option_history.py 03:00"),
    ("optlab.iv30", "date", 1, "IV rank · option_history.py → option_derive"),
    ("public.model_recs", "created_at", 5, "model track record (weekly) · API model snapshot"),
    ("lseg_research.signals_daily", "as_of", 1, "live StarMine alpha/ARM, PT, short interest → fit model · daily.py lseg signals"),
    ("lseg_research.starmine_history", "fetched_at", 20, "research history (monthly frequency, 28-day TTL by design)"),
]
PER_NAME = [("optlab.underlying", "date", "ticker"), ("lseg_research.daily_history", "date", "ticker")]
FUTURE = [("public.indicator_cache", "scored_date"), ("public.option_score_snapshots", "as_of"), ("public.model_recs", "snapshot_date")]


def lag_trading_days(last: date, ref: date) -> int:
    n, d = 0, last + timedelta(days=1)
    while d <= ref:
        n += R.is_trading_day(d)
        d += timedelta(days=1)
    return n


def daily_run_today(today: date) -> str:
    runs = []
    for f in (HERE / "out" / "runs").glob("*.json"):
        try:
            log = json.loads(f.read_text())
            st = datetime.fromisoformat(log["started"]).astimezone(R.ET)
        except (ValueError, KeyError, OSError):
            continue
        if st.date() == today and {"lseg", "model"} <= set(log.get("stages", [])):
            runs.append(f"{st:%H:%M} ET {log.get('status')}")
    return ", ".join(sorted(runs)) or "none"


def main() -> None:
    show_all = "--all" in sys.argv
    now = datetime.now(R.ET)
    ref = R.last_close_date(now)
    conn = connect()
    stale, lines = [], []
    for table, col, max_lag, what in CHECKS:
        try:
            v = conn.execute(f"SELECT MAX({col}) FROM {table}").fetchone()[0]
        except Exception as e:  # missing table/column = a finding too
            conn.rollback()
            stale.append(table)
            lines.append(f"✗ {table}: unreadable ({str(e)[:60]})")
            continue
        if v is None:
            stale.append(table)
            lines.append(f"✗ {table}: empty")
            continue
        last = v.astimezone(R.ET).date() if isinstance(v, datetime) else v
        lag = lag_trading_days(last, ref)
        bad = lag > max_lag
        if bad:
            stale.append(table)
        if bad or show_all:
            lines.append(f"{'✗' if bad else '✓'} {table}: newest {last} · {lag} trading day(s) behind {ref} (max {max_lag}) — {what}")
    # per-name staleness: MAX over all names hid optlab.underlying freezing name by name (10-20)
    for table, col, key in PER_NAME:
        try:
            n_all, n_old = conn.execute(f"SELECT COUNT(*), COUNT(*) FILTER (WHERE m < %s) FROM (SELECT {key}, MAX({col}) m "
                                        f"FROM {table} GROUP BY {key}) x", (ref - timedelta(days=4),)).fetchone()
        except Exception:
            conn.rollback()
            continue
        if n_all and n_old / n_all > 0.10:
            stale.append(table)
            lines.append(f"✗ {table}: {n_old}/{n_all} names have no bar in the 4 days before {ref} (per-name freeze?)")
    for table, col in FUTURE:
        try:
            n = conn.execute(f"SELECT COUNT(*) FROM {table} WHERE {col} > %s", (now.date(),)).fetchone()[0]
        except Exception:
            conn.rollback()
            continue
        if n:
            stale.append(table)
            lines.append(f"✗ {table}: {n} row(s) dated after today ({now.date()}) — UTC-date bug?")
    run = daily_run_today(now.date())
    if R.is_trading_day(now.date()) and now.hour >= 11 and run == "none":
        stale.append("daily.py")
        lines.append(f"✗ daily.py: no full run today ({now.date()}) — Model List built on old inputs")
    print(f"freshness: {len(CHECKS) - len([s for s in stale if s in dict((c[0], 1) for c in CHECKS)])}/{len(CHECKS)} fresh · "
          f"daily.py today: {run}")
    print("\n".join(lines))
    sys.exit(1 if stale else 0)


if __name__ == "__main__":
    main()
