#!/usr/bin/env python3
"""A357 step 3 — LSE traded daily bars for A352/S059 put contracts + model_recs puts.

  .venv/bin/python analysis/a357_lse_option_backfill.py --dry-run
  .venv/bin/python analysis/a357_lse_option_backfill.py --limit 20 --s059-only
  .venv/bin/python analysis/a357_lse_option_backfill.py   # full resumable run
"""
from __future__ import annotations

import argparse
import math
import sys
from statistics import median
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
SYNC = HERE.parent
ROOT = SYNC.parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(SYNC))

import a352_score_rank as A352  # noqa: E402
import s045_put_retest as S045  # noqa: E402
import s059_option_factors as S59  # noqa: E402
from a357_sample import (  # noqa: E402
    SAMPLE_PATH,
    SampleEvent,
    build_sample_plan,
    load_sample_plan,
    save_sample_plan,
)
from build_plan import connect  # noqa: E402
from lse_client import (  # noqa: E402
    export_options_csv,
    list_put_strikes,
    occ_symbol,
    parse_export_rows,
    snap_put_strike,
    warm_pair_cache,
)

ENTRY_CUT = date(2025, 10, 15)
CHAIN_OVERLAP = date(2026, 10, 8)  # option_chain_history.as_of min

DDL = """
CREATE TABLE IF NOT EXISTS lse_option_daily (
  occ text NOT NULL,
  ticker text NOT NULL,
  side text NOT NULL,
  strike numeric NOT NULL,
  model_strike numeric,
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
  model_strike numeric,
  strike numeric,
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
    model_strike: float | None = None
    source: str = "s059"


def ensure_tables(conn) -> None:
    for stmt in [s.strip() for s in DDL.split(";") if s.strip()]:
        conn.execute(stmt)
    conn.commit()
    for col, tbl in (("model_strike", "lse_option_daily"), ("model_strike", "lse_option_fetch_log"), ("strike", "lse_option_fetch_log")):
        conn.execute(
            f"ALTER TABLE {tbl} ADD COLUMN IF NOT EXISTS {col} numeric"
        )
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


def _pairs_cache(conn, cache: dict[tuple[str, date], list[float]], ticker: str, expiry: date) -> list[float]:
    key = (ticker.upper(), expiry)
    if key not in cache:
        cache[key] = list_put_strikes(conn, ticker, expiry)
    return cache[key]


def _log_fetch(conn, occ: str, status: str, *, model_strike: float | None, strike: float | None) -> None:
    conn.execute(
        """INSERT INTO lse_option_fetch_log (occ, status, model_strike, strike)
           VALUES (%s, %s, %s, %s)
           ON CONFLICT (occ) DO UPDATE SET status = EXCLUDED.status,
             model_strike = EXCLUDED.model_strike, strike = EXCLUDED.strike, fetched_at = now()""",
        (occ, status, model_strike, strike),
    )
    conn.commit()


def _s059_contract(conn, e: dict, pairs_cache: dict[tuple[str, date], list[float]]) -> Contract | None:
    model = strike_for_event(conn, e)
    if model is None or model <= 0:
        return None
    key = (e["t"].upper(), e["expiry"])
    if key not in pairs_cache:
        pairs_cache[key] = list_put_strikes(conn, e["t"], e["expiry"])
    listed = pairs_cache[key]
    snapped = snap_put_strike(model, listed)
    if snapped is None:
        bad_occ = occ_symbol(e["t"], e["expiry"], model, "put")
        _log_fetch(conn, bad_occ, "no_listed_strike", model_strike=model, strike=None)
        return None
    occ = occ_symbol(e["t"], e["expiry"], snapped, "put")
    return Contract(
        occ=occ,
        ticker=e["t"],
        side="put",
        strike=snapped,
        expiry=e["expiry"],
        entry=e["d"],
        model_strike=model,
        source="s059",
    )


def event_key(c: Contract) -> tuple[str, date, str]:
    """OCC does not include the entry date. Same contract on two days is two events."""
    return (c.occ, c.entry, c.source)


def status_is_ok(status: str) -> bool:
    """A zero-row export is not a successful backfill."""
    if not status.startswith("ok_"):
        return False
    try:
        return int(status.split("_", 1)[1]) > 0
    except ValueError:
        return False


def divergence_fails(rels: list[float], *, min_n: int = 3, max_median: float = 0.15) -> bool:
    if len(rels) < min_n:
        return True
    return float(median(rels)) > max_median


def widest_fetch(contracts: list[Contract]) -> list[Contract]:
    """One download per OCC, from the earliest entry, so a later event cannot shrink the window."""
    best: dict[str, Contract] = {}
    for c in contracts:
        cur = best.get(c.occ)
        if cur is None or c.entry < cur.entry:
            best[c.occ] = c
    return list(best.values())


def collect_s059_puts(conn, *, pair_progress: bool = True) -> dict[tuple[str, date, str], Contract]:
    out: dict[tuple[str, date, str], Contract] = {}
    pairs_cache: dict[tuple[str, date], list[float]] = {}
    print(f"pair cache warm {warm_pair_cache(conn)}", flush=True)
    events = [e for e in S59.aligned_events(conn) if e["d"] >= ENTRY_CUT]
    keys_n = len({(e["t"], e["expiry"]) for e in events})
    fetched = 0
    for i, e in enumerate(events):
        key = (e["t"].upper(), e["expiry"])
        if key not in pairs_cache:
            pairs_cache[key] = list_put_strikes(conn, e["t"], e["expiry"])
            fetched += 1
            if pair_progress and fetched % 25 == 0:
                print(f"pairs cache {fetched}/{keys_n} unique (ticker, expiry)", flush=True)
        c = _s059_contract(conn, e, pairs_cache)
        if c:
            out[event_key(c)] = c
    return out


def collect_s059_sample(conn, limit: int) -> list[Contract]:
    """Fetch pairs lazily until `limit` snapped S059 contracts (smoke path)."""
    pairs_cache: dict[tuple[str, date], list[float]] = {}
    out: list[Contract] = []
    events = sorted(
        (e for e in S59.aligned_events(conn) if e["d"] >= ENTRY_CUT),
        key=lambda e: (e["d"], e["t"]),
        reverse=True,
    )
    for e in events:
        key = (e["t"].upper(), e["expiry"])
        if key not in pairs_cache:
            pairs_cache[key] = list_put_strikes(conn, e["t"], e["expiry"])
        c = _s059_contract(conn, e, pairs_cache)
        if not c:
            continue
        if any(x.occ == c.occ and x.entry == c.entry for x in out):
            continue
        fetch_log, done = load_skip_sets(conn)
        if skip_occ(fetch_log, done, c.occ):
            continue
        out.append(c)
        if len(out) >= limit:
            break
    return out


def collect_model_puts(conn) -> dict[tuple[str, date, str], Contract]:
    out: dict[tuple[str, date, str], Contract] = {}
    for ticker, expiry, strike, snap in conn.execute(
        """SELECT ticker, expiry, strike::float8, snapshot_date
           FROM model_recs WHERE side = 'put' AND strike > 0"""
    ).fetchall():
        strike_f = float(strike)
        occ = occ_symbol(ticker, expiry, strike_f, "put")
        c = Contract(
            occ=occ,
            ticker=ticker,
            side="put",
            strike=strike_f,
            expiry=expiry,
            entry=snap,
            model_strike=None,
            source="model_recs",
        )
        out[event_key(c)] = c
    return out


def collect_contracts(conn) -> list[Contract]:
    # Sources stay separate. A model_recs row must not replace an S059 event on the same OCC.
    events = [*collect_s059_puts(conn).values(), *collect_model_puts(conn).values()]
    return sorted(events, key=lambda c: (c.entry, c.ticker, c.occ, c.source))


def collect_sample_contracts(conn, events: list[SampleEvent]) -> list[Contract]:
    """Snap only sampled events (pairs called per unique ticker, expiry)."""
    print(f"pair cache warm {warm_pair_cache(conn)}", flush=True)
    pairs_cache: dict[tuple[str, date], list[float]] = {}
    pair_keys = {(se.t.upper(), se.expiry_date()) for se in events}
    keys_n = len(pair_keys)
    fetched = 0
    for ticker, expiry in sorted(pair_keys, key=lambda x: (x[1], x[0]), reverse=True):
        pairs_cache[(ticker, expiry)] = list_put_strikes(conn, ticker, expiry)
        fetched += 1
        if fetched % 25 == 0 or fetched == keys_n:
            print(f"pairs cache {fetched}/{keys_n} unique (ticker, expiry)", flush=True)
    aligned = {(e["t"], e["d"], e["expiry"]): e for e in S59.aligned_events(conn)}
    out: list[Contract] = []
    seen: set[tuple[str, date]] = set()
    for se in sorted(events, key=lambda x: (x.entry(), x.t), reverse=True):
        key = (se.t, se.entry(), se.expiry_date())
        base = aligned.get(key)
        ev = dict(base) if base else {"t": se.t, "d": se.entry(), "expiry": se.expiry_date()}
        if "hold_sessions" not in ev:
            ev["hold_sessions"] = max((se.expiry_date() - se.entry()).days, 1)
        c = _s059_contract(conn, ev, pairs_cache)
        if not c or (c.occ, c.entry) in seen:
            continue
        seen.add((c.occ, c.entry))
        out.append(c)
    return out


def load_skip_sets(conn) -> tuple[set[str], set[str]]:
    logged = {
        r[0]
        for r in conn.execute(
            "SELECT occ FROM lse_option_fetch_log WHERE status IN ('no_data', 'no_listed_strike')"
        ).fetchall()
    }
    done = {r[0] for r in conn.execute("SELECT DISTINCT occ FROM lse_option_daily").fetchall()}
    return logged, done


def skip_occ(fetch_log: set[str], done: set[str], occ: str) -> bool:
    return occ in fetch_log or occ in done


def persist_rows(conn, c: Contract, rows: list[dict]) -> int:
    n = 0
    for r in rows:
        conn.execute(
            """INSERT INTO lse_option_daily (occ, ticker, side, strike, model_strike, expiry, date, open, high, low, close, volume)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (occ, date) DO UPDATE SET
                 open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
                 close = EXCLUDED.close, volume = EXCLUDED.volume,
                 model_strike = EXCLUDED.model_strike, fetched_at = now()""",
            (
                c.occ,
                c.ticker,
                c.side,
                c.strike,
                c.model_strike,
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
        _log_fetch(conn, c.occ, "no_data", model_strike=c.model_strike, strike=c.strike)
        return "no_data"
    head = body.lstrip()[:40].lower()
    if status != 200 or '"time"' not in head:
        _log_fetch(conn, c.occ, f"http_{status}", model_strike=c.model_strike, strike=c.strike)
        return f"http_{status}"
    rows = parse_export_rows(body)
    persist_rows(conn, c, rows)
    return f"ok_{len(rows)}"


def smoke_validate(conn, contracts: list[Contract], n_check: int = 3) -> bool:
    """Every overlap vs the exact snapped strike. Fail when the median relative gap exceeds 15%."""
    rels: list[float] = []
    by_ticker: dict[str, list[float]] = {}
    seen: set[str] = set()
    for c in contracts:
        if c.occ in seen:
            continue
        seen.add(c.occ)
        lse = {
            r[0]: float(r[1])
            for r in conn.execute(
                "SELECT date, close::float8 FROM lse_option_daily WHERE occ = %s AND date >= %s AND close IS NOT NULL",
                (c.occ, CHAIN_OVERLAP),
            ).fetchall()
        }
        for d, lse_close in sorted(lse.items()):
            row = conn.execute(
                """SELECT bid::float8, ask::float8, last::float8, strike::float8 FROM option_chain_history
                   WHERE ticker = %s AND expiry = %s AND side = %s AND as_of = %s
                     AND ABS(strike::float8 - %s) <= 0.02
                   ORDER BY ABS(strike::float8 - %s) LIMIT 1""",
                (c.ticker, c.expiry, c.side, d, c.strike, c.strike),
            ).fetchone()
            if not row:
                continue
            bid, ask, last, _stk = row
            ref = last if last and last > 0 else ((bid or 0) + (ask or 0)) / 2 if bid and ask else None
            if ref is None or ref <= 0:
                continue
            rel = abs(lse_close - ref) / ref
            rels.append(rel)
            by_ticker.setdefault(c.ticker, []).append(rel)
            print(
                f"smoke {c.ticker} {d} strike={c.strike:.2f} LSE={lse_close:.3f} chain={ref:.3f} rel={rel:.2%}",
                flush=True,
            )
    for ticker, xs in sorted(by_ticker.items()):
        if median(xs) > 0.15:
            print(f"smoke FAIL {ticker}: median rel {median(xs):.2%} > 15% over {len(xs)} overlaps", flush=True)
    ticker_fail = any(median(xs) > 0.15 for xs in by_ticker.values())
    if ticker_fail or divergence_fails(rels, min_n=n_check):
        med = median(rels) if rels else float("nan")
        print(f"smoke FAIL: n={len(rels)} median rel={med:.2%} (need ≥{n_check} overlaps and median ≤ 15%)", flush=True)
        return False
    print(f"smoke: {len(rels)} overlaps, median rel {median(rels):.2%}", flush=True)
    return True


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--sample", action="store_true", help="A357 step 4 — champion+random tercile sample only")
    ap.add_argument("--smoke-validate", action="store_true")
    ap.add_argument("--s059-only", action="store_true", help="Only S059 contracts (for strike-snap smoke)")
    ap.add_argument("--min-ok", type=int, default=0, help="Exit 1 if fewer than N ok_* in this run")
    args = ap.parse_args()

    with connect() as conn:
        ensure_tables(conn)
        smoke_sample = args.s059_only and args.limit and not args.dry_run and not args.sample
        if args.sample:
            loaded = load_sample_plan()
            if loaded:
                events, meta = loaded
                print(f"A357 sample · reusing {SAMPLE_PATH} ({meta.get('n_events')} events)", flush=True)
            else:
                scored = A352.rebuild_book(conn)
                events, meta = build_sample_plan(scored)
                save_sample_plan(events, meta)
                print(f"A357 sample · wrote plan → {SAMPLE_PATH}", flush=True)
            print(
                f"sample: {meta['n_events']} events · {meta['n_days']} days (≥{meta.get('week_floor')}) · "
                f"~{meta['estimated_lse_calls']} LSE calls ({meta['n_unique_ticker_expiry']} pair caches + exports)",
                flush=True,
            )
            if args.dry_run:
                return
            contracts = collect_sample_contracts(conn, events)
            print(f"snapped {len(contracts)} events for sample", flush=True)
        elif smoke_sample:
            todo = collect_s059_sample(conn, args.limit)
            contracts = todo
            print(f"A357 smoke · {len(todo)} S059 contracts (lazy pairs)", flush=True)
        else:
            contracts = collect_contracts(conn)
            n_s059 = sum(1 for c in contracts if c.source == "s059")
            print(
                f"A357 backfill · {len(contracts)} events ({n_s059} S059≥{ENTRY_CUT} + model_recs puts)",
                flush=True,
            )
        if args.dry_run:
            return

        fetch_log, done = load_skip_sets(conn)
        contracts = widest_fetch(contracts)
        if args.sample:
            todo = [c for c in contracts if not skip_occ(fetch_log, done, c.occ)]
            todo.sort(key=lambda c: (c.entry, c.ticker), reverse=True)
        elif not smoke_sample:
            todo = [c for c in contracts if not skip_occ(fetch_log, done, c.occ)]
            if args.s059_only:
                todo = [c for c in todo if c.source == "s059"]
        else:
            todo = [c for c in contracts if not skip_occ(fetch_log, done, c.occ)]
        todo.sort(key=lambda c: (c.entry, c.ticker), reverse=True)
        if args.smoke_validate:
            todo = [c for c in todo if c.entry >= CHAIN_OVERLAP]
        if args.smoke_validate and args.limit == 0:
            raise SystemExit("smoke-validate needs --limit N")
        if args.limit:
            todo = todo[: args.limit]
        print(f"pending {len(todo)} (skipped {len(contracts) - len(todo)} resumable)", flush=True)

        ok_count = 0
        if todo:
            for i, c in enumerate(todo, 1):
                st = fetch_one(conn, c)
                if status_is_ok(st):
                    ok_count += 1
                if i % 25 == 0 or args.limit:
                    print(f"  [{i}/{len(todo)}] {c.ticker} {c.occ[-20:]} → {st}", flush=True)

        if args.min_ok and ok_count < args.min_ok:
            raise SystemExit(f"smoke failed: {ok_count} ok (need ≥ {args.min_ok})")

        if args.smoke_validate and todo:
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
