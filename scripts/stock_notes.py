#!/usr/bin/env python3
"""Per-ticker desk notes — the shared memory agents read before analysing a stock (Jamie 10-28).

Store: public.fund_score_notes (same rows the Breakdown › Notes tab and the AI explain prompts read).
A note is ONE concise fact that took analysis to learn: a good/bad trade and why, earnings behaviour,
support/resistance, a backtest result, the stock's character. ≤ 280 chars, dated, never a forecast.

  stock_notes.py show PLTR GOOGL        # read before analysing / recommending a ticker
  stock_notes.py add PLTR character "Mega-cap: 0.15Δ weekly put pays ~0.2 %/wk — below the 0.30 floor" --src S126 --author claude
  stock_notes.py recent --days 7        # what the team learned this week
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import sys
from pathlib import Path

import psycopg

KINDS = ("trade", "earnings", "levels", "backtest", "character", "lesson", "thesis")
MAX = 280


def conn():
    url = os.environ.get("DATABASE_URL")
    if not url:
        env = Path(__file__).resolve().parents[1] / ".env.local"
        for line in env.read_text().splitlines() if env.exists() else []:
            if line.startswith("DATABASE_URL="):
                url = line.split("=", 1)[1].strip().strip('"')
    return psycopg.connect(url)


def fmt(r) -> str:
    tid, tk, as_of, body, author, tags = r
    tags = tags or []
    kind = next((t for t in tags if t in KINDS), "note")
    src = next((t[4:] for t in tags if t.startswith("src:")), None)
    age = (dt.date.today() - as_of).days
    return f"{tk} {as_of} ({age}d) {kind}: {body}" + (f" [{src}]" if src else "") + (f" — {author}" if author else "")


def show(tickers: list[str], limit: int) -> None:
    with conn() as c:
        for tk in tickers:
            rows = c.execute(
                "select id, ticker, as_of, body, author, tags from fund_score_notes where ticker=%s"
                " and (expires_at is null or expires_at > now()) order by as_of desc, created_at desc limit %s",
                (tk.upper(), limit)).fetchall()
            print("\n".join(fmt(r) for r in rows) if rows else f"{tk.upper()}: no notes")


def recent(days: int) -> None:
    with conn() as c:
        rows = c.execute(
            "select id, ticker, as_of, body, author, tags from fund_score_notes where created_at > now() - %s * interval '1 day'"
            " order by ticker, as_of desc", (days,)).fetchall()
        print("\n".join(fmt(r) for r in rows) or "no notes")


def add(tk: str, kind: str, body: str, src: str | None, author: str, as_of: str | None, expires: str | None) -> None:
    body = " ".join(body.split())
    if kind not in KINDS:
        sys.exit(f"kind must be one of {KINDS}")
    if not body or len(body) > MAX:
        sys.exit(f"note must be 1–{MAX} chars (got {len(body)}) — keep it to one fact")
    tags = [kind] + ([f"src:{src}"] if src else [])
    with conn() as c:
        dup = c.execute("select 1 from fund_score_notes where ticker=%s and body=%s", (tk.upper(), body)).fetchone()
        if dup:
            print("duplicate — skipped"); return
        c.execute(
            "insert into fund_score_notes (ticker, as_of, body, author, tags, expires_at, linked_snapshot_as_of)"
            " values (%s, %s, %s, %s, %s::jsonb, %s, %s)",
            (tk.upper(), as_of or dt.date.today().isoformat(), body, author, psycopg.types.json.Json(tags), expires,
             as_of or dt.date.today().isoformat()))
    print(f"added {tk.upper()} {kind}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest="cmd", required=True)
    s = sp.add_parser("show"); s.add_argument("tickers", nargs="+"); s.add_argument("--limit", type=int, default=8)
    r = sp.add_parser("recent"); r.add_argument("--days", type=int, default=7)
    a = sp.add_parser("add"); a.add_argument("ticker"); a.add_argument("kind", choices=KINDS); a.add_argument("body")
    a.add_argument("--src"); a.add_argument("--author", default=os.environ.get("FILDI_AGENT", "agent"))
    a.add_argument("--as-of"); a.add_argument("--expires", help="ISO date after which the note is hidden")
    x = ap.parse_args()
    if x.cmd == "show": show(x.tickers, x.limit)
    elif x.cmd == "recent": recent(x.days)
    else: add(x.ticker, x.kind, x.body, x.src, x.author, x.as_of, x.expires)


if __name__ == "__main__":
    main()
