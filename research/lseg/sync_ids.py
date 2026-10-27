"""Resolve ticker → RIC / CUSIP / ISIN into research_common.security_map (LSEG columns only).

Loop D in research/LSEG_WRDS_SYNC.md: WRDS joins IBES/CRSP on the CUSIPs written here.
Never touches ibes_oftic / crsp_permno (WRDS-owned).

Usage: .venv/bin/python sync_ids.py [--tickers NVDA,BRK.B | --universe book|registry] [--force]
       .venv/bin/python sync_ids.py --missing     # daily: every universe name without a RIC (10-27: 422 had none → no LSEG data)
"""
from __future__ import annotations

import argparse
from datetime import timedelta, datetime, timezone

from _session import add_lseg_universe_args, resolve_lseg_universe, clean, connect_local, lseg_session
from db import ensure_schema, get_last_ok, log_pull, upsert_sync_state

DATASET = "security_map_ids"
US_VENUES = ("NASDAQ", "NYSE", "CBOE", "BATS")
TTL = timedelta(days=30)
MISS_RETRY_DAYS = 30   # a name LSEG can't resolve is remembered (ric NULL row) and retried monthly, not daily

UPSERT = """
INSERT INTO research_common.security_map (ticker, ric, cusip, isin, updated_by_lseg, updated_at)
VALUES (%s, %s, %s, %s, now(), now())
ON CONFLICT (ticker) DO UPDATE SET
  ric   = COALESCE(EXCLUDED.ric,   research_common.security_map.ric),
  cusip = COALESCE(EXCLUDED.cusip, research_common.security_map.cusip),
  isin  = COALESCE(EXCLUDED.isin,  research_common.security_map.isin),
  updated_by_lseg = now(),
  updated_at = now()
"""


def _norm(t: str) -> str:
    return "".join(ch for ch in t.upper() if ch.isalnum())  # "BRK B" / "BRK.B" → BRKB


def fallback_rics(ticker: str) -> list[str]:
    """Candidate US RICs when symbol conversion misses (e.g. class shares BRK.B → BRKb.N)."""
    if "." in ticker or "/" in ticker or "-" in ticker:
        base, cls = ticker.replace("/", ".").replace("-", ".").split(".", 1)
        roots = [f"{base}{cls.lower()}"]
    else:
        roots = [ticker]
    return [f"{r}{sfx}" for r in roots for sfx in (".O", ".N", ".K", "", ".A", ".P", ".Z")]


def verify(ld, rics: list[str]) -> dict[str, dict]:
    """RIC → {ticker_symbol, cusip, isin} for RICs that resolve to a US ISIN."""
    out: dict[str, dict] = {}
    if not rics:
        return out
    df = ld.get_data(rics, ["TR.TickerSymbol", "TR.CUSIP", "TR.ISIN", "TR.ExchangeName", "TR.PriceClose"])
    for _, r in df.iterrows():
        isin = clean(r.get("ISIN"))
        exch = str(clean(r.get("Exchange Name")) or "").upper()
        if "^" in str(r["Instrument"]):  # expired / delisted RIC (e.g. BFb.B^J07)
            continue
        # US ISIN, or a foreign issuer listed on a US venue (POET: CA ISIN on NASDAQ)
        if isin and (str(isin).startswith("US") or any(v in exch for v in US_VENUES)):
            out[r["Instrument"]] = {
                "symbol": clean(r.get("Ticker Symbol")),
                "cusip": clean(r.get("CUSIP")),
                "isin": isin,
                "price": clean(r.get("Price Close")),
            }
    return out


def _app_closes(tickers: list[str]) -> dict[str, tuple[float, object]]:
    from _session import connect_local
    with connect_local() as conn:
        return {t: (float(c), d) for t, d, c in conn.execute(
            "SELECT DISTINCT ON (ticker) ticker, date, close FROM prices_historical WHERE ticker = ANY(%s) ORDER BY ticker, date DESC", (tickers,)).fetchall() if c}


def _matches(t: str, info: dict | None, app: dict, ld=None, ric: str | None = None) -> bool:
    """Ticker field agrees, or (LSEG's ticker field is blank/odd, e.g. AVB.N '' / EQR.N 'VMRK') its price matches the app's last
    close within 3%: a second-source check instead of trusting vendor metadata."""
    if not info:
        return False
    if _norm(info["symbol"] or "") == _norm(t):
        return True
    if t not in app:
        return False
    a, d = app[t]
    p = info.get("price")
    if p and abs(float(p) / a - 1) <= 0.03:
        return True
    if ld is not None and ric:  # the app's close may be stale: compare LSEG's close on the app's last date instead
        try:
            df = ld.get_data(ric, ["TR.PriceClose"], {"SDate": str(d), "EDate": str(d)})
            v = clean(df.iloc[0, 1]) if len(df) else None
            return bool(v and abs(float(v) / a - 1) <= 0.03)
        except Exception:
            return False
    return False


def resolve(ld, tickers: list[str]) -> dict[str, tuple[str, str | None, str]]:
    from lseg.data.discovery import SymbolTypes, convert_symbols

    found: dict[str, tuple[str, str | None, str]] = {}
    conv = convert_symbols(
        tickers,
        from_symbol_type=SymbolTypes.TICKER_SYMBOL,
        to_symbol_types=[SymbolTypes.RIC],
    )
    candidates = {t: clean(conv.loc[t, "RIC"]) if t in conv.index else None for t in tickers}
    checked = verify(ld, [r for r in candidates.values() if r])
    app = _app_closes(tickers)
    for t, ric in candidates.items():
        info = checked.get(ric) if ric else None
        if _matches(t, info, app, ld, ric):
            found[t] = (ric, info["cusip"], info["isin"])

    # One RIC per call: a single unknown RIC can fail the whole batch.
    for t in [t for t in tickers if t not in found]:
        for ric in fallback_rics(t):
            try:
                info = verify(ld, [ric]).get(ric)
            except Exception:
                continue
            if _matches(t, info, app, ld, ric):
                found[t] = (ric, info["cusip"], info["isin"])
                break
    return found


def missing_tickers(conn) -> list[str]:
    """Active universe names with no RIC, skipping ones that failed to resolve in the last MISS_RETRY_DAYS."""
    return [r[0] for r in conn.execute("""
        SELECT r.ticker FROM ticker_registry r LEFT JOIN research_common.security_map s ON s.ticker = r.ticker
        WHERE r.is_active AND r.fetch_fundamentals AND s.ric IS NULL
          AND (s.updated_by_lseg IS NULL OR s.updated_by_lseg < now() - make_interval(days => %s))
        ORDER BY 1""", (MISS_RETRY_DAYS,))]


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    add_lseg_universe_args(p)
    p.add_argument("--missing", action="store_true", help="only universe names without a RIC (no TTL, no cap)")
    args = p.parse_args()
    if args.missing:
        with connect_local() as conn:
            tickers = missing_tickers(conn)
        if not tickers:
            print("no universe names missing a RIC")
            return
        args.tickers = ",".join(tickers)   # bypass the TTL skip below
    else:
        tickers = resolve_lseg_universe(args)

    with connect_local() as conn:
        ensure_schema(conn)
        last = get_last_ok(conn, DATASET)
        if last and not args.force and not args.tickers and datetime.now(timezone.utc) - last < TTL:
            print(f"skip: {DATASET} refreshed {last:%Y-%m-%d} (< {TTL.days}d). Use --force.")
            return

    with lseg_session() as ld:
        found = resolve(ld, tickers)

    missing = [t for t in tickers if t not in found]
    # Soft misses (foreign / thin names) are expected forever — keep them in notes,
    # never in pull_log.error. Only hard-fail when the batch mostly misses (vendor outage).
    resolved_pct = (100.0 * len(found) / len(tickers)) if tickers else 100.0
    soft_miss = bool(missing) and resolved_pct >= 95.0
    hard_miss = bool(missing) and not soft_miss
    notes = f"unresolved: {','.join(missing)}" if missing else ""
    status = "ok" if not missing else ("partial" if soft_miss else "error")
    with connect_local() as conn:
        with conn.cursor() as cur:
            cur.executemany(UPSERT, [(t, *found[t]) for t in found])
            # remember misses so --missing retries them monthly, not every day
            cur.executemany("""INSERT INTO research_common.security_map (ticker, updated_by_lseg, updated_at) VALUES (%s, now(), now())
                               ON CONFLICT (ticker) DO UPDATE SET updated_by_lseg = now()
                               WHERE research_common.security_map.ric IS NULL""", [(t,) for t in missing])
        # Soft partial still advances last_ok_at so Settings does not stay red forever.
        upsert_sync_state(conn, dataset=DATASET, watermark=datetime.now(timezone.utc).date().isoformat(),
                          rows=len(found), tickers=tickers, notes=notes)
        log_pull(
            conn,
            dataset=DATASET,
            status=status,
            tickers=tickers,
            rows=len(found),
            error=f"unresolved: {missing}" if hard_miss else None,
        )
        conn.commit()

    for t in tickers:
        print(f"{t:7s} {' | '.join(str(x) for x in found[t]) if t in found else 'UNRESOLVED'}")
    print(f"{len(found)}/{len(tickers)} resolved")


if __name__ == "__main__":
    main()
