"""Desk media sentiment daily (A214): StockTwits stream + earnings-call tone → media_sentiment_daily.

Display only — never feeds Model List / fit scores until a study row exists.
OpenJev headline classify stays out of this job (tier B; Live strip already uses openjev_headline_labels).

    .venv/bin/python media_sentiment.py            # upsert call_tone + StockTwits for pool
    .venv/bin/python media_sentiment.py --dry      # print pool sizes, fetch nothing
    .venv/bin/python media_sentiment.py --limit 40 # cap StockTwits GETs this run
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date

from build_plan import connect, rows

DDL = """
CREATE TABLE IF NOT EXISTS watchlist_sync.media_sentiment_daily (
  as_of date NOT NULL,
  ticker text NOT NULL,
  source text NOT NULL,
  score float8,
  n int,
  sample jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (as_of, ticker, source)
);
CREATE INDEX IF NOT EXISTS media_sentiment_daily_ticker_idx
  ON watchlist_sync.media_sentiment_daily (ticker, as_of DESC);
"""

# StockTwits public symbol stream — probed 2026-10-22: HTTP 200, no rate-limit headers.
# Stay polite: ~1 req/s, default daily cap below.
ST_URL = "https://api.stocktwits.com/api/2/streams/symbol/{ticker}.json"
ST_SLEEP = 1.15
DEFAULT_ST_LIMIT = 80


def pool_tickers(conn) -> list[str]:
    """Model List ∪ recent option_score_snapshots (A214 acceptance pool)."""
    return [
        r["ticker"]
        for r in rows(
            conn,
            """
            SELECT DISTINCT UPPER(ticker) AS ticker FROM (
              SELECT ticker FROM model_recs
              UNION
              SELECT ticker FROM option_score_snapshots
              WHERE as_of::date >= CURRENT_DATE - 3
            ) u
            WHERE ticker ~ '^[A-Z][A-Z0-9.-]{0,9}$'
            ORDER BY 1
            """,
        )
    ]


def upsert(conn, as_of: date, ticker: str, source: str, score: float | None, n: int, sample: dict) -> None:
    conn.execute(
        """
        INSERT INTO watchlist_sync.media_sentiment_daily (as_of, ticker, source, score, n, sample, fetched_at)
        VALUES (%s, %s, %s, %s, %s, %s::jsonb, now())
        ON CONFLICT (as_of, ticker, source) DO UPDATE SET
          score = EXCLUDED.score, n = EXCLUDED.n, sample = EXCLUDED.sample, fetched_at = now()
        """,
        (as_of, ticker, source, score, n, json.dumps(sample)),
    )


def sync_call_tone(conn, as_of: date, tickers: set[str]) -> int:
    """Non-keyword source from stored earnings_transcripts summaries (no vendor call)."""
    if not tickers:
        return 0
    got = rows(
        conn,
        """
        SELECT DISTINCT ON (ticker) ticker, quarter, av_sentiment,
               summary->>'tone_prepared' AS tone_prepared,
               summary->>'tone_qa' AS tone_qa,
               summary->>'tone' AS tone,
               summary->>'guidance' AS guidance
        FROM watchlist_sync.earnings_transcripts
        WHERE status = 'ok' AND summary IS NOT NULL AND ticker = ANY(%s)
        ORDER BY ticker, quarter DESC
        """,
        (list(tickers),),
    )
    n_ok = 0
    for r in got:
        tones = []
        for k in ("tone_prepared", "tone_qa", "tone"):
            try:
                if r[k] is not None and str(r[k]).strip() != "":
                    tones.append(float(r[k]))
            except (TypeError, ValueError):
                pass
        av = r["av_sentiment"]
        # Map call tone (−2..2) and optional AV (−1..1-ish) into (−1, 1)
        parts = [t / 2.0 for t in tones]
        if av is not None and isinstance(av, (int, float)):
            parts.append(max(-1.0, min(1.0, float(av))))
        if not parts:
            continue
        score = sum(parts) / len(parts)
        upsert(
            conn,
            as_of,
            r["ticker"],
            "call_tone",
            round(score, 4),
            len(parts),
            {"quarter": r["quarter"], "guidance": r["guidance"], "tones": tones, "av": av},
        )
        n_ok += 1
    conn.commit()
    return n_ok


def fetch_stocktwits(ticker: str) -> tuple[str, dict | None]:
    """Returns ('ok', payload) | ('http', None) | ('error', None)."""
    url = ST_URL.format(ticker=urllib.parse.quote(ticker))
    req = urllib.request.Request(url, headers={"User-Agent": "fildi-media-sentiment/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = json.loads(resp.read().decode())
            return "ok", {"status": resp.status, "body": body, "headers": dict(resp.headers)}
    except urllib.error.HTTPError as e:
        return f"http_{e.code}", None
    except Exception:  # noqa: BLE001
        return "error", None


def score_stocktwits(body: dict) -> tuple[float | None, int, dict]:
    msgs = body.get("messages") or []
    bull = bear = 0
    for m in msgs:
        ent = (m.get("entities") or {}).get("sentiment") or {}
        label = str(ent.get("basic") or "").lower()
        if "bull" in label:
            bull += 1
        elif "bear" in label:
            bear += 1
    tagged = bull + bear
    if tagged == 0:
        return None, len(msgs), {"bull": 0, "bear": 0, "untagged": len(msgs), "watchlist_count": (body.get("symbol") or {}).get("watchlist_count")}
    score = (bull - bear) / tagged  # −1..+1
    return round(score, 4), tagged, {
        "bull": bull,
        "bear": bear,
        "untagged": len(msgs) - tagged,
        "messages": len(msgs),
        "watchlist_count": (body.get("symbol") or {}).get("watchlist_count"),
    }


def sync_stocktwits(conn, as_of: date, tickers: list[str], limit: int) -> tuple[int, int, list[str]]:
    """Fetch StockTwits for tickers missing today's row first, then refresh oldest."""
    have = {
        r["ticker"]
        for r in rows(
            conn,
            "SELECT ticker FROM watchlist_sync.media_sentiment_daily WHERE as_of = %s AND source = 'stocktwits'",
            (as_of,),
        )
    }
    ordered = [t for t in tickers if t not in have] + [t for t in tickers if t in have]
    ok = fail = 0
    notes: list[str] = []
    for t in ordered[:limit]:
        status, payload = fetch_stocktwits(t)
        if status != "ok" or not payload:
            fail += 1
            notes.append(f"{t}:{status}")
            if status in ("http_401", "http_403"):
                notes.append("stocktwits_denied_stop")
                break
            if status == "http_429":
                time.sleep(30)
            continue
        score, n, sample = score_stocktwits(payload["body"])
        upsert(conn, as_of, t, "stocktwits", score, n, sample)
        conn.commit()
        ok += 1
        time.sleep(ST_SLEEP)
    return ok, fail, notes


ST_MIN_N = 5  # tagged posts; below this the lean is one or two posters (A356)


def rank_source(conn, as_of: date, source: str = "stocktwits", min_n: int = ST_MIN_N) -> int:
    """A356: raw scores skew positive (StockTwits tagged 14-d median +0.78; call tone +0.42), so a score
    vs 0 mislabels. Write a same-day cross-sectional percentile (rows with n ≥ min_n) + thin flag into sample."""
    cur = conn.execute(
        """
        WITH base AS (
          SELECT ticker, score, n
          FROM watchlist_sync.media_sentiment_daily
          WHERE as_of = %(d)s AND source = %(s)s AND score IS NOT NULL
        ), med AS (
          SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY score) AS med FROM base WHERE n >= %(m)s
        ), d AS (
          SELECT b.ticker, b.n, m.med,
                 CASE WHEN b.n >= %(m)s THEN round((100 * percent_rank() OVER (
                   PARTITION BY (b.n >= %(m)s) ORDER BY b.score))::numeric, 0) END AS pct
          FROM base b CROSS JOIN med m
        )
        UPDATE watchlist_sync.media_sentiment_daily x
        SET sample = coalesce(x.sample, '{}'::jsonb)
              || jsonb_build_object('pct', d.pct, 'thin', d.n < %(m)s, 'pool_median', round(d.med::numeric, 3))
        FROM d
        WHERE x.as_of = %(d)s AND x.source = %(s)s AND x.ticker = d.ticker
        """,
        {"d": as_of, "m": min_n, "s": source},
    )
    conn.commit()
    return cur.rowcount


def meter_stocktwits(conn, calls: int) -> None:
    if calls <= 0:
        return
    conn.execute(
        """INSERT INTO api_usage (source, date, calls_made, updated_at)
           VALUES ('stocktwits', (now() AT TIME ZONE 'America/Los_Angeles')::date, %s, now())
           ON CONFLICT (source, date) DO UPDATE SET calls_made = api_usage.calls_made + excluded.calls_made,
           updated_at = now()""",
        (calls,),
    )
    conn.commit()


def coverage(conn, as_of: date, pool: list[str]) -> tuple[int, int]:
    """Names with ≥1 non-keyword source today (stocktwits or call_tone)."""
    if not pool:
        return 0, 0
    n = rows(
        conn,
        """
        SELECT COUNT(DISTINCT ticker) AS n
        FROM watchlist_sync.media_sentiment_daily
        WHERE as_of = %s AND source IN ('stocktwits', 'call_tone') AND ticker = ANY(%s)
        """,
        (as_of, pool),
    )[0]["n"]
    return int(n), len(pool)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--limit", type=int, default=DEFAULT_ST_LIMIT, help="max StockTwits GETs this run")
    ap.add_argument("--ticker", help="single ticker (debug)")
    args = ap.parse_args()

    conn = connect()
    conn.execute(DDL)
    conn.commit()
    as_of = date.today()
    pool = [args.ticker.upper()] if args.ticker else pool_tickers(conn)
    print(f"{as_of}: pool={len(pool)} stocktwits_limit={args.limit}", flush=True)
    if args.dry:
        cov_n, cov_d = coverage(conn, as_of, pool)
        print(f"dry: coverage_today {cov_n}/{cov_d} ({100 * cov_n / cov_d if cov_d else 0:.0f}%)")
        return

    call_n = sync_call_tone(conn, as_of, set(pool))
    print(f"call_tone upserted {call_n}", flush=True)
    st_ok, st_fail, notes = sync_stocktwits(conn, as_of, pool, args.limit)
    print(f"stocktwits ok={st_ok} fail={st_fail} {' '.join(notes[:8])}", flush=True)
    meter_stocktwits(conn, st_ok + st_fail)
    ranked = (rank_source(conn, as_of, "stocktwits", ST_MIN_N), rank_source(conn, as_of, "call_tone", 1))
    print(f"ranked stocktwits={ranked[0]} call_tone={ranked[1]} (same-day pct; stocktwits min n {ST_MIN_N})", flush=True)
    cov_n, cov_d = coverage(conn, as_of, pool)
    pct = 100 * cov_n / cov_d if cov_d else 0
    print(f"coverage non-keyword {cov_n}/{cov_d} ({pct:.0f}%) target≥70%", flush=True)


if __name__ == "__main__":
    main()
