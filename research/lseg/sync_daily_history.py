"""Daily close + ATM implied-vol history → lseg_research.daily_history (research/backtests only).

Efficiency / integrity rules:
  - Batched: one get_history call covers up to BATCH RICs (LSEG returns one column per RIC, or (RIC, field) pairs).
  - Incremental per ticker: resumes from its own last stored date; never re-fetches stored history.
  - Resumable: commits after every batch, so an interrupted run loses at most one batch.
  - Corporate actions, any split or reverse split: each incremental fetch re-reads the last OVERLAP stored days. LSEG returns
    history on *today's* share basis, so if those days no longer match what we stored (median ratio off by > 1%), the
    ticker's whole close history is re-fetched and replaced. Logged to lseg_research.corporate_action_log.
  - Budget: only the columns backtests use (~4 points/day); the monthly datapoint guard lives in _session.lseg_session.

Usage: .venv/bin/python sync_daily_history.py [--tickers … | coverage default] [--start 2020-01-01] [--force]
"""
from __future__ import annotations

import argparse
from datetime import date, timedelta
from statistics import median

from _session import add_lseg_universe_args, clean, connect_local, load_ric_map, lseg_session, resolve_lseg_universe
from db import ensure_schema, log_pull, upsert_sync_state

DATASET = "daily_history"
BATCH = 20
OVERLAP = 5
ACTION_TOL = 0.01
IV_FETCH = {"30D_A_IM_P": "iv30_put", "30D_A_IM_C": "iv30_call", "60D_A_IM_P": "iv60_put"}
COLS = ["close", "iv30_put", "iv30_call", "iv60_put", "iv60_call", "iv90_put", "iv90_call"]
UPSERT = f"""
INSERT INTO lseg_research.daily_history (ticker, date, {", ".join(COLS)}, fetched_at)
VALUES (%s, %s, {", ".join(["%s"] * len(COLS))}, now())
ON CONFLICT (ticker, date) DO UPDATE SET {", ".join(f"{c} = COALESCE(EXCLUDED.{c}, daily_history.{c})" for c in COLS)}, fetched_at = now()
"""
ACTION_DDL = """CREATE TABLE IF NOT EXISTS lseg_research.corporate_action_log (
  id bigserial PRIMARY KEY, ticker text NOT NULL, detected_at timestamptz NOT NULL DEFAULT now(),
  ratio double precision NOT NULL, overlap_days integer NOT NULL, action text NOT NULL)"""


def atmiv_ric(ticker: str) -> str:
    return f"{ticker.replace('.', '')}ATMIV.U"


def series_of(frame, ric: str, field: str) -> list[tuple[date, float]]:
    """(date, value) for one RIC/field from a get_history frame of any shape:
    multi-RIC multi-field → (ric, field) columns · multi-RIC one field → ric columns · one RIC → field columns."""
    if frame is None or getattr(frame, "empty", True):
        return []
    cols = frame.columns
    if getattr(cols, "nlevels", 1) > 1:
        if (ric, field) not in cols:
            return []
        s = frame[(ric, field)]
    elif ric in cols:
        s = frame[ric]
    elif field in cols:
        s = frame[field]
    else:
        return []
    return [(ix.date(), float(v)) for ix, v in s.items() if clean(v) is not None]


def fetch(ld, rics: list[str], fields: list[str], start: str, end: str) -> dict:
    """{ric: frame}. One request per batch; if a bad RIC fails the batch, retry one by one."""
    if not rics:
        return {}
    try:
        # end= is required: without it get_history silently returns only the last 20 rows.
        h = ld.get_history(rics, fields=fields, interval="daily", start=start, end=end)
        return {r: h for r in rics}
    except Exception as e:
        if len(rics) == 1:
            print(f"warn: {rics[0]}: {str(e)[:80]}")
            return {}
        out = {}
        for r in rics:
            out.update(fetch(ld, [r], fields, start, end))
        return out


def fallback_closes(ld, rics: list[str], start: str, end: str) -> dict[str, list[tuple[date, float]]]:
    """Daily closes via the reference-data field TR.PriceClose for RICs the time-series service rejects
    (2026-10-05: AVB.N / EQR.N return TS.Interday error 70005 for TRDPRC_1 but have TR.PriceClose history). One request per batch."""
    out: dict[str, list[tuple[date, float]]] = {}
    if not rics:
        return out
    try:
        df = ld.get_data(rics, ["TR.PriceClose.date", "TR.PriceClose"], {"SDate": start, "EDate": end, "Frq": "D"})
    except Exception as e:
        print(f"warn: TR.PriceClose fallback {rics[:3]}: {str(e)[:80]}")
        return out
    for _, r in df.iterrows():
        d, v = clean(r.iloc[1]), clean(r.iloc[2])
        if d is not None and v is not None:
            out.setdefault(r.iloc[0], []).append((d.date() if hasattr(d, "date") else d, float(v)))
    return out


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    add_lseg_universe_args(p)
    p.add_argument("--start", default="2020-01-01")
    args = p.parse_args()
    tickers = resolve_lseg_universe(args)
    end = date.today().isoformat()
    with connect_local() as conn:
        ensure_schema(conn)
        conn.execute(ACTION_DDL)
        conn.commit()
        stored: dict[str, dict[date, float]] = {}
        for t, d, c in conn.execute("""SELECT ticker, date, close FROM (SELECT ticker, date, close, row_number() OVER (PARTITION BY ticker ORDER BY date DESC) k
                                       FROM lseg_research.daily_history WHERE ticker = ANY(%s) AND close IS NOT NULL) x WHERE k <= %s""",
                                    (tickers, OVERLAP)).fetchall():
            stored.setdefault(t, {})[d] = c
        first = dict(conn.execute("SELECT ticker, MIN(date) FROM lseg_research.daily_history WHERE ticker = ANY(%s) GROUP BY 1", (tickers,)).fetchall())
    ric_map = load_ric_map(tickers)
    # one date range per batch: new/forced tickers from --start; existing ones from their overlap window
    groups: dict[str, list[str]] = {}
    for t in tickers:
        s = args.start if args.force or t not in stored else (min(stored[t]) - timedelta(days=1)).isoformat()
        groups.setdefault(s, []).append(t)
    total, actions, no_iv = 0, [], []
    with lseg_session() as ld, connect_local() as conn:
        try:
            for start, ts in sorted(groups.items()):
                for i in range(0, len(ts), BATCH):
                    batch = ts[i:i + BATCH]
                    px = fetch(ld, [ric_map[t] for t in batch if t in ric_map], ["TRDPRC_1"], start, end)
                    missing = [ric_map[t] for t in batch if t in ric_map and not series_of(px.get(ric_map[t]), ric_map[t], "TRDPRC_1")]
                    fb = fallback_closes(ld, missing, start, end)
                    ivs = fetch(ld, [atmiv_ric(t) for t in batch], list(IV_FETCH), start, end)
                    rows, refetch = [], []
                    for t in batch:
                        ric = ric_map.get(t)
                        closes = dict(series_of(px.get(ric), ric, "TRDPRC_1") or fb.get(ric, [])) if ric else {}
                        old = stored.get(t, {})
                        common = [d for d in old if d in closes and old[d]]
                        if common and not args.force:
                            ratio = median(closes[d] / old[d] for d in common)
                            if abs(ratio - 1) > ACTION_TOL:
                                refetch.append(t)
                                actions.append((t, ratio, len(common)))
                        day: dict[date, dict] = {d: {"close": v} for d, v in closes.items()}
                        got = False
                        for src, col in IV_FETCH.items():
                            for d, v in series_of(ivs.get(atmiv_ric(t)), atmiv_ric(t), src):
                                if v > 0:
                                    day.setdefault(d, {})[col] = v
                                    got = True
                        if not got and t not in stored:
                            no_iv.append(t)
                        if t not in refetch:
                            rows += [(t, d, *[v.get(c) for c in COLS]) for d, v in day.items()]
                    if refetch:  # history changed share basis (split / reverse split): replace closes wholesale
                        for t in refetch:  # each from its own first stored date, so deeper history isn't lost
                            since = min(first.get(t, date.fromisoformat(args.start)), date.fromisoformat(args.start)).isoformat()
                            full = fetch(ld, [ric_map[t]], ["TRDPRC_1"], since, end) if t in ric_map else {}
                            ser = series_of(full.get(ric_map.get(t)), ric_map.get(t), "TRDPRC_1")
                            if not ser:
                                continue
                            conn.execute("UPDATE lseg_research.daily_history SET close = NULL WHERE ticker = %s", (t,))
                            rows += [(t, d, v, None, None, None, None, None, None) for d, v in ser]
                            r = next(a for a in actions if a[0] == t)
                            conn.execute("INSERT INTO lseg_research.corporate_action_log (ticker, ratio, overlap_days, action) VALUES (%s, %s, %s, %s)",
                                         (t, r[1], r[2], f"close history re-fetched from {since}"))
                    with conn.cursor() as cur:
                        cur.executemany(UPSERT, rows)
                    conn.commit()  # resumable: each batch is durable
                    total += len(rows)
        except Exception as e:
            conn.rollback()
            log_pull(conn, dataset=DATASET, status="error", tickers=tickers, error=str(e)[:500])
            conn.commit()
            raise
        upsert_sync_state(conn, dataset=DATASET, watermark=end, rows=total, tickers=tickers)
        log_pull(conn, dataset=DATASET, status="ok", tickers=tickers, rows=total, watermark_from=args.start)
        conn.commit()
    print(f"{DATASET}: {total} rows upserted · {len(tickers)} tickers in {sum((len(v) + BATCH - 1) // BATCH for v in groups.values())} batches · "
          f"corporate actions: {[(t, round(r, 4)) for t, r, _ in actions] or 'none'} · new names without IV: {no_iv[:20]}")


if __name__ == "__main__":
    main()
