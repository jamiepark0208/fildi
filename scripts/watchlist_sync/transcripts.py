"""Earnings-call transcripts (Claude, PM role, user 2026-10-14): fetch → store → summarize, inside Alpha Vantage's free 25 calls/day.

Queue (one transcript per ticker per fiscal quarter, never re-fetched):
  tier 1  names in the book (stock held or short option) — they matter most and move first after a report
  tier 2  today's Model List option candidates (latest plan)
  tier 3  the rest of the Friday model universe (model_recs), oldest-checked first
Latest reported fiscal quarter comes from Finnhub /stock/earnings (free; same fiscal YYYYQn labels AV uses — checked on MSFT 10-14).
Budget: AV calls are counted in api_usage (source 'av', shared with any other AV use); this job stops at AV_DAILY_CAP − AV_RESERVE.
Summary: Claude Haiku → JSON (guidance, tone, demand, margins, financing/dilution, risks, catalysts, 5 bullets) + AV's own per-segment
sentiment averaged (deterministic cross-check). Shown in Live › Portfolio Alerts › Your names (GET /api/pm/names).

    .venv/bin/python transcripts.py            # daily run (LaunchAgent com.fildi.transcripts, 08:00 PT, after the Model List)
    .venv/bin/python transcripts.py --dry      # print the queue, fetch nothing
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime

from build_plan import connect, rows

AV_DAILY_CAP, AV_RESERVE = 25, 5
MODEL = "claude-haiku-5-5"
MAX_CHARS = 60_000      # ~15k tokens; long calls are cut after the Q&A start + tail
DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.earnings_transcripts (
  ticker text NOT NULL, quarter text NOT NULL, status text NOT NULL, fetched_at timestamptz NOT NULL DEFAULT now(),
  segments int, av_sentiment float8, transcript jsonb, summary jsonb, summary_model text, PRIMARY KEY (ticker, quarter));
CREATE TABLE IF NOT EXISTS watchlist_sync.transcript_checks (ticker text PRIMARY KEY, checked_at timestamptz NOT NULL, quarter text)"""
SCHEMA_VERSION = 2
PROMPT = """You are an equity analyst extracting model inputs from an earnings call, for a trader who sells weekly puts and keeps an
FCF / fair-value model on this stock. Return ONLY one JSON object, every string ≤ 25 words, numbers as plain numbers (USD in millions,
percents as 12.5 for 12.5%). Use null when the call doesn't say. No advice.
Keys:
 "guidance": revenue/EPS outlook vs prior: "raised","maintained","lowered","withdrawn","initiated","none" (cost/opex cuts are not "lowered");
 "guidance_detail": short string;
 "guidance_items": list of {{"metric": "revenue"|"eps"|"ebitda"|"gross_margin"|"op_margin"|"fcf"|"capex"|"opex"|"other",
     "label": short name, "period": "FY2026" or "Q4 FY2026" style (fiscal), "low": number|null, "high": number|null, "unit": "usd_m"|"usd_per_share"|"pct"|"other",
     "prior_low": number|null, "prior_high": number|null}};
 "model_inputs": {{"revenue_growth_pct": number|null, "gross_margin_pct": number|null, "op_margin_pct": number|null,
     "capex_usd_m": number|null, "fcf_usd_m": number|null, "period": string|null, "note": short string}} — management's stated or implied figures for the
     next fiscal year; null if not stated (do not invent);
 "kpis": up to 4 {{"name": short, "value": short string, "change": short string}} — company-specific operating metrics (backlog, bookings, ARR, units…);
 "tone_prepared": integer -2..2; "tone_qa": integer -2..2 (management under analyst questioning);
 "analyst_concerns": up to 3 short strings (what analysts pushed on);
 "demand": short string; "margins": short string;
 "financing": capital raises, ATM, converts, buybacks, cash runway, dilution ("none mentioned" if none);
 "risks": up to 3 short strings; "catalysts": up to 3 short strings with dates if given;
 "bullets": exactly 5 short bullets a trader needs, most important first.
Ticker {ticker}, fiscal quarter {quarter}.

TRANSCRIPT:
{text}"""


def env(name: str) -> str:
    if os.environ.get(name):
        return os.environ[name]
    for line in open(os.path.join(os.path.dirname(__file__), "..", "..", ".env.local")):
        if line.startswith(name + "="):
            return line.split("=", 1)[1].strip().strip('"')
    return ""


def get_json(url: str, timeout: int = 60, data: bytes | None = None, headers: dict | None = None) -> dict | list:
    req = urllib.request.Request(url, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def av_used_today(conn) -> int:
    r = conn.execute("SELECT calls_made FROM api_usage WHERE source = 'av' AND date = (now() AT TIME ZONE 'America/Los_Angeles')::date").fetchone()
    return r[0] if r else 0


def usage(conn, source: str) -> None:
    """One call → api_usage (Settings › API Monitor; same table every client writes)."""
    conn.execute("""INSERT INTO api_usage (source, date, calls_made, updated_at) VALUES (%s, (now() AT TIME ZONE 'America/Los_Angeles')::date, 1, now())
                    ON CONFLICT (source, date) DO UPDATE SET calls_made = api_usage.calls_made + 1, updated_at = now()""", (source,))
    conn.commit()


def av_count(conn) -> None:
    usage(conn, "av")


def queue(conn) -> list[tuple[int, str]]:
    snap = conn.execute("SELECT MAX(id) FROM portfolio_snapshots").fetchone()[0]
    t1 = {r["t"] for r in rows(conn, """SELECT UPPER(symbol) AS t FROM portfolio_positions WHERE snapshot_id = %s
                                        UNION SELECT UPPER(symbol) FROM portfolio_options WHERE snapshot_id = %s AND expiration >= CURRENT_DATE""",
                                    (snap, snap))}
    t2 = {r["t"] for r in rows(conn, """SELECT DISTINCT ticker AS t FROM watchlist_sync.plan_items
                                        WHERE plan_id = (SELECT MAX(id) FROM watchlist_sync.plans) AND kind = 'option'""")}
    t3 = {r["t"] for r in rows(conn, "SELECT DISTINCT ticker AS t FROM model_recs WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM model_recs)")}
    checked = {r["ticker"]: r["checked_at"] for r in rows(conn, "SELECT ticker, checked_at FROM watchlist_sync.transcript_checks")}
    out, seen = [], set()
    for tier, names in ((1, t1), (2, t2), (3, t3)):
        for t in sorted(names - seen, key=lambda t: (checked.get(t) is not None, checked.get(t) or 0)):
            if "." in t or len(t) > 5:
                continue
            seen.add(t)
            out.append((tier, t))
    return out


_CALLS: dict[str, int] = {}  # anthropic / finnhub calls this run → api_usage at the end
_AI_USAGE: list[tuple[str, int, int]] = []  # (ticker, in, out) per Haiku call → ai_usage_log at the end (A130)


def latest_quarter(ticker: str) -> str | None:
    _CALLS["finnhub"] = _CALLS.get("finnhub", 0) + 1
    d = get_json(f"https://finnhub.io/api/v1/stock/earnings?symbol={urllib.parse.quote(ticker)}&token={env('FINNHUB_API_KEY')}", 30)
    done = [x for x in d if isinstance(x, dict) and x.get("actual") is not None and x.get("year") and x.get("quarter")] if isinstance(d, list) else []
    return f"{done[0]['year']}Q{done[0]['quarter']}" if done else None


def prev_quarter(q: str) -> str:
    y, n = int(q[:4]), int(q[5])
    return f"{y - 1}Q4" if n == 1 else f"{y}Q{n - 1}"


def fetch_store(conn, t: str, quarter: str) -> str:
    """One AV call → stored row. Returns 'ok' | 'empty' | 'limit' | 'error'."""
    try:
        d = get_json("https://www.alphavantage.co/query?" + urllib.parse.urlencode(
            {"function": "EARNINGS_CALL_TRANSCRIPT", "symbol": t, "quarter": quarter, "apikey": env("ALPHA_VANTAGE_API_KEY")}), 100)
    except Exception:  # noqa: BLE001
        return "error"
    av_count(conn)
    if isinstance(d, dict) and ("Information" in d or "Note" in d):
        return "limit"
    segs = (d.get("transcript") or []) if isinstance(d, dict) else []
    sent = [float(x["sentiment"]) for x in segs if x.get("sentiment") not in (None, "")]
    try:
        summary = summarize(t, quarter, segs) if segs else None
    except Exception:  # noqa: BLE001 — Haiku timeout must not kill the run or waste the AV call; resummarize() fills it next run
        summary = None
    if summary:
        summary["schema"] = SCHEMA_VERSION
    conn.execute("""INSERT INTO watchlist_sync.earnings_transcripts (ticker, quarter, status, segments, av_sentiment, transcript, summary, summary_model)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (ticker, quarter) DO NOTHING""",
                 (t, quarter, "ok" if segs else "empty", len(segs), sum(sent) / len(sent) if sent else None,
                  json.dumps(segs) if segs else None, json.dumps(summary) if summary else None, MODEL if summary else None))
    conn.commit()
    return "ok" if segs else "empty"


def summarize(ticker: str, quarter: str, segs: list[dict]) -> dict | None:
    text = "\n".join(f"{s.get('speaker', '')} ({s.get('title', '')}): {s.get('content', '')}" for s in segs)
    if len(text) > MAX_CHARS:
        text = text[: MAX_CHARS - 15_000] + "\n…\n" + text[-15_000:]
    body = json.dumps({"model": MODEL, "max_tokens": 3500,
                       "messages": [{"role": "user", "content": PROMPT.format(ticker=ticker, quarter=quarter, text=text)}]}).encode()
    _CALLS["anthropic"] = _CALLS.get("anthropic", 0) + 1
    r = get_json("https://api.anthropic.com/v1/messages", 120, body,
                 {"content-type": "application/json", "x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01"})
    u = r.get("usage") or {}
    _AI_USAGE.append((ticker, int(u.get("input_tokens") or 0), int(u.get("output_tokens") or 0)))
    out = "".join(c.get("text", "") for c in r.get("content", []))
    try:
        return json.loads(out[out.index("{"): out.rindex("}") + 1])
    except ValueError:
        return None


def resummarize(conn) -> None:
    """Summaries that failed (or a prompt change): re-run from stored transcripts; no AV calls."""
    for r in rows(conn, """SELECT ticker, quarter, transcript FROM watchlist_sync.earnings_transcripts
                         WHERE status = 'ok' AND (summary IS NULL OR COALESCE((summary->>'schema')::int, 1) < %s)""", (SCHEMA_VERSION,)):
        try:
            s = summarize(r["ticker"], r["quarter"], r["transcript"])
        except Exception:  # noqa: BLE001 — one slow call skips that row, not the whole run
            continue
        if s:
            s["schema"] = SCHEMA_VERSION
            conn.execute("UPDATE watchlist_sync.earnings_transcripts SET summary = %s, summary_model = %s WHERE ticker = %s AND quarter = %s",
                         (json.dumps(s), MODEL, r["ticker"], r["quarter"]))
            conn.commit()


def main() -> None:
    dry = "--dry" in sys.argv
    conn = connect()
    for stmt in DDL.split(";"):
        conn.execute(stmt)
    conn.commit()
    if not dry:
        resummarize(conn)
    have = {(r["ticker"], r["quarter"]) for r in rows(conn, "SELECT ticker, quarter FROM watchlist_sync.earnings_transcripts")}
    budget = AV_DAILY_CAP - AV_RESERVE - av_used_today(conn)
    q = queue(conn)
    if dry:
        print(f"AV budget left today: {budget}; queue {len(q)} (tier1 {sum(1 for t, _ in q if t == 1)})")
        print(" ".join(f"{t}:{n}" for t, n in q[:40]))
        return
    fetched = 0
    # order: book names' latest call → book names' prior 3 calls (tone/guidance trend) → everyone else's latest
    def latest_pass(items):
        nonlocal budget, fetched
        for tier, t in items:
            if budget <= 0:
                break
            try:
                quarter = latest_quarter(t)
            except Exception:  # noqa: BLE001
                continue
            time.sleep(1.1)  # Finnhub 60/min
            conn.execute("""INSERT INTO watchlist_sync.transcript_checks (ticker, checked_at, quarter) VALUES (%s, now(), %s)
                            ON CONFLICT (ticker) DO UPDATE SET checked_at = now(), quarter = excluded.quarter""", (t, quarter))
            conn.commit()
            if not quarter or (t, quarter) in have:
                continue
            status = fetch_store(conn, t, quarter)
            if status == "error":
                continue
            budget -= 1
            if status == "limit":
                budget = 0
                break
            fetched += 1
            time.sleep(1.5)

    def backfill_pass():
        nonlocal budget, fetched
        # tone/guidance trend: back-fill up to 3 prior quarters for book names (tier 1) once the latest quarters are done
        PRIOR = 3
        for tier, t in q:
            if tier != 1 or budget <= 0:
                break
            latest = conn.execute("SELECT quarter FROM watchlist_sync.transcript_checks WHERE ticker = %s", (t,)).fetchone()
            if not latest or not latest[0]:
                continue
            pq = latest[0]
            for _ in range(PRIOR):
                pq = prev_quarter(pq)
                if (t, pq) in have or budget <= 0:
                    continue
                status = fetch_store(conn, t, pq)
                have.add((t, pq))
                if status != "error":
                    budget -= 1
                if status == "limit":
                    budget = 0
                if status in ("empty", "limit"):
                    break
                fetched += 1
                time.sleep(1.5)

    latest_pass([x for x in q if x[0] == 1])
    backfill_pass()
    latest_pass([x for x in q if x[0] > 1])
    for src, n in _CALLS.items():
        conn.execute("""INSERT INTO api_usage (source, date, calls_made, updated_at) VALUES (%s, (now() AT TIME ZONE 'America/Los_Angeles')::date, %s, now())
                        ON CONFLICT (source, date) DO UPDATE SET calls_made = api_usage.calls_made + excluded.calls_made, updated_at = now()""", (src, n))
    for t, i, o in _AI_USAGE:  # same table as the API server's callHaiku (Settings › API Monitor › AI spend)
        conn.execute("""INSERT INTO ai_usage_log (user_id, ticker, surface_type, cached, input_tokens, output_tokens, model)
                        VALUES (NULL, %s, 'transcripts', false, %s, %s, %s)""", (t, i, o, MODEL))
    conn.commit()
    msg = f"fetched {fetched}, AV budget left {budget}"
    try:
        os.makedirs("/tmp/fildi-logs", exist_ok=True)
        with open("/tmp/fildi-logs/transcripts-last.json", "w") as fh:  # Settings › Scheduled Tasks reads this
            json.dump({"ts": datetime.now().astimezone().isoformat(timespec="seconds"), "ok": True, "detail": msg}, fh)
    except OSError:
        pass
    print(f"{date.today()}: {msg}")


if __name__ == "__main__":
    main()
