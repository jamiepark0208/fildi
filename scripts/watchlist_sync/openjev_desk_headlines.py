"""A143 — overnight OpenJev headline labels for Desk daily news (display only, S037).

Pull Finnhub company news since prior close for held + Model List names; ask rel/dir/cat
(drop mat). Store in watchlist_sync.openjev_headline_labels. Desk reads via API.

    .venv/bin/python openjev_desk_headlines.py [--limit N]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "scripts"))
import vendor_gate  # noqa: E402  (A303 shared cross-process budget)

PT = ZoneInfo("America/Los_Angeles")
DDL = """
CREATE TABLE IF NOT EXISTS watchlist_sync.openjev_headline_labels (
  id bigserial PRIMARY KEY,
  ticker text NOT NULL,
  ts timestamptz NOT NULL,
  headline text NOT NULL,
  url text,
  rel double precision,
  dir double precision,
  cat text,
  labeled_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticker, ts, headline)
);
CREATE INDEX IF NOT EXISTS oj_hl_ticker_ts ON watchlist_sync.openjev_headline_labels (ticker, ts DESC);
"""


def connect():
    from build_plan import connect as c
    return c()


def held_and_model(conn) -> list[str]:
    sid = conn.execute("SELECT MAX(id) FROM portfolio_snapshots").fetchone()[0]
    q = """
        SELECT DISTINCT UPPER(ticker) AS t FROM (
          SELECT symbol AS ticker FROM portfolio_positions WHERE snapshot_id = %s
          UNION
          SELECT symbol FROM portfolio_options
            WHERE snapshot_id = %s AND expiration >= CURRENT_DATE
          UNION
          SELECT ticker FROM model_recs
            WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM model_recs)
        ) x WHERE ticker ~ '^[A-Z][A-Z0-9.-]{0,9}$'
    """
    try:
        rows = conn.execute(q, (sid, sid)).fetchall()
    except Exception:
        conn.rollback()
        rows = conn.execute(
            """SELECT DISTINCT UPPER(symbol) FROM portfolio_positions WHERE snapshot_id = %s
               UNION SELECT DISTINCT UPPER(symbol) FROM portfolio_options
               WHERE snapshot_id = %s AND expiration >= CURRENT_DATE""",
            (sid, sid),
        ).fetchall()
    return [r[0] for r in rows]


def finnhub_news(ticker: str, since: dt.date, until: dt.date) -> list[dict]:
    key = os.environ.get("FINNHUB_API_KEY") or os.environ.get("FINNHUB_TOKEN")
    if not key:
        return []
    url = (
        f"https://finnhub.io/api/v1/company-news?symbol={ticker}"
        f"&from={since.isoformat()}&to={until.isoformat()}&token={key}"
    )
    try:
        vendor_gate.wait("Finnhub")
        with urllib.request.urlopen(url, timeout=20) as r:
            body = json.loads(r.read().decode())
    except Exception:
        return []
    out = []
    for x in body or []:
        h = (x.get("headline") or "").strip()
        if not h:
            continue
        ts = x.get("datetime")
        if isinstance(ts, (int, float)):
            when = dt.datetime.fromtimestamp(ts, tz=dt.timezone.utc)
        else:
            continue
        out.append({
            "headline": h[:500],
            "url": (x.get("url") or "")[:500],
            "ts": when,
            "summary": (x.get("summary") or "")[:400],
        })
    return out


def label_one(port: int, ticker: str, name: str, h: dict) -> dict | None:
    from openjev_news import questions
    import oj
    q = questions(name)
    ask = {"rel": q["rel"], "dir": q["dir"], "cat": q["cat"]}
    state = f"Company: {name} (ticker {ticker}).\nHeadline: {h['headline']}"
    if h.get("summary"):
        state += f"\nSummary: {h['summary']}"
    try:
        ans = oj.post(port, state[:8000], ask)["answers"]
    except Exception:
        return None
    rel = float(ans["rel"].get("noul", 0))
    d = ans["dir"]
    if "score" in d:
        dir_v = float(d["score"]) * 2 - 1
    elif "expected" in d:
        dir_v = float(d["expected"]) * 2 - 1
    else:
        dir_v = 0.0
    cat = ans["cat"].get("choice") or "other"
    return {"rel": rel, "dir": dir_v, "cat": cat}


def run(limit: int | None = None, *, max_new: int | None = None, reuse: bool = False) -> dict:
    """Label new Finnhub headlines. reuse=True: the caller already loaded the model (A261 morning tick)."""
    import oj
    conn = connect()
    for stmt in DDL.split(";"):
        if stmt.strip():
            conn.execute(stmt)
    conn.commit()
    tickers = held_and_model(conn)
    if limit:
        tickers = tickers[:limit]
    today = dt.datetime.now(PT).date()
    since = today - dt.timedelta(days=1)
    if reuse:
        import oj_server
        port = oj_server.running_port()
    else:
        port = oj.ensure_server()
    if port is None:
        return {"ok": False, "error": "openjev unavailable"}
    names = {t: t for t in tickers}
    try:
        for r in conn.execute(
            "SELECT UPPER(ticker), COALESCE(company_name, ticker) FROM fmp_fundamentals WHERE UPPER(ticker) = ANY(%s)",
            (tickers,),
        ).fetchall():
            names[r[0]] = r[1]
    except Exception:
        conn.rollback()
    n_lab, n_skip = 0, 0
    have = {(r[0], r[1]) for r in conn.execute(
        "SELECT ticker, headline FROM watchlist_sync.openjev_headline_labels WHERE ts >= %s",
        (dt.datetime.combine(since, dt.time.min, tzinfo=PT),),
    ).fetchall()}
    for t in tickers:
        if max_new is not None and n_lab >= max_new:
            break
        for h in finnhub_news(t, since, today)[:12]:
            if max_new is not None and n_lab >= max_new:
                break
            if (t, h["headline"]) in have:
                continue
            lab = label_one(port, t, names.get(t, t), h)
            if not lab:
                n_skip += 1
                continue
            have.add((t, h["headline"]))
            try:
                conn.execute(
                    """INSERT INTO watchlist_sync.openjev_headline_labels
                       (ticker, ts, headline, url, rel, dir, cat)
                       VALUES (%s, %s, %s, %s, %s, %s, %s)
                       ON CONFLICT (ticker, ts, headline) DO UPDATE SET
                         rel = EXCLUDED.rel, dir = EXCLUDED.dir, cat = EXCLUDED.cat, labeled_at = now()""",
                    (t, h["ts"], h["headline"], h["url"], lab["rel"], lab["dir"], lab["cat"]),
                )
                n_lab += 1
            except Exception:
                conn.rollback()
                n_skip += 1
        conn.commit()
    return {"ok": True, "tickers": len(tickers), "labeled": n_lab, "skipped": n_skip}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int)
    a = ap.parse_args()
    print(json.dumps(run(a.limit), indent=1))


if __name__ == "__main__":
    main()
