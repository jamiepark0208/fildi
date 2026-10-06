"""Past earnings reactions → lseg_research.earnings_moves.

Report dates+times: LSEG `TR.EPSActReportDate` per fiscal quarter (last ~9). (The events feed is capped per
request and crowded out by foreign-listing dividends, so it is NOT used for history.) Prices: app
`prices_historical` (Yahoo) first, LSEG `get_history` only where the app doesn't reach. Reaction window by report
time: after the close (≥16:00) → close(report day) to close(next day); pre-market (<09:30) → close(prev day) to
close(report day); unknown/intraday → close(prev) to close(next).

Usage: .venv/bin/python sync_earnings_moves.py [--tickers … | coverage default] [--years 2] [--force]
"""
from __future__ import annotations

import argparse
from bisect import bisect_left, bisect_right
from datetime import date, datetime, timedelta, timezone

from _session import add_lseg_universe_args, clean, connect_local, load_ric_map, lseg_session, resolve_lseg_universe
from db import ensure_schema, get_last_ok, log_pull, upsert_sync_state

DATASET = "earnings_moves"
TTL = timedelta(days=7)

UPSERT = """
INSERT INTO lseg_research.earnings_moves (ticker, report_date, move_pct, price_source, computed_at)
VALUES (%s, %s, %s, %s, now())
ON CONFLICT (ticker, report_date) DO UPDATE SET move_pct = EXCLUDED.move_pct,
  price_source = EXCLUDED.price_source, computed_at = now()
"""


def window_move(closes: list[tuple[date, float]], d: date, when: str = "unknown") -> float | None:
    days = [c[0] for c in closes]
    i_on = bisect_left(days, d)
    on_day = i_on < len(days) and days[i_on] == d
    i_prev = i_on - 1
    i_next = bisect_right(days, d)
    if when == "amc" and on_day:
        i_prev, i_next = i_on, i_on + 1
    elif when == "bmo" and on_day:
        i_next = i_on
    if i_prev < 0 or i_next >= len(closes):
        return None
    (d0, p0), (d1, p1) = closes[i_prev], closes[i_next]
    if (d1 - d0).days > 7 or p0 <= 0:  # gap in data → don't trust
        return None
    return (p1 / p0 - 1) * 100


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    add_lseg_universe_args(p)
    p.add_argument("--years", type=int, default=2)
    args = p.parse_args()
    tickers = resolve_lseg_universe(args)
    from coverage import BENCHMARKS
    tickers = [t for t in tickers if t not in BENCHMARKS]  # funds have no earnings (LSEG returns junk dates back to 2004)
    start = date.today() - timedelta(days=365 * args.years)

    with connect_local() as conn:
        ensure_schema(conn)
        last = get_last_ok(conn, DATASET)
        if last and not args.force and not args.tickers and datetime.now(timezone.utc) - last < TTL:
            print(f"skip: {DATASET} refreshed {last:%Y-%m-%d} (< {TTL.days}d). Use --force.")
            return
        app_px: dict[str, list[tuple[date, float]]] = {}
        for t, d, c in conn.execute(
            "SELECT UPPER(ticker), date::date, close FROM prices_historical WHERE UPPER(ticker) = ANY(%s) AND date >= %s ORDER BY 1, 2",
            (tickers, start - timedelta(days=10)),
        ).fetchall():
            if c is not None:
                app_px.setdefault(t, []).append((d, float(c)))
        # already-stored LSEG history (sync_daily_history) before any new LSEG request: no duplicate price fetches
        hist_px: dict[str, list[tuple[date, float]]] = {}
        for t, d, c in conn.execute(
            "SELECT ticker, date, close FROM lseg_research.daily_history WHERE ticker = ANY(%s) AND date >= %s AND close IS NOT NULL ORDER BY 1, 2",
            (tickers, start - timedelta(days=10)),
        ).fetchall():
            hist_px.setdefault(t, []).append((d, float(c)))

    ric_map = load_ric_map(tickers)
    by_ric = {r: t for t, r in ric_map.items()}
    rows: list[tuple] = []
    with connect_local() as conn:
        try:
            with lseg_session() as ld:
                ev = ld.get_data(list(ric_map.values()), ["TR.EPSActReportDate"],
                                 {"SDate": "0", "EDate": f"-{4 * args.years}", "Period": "FQ0", "Frq": "FQ"})
                reports: dict[str, dict[date, str]] = {}
                for _, r in ev.iterrows():
                    ts = clean(r.iloc[1])
                    if ts is None or r.iloc[0] not in by_ric or not hasattr(ts, "date") or ts.date() >= date.today():
                        continue
                    hm = ts.hour * 60 + ts.minute
                    when = "unknown" if hm == 0 else "amc" if hm >= 16 * 60 else "bmo" if hm < 9 * 60 + 30 else "unknown"
                    reports.setdefault(by_ric[r.iloc[0]], {})[ts.date()] = when

                for t, dates in reports.items():
                    # stored LSEG history (split-consistent) first, app prices for days it lacks; a new LSEG price request
                    # only when neither has anything. Reports before the stored window are skipped, not fetched.
                    merged = {d: c for d, c in app_px.get(t, [])}
                    merged.update({d: c for d, c in hist_px.get(t, [])})
                    px = sorted(merged.items())
                    src = "lseg_history" if hist_px.get(t) else "app"
                    if px:
                        dates = {d: w for d, w in dates.items() if d >= px[0][0] + timedelta(days=3)}
                    need_lseg = not px
                    lseg_px: list[tuple[date, float]] = []
                    if need_lseg:
                        try:
                            # end= is required: without it get_history silently returns only the last 20 rows.
                            h = ld.get_history(ric_map[t], fields=["TRDPRC_1"], interval="daily",
                                               start=(min(dates) - timedelta(days=10)).isoformat(),
                                               end=date.today().isoformat())
                            lseg_px = [(ix.date(), float(v)) for ix, v in h.iloc[:, 0].items() if clean(v) is not None]
                        except Exception as e:
                            print(f"warn: LSEG history {t}: {str(e)[:80]}")
                    for d, when in sorted(dates.items()):
                        m = window_move(px, d, when) if px else None
                        source = src
                        if m is None and lseg_px:
                            m, source = window_move(lseg_px, d, when), "lseg"
                        if m is not None:
                            rows.append((t, d, round(m, 4), source))
        except Exception as e:
            log_pull(conn, dataset=DATASET, status="error", tickers=tickers, error=str(e)[:500])
            conn.commit()
            raise
        with conn.cursor() as cur:
            cur.executemany(UPSERT, rows)
        upsert_sync_state(conn, dataset=DATASET, watermark=date.today().isoformat(), rows=len(rows), tickers=tickers)
        log_pull(conn, dataset=DATASET, status="ok", tickers=tickers, rows=len(rows), watermark_from=start.isoformat())
        conn.commit()
    srcs = {s: sum(1 for r in rows if r[3] == s) for s in ("app", "lseg_history", "lseg")}
    print(f"{DATASET}: {len(rows)} report moves for {len({r[0] for r in rows})} tickers (prices: {srcs})")


if __name__ == "__main__":
    main()
