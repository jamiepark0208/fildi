#!/usr/bin/env python3
"""A357 step 3 — LSE traded daily bars for A352/S059 put contracts + model_recs puts.

  .venv/bin/python analysis/a357_lse_option_backfill.py --dry-run
  .venv/bin/python analysis/a357_lse_option_backfill.py --limit 20 --smoke-validate
  .venv/bin/python analysis/a357_lse_option_backfill.py   # full resumable run
"""
from __future__ import annotations

import argparse
import math
import sys
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
SYNC = HERE.parent
ROOT = SYNC.parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(SYNC))

import s045_put_retest as S045  # noqa: E402
import s059_option_factors as S59  # noqa: E402
from build_plan import connect  # noqa: E402
from lse_client import export_options_csv, occ_symbol, parse_export_rows  # noqa: E402

ENTRY_CUT = date(2025, 10, 15)
CHAIN_OVERLAP = date(2026, 10, 8)  # option_chain_history.as_of min

DDL = """
CREATE TABLE IF NOT EXISTS lse_option_daily (
  occ text NOT NULL,
  ticker text NOT NULL,
  side text NOT NULL,
  strike numeric NOT NULL,
  expiry date NOT NULL,
  date date NOT NULL,
  open numeric,
  high numeric,
  low numeric,
  close numeric,
  volume bigint,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (occ, date)
);
CREATE TABLE IF NOT EXISTS lse_option_fetch_log (
  occ text PRIMARY KEY,
  status text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lse_option_daily_ticker ON lse_option_daily (ticker, date);
"""


@dataclass(frozen=True)
class Contract:
    occ: str
    ticker: str
    side: str
    strike: float
    expiry: date
    entry: date


def ensure_tables(conn) -> None:
    for stmt in [s.strip() for s in DDL.split(";") if s.strip()]:
        conn.execute(stmt)
    conn.commit()


def _spot_at(conn, ticker: str, d: date) -> float | None:
    row = conn.execute(
        "SELECT close::float8 FROM lseg_research.daily_history WHERE ticker = %s AND date = %s AND close > 0",
        (ticker, d),
    ).fetchone()
    return float(row[0]) if row else None


def strike_for_event(conn, e: dict) -> float | None:
    spot = _spot_at(conn, e["t"], e["d"])
    if not spot or not e.get("iv30"):
        return None
    iv = float(e["iv30"])
    tt = float(e["hold_sessions"]) / 252.0
    return spot * math.exp(-S045.Z * iv * math.sqrt(tt))


def collect_s059_puts(conn) -> dict[str, Contract]:
    out: dict[str, Contract] = {}
    for e in S59.aligned_events(conn):
        if e["d"] < ENTRY_CUT:
            continue
        strike = strike_for_event(conn, e)
        if strike is None or strike <= 0:
            continue
        occ = occ_symbol(e["t"], e["expiry"], strike, "put")
        out[occ] = Contract(
            occ=occ,
            ticker=e["t"],
            side="put",
            strike=strike,
            expiry=e["expiry"],
            entry=e["d"],
        )
    return out


def collect_model_puts(conn) -> dict[str, Contract]:
    out: dict[str, Contract] = {}
    for ticker, expiry, strike, snap in conn.execute(
        """SELECT ticker, expiry, strike::float8, snapshot_date
           FROM model_recs WHERE side = 'put' AND strike > 0"""
    ).fetchall():
        strike_f = float(strike)
        occ = occ_symbol(ticker, expiry, strike_f, "put")
        out[occ] = Contract(
            occ=occ,
            ticker=ticker,
            side="put",
            strike=strike_f,
            expiry=expiry,
            entry=snap,
        )
    return out


def collect_contracts(conn) -> list[Contract]:
    merged = {**collect_s059_puts(conn), **collect_model_puts(conn)}
    return sorted(merged.values(), key=lambda c: (c.entry, c.ticker, c.occ))


def load_skip_sets(conn) -> tuple[set[str], set[str]]:
    logged = {
        r[0]
        for r in conn.execute("SELECT occ FROM lse_option_fetch_log WHERE status = 'no_data'").fetchall()
    }
    done = {r[0] for r in conn.execute("SELECT DISTINCT occ FROM lse_option_daily").fetchall()}
    return logged, done


def should_skip_occ(fetch_log: set[str], has_daily: bool) -> bool:
    """Skip when logged no-data (fetch_log) or daily bars already stored."""
    return has_daily


def skip_occ(fetch_log: set[str], done: set[str], occ: str) -> bool:
    return occ in fetch_log or occ in done


def persist_rows(conn, c: Contract, rows: list[dict]) -> int:
    n = 0
    for r in rows:
        conn.execute(
            """INSERT INTO lse_option_daily (occ, ticker, side, strike, expiry, date, open, high, low, close, volume)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (occ, date) DO UPDATE SET
                 open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
                 close = EXCLUDED.close, volume = EXCLUDED.volume, fetched_at = now()""",
            (
                c.occ,
                c.ticker,
                c.side,
                c.strike,
                c.expiry,
                r["date"],
                r.get("open"),
                r.get("high"),
                r.get("low"),
                r.get("close"),
                r.get("volume"),
            ),
        )
        n += 1
    conn.commit()
    return n


def fetch_one(conn, c: Contract) -> str:
    d0 = c.entry - timedelta(days=3)
    status, body = export_options_csv(conn, c.occ, date_from=d0, date_to=c.expiry)
    if status == 404 or "data-unavailable" in body.lower() or "not found" in body.lower():
        conn.execute(
            "INSERT INTO lse_option_fetch_log (occ, status) VALUES (%s, %s) ON CONFLICT (occ) DO NOTHING",
            (c.occ, "no_data"),
        )
        conn.commit()
        return "no_data"
    head = body.lstrip()[:40].lower()
    if status != 200 or '"time"' not in head:
        conn.execute(
            "INSERT INTO lse_option_fetch_log (occ, status) VALUES (%s, %s) ON CONFLICT (occ) DO UPDATE SET status = EXCLUDED.status, fetched_at = now()",
            (c.occ, f"http_{status}"),
        )
        conn.commit()
        return f"http_{status}"
    rows = parse_export_rows(body)
    persist_rows(conn, c, rows)
    return f"ok_{len(rows)}"


def smoke_validate(conn, contracts: list[Contract], n_check: int = 3) -> bool:
    """Compare LSE close vs option_chain_history on overlapping dates (≥ 10-08)."""
    checked = 0
    for c in contracts:
        if checked >= n_check:
            break
        lse = {
            r[0]: float(r[1])
            for r in conn.execute(
                "SELECT date, close::float8 FROM lse_option_daily WHERE occ = %s AND date >= %s AND close IS NOT NULL",
                (c.occ, CHAIN_OVERLAP),
            ).fetchall()
        }
        if not lse:
            continue
        for d, lse_close in sorted(lse.items()):
            row = conn.execute(
                """SELECT bid::float8, ask::float8, last::float8, strike::float8 FROM option_chain_history
                   WHERE ticker = %s AND expiry = %s AND side = %s AND as_of = %s
                   ORDER BY ABS(strike::float8 - %s) LIMIT 1""",
                (c.ticker, c.expiry, c.side, d, c.strike),
            ).fetchone()
            if row and abs(row[3] - c.strike) > max(0.05, c.strike * 0.08):
                continue
            if not row:
                continue
            bid, ask, last, _stk = row
            ref = last if last and last > 0 else ((bid or 0) + (ask or 0)) / 2 if bid and ask else None
            if ref is None or ref <= 0:
                continue
            rel = abs(lse_close - ref) / ref
            print(
                f"smoke {c.ticker} {d} strike={c.strike:.2f} LSE={lse_close:.3f} chain={ref:.3f} rel={rel:.2%}",
                flush=True,
            )
            checked += 1
            break
    if checked < n_check:
        print(f"smoke: only {checked} chain overlaps (need {n_check} where chain exists)", flush=True)
        return False
    print(f"smoke: {checked} overlaps logged (see rel=; hand check vs option_chain_history)", flush=True)
    return True


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--smoke-validate", action="store_true")
    args = ap.parse_args()

    with connect() as conn:
        ensure_tables(conn)
        contracts = collect_contracts(conn)
        print(f"A357 backfill · {len(contracts)} unique OCC contracts (s059≥{ENTRY_CUT} ∪ model_recs puts)", flush=True)
        if args.dry_run:
            return

        fetch_log, done = load_skip_sets(conn)
        todo = [c for c in contracts if not skip_occ(fetch_log, done, c.occ)]
        todo.sort(key=lambda c: (c.entry, c.ticker), reverse=True)
        if args.smoke_validate:
            todo = [c for c in todo if c.entry >= CHAIN_OVERLAP]
        if args.smoke_validate and args.limit == 0:
            todo = []  # validate-only: no new exports
        elif args.limit:
            todo = todo[: args.limit]
        print(f"pending {len(todo)} (skipped {len(contracts) - len(todo)} resumable)", flush=True)

        if args.smoke_validate and args.limit == 0 and not todo:
            todo = []

        if not todo and not args.smoke_validate:
            return

        if todo:
            for i, c in enumerate(todo, 1):
                st = fetch_one(conn, c)
                if i % 25 == 0 or args.limit:
                    print(f"  [{i}/{len(todo)}] {c.ticker} {c.occ[-20:]} → {st}", flush=True)

        if args.smoke_validate:
            refreshed = {
                r[0]
                for r in conn.execute(
                    "SELECT DISTINCT occ FROM lse_option_daily WHERE date >= %s", (CHAIN_OVERLAP,)
                ).fetchall()
            }
            subset = [c for c in contracts if c.occ in refreshed]
            if not smoke_validate(conn, subset):
                raise SystemExit("smoke-validate failed (LSE vs option_chain_history)")


if __name__ == "__main__":
    main()
