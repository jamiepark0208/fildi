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
    ("watchlist_sync.congress_trades", "disclosure_date", 4, "Breakdown › Congress, Feed › Congress · congress_trades.py (FMP *-latest, page 0 only)"),
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
    ("watchlist_sync.tasty_metrics_daily", "date", 1, "tastytrade IV rank/pctile + liquidity (S096 forward test) · daily.py tastytrade step"),
    ("watchlist_sync.iv_rank_daily", "date", 1, "IV-rank resolver (LSEG → tastytrade) read by Options score + Model List · daily.py iv_rank.py"),
    ("watchlist_sync.put_ladder", "as_of", 8, "Rankings › Put ladder · weekly S088 run (daily.py --if-due)"),
    ("watchlist_sync.long_option_board", "as_of", 3, "Rankings › Long options · daily.py S086 step"),
]
# (table, date col, key, active-names filter). 11-03: names that left option_history's universe (book / top-30 recs change)
# stop updating by design — only names it fetched in the last 3 days can be frozen (16/63 false alarm on 11-02).
PER_NAME = [("optlab.underlying", "date", "ticker",
             "ticker IN (SELECT ticker FROM optlab.underlying_fetched WHERE fetched_at > now() - interval '3 days')"),
            ("lseg_research.daily_history", "date", "ticker", "TRUE")]
FUTURE = [("public.indicator_cache", "scored_date"), ("public.option_score_snapshots", "as_of"), ("public.model_recs", "snapshot_date")]
MISSING_INPUT_MAX_SHARE = 0.15   # A243 10-22: 83/180 (46 %) of sell-put candidates blocked for missing inputs, no check caught it


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


def snapshot_as_of(conn, now: datetime) -> str | None:
    """option_score_snapshots must carry the session the Model List prices and drift-checks against — exact match, no maxLag
    slack: on 10-20 and 10-22 the as_of day was missing entirely while MAX(computed_at) with maxLag 1 still read fresh (A243).
    Expected = today once the morning build has run in an open session (maintain builds the list at 10:00 ET), else last close."""
    expect = now.date() if (R.market_open(now) and now.hour >= 10) else R.last_close_date(now)
    # Existence, not MAX == expect: weekend/holiday runs stamp the calendar date on purpose (live chain; re-dating would
    # overwrite Friday), so MAX can sit past the expected session while that session is present (11-08 false alarm).
    if conn.execute("SELECT 1 FROM public.option_score_snapshots WHERE as_of = %s LIMIT 1", (expect,)).fetchone():
        return None
    v = conn.execute("SELECT MAX(as_of) FROM public.option_score_snapshots").fetchone()[0]
    return (f"✗ public.option_score_snapshots: newest as_of {v or 'none'} ≠ {expect} (session the list is checked against) "
            f"— drift checks measure our staleness, not the market")


def _missing_input_causes(conn, tickers: list[str], as_of: date) -> dict[str, list[str]]:
    """Which put_edge.scores gate each blocked name fails (put_edge.py:74-82): ≥ 61 LSEG bars in 120 days with the last inside
    7 days, lab_tech comps, iv30_put on ≥ 40 of the last 61 bars. Cause split tells a vendor gap from a thin-IV name."""
    bars = {t: (n, last, ivs) for t, n, last, ivs in conn.execute("""
        WITH b AS (SELECT ticker, date, iv30_put, ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) rn
                   FROM lseg_research.daily_history
                   WHERE ticker = ANY(%s) AND date BETWEEN %s::date - 120 AND %s AND close > 0)
        SELECT ticker, COUNT(*), MAX(date), COUNT(iv30_put) FILTER (WHERE rn <= 61) FROM b GROUP BY ticker""",
        (tickers, as_of, as_of)).fetchall()}
    tech = {t for (t,) in conn.execute("""SELECT ticker FROM watchlist_sync.lab_tech
        WHERE as_of = (SELECT MAX(as_of) FROM watchlist_sync.lab_tech WHERE as_of <= %s)
          AND v2->'comps'->>'trendContext' IS NOT NULL AND v2->'comps'->>'volumeConfirm' IS NOT NULL""", (as_of,)).fetchall()}
    rics = {t for (t,) in conn.execute(
        "SELECT ticker FROM research_common.security_map WHERE ticker = ANY(%s) AND ric IS NOT NULL", (tickers,)).fetchall()}
    out: dict[str, list[str]] = {}
    for t in tickers:
        b = bars.get(t)
        if t not in rics:
            cause = "no RIC (outside LSEG map — sync_ids or drop from weekly puts)"
        elif not b or b[0] < 61 or (as_of - b[1]).days > 7:
            cause = "no/short LSEG history (sync_daily_history)"
        elif t not in tech:
            cause = "no lab_tech"
        elif b[2] < 40:
            cause = "thin iv30_put"
        else:
            cause = "other (re-read put_edge gates)"
        out.setdefault(cause, []).append(t)
    return out


def put_edge_missing_inputs(conn) -> list[str]:
    """Share of the latest plan's sell-put pool blocked because put-edge inputs are missing (build_plan.py:335), i.e. we don't
    know the edge — not because the market failed a check. A243: 46 % on 10-22 and nothing flagged it."""
    p = conn.execute("SELECT id, created_at, close_date FROM watchlist_sync.plans ORDER BY id DESC LIMIT 1").fetchone()
    if not p:
        return ["✗ watchlist_sync.plans: no plan to audit"]
    pid, created, close = p
    pool = conn.execute("""SELECT ticker, l1_checks FROM watchlist_sync.plan_items
                           WHERE plan_id = %s AND list_key = 'sell_puts'""", (pid,)).fetchall()
    if not pool:
        return [f"✗ plan #{pid}: no sell_puts candidates"]
    blocked = []
    for t, checks in pool:
        cs = json.loads(checks) if isinstance(checks, str) else (checks or [])
        if any(c["check"] == "put_edge" and not c["pass"] and c["severity"] == "block"
               and str(c["detail"]).startswith("no put-edge inputs") for c in cs):
            blocked.append(t)
    share = len(blocked) / len(pool)
    if share <= MISSING_INPUT_MAX_SHARE:
        return []
    causes = _missing_input_causes(conn, blocked, (created.astimezone(R.ET).date() if created else close))
    return [f"✗ put_edge inputs: {len(blocked)}/{len(pool)} ({100 * share:.0f} %) of plan #{pid} sell-put candidates blocked for "
            f"missing inputs (max {100 * MISSING_INPUT_MAX_SHARE:.0f} %) — unknown edge, not a market reason",
            "  by cause: " + " · ".join(f"{k} {len(v)} ({', '.join(sorted(v)[:6])}{'…' if len(v) > 6 else ''})"
                                        for k, v in sorted(causes.items(), key=lambda x: -len(x[1])))]


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
    for table, col, key, active in PER_NAME:
        try:
            n_all, n_old = conn.execute(f"SELECT COUNT(*), COUNT(*) FILTER (WHERE m < %s) FROM (SELECT {key}, MAX({col}) m "
                                        f"FROM {table} WHERE {active} GROUP BY {key}) x", (ref - timedelta(days=4),)).fetchone()
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
    snap = snapshot_as_of(conn, now)
    if snap:
        stale.append("public.option_score_snapshots")
        lines.append(snap)
    try:
        missing = put_edge_missing_inputs(conn)
    except Exception as e:
        conn.rollback()
        stale.append("put_edge_inputs")
        missing = [f"✗ put_edge inputs: unreadable ({str(e)[:60]})"]
    if missing:
        stale.append("put_edge_inputs")
        lines.extend(missing)
    # strategy signals must get a real contract the session after they fire (strategy_signals.price_open); Jamie 11-09:
    # "our processes should already be checking that" — rows still open > 2 trading days = pricing stalled.
    try:
        late = conn.execute("""SELECT strategy_id, COUNT(*), MIN(as_of) FROM watchlist_sync.strategy_signals
                               WHERE status = 'open' GROUP BY 1""").fetchall()
    except Exception:
        conn.rollback()
        late = []
    late = [(s, n, d) for s, n, d in late if lag_trading_days(d, ref) > 2]
    if late:
        stale.append("strategy_signals")
        lines.append("✗ strategy_signals: unpriced > 2 sessions — " + " · ".join(f"{s} {n} (since {d})" for s, n, d in late))
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
