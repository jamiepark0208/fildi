#!/usr/bin/env python3
"""W1 — Fill WRDS-owned columns on research_common.security_map (ibes_oftic, crsp_permno).

GOOGL vs GOOG are separate share classes (A vs C). Prefer exact ticker match on
IBES idsum / CRSP stocknames; fall back to 8-char CUSIP only when ticker misses.
Never overwrites LSEG ric/cusip/isin columns.

Usage:
  cd research/wrds && .venv/bin/python fill_security_map_wrds.py
  .venv/bin/python fill_security_map_wrds.py --tickers GOOGL,GOOG,NVDA
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone

from _auth import connect
from db import connect_local, ensure_schema, log_pull, upsert_sync_state
from universe import add_universe_args, resolve_universe

DATASET = "security_map_wrds"

UPSERT = """
UPDATE research_common.security_map SET
  ibes_oftic = COALESCE(%s, ibes_oftic),
  crsp_permno = COALESCE(%s, crsp_permno),
  updated_by_wrds = now(),
  updated_at = now()
WHERE ticker = %s
"""


def cusip8(c: str | None) -> str | None:
    if not c:
        return None
    s = "".join(ch for ch in str(c).upper() if ch.isalnum())
    return s[:8] if len(s) >= 8 else (s or None)


def load_local_rows(tickers: list[str] | None) -> list[tuple[str, str | None]]:
    with connect_local() as conn:
        if tickers:
            rows = conn.execute(
                "SELECT ticker, cusip FROM research_common.security_map WHERE ticker = ANY(%s) ORDER BY ticker",
                (tickers,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT ticker, cusip FROM research_common.security_map ORDER BY ticker"
            ).fetchall()
    return [(str(t).upper(), c) for t, c in rows]


def resolve_oftic(db, tickers: list[str], cusip_by_t: dict[str, str | None]) -> dict[str, str]:
    if not tickers:
        return {}
    sql_list = ",".join(repr(t) for t in tickers)
    df = db.raw_sql(
        f"""
        SELECT oftic, ticker, cusip, sdates
        FROM tr_ibes.idsum
        WHERE UPPER(oftic) IN ({sql_list})
           OR UPPER(ticker) IN ({sql_list})
        """
    )
    out: dict[str, str] = {}
    if df is None or df.empty:
        # CUSIP fallback batch
        c8s = sorted({cusip8(c) for c in cusip_by_t.values() if cusip8(c)})
        if not c8s:
            return out
        csql = ",".join(repr(c) for c in c8s)
        df = db.raw_sql(
            f"SELECT oftic, ticker, cusip, sdates FROM tr_ibes.idsum WHERE LEFT(cusip, 8) IN ({csql})"
        )
        if df is None or df.empty:
            return out

    # Prefer exact oftic == our ticker (latest sdates)
    df = df.copy()
    df["oftic_u"] = df["oftic"].astype(str).str.upper()
    df["tick_u"] = df["ticker"].astype(str).str.upper()
    df["c8"] = df["cusip"].map(cusip8)
    df = df.sort_values("sdates", ascending=False, na_position="last")

    for t in tickers:
        hit = df[df["oftic_u"] == t]
        if hit.empty:
            hit = df[df["tick_u"] == t]
        if hit.empty:
            c = cusip8(cusip_by_t.get(t))
            if c:
                hit = df[df["c8"] == c]
                # If CUSIP matches multiple classes, require oftic startswith ticker root carefully:
                # for class shares, oftic should equal ticker when present in map.
                if not hit.empty and len(hit["oftic_u"].unique()) > 1:
                    prefer = hit[hit["oftic_u"] == t]
                    hit = prefer if not prefer.empty else hit.iloc[0:0]
        if not hit.empty:
            out[t] = str(hit.iloc[0]["oftic_u"])
    return out


def resolve_permno(db, tickers: list[str], cusip_by_t: dict[str, str | None]) -> dict[str, int]:
    if not tickers:
        return {}
    sql_list = ",".join(repr(t) for t in tickers)
    df = db.raw_sql(
        f"""
        SELECT permno, ticker, ncusip, cusip, nameenddt, shrcls
        FROM crsp.stocknames
        WHERE UPPER(ticker) IN ({sql_list})
        """
    )
    out: dict[str, int] = {}
    by_ticker = df.copy() if df is not None and not df.empty else None
    if by_ticker is not None:
        by_ticker["tick_u"] = by_ticker["ticker"].astype(str).str.upper()
        by_ticker = by_ticker.sort_values("nameenddt", ascending=False, na_position="last")
        for t in tickers:
            hit = by_ticker[by_ticker["tick_u"] == t]
            if not hit.empty:
                out[t] = int(hit.iloc[0]["permno"])

    missing = [t for t in tickers if t not in out]
    if not missing:
        return out

    c8s = sorted({cusip8(cusip_by_t[t]) for t in missing if cusip8(cusip_by_t.get(t))})
    if not c8s:
        return out
    csql = ",".join(repr(c) for c in c8s)
    cdf = db.raw_sql(
        f"""
        SELECT permno, ticker, ncusip, cusip, nameenddt, shrcls
        FROM crsp.stocknames
        WHERE ncusip IN ({csql}) OR LEFT(cusip, 8) IN ({csql})
        """
    )
    if cdf is None or cdf.empty:
        return out
    cdf = cdf.copy()
    cdf["tick_u"] = cdf["ticker"].astype(str).str.upper()
    cdf["c8"] = cdf["ncusip"].map(cusip8)
    cdf = cdf.sort_values("nameenddt", ascending=False, na_position="last")
    used = set(out.values())
    for t in missing:
        c = cusip8(cusip_by_t.get(t))
        if not c:
            continue
        hit = cdf[cdf["c8"] == c]
        # Prefer row whose ticker equals ours; else first unused permno for that CUSIP
        prefer = hit[hit["tick_u"] == t]
        pool = prefer if not prefer.empty else hit
        for _, row in pool.iterrows():
            p = int(row["permno"])
            if p in used and t not in out:
                # allow if already assigned to this ticker only
                continue
            if p not in used or out.get(t) == p:
                out[t] = p
                used.add(p)
                break
    return out


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    add_universe_args(p)
    p.add_argument(
        "--filter-universe",
        action="store_true",
        help="Restrict to --universe / --tickers (default: all security_map rows)",
    )
    args = p.parse_args()

    want = resolve_universe(args) if (args.tickers or args.filter_universe) else None
    local_rows = load_local_rows(want)
    if not local_rows:
        print("no security_map rows — run LSEG sync_ids.py first")
        return 2

    tickers = [t for t, _ in local_rows]
    cusip_by_t = {t: c for t, c in local_rows}
    print(f"resolving {len(tickers)} tickers (GOOGL≠GOOG — separate classes)", flush=True)

    db = connect()
    try:
        oftic = resolve_oftic(db, tickers, cusip_by_t)
        permno = resolve_permno(db, tickers, cusip_by_t)
    finally:
        db.close()

    n = 0
    with connect_local() as conn:
        ensure_schema(conn)
        # security_map lives in research_common — ensure exists
        for t in tickers:
            o = oftic.get(t)
            pno = permno.get(t)
            if o is None and pno is None:
                continue
            conn.execute(UPSERT, (o, pno, t))
            n += 1
            print(f"{t:8s} oftic={o or '—':8s} permno={pno or '—'}")
        upsert_sync_state(
            conn,
            dataset=DATASET,
            watermark=datetime.now(timezone.utc).date().isoformat(),
            rows=n,
            tickers=tickers,
            notes=f"oftic={len(oftic)} permno={len(permno)}",
        )
        log_pull(conn, dataset=DATASET, status="ok", tickers=tickers, rows=n)
        conn.commit()

    missing_o = [t for t in tickers if t not in oftic]
    missing_p = [t for t in tickers if t not in permno]
    print(f"updated={n} oftic={len(oftic)}/{len(tickers)} permno={len(permno)}/{len(tickers)}")
    if missing_o:
        print(f"no oftic: {','.join(missing_o[:20])}")
    if missing_p:
        print(f"no permno: {','.join(missing_p[:20])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
