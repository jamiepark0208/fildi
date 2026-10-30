"""Post-earnings notes (Jamie 10-29): after a report, write neutral facts into Breakdown › Notes (fund_score_notes) so Jamie and
every agent see what happened without re-reading the call. Runs at the end of transcripts.py (daily 08:00 PT); a note waits until
(a) the call transcript is stored and summarised and (b) the first close after the report date exists — so it lands ~1 day later.

Two notes per report, kind 'earnings', tag src:transcript:<T>:<Q>, author 'auto':
  1. numbers (no LLM): 2-day move around the report vs the stock's usual 2-day move and SPY, EPS vs estimate, guidance label.
  2. the call (Haiku, text only): what management reported/guided and what analysts pushed on — from the stored summary JSON.
Neutral voice: facts and both sides, no opinion, no advice (notes are history, never a forecast — AGENTS.md read-next 7).

    .venv/bin/python earnings_notes.py            # write due notes
    .venv/bin/python earnings_notes.py --print    # show what would be written
"""
from __future__ import annotations

import json
import math
import sys
from datetime import date


from build_plan import connect, rows

MAX = 280                 # = scripts/stock_notes.py MAX
LOOKBACK_DAYS = 21        # only reports this recent get notes (prior-quarter backfills don't)
PROMPT = """Write ONE neutral note (at most 200 characters, count them) on {ticker}'s {quarter} earnings call for an internal stock-notes log.
State what management reported or guided and the main question analysts pushed on. Use only facts and numbers that appear in the JSON.
No opinion, no adjectives like strong/weak/great/disappointing, no advice, no price targets. Plain text, one or two sentences.
JSON: {summary}"""


def _due(conn) -> list[dict]:
    """Latest-quarter transcripts with a summary, reported within LOOKBACK_DAYS, without an auto note yet."""
    return rows(conn, """
        SELECT t.ticker, t.quarter, t.summary, e.report_date, e.eps_actual::float8 AS eps_a, e.eps_estimate::float8 AS eps_e
        FROM watchlist_sync.earnings_transcripts t
        JOIN watchlist_sync.transcript_checks c ON c.ticker = t.ticker AND c.quarter = t.quarter
        JOIN LATERAL (SELECT report_date, eps_actual, eps_estimate FROM public.earnings_calendar
                      WHERE ticker = t.ticker AND report_date <= t.fetched_at::date AND report_date >= t.fetched_at::date - 30
                        AND report_date BETWEEN c.period AND c.period + 100   -- the call's quarter, not a newer report (Finnhub lag)
                      ORDER BY report_date DESC LIMIT 1) e ON true
        WHERE t.status = 'ok' AND t.summary IS NOT NULL AND e.report_date >= CURRENT_DATE - %s
          AND NOT EXISTS (SELECT 1 FROM fund_score_notes n WHERE n.ticker = t.ticker
                          AND n.tags @> jsonb_build_array('src:transcript:' || t.ticker || ':' || t.quarter))""", (LOOKBACK_DAYS,))


def _reaction(conn, t: str, rd: date) -> dict | None:
    """Close before the report date → first close after it (covers before-open and after-close reports). None until that close exists."""
    def closes(sym):
        return [(d, c) for d, c in conn.execute("""SELECT date, close::float8 FROM prices_historical
                                                    WHERE UPPER(ticker) = %s AND date BETWEEN %s::date - 120 AND %s::date + 7
                                                    ORDER BY date""", (sym, rd, rd)).fetchall() if c]
    s, m = closes(t), closes("SPY")
    pre = [x for x in s if x[0] < rd]
    post = [x for x in s if x[0] > rd]
    if len(pre) < 61 or not post:
        return None
    p0, p1, d1 = pre[-1][1], post[0][1], post[0][0]
    rets = [math.log(pre[i][1] / pre[i - 1][1]) for i in range(len(pre) - 60, len(pre))]
    sd = (sum(r * r for r in rets) / len(rets) - (sum(rets) / len(rets)) ** 2) ** 0.5 * math.sqrt(2)
    spy0 = next((c for d, c in reversed(m) if d < rd), None)
    spy1 = next((c for d, c in m if d == d1), None)
    mv = p1 / p0 - 1
    return {"move": 100 * mv, "z": abs(math.log(p1 / p0)) / sd if sd else None, "to": d1,
            "spy": 100 * (spy1 / spy0 - 1) if spy0 and spy1 else None}


def numbers_note(r: dict, x: dict) -> str:
    s = r["summary"] or {}
    parts = [f"{r['quarter']} report {r['report_date']:%m-%d}: {x['move']:+.1f} % to the {x['to']:%m-%d} close"
             + (f" ({x['z']:.1f}× its usual 2-day move" if x["z"] is not None else " (")
             + (f"; SPY {x['spy']:+.1f} %)" if x["spy"] is not None else ")")]
    if r["eps_a"] is not None and r["eps_e"]:
        parts.append(f"EPS {r['eps_a']:g} vs est {r['eps_e']:.2f} ({100 * (r['eps_a'] - r['eps_e']) / abs(r['eps_e']):+.0f} %)")
    if s.get("guidance") and s["guidance"] != "none":
        parts.append(f"guidance {s['guidance']}")
    k = (s.get("kpis") or [])[:1]
    if k and k[0].get("name") and k[0].get("value"):
        parts.append(f"{k[0]['name']} {k[0]['value']}")
    out = ". ".join(parts) + "."
    return out if len(out) <= MAX else ". ".join(parts[:2]) + "."


def call_note(r: dict, ask) -> str:
    s = r["summary"] or {}
    keep = {k: s.get(k) for k in ("guidance", "guidance_detail", "kpis", "demand", "margins", "analyst_concerns", "financing")}
    try:
        p = PROMPT.format(ticker=r["ticker"], quarter=r["quarter"], summary=json.dumps(keep))
        txt = " ".join(ask(r["ticker"], p).split())
        if len(txt) > MAX:   # one retry, shorter
            txt = " ".join(ask(r["ticker"], p + f"\n\nYour last draft was {len(txt)} characters. Rewrite it under 200:\n{txt}").split())
    except Exception:  # noqa: BLE001 — fall back to the summary's own words
        txt = ""
    if not txt or len(txt) > MAX:
        c = (s.get("analyst_concerns") or [None])[0]
        txt = " ".join(f"Call: {s.get('guidance_detail') or s.get('demand') or ''}" .split()) + (f"; analysts asked about {c}" if c else "")
        txt = txt[:MAX - 1].rsplit(" ", 1)[0].rstrip(",;") + "…" if len(txt) >= MAX else txt
    return txt


def _insert(conn, t: str, q: str, body: str, as_of) -> None:
    tags = ["earnings", f"src:transcript:{t}:{q}"]
    conn.execute("""INSERT INTO fund_score_notes (ticker, as_of, body, author, tags, linked_snapshot_as_of)
                    SELECT %s, %s, %s, 'auto', %s::jsonb, %s
                    WHERE NOT EXISTS (SELECT 1 FROM fund_score_notes WHERE ticker = %s AND body = %s)""",
                 (t, as_of, body, json.dumps(tags), as_of, t, body))


def run(conn, ask, dry: bool = False) -> int:
    """Write due notes; returns how many reports got notes. `ask(ticker, prompt) -> str` is the Haiku call (transcripts._summ_note)."""
    n = 0
    for r in _due(conn):
        x = _reaction(conn, r["ticker"], r["report_date"])
        if not x:
            continue   # first close after the report not in yet → next run
        a, b = numbers_note(r, x), call_note(r, ask)
        if dry:
            print(f"{r['ticker']} {r['quarter']}\n  {a}\n  {b}")
        else:
            _insert(conn, r["ticker"], r["quarter"], a, x["to"])
            _insert(conn, r["ticker"], r["quarter"], b, x["to"])
            conn.commit()
        n += 1
    return n


if __name__ == "__main__":
    import transcripts
    with connect() as c:
        print(f"earnings notes: {run(c, transcripts._summ_note, dry='--print' in sys.argv)}")
