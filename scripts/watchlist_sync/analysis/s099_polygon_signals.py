"""S099 — Massive/Polygon free endpoints vs Fildi's stock and put boards (A262).

Question: do short interest, short volume, Form 4, and non-earnings 8-Ks add to
21-day peer-residual return or to weekly short-put pnl beyond what Fildi already
ranks on? Related tickers are checked against peer_groups (verification). Float
is a snapshot. 13-F has no ticker filter.

Frozen before the full run (do not flip a sign and call it a pass):
  dtc     days_to_cover of the latest FINRA print with settlement_date <= Monday − 12d
          (publication lag). High = more crowded short.
  si_chg  that print / the prior print − 1, prior settlement within 45 days.
  sv20    mean short_volume_ratio over the last 10–20 prints with date <= Monday − 1d,
          span <= 40 calendar days. The vendor field is a percent (34.5 = 34.5%).
  ins_net open-market net shares over filings with filing_date in (Monday−90d, Monday]:
          code P positive, code S negative, security_type non_derivative
          (the live value; hyphenated form accepted), record_type transaction.
          Grants, exercises, gifts ignored. A fetched name with no such rows is 0.
  ek21    distinct 8-K accessions with filing_date in (Monday−21d, Monday] that have
          at least one disclosure outside earnings. Live taxonomy (5-name smoke,
          before the board): primary financial_results, secondary
          earnings_and_performance / guidance_and_outlook, tertiary
          quarterly_earnings / annual_earnings. Doc example labels
          earnings_announcement and quarterly_results are excluded too.

Not tested as return signals: free float (endpoint has no history), related tickers
(snapshot), 13-F (filer scan only; a cusip query is ignored).

Pass bar (INDEX S099 / A262, unchanged): holdout 2023-01→ week-clustered t >= 2,
same sign in both halves split at the panel's median Monday, AND marginal t >= 2
(Fama-MacBeth partial, or within-comparator-quintile). Stock comparator =
StarMine combined_alpha_rank + lab_tech v2. Put comparator = put_edge
(rank IV/RV + vol-of-vol + put tech) on the S059 harness. t >= 2 is one-sided
on the raw feature (high value, high outcome). A negative t is reported and
is not a pass.

Run from scripts/watchlist_sync:
  nice -n 15 env OMP_NUM_THREADS=4 .venv/bin/python analysis/s099_polygon_signals.py --smoke
  nice -n 15 env OMP_NUM_THREADS=4 .venv/bin/python analysis/s099_polygon_signals.py
  nice -n 15 env OMP_NUM_THREADS=4 .venv/bin/python analysis/s099_polygon_signals.py --boards
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(HERE))

import polygon_gate  # noqa: E402
from build_plan import connect  # noqa: E402
from lab import nw_t  # noqa: E402
from s045_put_retest import rank  # noqa: E402

SMOKE = ("CAVA", "SHOP", "TMO", "MU", "CRWV")
HAND = "MU"
HOLDOUT = date(2023, 1, 1)
SI_LAG = 12
SV_LAG = 1
INS_WIN = 90
EK_WIN = 21
SI_CHG_MAX_GAP = 45
MIN_NAMES = 30
MIN_HALF = 8
API = "https://api.polygon.io"
OUT = ROOT / "out" / "studies" / "S099.md"
CALLS = [0]
LOGGED = [0]
MAX_PAGES = 40
CALL_CAP = 800

EARN_PRIMARY = {"financial_results"}
EARN_SECONDARY = {"earnings_announcement", "earnings_and_performance", "guidance_and_outlook"}
EARN_TERTIARY = {"quarterly_results", "quarterly_earnings", "annual_earnings"}

SIGNALS = ("dtc", "si_chg", "sv20", "ins_net", "ek21")


def _key() -> str:
    if os.environ.get("POLYGON_API_KEY"):
        return os.environ["POLYGON_API_KEY"]
    for line in open(ROOT.parent.parent / ".env.local"):
        if line.startswith("POLYGON_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit("POLYGON_API_KEY missing")


KEY = None


def get(path: str) -> dict:
    global KEY
    if KEY is None:
        KEY = _key()
    url = path if path.startswith("http") else f"{API}{path}"
    if "apiKey=" not in url and "apikey=" not in url:
        url += ("&" if "?" in url else "?") + "apiKey=" + KEY
    for attempt in range(5):
        polygon_gate.wait()
        CALLS[0] += 1
        try:
            with urllib.request.urlopen(url, timeout=90) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            err = e.read().decode()[:240]
            if e.code == 429:
                time.sleep(65)
                continue
            return {"status": "ERROR", "http": e.code, "error": err}
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError):
            time.sleep(15 * (attempt + 1))
    return {"status": "ERROR", "error": "retries exhausted"}


def next_path(nxt: str | None) -> str | None:
    if not nxt:
        return None
    p = urllib.parse.urlparse(nxt)
    q = [(k, v) for k, v in urllib.parse.parse_qsl(p.query, keep_blank_values=True) if k.lower() != "apikey"]
    return p.path + ("?" + urllib.parse.urlencode(q) if q else "")


def dparse(s) -> date | None:
    if not s:
        return None
    return date.fromisoformat(str(s)[:10])


def tickers_of(row: dict) -> set[str]:
    out = set()
    if row.get("ticker"):
        out.add(str(row["ticker"]).upper())
    sym = row.get("issuer_trading_symbol")
    if sym:
        out.add(str(sym).upper())
    for t in row.get("tickers") or []:
        out.add(str(t).upper())
    return out


def pages(path: str, want: set[str] | None) -> tuple[list, int, str]:
    url, seen, out, n_pages = path, set(), [], 0
    while url and n_pages < MAX_PAGES:
        if url in seen:
            break
        seen.add(url)
        body = get(url)
        n_pages += 1
        if body.get("http") == 403:
            return out, n_pages, "403 " + str(body.get("error") or "")
        if body.get("status") == "ERROR" or body.get("http"):
            return out, n_pages, str(body.get("error") or body.get("http"))
        res = body.get("results") or []
        if want is not None and res:
            matched = [r for r in res if tickers_of(r) & want]
            if len(matched) < 0.8 * len(res):
                return out, n_pages, f"filter leak {len(matched)}/{len(res)}"
            res = matched
        out.extend(res)
        url = next_path(body.get("next_url"))
    return out, n_pages, ("capped" if url else "ok")


def ensure(conn) -> None:
    conn.execute("""
    CREATE TABLE IF NOT EXISTS watchlist_sync.s099_fetch (
      endpoint text NOT NULL, chunk_id text NOT NULL, n_rows int, status text,
      fetched_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (endpoint, chunk_id))""")
    conn.execute("""
    CREATE TABLE IF NOT EXISTS watchlist_sync.s099_short_interest (
      ticker text NOT NULL, settlement_date date NOT NULL, short_interest bigint NOT NULL,
      avg_daily_volume bigint, days_to_cover double precision, PRIMARY KEY (ticker, settlement_date))""")
    conn.execute("""
    CREATE TABLE IF NOT EXISTS watchlist_sync.s099_short_volume (
      ticker text NOT NULL, date date NOT NULL, short_volume bigint, total_volume bigint,
      short_volume_ratio double precision, PRIMARY KEY (ticker, date))""")
    conn.execute("""
    CREATE TABLE IF NOT EXISTS watchlist_sync.s099_form4 (
      row_key text PRIMARY KEY, ticker text NOT NULL, accession text, filing_date date,
      transaction_date date, code text, acquired text, shares double precision,
      price double precision, value double precision, security_type text, record_type text,
      owner_cik text)""")
    conn.execute("""
    CREATE TABLE IF NOT EXISTS watchlist_sync.s099_8k (
      row_key text PRIMARY KEY, ticker text NOT NULL, accession text, filing_date date,
      primary_category text, secondary_category text, tertiary_category text)""")
    conn.execute("""
    CREATE TABLE IF NOT EXISTS watchlist_sync.s099_float (
      ticker text PRIMARY KEY, effective_date date, free_float double precision,
      free_float_percent double precision)""")
    conn.execute("""
    CREATE TABLE IF NOT EXISTS watchlist_sync.s099_related (
      ticker text NOT NULL, related text NOT NULL, ord int, PRIMARY KEY (ticker, related))""")
    conn.commit()


def done_set(conn, endpoint: str) -> set[str]:
    return {r[0] for r in conn.execute(
        "SELECT chunk_id FROM watchlist_sync.s099_fetch WHERE endpoint = %s AND status = 'ok'", (endpoint,))}


def mark(conn, endpoint: str, tickers: list[str], n_by: dict[str, int], status: str) -> None:
    for t in tickers:
        conn.execute("""INSERT INTO watchlist_sync.s099_fetch (endpoint, chunk_id, n_rows, status)
                        VALUES (%s, %s, %s, %s)
                        ON CONFLICT (endpoint, chunk_id) DO UPDATE SET n_rows = EXCLUDED.n_rows,
                        status = EXCLUDED.status, fetched_at = now()""",
                     (endpoint, t, n_by.get(t, 0), status))
    conn.commit()


def flush_usage(conn) -> None:
    n = CALLS[0] - LOGGED[0]
    if n <= 0:
        return
    polygon_gate.record(conn, n)
    LOGGED[0] = CALLS[0]


def chunks(xs: list[str], n: int):
    for i in range(0, len(xs), n):
        yield xs[i:i + n]


def over_cap() -> bool:
    return CALLS[0] >= CALL_CAP


def copy_short_interest(conn, tickers: set[str]) -> None:
    have = done_set(conn, "si")
    rows = conn.execute("""SELECT ticker, settlement_date, short_interest, avg_daily_volume, days_to_cover
                           FROM short_interest_history WHERE source IS DISTINCT FROM 'polygon-empty'""").fetchall()
    by = defaultdict(list)
    for t, d, si, adv, dtc in rows:
        if t in tickers and t not in have:
            by[t].append((t, d, si, adv, dtc))
    if not by:
        return
    conn.cursor().executemany("""INSERT INTO watchlist_sync.s099_short_interest
        (ticker, settlement_date, short_interest, avg_daily_volume, days_to_cover)
        VALUES (%s,%s,%s,%s,%s) ON CONFLICT (ticker, settlement_date) DO NOTHING""",
        [r for rs in by.values() for r in rs])
    mark(conn, "si", list(by), {t: len(rs) for t, rs in by.items()}, "ok")
    print(f"copied short interest {len(by)} names from short_interest_history", flush=True)


def _insert(conn, sql: str, rows: list) -> None:
    if not rows:
        return
    for i in range(0, len(rows), 2000):
        conn.cursor().executemany(sql, rows[i:i + 2000])


def fetch_si(conn, tickers: list[str]) -> None:
    need = [t for t in tickers if t not in done_set(conn, "si")]
    for ch in chunks(need, 25):
        if over_cap():
            print("call cap — short interest unfinished", flush=True)
            return
        want = set(ch)
        path = "/stocks/v1/short-interest?ticker.any_of=" + ",".join(ch) + "&limit=5000&sort=settlement_date.asc"
        raw, n_pages, flag = pages(path, want)
        print(f"si {ch[0]}.. n {len(raw)} pages {n_pages} {flag} calls {CALLS[0]}", flush=True)
        if flag != "ok":
            print("si stop", flag, flush=True)
            return
        rows, n_by = [], defaultdict(int)
        for r in raw:
            t = (r.get("ticker") or "").upper()
            d = dparse(r.get("settlement_date"))
            if t not in want or not d or r.get("short_interest") is None:
                continue
            adv = r.get("avg_daily_volume")
            dtc = r.get("days_to_cover")
            rows.append((t, d, int(round(r["short_interest"])),
                         None if adv is None else int(round(adv)),
                         None if dtc is None else float(dtc)))
            n_by[t] += 1
        _insert(conn, """INSERT INTO watchlist_sync.s099_short_interest
            (ticker, settlement_date, short_interest, avg_daily_volume, days_to_cover)
            VALUES (%s,%s,%s,%s,%s) ON CONFLICT (ticker, settlement_date) DO UPDATE SET
            short_interest = EXCLUDED.short_interest, avg_daily_volume = EXCLUDED.avg_daily_volume,
            days_to_cover = EXCLUDED.days_to_cover""", rows)
        mark(conn, "si", ch, n_by, "ok")
        flush_usage(conn)


def fetch_sv(conn, tickers: list[str]) -> None:
    need = [t for t in tickers if t not in done_set(conn, "sv")]
    for ch in chunks(need, 8):
        if over_cap():
            print("call cap — short volume unfinished", flush=True)
            return
        want = set(ch)
        path = ("/stocks/v1/short-volume?ticker.any_of=" + ",".join(ch)
                + "&date.gte=2024-01-01&limit=5000&sort=date.asc")
        raw, n_pages, flag = pages(path, want)
        print(f"sv {ch[0]}.. n {len(raw)} pages {n_pages} {flag} calls {CALLS[0]}", flush=True)
        if flag != "ok":
            print("sv stop", flag, flush=True)
            return
        rows, n_by = [], defaultdict(int)
        for r in raw:
            t = (r.get("ticker") or "").upper()
            d = dparse(r.get("date"))
            if t not in want or not d:
                continue
            ratio = r.get("short_volume_ratio")
            sv, tv = r.get("short_volume"), r.get("total_volume")
            if ratio is None and tv:
                ratio = 100.0 * float(sv or 0) / float(tv)
            rows.append((t, d, None if sv is None else int(round(sv)),
                         None if tv is None else int(round(tv)),
                         None if ratio is None else float(ratio)))
            n_by[t] += 1
        _insert(conn, """INSERT INTO watchlist_sync.s099_short_volume
            (ticker, date, short_volume, total_volume, short_volume_ratio) VALUES (%s,%s,%s,%s,%s)
            ON CONFLICT (ticker, date) DO UPDATE SET short_volume = EXCLUDED.short_volume,
            total_volume = EXCLUDED.total_volume, short_volume_ratio = EXCLUDED.short_volume_ratio""", rows)
        mark(conn, "sv", ch, n_by, "ok")
        flush_usage(conn)


def _key_of(*parts) -> str:
    return hashlib.md5("|".join("" if p is None else str(p) for p in parts).encode()).hexdigest()


def fetch_form4(conn, tickers: list[str]) -> None:
    need = [t for t in tickers if t not in done_set(conn, "f4")]
    for ch in chunks(need, 8):
        if over_cap():
            print("call cap — form 4 unfinished", flush=True)
            return
        want = set(ch)
        path = ("/stocks/filings/vX/form-4?tickers.any_of=" + ",".join(ch)
                + "&filing_date.gte=2022-01-01&limit=10000&sort=filing_date.asc")
        raw, n_pages, flag = pages(path, want)
        print(f"f4 {ch[0]}.. n {len(raw)} pages {n_pages} {flag} calls {CALLS[0]}", flush=True)
        if flag != "ok":
            print("f4 stop", flag, flush=True)
            return
        rows, n_by = [], defaultdict(int)
        for r in raw:
            owners = tickers_of(r) & want
            fd, td = dparse(r.get("filing_date")), dparse(r.get("transaction_date"))
            for t in owners:
                rk = _key_of(t, r.get("accession_number"), r.get("owner_cik"), td, r.get("transaction_code"),
                             r.get("security_type"), r.get("record_type"), r.get("transaction_shares"),
                             r.get("transaction_price_per_share"), r.get("transaction_value"),
                             r.get("security_title"))
                rows.append((rk, t, r.get("accession_number"), fd, td, r.get("transaction_code"),
                             r.get("transaction_acquired_disposed"), r.get("transaction_shares"),
                             r.get("transaction_price_per_share"), r.get("transaction_value"),
                             r.get("security_type"), r.get("record_type"), r.get("owner_cik")))
                n_by[t] += 1
        _insert(conn, """INSERT INTO watchlist_sync.s099_form4
            (row_key, ticker, accession, filing_date, transaction_date, code, acquired, shares, price, value,
             security_type, record_type, owner_cik) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (row_key) DO NOTHING""", rows)
        mark(conn, "f4", ch, n_by, "ok")
        flush_usage(conn)


def fetch_8k(conn, tickers: list[str]) -> None:
    need = [t for t in tickers if t not in done_set(conn, "ek")]
    for ch in chunks(need, 10):
        if over_cap():
            print("call cap — 8-K unfinished", flush=True)
            return
        want = set(ch)
        path = ("/stocks/filings/8-K/vX/disclosures?tickers.any_of=" + ",".join(ch)
                + "&filing_date.gte=2022-01-01&limit=1000&sort=filing_date.asc")
        raw, n_pages, flag = pages(path, want)
        print(f"8k {ch[0]}.. n {len(raw)} pages {n_pages} {flag} calls {CALLS[0]}", flush=True)
        if flag != "ok":
            print("8k stop", flag, flush=True)
            return
        rows, n_by = [], defaultdict(int)
        for r in raw:
            fd = dparse(r.get("filing_date"))
            for t in tickers_of(r) & want:
                rk = _key_of(t, r.get("accession_number"), r.get("primary_category"),
                             r.get("secondary_category"), r.get("tertiary_category"))
                rows.append((rk, t, r.get("accession_number"), fd, r.get("primary_category"),
                             r.get("secondary_category"), r.get("tertiary_category")))
                n_by[t] += 1
        _insert(conn, """INSERT INTO watchlist_sync.s099_8k
            (row_key, ticker, accession, filing_date, primary_category, secondary_category, tertiary_category)
            VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (row_key) DO NOTHING""", rows)
        mark(conn, "ek", ch, n_by, "ok")
        flush_usage(conn)


def fetch_float(conn, tickers: list[str]) -> None:
    need = [t for t in tickers if t not in done_set(conn, "float")]
    for ch in chunks(need, 80):
        if over_cap():
            print("call cap — float unfinished", flush=True)
            return
        want = set(ch)
        raw, n_pages, flag = pages("/stocks/vX/float?ticker.any_of=" + ",".join(ch) + "&limit=1000", want)
        print(f"float {ch[0]}.. n {len(raw)} pages {n_pages} {flag}", flush=True)
        if flag != "ok":
            print("float stop", flag, flush=True)
            return
        rows, n_by = [], defaultdict(int)
        for r in raw:
            t = (r.get("ticker") or "").upper()
            if t not in want:
                continue
            rows.append((t, dparse(r.get("effective_date")), r.get("free_float"), r.get("free_float_percent")))
            n_by[t] += 1
        _insert(conn, """INSERT INTO watchlist_sync.s099_float
            (ticker, effective_date, free_float, free_float_percent) VALUES (%s,%s,%s,%s)
            ON CONFLICT (ticker) DO UPDATE SET effective_date = EXCLUDED.effective_date,
            free_float = EXCLUDED.free_float, free_float_percent = EXCLUDED.free_float_percent""", rows)
        mark(conn, "float", ch, n_by, "ok")
        flush_usage(conn)


def fetch_related(conn, tickers: list[str]) -> None:
    need = [t for t in tickers if t not in done_set(conn, "rel")]
    for i, t in enumerate(need):
        if over_cap():
            print("call cap — related unfinished", flush=True)
            return
        body = get(f"/v1/related-companies/{t}")
        flag = "ok"
        if body.get("http") == 403 or body.get("status") == "ERROR":
            print("related stop", t, body.get("error"), flush=True)
            return
        res = body.get("results") or []
        rows = []
        for j, r in enumerate(res):
            rel = (r.get("ticker") or "").upper()
            if rel:
                rows.append((t, rel, j))
        conn.execute("DELETE FROM watchlist_sync.s099_related WHERE ticker = %s", (t,))
        _insert(conn, "INSERT INTO watchlist_sync.s099_related (ticker, related, ord) VALUES (%s,%s,%s) ON CONFLICT DO NOTHING", rows)
        mark(conn, "rel", [t], {t: len(rows)}, flag)
        if i % 20 == 0:
            print(f"related {i}/{len(need)} {t} n {len(rows)} calls {CALLS[0]}", flush=True)
            flush_usage(conn)
    flush_usage(conn)


def universe(conn, smoke: bool) -> list[str]:
    if smoke:
        return list(SMOKE)
    lab = [r[0] for r in conn.execute("SELECT DISTINCT ticker FROM watchlist_sync.lab_outcomes ORDER BY 1")]
    return sorted(set(lab) | set(SMOKE))


def fetch_all(conn, tickers: list[str], smoke: bool) -> None:
    if not smoke:
        copy_short_interest(conn, set(tickers))
    fetch_si(conn, tickers)
    fetch_sv(conn, tickers)
    fetch_form4(conn, tickers)
    fetch_8k(conn, tickers)
    fetch_float(conn, tickers)
    fetch_related(conn, tickers)
    flush_usage(conn)


def hand_lines(conn) -> list[str]:
    lines = []
    row = conn.execute("""SELECT settlement_date, short_interest, avg_daily_volume, days_to_cover
                          FROM watchlist_sync.s099_short_interest WHERE ticker = %s
                          ORDER BY settlement_date DESC LIMIT 1""", (HAND,)).fetchone()
    if not row:
        lines.append(f"HAND {HAND}: no short-interest row")
    else:
        d, si, adv, dtc = row
        recomputed = (si / adv) if adv else None
        gap = None if recomputed is None or dtc is None else recomputed - float(dtc)
        lines.append(f"HAND {HAND} {d}: short_interest {si} avg_daily_volume {adv} days_to_cover {dtc} "
                     f"recomputed si/adv {None if recomputed is None else round(recomputed, 4)} "
                     f"gap {None if gap is None else round(gap, 4)}")
        lseg = conn.execute("""SELECT as_of, short_interest, short_pct, free_float, shares_out
                               FROM lseg_research.signals_daily WHERE ticker = %s ORDER BY as_of DESC LIMIT 1""",
                            (HAND,)).fetchone()
        if lseg:
            lines.append(f"HAND {HAND} LSEG {lseg[0]}: short_interest {lseg[1]} short_pct {lseg[2]} "
                         f"free_float {lseg[3]} shares_out {lseg[4]} "
                         f"polygon−lseg shares {None if lseg[1] is None else int(si) - int(round(lseg[1]))}")
    pub = conn.execute("""SELECT settlement_date, short_interest, avg_daily_volume, days_to_cover
                          FROM short_interest_history WHERE ticker = 'SHOP' AND settlement_date = '2026-09-30'""").fetchone()
    live = conn.execute("""SELECT settlement_date, short_interest, avg_daily_volume, days_to_cover
                           FROM watchlist_sync.s099_short_interest
                           WHERE ticker = 'SHOP' AND settlement_date = '2026-09-30'""").fetchone()
    lines.append(f"HAND SHOP 2026-09-30 public table {pub} study table {live}")
    f4 = conn.execute("""SELECT filing_date, transaction_date, code, shares, price, value, security_type, record_type
                         FROM watchlist_sync.s099_form4
                         WHERE ticker = %s AND code IN ('P','S') AND shares IS NOT NULL AND price IS NOT NULL
                           AND replace(security_type, '-', '_') = 'non_derivative' AND record_type = 'transaction'
                         ORDER BY filing_date LIMIT 1""", (HAND,)).fetchone()
    if not f4:
        lines.append(f"HAND {HAND} form4: no open-market non-derivative row")
    else:
        gap = None if f4[5] is None else float(f4[5]) - float(f4[3]) * float(f4[4])
        lines.append(f"HAND {HAND} form4 filed {f4[0]} traded {f4[1]} code {f4[2]} shares {f4[3]} "
                     f"price {f4[4]} value {f4[5]} shares*price gap {None if gap is None else round(gap, 4)} "
                     f"{f4[6]} {f4[7]}")
    ek = conn.execute("""SELECT filing_date, accession, primary_category, secondary_category, tertiary_category
                         FROM watchlist_sync.s099_8k WHERE ticker = %s ORDER BY filing_date LIMIT 1""", (HAND,)).fetchone()
    lines.append(f"HAND {HAND} 8k {ek}")
    sv = conn.execute("""SELECT date, short_volume, total_volume, short_volume_ratio
                         FROM watchlist_sync.s099_short_volume WHERE ticker = %s ORDER BY date LIMIT 1""",
                      (HAND,)).fetchone()
    if sv and sv[2]:
        pct = 100.0 * float(sv[1] or 0) / float(sv[2])
        lines.append(f"HAND {HAND} short volume {sv[0]}: short {sv[1]} total {sv[2]} "
                     f"vendor ratio {sv[3]} 100*short/total {pct:.2f}")
    else:
        lines.append(f"HAND {HAND} short volume {sv}")
    fl = conn.execute("SELECT effective_date, free_float, free_float_percent FROM watchlist_sync.s099_float WHERE ticker = %s",
                      (HAND,)).fetchone()
    lines.append(f"HAND {HAND} float {fl}")
    return lines


def coverage_lines(conn) -> list[str]:
    def one(sql):
        return conn.execute(sql).fetchone()
    si = one("SELECT count(distinct ticker), count(*), min(settlement_date), max(settlement_date) FROM watchlist_sync.s099_short_interest")
    sv = one("SELECT count(distinct ticker), count(*), min(date), max(date) FROM watchlist_sync.s099_short_volume")
    f4 = one("SELECT count(distinct ticker), count(*), min(filing_date), max(filing_date) FROM watchlist_sync.s099_form4")
    ek = one("SELECT count(distinct ticker), count(*), min(filing_date), max(filing_date) FROM watchlist_sync.s099_8k")
    fl = one("SELECT count(*), min(effective_date), max(effective_date) FROM watchlist_sync.s099_float")
    rel = one("SELECT count(distinct ticker), count(*) FROM watchlist_sync.s099_related")
    cats = conn.execute("""SELECT coalesce(primary_category,'(none)'), count(*) FROM watchlist_sync.s099_8k
                           GROUP BY 1 ORDER BY 2 DESC LIMIT 8""").fetchall()
    codes = conn.execute("""SELECT coalesce(code,'(none)'), coalesce(security_type,'(none)'), count(*)
                            FROM watchlist_sync.s099_form4 GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 8""").fetchall()
    return [
        f"Short interest: {si[0]} names, {si[1]} prints, {si[2]} → {si[3]}.",
        f"Short volume: {sv[0]} names, {sv[1]} days, {sv[2]} → {sv[3]}.",
        f"Form 4: {f4[0]} names, {f4[1]} rows, {f4[2]} → {f4[3]}. Top code/type {codes}.",
        f"8-K: {ek[0]} names, {ek[1]} rows, {ek[2]} → {ek[3]}. Top primary {cats}.",
        f"Float snapshot: {fl[0]} names, effective {fl[1]} → {fl[2]}. Related: {rel[0]} names, {rel[1]} edges.",
    ]


class Feat:
    def __init__(self, conn):
        self.si_names = done_set(conn, "si")
        self.sv_names = done_set(conn, "sv")
        self.f4_names = done_set(conn, "f4")
        self.ek_names = done_set(conn, "ek")
        self.si = defaultdict(list)
        for t, d, si, dtc in conn.execute("""SELECT ticker, settlement_date, short_interest, days_to_cover
                                             FROM watchlist_sync.s099_short_interest ORDER BY ticker, settlement_date"""):
            self.si[t].append((d, float(si), None if dtc is None else float(dtc)))
        self.sv = defaultdict(list)
        for t, d, ratio in conn.execute("""SELECT ticker, date, short_volume_ratio FROM watchlist_sync.s099_short_volume
                                           WHERE short_volume_ratio IS NOT NULL ORDER BY ticker, date"""):
            self.sv[t].append((d, float(ratio)))
        ins = defaultdict(lambda: defaultdict(float))
        for t, fd, code, shares, st, rt in conn.execute("""SELECT ticker, filing_date, code, shares, security_type, record_type
                                                          FROM watchlist_sync.s099_form4 WHERE filing_date IS NOT NULL"""):
            kind = (st or "").lower().replace("-", "_")
            if kind != "non_derivative" or (rt or "").lower() != "transaction":
                continue
            if code == "P":
                sign = 1.0
            elif code == "S":
                sign = -1.0
            else:
                continue
            if shares is None or fd is None:
                continue
            ins[t][fd] += sign * abs(float(shares))
        self.ins = {}
        for t, days in ins.items():
            ds = sorted(days)
            pref = [0.0]
            for d in ds:
                pref.append(pref[-1] + days[d])
            self.ins[t] = (ds, pref)
        ek = defaultdict(set)
        for t, fd, acc, p, s, ter in conn.execute("""SELECT ticker, filing_date, accession, primary_category,
                                                    secondary_category, tertiary_category FROM watchlist_sync.s099_8k
                                                    WHERE filing_date IS NOT NULL AND accession IS NOT NULL"""):
            if (p or "") in EARN_PRIMARY or (s or "") in EARN_SECONDARY or (ter or "") in EARN_TERTIARY:
                continue
            ek[t].add((fd, acc))
        self.ek = {}
        for t, pairs in ek.items():
            by = defaultdict(set)
            for fd, acc in pairs:
                by[fd].add(acc)
            ds = sorted(by)
            pref = [0.0]
            for d in ds:
                pref.append(pref[-1] + len(by[d]))
            self.ek[t] = (ds, pref)

    def _window(self, packed, as_of: date, win: int) -> float:
        ds, pref = packed
        import bisect
        hi = bisect.bisect_right(ds, as_of)
        lo = bisect.bisect_right(ds, as_of - timedelta(days=win))
        return pref[hi] - pref[lo]

    def at(self, t: str, as_of: date) -> dict:
        import bisect
        out = {k: None for k in SIGNALS}
        if t in self.si_names:
            series = self.si.get(t) or []
            dates = [x[0] for x in series]
            i = bisect.bisect_right(dates, as_of - timedelta(days=SI_LAG)) - 1
            if i >= 0 and series[i][2] is not None:
                out["dtc"] = series[i][2]
            if i >= 1 and series[i][1]:
                gap = (series[i][0] - series[i - 1][0]).days
                if 0 < gap <= SI_CHG_MAX_GAP and series[i - 1][1]:
                    out["si_chg"] = series[i][1] / series[i - 1][1] - 1.0
            elif i >= 0:
                out["si_chg"] = None
        if t in self.sv_names:
            series = self.sv.get(t) or []
            dates = [x[0] for x in series]
            i = bisect.bisect_right(dates, as_of - timedelta(days=SV_LAG))
            tail = series[max(0, i - 20):i]
            if len(tail) >= 10 and (tail[-1][0] - tail[0][0]).days <= 40:
                out["sv20"] = float(np.mean([x[1] for x in tail]))
        if t in self.f4_names:
            out["ins_net"] = self._window(self.ins[t], as_of, INS_WIN) if t in self.ins else 0.0
        if t in self.ek_names:
            out["ek21"] = self._window(self.ek[t], as_of, EK_WIN) if t in self.ek else 0.0
        return out


def asof_val(series: list[tuple[date, float]], d: date):
    import bisect
    i = bisect.bisect_right([x[0] for x in series], d) - 1
    return None if i < 0 else series[i][1]


def holdout_mid(conn) -> date:
    rows = [r[0] for r in conn.execute("""SELECT DISTINCT as_of FROM watchlist_sync.lab_outcomes
        WHERE EXTRACT(DOW FROM as_of) = 1 AND as_of >= %s AND outcomes->>'rel_21' IS NOT NULL
        ORDER BY 1""", (HOLDOUT,))]
    if not rows:
        raise SystemExit("no holdout Mondays")
    return rows[len(rows) // 2]


def pack(pairs: list[tuple[date, float]], mid: date, lag: int) -> dict:
    if len(pairs) < 8:
        return {"thin": True, "n": len(pairs), "na": 0, "nb": 0}
    vals = np.array([v for _, v in pairs], float)
    a = np.array([v for d, v in pairs if d < mid], float)
    b = np.array([v for d, v in pairs if d >= mid], float)
    return {"thin": False, "mean": float(vals.mean()), "t": float(nw_t(vals, lag)),
            "a": float(a.mean()) if len(a) else None, "b": float(b.mean()) if len(b) else None,
            "n": len(vals), "na": int(len(a)), "nb": int(len(b))}


def clears(p: dict | None) -> bool:
    if not p or p.get("thin"):
        return False
    if p["na"] < MIN_HALF or p["nb"] < MIN_HALF:
        return False
    if not (p["mean"] > 0 and p["a"] and p["a"] > 0 and p["b"] and p["b"] > 0):
        return False
    t = p["t"]
    return t == t and t >= 2


def board_rows(groups: dict, ykey: str, skey: str, comps: list[str], mid: date, lag: int) -> dict:
    ic, spread, coef, wq = [], [], [], []
    comp_ic = {c: [] for c in comps}
    for w in sorted(groups):
        g = groups[w]
        if len(g) < MIN_NAMES:
            continue
        sig = np.array([r[skey] for r in g], float)
        y = np.array([r[ykey] for r in g], float)
        if np.std(sig) == 0 or np.std(y) == 0:
            continue
        rs, ry = rank(sig), rank(y)
        ic.append((w, float(np.corrcoef(rs, ry)[0, 1])))
        k = max(1, len(g) // (5 if ykey in ("pnl", "breach") else 10))
        order = np.argsort(-sig, kind="mergesort")
        spread.append((w, float(y[order[:k]].mean() - y[order[-k:]].mean())))
        cr = [rank(np.array([r[c] for r in g], float)) for c in comps]
        for c, rc in zip(comps, cr):
            if np.std(rc):
                comp_ic[c].append((w, float(np.corrcoef(rc, ry)[0, 1])))
        X = np.column_stack([np.ones(len(g)), rs, *cr])
        beta = np.linalg.lstsq(X, ry, rcond=None)[0]
        coef.append((w, float(beta[1])))
        comp = np.mean(cr, axis=0) if cr else rs
        q = np.clip((comp * 0.999 * 5).astype(int), 0, 4)
        bits = []
        for qi in range(5):
            m = q == qi
            if m.sum() < 8 or np.std(sig[m]) == 0:
                continue
            med = np.median(sig[m])
            hi, lo = y[m & (sig >= med)], y[m & (sig < med)]
            if len(hi) and len(lo):
                bits.append(float(hi.mean() - lo.mean()))
        if len(bits) >= 3:
            wq.append((w, float(np.mean(bits))))
    return {"ic": pack(ic, mid, lag), "spread": pack(spread, mid, lag), "fm": pack(coef, mid, lag),
            "within": pack(wq, mid, lag),
            "comp": {c: pack(v, mid, lag) for c, v in comp_ic.items()},
            "n_rows": sum(len(g) for g in groups.values())}


def label_of(primary: dict, fm: dict, wq: dict, spread: dict | None = None) -> str:
    marg = clears(fm) or clears(wq)
    if spread is not None and clears(primary) and spread.get("mean") is not None and spread["mean"] <= 0:
        return "IC only, spread flips — not a pass"
    if clears(primary) and marg:
        return "PASS"
    if clears(primary):
        return "standalone only — not a pass"
    return "not a pass"


def load_stock(conn, feat: Feat, mid: date):
    digest = conn.execute("""SELECT engine_digest FROM watchlist_sync.lab_tech
        WHERE engine_digest LIKE '%%-ivhist' GROUP BY 1 ORDER BY max(as_of) DESC, max(computed_at) DESC LIMIT 1""").fetchone()[0]
    outcomes = conn.execute("""SELECT ticker, as_of, (outcomes->>'rel_21')::float8 FROM watchlist_sync.lab_outcomes
        WHERE EXTRACT(DOW FROM as_of) = 1 AND as_of >= %s AND outcomes->>'rel_21' IS NOT NULL""", (HOLDOUT,)).fetchall()
    tech = {(t, d): float(v) for t, d, v in conn.execute(
        """SELECT ticker, as_of, (v2->>'total')::float8 FROM watchlist_sync.lab_tech
           WHERE engine_digest = %s AND v2->>'total' IS NOT NULL""", (digest,)) if v is not None}
    alpha = defaultdict(list)
    for t, d, v in conn.execute("""SELECT ticker, obs_date, value::float8 FROM lseg_research.starmine_history
                                   WHERE metric = 'combined_alpha_rank' AND value IS NOT NULL ORDER BY ticker, obs_date"""):
        alpha[t].append((d, float(v)))
    per = {s: defaultdict(list) for s in SIGNALS}
    for t, d, rel in outcomes:
        sig = feat.at(t, d)
        al = asof_val(alpha.get(t, []), d)
        te = tech.get((t, d))
        if al is None or te is None or rel is None:
            continue
        base = {"d": d, "t": t, "rel": float(rel), "alpha": al, "tech": te}
        for s in SIGNALS:
            if sig[s] is None:
                continue
            per[s][d].append({**base, s: sig[s]})
    out = {}
    for s in SIGNALS:
        out[s] = board_rows(per[s], "rel", s, ["alpha", "tech"], mid, 3)
        out[s]["label"] = label_of(out[s]["ic"], out[s]["fm"], out[s]["within"], out[s]["spread"])
        nz = [r[s] for g in per[s].values() for r in g]
        out[s]["nonzero"] = float(np.mean([v != 0 for v in nz])) if nz else None
        out[s]["names"] = len({r["t"] for g in per[s].values() for r in g})
    return digest, out, per


def placebo_dtc(per_dtc, mid: date) -> str:
    rng = np.random.default_rng(99)
    weeks = sorted(per_dtc)
    real = []
    base = []
    for w in weeks:
        g = per_dtc[w]
        if len(g) < MIN_NAMES:
            continue
        sig = np.array([r["dtc"] for r in g], float)
        y = np.array([r["rel"] for r in g], float)
        if np.std(sig) == 0 or np.std(y) == 0:
            continue
        real.append((w, float(np.corrcoef(rank(sig), rank(y))[0, 1])))
        base.append((sig, y))
    real_t = pack(real, mid, 3).get("t")
    hits = 0
    n = 50
    for _ in range(n):
        pairs = []
        for (sig, y), (w, _) in zip(base, real):
            sh = rng.permutation(sig)
            if np.std(sh) == 0:
                continue
            pairs.append((w, float(np.corrcoef(rank(sh), rank(y))[0, 1])))
        t = pack(pairs, mid, 3).get("t")
        if t == t and real_t == real_t and abs(t) >= abs(real_t):
            hits += 1
    return f"dtc placebo 50 within-week shuffles seed 99: {hits} with |IC t| >= real ({real_t})"


def load_puts(conn, feat: Feat, mid: date, digest: str):
    import s059_option_factors as S059
    ev = S059.aligned_events(conn)
    pinned = {}
    for t, d, v2 in conn.execute("""SELECT ticker, as_of, v2 FROM watchlist_sync.lab_tech WHERE engine_digest = %s""", (digest,)):
        comps = (v2 or {}).get("comps") or {}
        tr, vc = comps.get("trendContext"), comps.get("volumeConfirm")
        if tr is not None and vc is not None:
            pinned[(t, d)] = float(tr) - float(vc)
    by = defaultdict(list)
    for e in ev:
        if e["d"] < HOLDOUT:
            continue
        e["put_tech"] = pinned.get((e["t"], e["d"]))
        if e.get("iv_rv") is None or e.get("vol_of_vol") is None or e.get("put_tech") is None:
            continue
        by[e["d"]].append(e)
    for g in by.values():
        if len(g) < MIN_NAMES:
            continue
        sc = (rank([e["iv_rv"] for e in g]) + rank([e["vol_of_vol"] for e in g])
              + rank([e["put_tech"] for e in g]))
        for e, s in zip(g, sc):
            e["put_edge"] = float(s)
    per = {s: defaultdict(list) for s in SIGNALS}
    for e in ev:
        if e["d"] < HOLDOUT or e.get("put_edge") is None:
            continue
        sig = feat.at(e["t"], e["d"])
        base = {"d": e["d"], "t": e["t"], "pnl": float(e["pnl"]), "breach": float(e["breach"]), "put_edge": e["put_edge"]}
        for s in SIGNALS:
            if sig[s] is None:
                continue
            per[s][e["d"]].append({**base, s: sig[s]})
    out = {}
    for s in SIGNALS:
        stats = board_rows(per[s], "pnl", s, ["put_edge"], mid, 1)
        br = board_rows(per[s], "breach", s, ["put_edge"], mid, 1)
        stats["breach_spread"] = br["spread"]
        stats["label"] = label_of(stats["spread"], stats["fm"], stats["within"])
        nz = [r[s] for g in per[s].values() for r in g]
        stats["nonzero"] = float(np.mean([v != 0 for v in nz])) if nz else None
        stats["names"] = len({r["t"] for g in per[s].values() for r in g})
        stats["n_puts"] = sum(len(g) for g in per[s].values())
        out[s] = stats
    return out


def verify_float(conn) -> str:
    rows = conn.execute("""SELECT f.free_float_percent, f.free_float, s.free_float, s.shares_out
                           FROM watchlist_sync.s099_float f
                           JOIN lseg_research.signals_daily s ON s.ticker = f.ticker
                           WHERE s.as_of = '2026-10-22' AND s.shares_out > 0 AND f.free_float_percent IS NOT NULL""").fetchall()
    if len(rows) < 10:
        return f"Float vs LSEG 2026-10-22: n {len(rows)}"
    both = [(float(a), 100.0 * float(c) / float(d), float(b) / float(c) if c else None)
            for a, b, c, d in rows if c]
    if len(both) < 10:
        return f"Float vs LSEG: n {len(both)}"
    a = np.array([x[0] for x in both])
    b = np.array([x[1] for x in both])
    ratio = np.array([x[2] for x in both if x[2]], float)
    corr = float(np.corrcoef(rank(a), rank(b))[0, 1])
    return (f"Float vs LSEG free_float/shares_out on 2026-10-22: n {len(both)}, Spearman {corr:+.3f}, "
            f"median polygon% {np.median(a):.1f} vs LSEG% {np.median(b):.1f}, "
            f"median polygon shares / LSEG shares {np.median(ratio):.3f}")


def verify_related(conn) -> list[str]:
    members = defaultdict(set)
    group = {}
    for t, g in conn.execute("SELECT ticker, group_id FROM peer_group_members WHERE removed_at IS NULL"):
        members[g].add(t)
        group[t] = g
    rel = defaultdict(list)
    for t, r, _o in conn.execute("SELECT ticker, related, ord FROM watchlist_sync.s099_related ORDER BY ticker, ord"):
        rel[t].append(r)
    jacs, prec, rec = [], [], []
    for t, names in rel.items():
        g = group.get(t)
        if not g:
            continue
        peers = members[g] - {t}
        R, P = set(names), peers
        if not R and not P:
            continue
        inter = R & P
        jacs.append(len(inter) / len(R | P) if (R or P) else 0.0)
        prec.append(len(inter) / len(R) if R else 0.0)
        rec.append(len(inter) / len(P) if P else 0.0)
    def avg(xs):
        return float(np.mean(xs)) if xs else float("nan")
    mu_g = group.get("MU")
    mu_peers = sorted(members.get(mu_g, set()) - {"MU"}) if mu_g else []
    mu_rel = rel.get("MU", [])
    return [
        f"Related vs peer_group_members: n {len(jacs)} names with both. "
        f"Mean Jaccard {avg(jacs):.3f}, precision {avg(prec):.3f}, recall {avg(rec):.3f}.",
        f"MU group {mu_g}. Polygon related {mu_rel}. Peer-group mates {mu_peers}. "
        f"Overlap {sorted(set(mu_rel) & set(mu_peers))}.",
    ]


def fmt(p: dict | None, scale: float, digits: int) -> str:
    if not p or p.get("thin"):
        n = 0 if not p else p.get("n")
        return f"thin (weeks {n})"
    def sc(v):
        return "na" if v is None else f"{v * scale:+.{digits}f}"
    t = p.get("t")
    ts = "na" if t != t else f"{t:+.2f}"
    return f"{sc(p['mean'])} t {ts} halves {sc(p.get('a'))} / {sc(p.get('b'))} weeks {p['n']} ({p['na']}/{p['nb']})"


def write_report(conn, mid, digest, stock, puts, extra: list[str]) -> None:
    lines = [
        "# S099 — Polygon free endpoints vs Fildi",
        "",
        f"Holdout Mondays from {HOLDOUT}, split {mid} (median Monday with rel_21; that week is in the second half). "
        f"lab_tech digest {digest}. Stock t is Newey-West lag 3. Put t is Newey-West lag 1 "
        f"(same-week hold). Pass = t >= 2, both halves positive, at least {MIN_HALF} weeks each, "
        f"and the Fama-MacBeth partial or the within-comparator split also clears that bar.",
        "",
        "13-F: not tested. `GET /stocks/filings/vX/13-F?cusip=595112103&limit=2` (MU's CUSIP in "
        "research_common.security_map) returned issuer DYCOM INDS INC, CUSIP 267475101, filed 2026-10-23. "
        "The cusip parameter is ignored. The docs expose filer_cik and filing_date only, so a name-level "
        "history is a full filer scan. One probe call, no scan.",
        "",
        "## Coverage",
        *coverage_lines(conn),
        "",
        "## Hand-check",
        *hand_lines(conn),
        "",
        "## Stock board (rel_21)",
        "IC is the rank correlation. Spread is the top decile minus the bottom decile, in percentage points per 21 days. "
        "FM is the within-week partial of the signal's rank given combined-alpha rank and lab_tech v2.",
    ]
    for s in SIGNALS:
        st = stock[s]
        lines.append(
            f"- **{s}** {st['label']}. names {st['names']}, nonzero {st['nonzero']}. "
            f"IC {fmt(st['ic'], 1, 3)}. Decile {fmt(st['spread'], 100, 2)} pp. "
            f"FM {fmt(st['fm'], 1, 3)}. Within-quintile {fmt(st['within'], 100, 2)} pp. "
            f"Same weeks alpha IC {fmt(st['comp'].get('alpha'), 1, 3)}; tech IC {fmt(st['comp'].get('tech'), 1, 3)}.")
    lines += ["", "## Put board (S059 pnl, net of the bid+23% fill, per $ of collateral)",
              "Spread is Q5 minus Q1 in bp per week. FM partial is given put_edge."]
    if puts is None:
        lines.append("Put board did not run.")
    elif isinstance(puts, str):
        lines.append(puts)
    else:
        for s in SIGNALS:
            st = puts[s]
            lines.append(
                f"- **{s}** {st['label']}. puts {st['n_puts']}, names {st['names']}, nonzero {st['nonzero']}. "
                f"Q5−Q1 {fmt(st['spread'], 1e4, 1)} bp. "
                f"FM {fmt(st['fm'], 1, 3)}. Within-quintile {fmt(st['within'], 1e4, 1)} bp. "
                f"Breach Q5−Q1 {fmt(st['breach_spread'], 100, 2)} pp. "
                f"Same weeks put_edge IC {fmt(st['comp'].get('put_edge'), 1, 3)}.")
    lines += ["", "## Verification", verify_float(conn), *verify_related(conn), "", "## Other", *extra]
    any_pass = any(stock[s]["label"] == "PASS" for s in SIGNALS) or (
        isinstance(puts, dict) and any(puts[s]["label"] == "PASS" for s in SIGNALS))
    lines += ["", f"Ship: {'a PASS is below' if any_pass else 'nothing'}. "
              "Polygon is commercial data, so a pass could be rebuilt live. "
              "Float has no history. Related tickers are a peer check, not a score. 13-F was not tested."]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines) + "\n")
    print(f"wrote {OUT}", flush=True)


def main() -> None:
    smoke = "--smoke" in sys.argv
    boards_only = "--boards" in sys.argv
    conn = connect()
    ensure(conn)
    tickers = universe(conn, smoke)
    print(f"{'smoke' if smoke else 'full'} tickers {len(tickers)}", flush=True)
    if not boards_only:
        fetch_all(conn, tickers, smoke)
    print("\n".join(hand_lines(conn)), flush=True)
    print("\n".join(coverage_lines(conn)), flush=True)
    if smoke:
        print(f"smoke calls {CALLS[0]}", flush=True)
        return
    board_eps = ("si", "sv", "f4", "ek", "float")
    missing = {ep: len(tickers) - len(done_set(conn, ep)) for ep in board_eps}
    if any(missing.values()):
        print("fetch incomplete", missing, "— not scoring a partial universe", flush=True)
        return
    rel_missing = len(tickers) - len(done_set(conn, "rel"))
    if rel_missing:
        print(f"related verification only: {rel_missing} names without related-companies snapshot", flush=True)
    mid = holdout_mid(conn)
    print("mid", mid, flush=True)
    feat = Feat(conn)
    digest, stock, per = load_stock(conn, feat, mid)
    extra = [placebo_dtc(per["dtc"], mid), f"Polygon calls this process {CALLS[0]} (probe calls were logged earlier)."]
    print("stock done", {s: stock[s]["label"] for s in SIGNALS}, flush=True)
    puts = None
    try:
        print("building puts", flush=True)
        puts = load_puts(conn, feat, mid, digest)
        print("puts done", {s: puts[s]["label"] for s in SIGNALS}, flush=True)
    except Exception as e:
        import traceback
        traceback.print_exc()
        puts = f"Put board failed: {e}"
    write_report(conn, mid, digest, stock, puts, extra)
    conn.close()


if __name__ == "__main__":
    main()
