"""Backfill a missed RTH day into option_chain_history from LSEG daily option bids.

Seed = prior session's option_chain_history (same OTM band we already persisted). For each
(ticker, expiry, side, strike), pull LSEG history (cached in optlab.lseg_opt_daily) and write
the target day's bid/ask/mid/iv into option_chain_history. Then:

  cd artifacts/api-server && pnpm exec tsx src/scripts/run-model-snapshot.ts --as-of=YYYY-MM-DD --from-history

Usage (LSEG Workspace up; research/lseg/.venv):
  ../research/lseg/.venv/bin/python backfill_option_session.py --as-of=2026-10-23 [--seed=2026-10-22] [--cap=800]
"""
from __future__ import annotations

import argparse
import sys
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
LSEG = HERE.parents[1] / "research" / "lseg"
sys.path[:0] = [str(HERE), str(LSEG)]

from build_plan import connect  # noqa: E402
import option_prices as OP  # noqa: E402
from _session import lseg_session  # noqa: E402


def prior_session(conn, as_of: date) -> date | None:
    r = conn.execute(
        "SELECT MAX(as_of) FROM option_chain_history WHERE as_of < %s AND bid > 0", (as_of,)
    ).fetchone()
    return r[0] if r and r[0] else None


def seed_rows(conn, seed: date, tickers: list[str] | None) -> list[tuple]:
    q = """SELECT ticker, expiry, side, strike::float8, dte, spot::float8
           FROM option_chain_history WHERE as_of = %s AND bid > 0"""
    args: list = [seed]
    if tickers:
        q += " AND ticker = ANY(%s)"
        args.append(tickers)
    return conn.execute(q, args).fetchall()


def watchlist_premium(conn) -> list[str]:
    """Snapshot universe ≈ watchlist ∪ recent option-score names (same spirit as model snapshot)."""
    rows = conn.execute("""
      SELECT DISTINCT UPPER(ticker) t FROM (
        SELECT ticker FROM watchlist
        UNION ALL
        SELECT ticker FROM option_score_snapshots
          WHERE as_of = (SELECT MAX(as_of) FROM option_score_snapshots)
        UNION ALL
        SELECT ticker FROM model_recs
          WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM model_recs)
      ) x ORDER BY 1""").fetchall()
    return [r[0] for r in rows]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--as-of", required=True, help="missed session date YYYY-MM-DD")
    ap.add_argument("--seed", help="prior option_chain_history day (default: latest before as-of)")
    ap.add_argument("--cap", type=int, default=800, help="max new LSEG RIC pulls this run")
    ap.add_argument("--all-seed-tickers", action="store_true",
                    help="use every ticker on the seed day (default: watchlist ∪ score pool only)")
    a = ap.parse_args()
    as_of = date.fromisoformat(a.as_of)
    conn = connect()
    OP.ensure(conn)
    seed = date.fromisoformat(a.seed) if a.seed else prior_session(conn, as_of)
    if not seed:
        sys.exit("no prior option_chain_history day to seed strikes from")
    tickers = None if a.all_seed_tickers else watchlist_premium(conn)
    seeds = seed_rows(conn, seed, tickers)
    if not seeds:
        sys.exit(f"no seed rows on {seed} for universe")

    # Ensure Fri equity close exists for spot sanity (best-effort).
    spot = {
        t: c for t, c in conn.execute(
            "SELECT ticker, close::float8 FROM lseg_research.daily_history WHERE date = %s", (as_of,)
        ).fetchall()
    }
    if not spot:
        print(f"note: no lseg_research.daily_history for {as_of} yet — using seed spots; run sync_daily_history")

    def day_quote(rics: list[str]) -> tuple | None:
        """Fri row already in cache? Avoid a refresh pull when we already have as_of."""
        return conn.execute(
            """SELECT bid, ask, mid, last, oi, iv FROM optlab.lseg_opt_daily
               WHERE ric = ANY(%s) AND date = %s AND bid > 0
               ORDER BY bid DESC NULLS LAST LIMIT 1""",
            (rics, as_of),
        ).fetchone()

    wrote = 0
    misses = 0
    pulls = 0
    cache_hits = 0
    with lseg_session() as ld:
        for ticker, expiry, side, strike, dte, seed_spot in seeds:
            cp = "P" if side == "put" else "C"
            ric_list = OP.rics(ticker, expiry, cp, strike)
            if not ric_list:
                misses += 1
                continue
            day = day_quote(ric_list)
            if day is None:
                if pulls >= a.cap:
                    continue  # keep scanning for cache hits
                try:
                    hist = OP.history(ld, conn, ticker, expiry, cp, strike)
                except Exception as e:
                    print(f"  skip {ticker} {expiry} {strike}{cp}: {e}")
                    misses += 1
                    continue
                pulls += 1
                if not hist:
                    misses += 1
                    continue
                row = next((r for r in hist if r[0] == as_of and r[1] and r[1] > 0), None)
                if not row:
                    misses += 1
                    continue
                day = row[1:]
            else:
                cache_hits += 1
            bid, ask, mid, last, oi, iv = day
            S = spot.get(ticker) or seed_spot
            conn.execute(
                """INSERT INTO option_chain_history
                     (as_of, ticker, expiry, side, strike, dte, spot, bid, ask, last, iv, delta, volume, open_interest, source)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NULL,NULL,%s,'lseg')
                   ON CONFLICT (as_of, ticker, expiry, side, strike) DO UPDATE SET
                     bid=EXCLUDED.bid, ask=EXCLUDED.ask, last=EXCLUDED.last, iv=EXCLUDED.iv,
                     spot=EXCLUDED.spot, open_interest=EXCLUDED.open_interest, source=EXCLUDED.source,
                     fetched_at=now()""",
                (as_of, ticker, expiry, side, strike, dte, S, bid, ask, last or mid, iv, oi),
            )
            wrote += 1
            if wrote % 200 == 0:
                conn.commit()
                print(f"  … {wrote} written, {pulls} pulls, {cache_hits} cache", flush=True)
        conn.commit()

    n = conn.execute(
        "SELECT COUNT(*) FROM option_chain_history WHERE as_of = %s AND bid > 0", (as_of,)
    ).fetchone()[0]
    print(f"backfill {as_of}: wrote {wrote} (seed {seed} n={len(seeds)}), misses {misses}, "
          f"pulls {pulls}, cache_hits {cache_hits}, table now {n} live-bid rows"
          + (f" — hit --cap={a.cap}, re-run to continue" if pulls >= a.cap else ""))
    print(f"next: cd artifacts/api-server && pnpm exec tsx src/scripts/run-model-snapshot.ts "
          f"--as-of={as_of} --from-history")


if __name__ == "__main__":
    main()
