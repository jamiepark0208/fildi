"""Post-earnings notes (Jamie 10-29): after a report, write neutral facts into Breakdown › Notes (fund_score_notes) so Jamie and
every agent see what happened without re-reading the call. Runs at the end of transcripts.py (daily 08:00 PT); a note waits until
(a) the call transcript is stored and summarised and (b) the first close after the report date exists — so it lands ~1 day later.

v2 (10-30): the 8-K press release comes first (earnings_packet.py) — it is filed on the report day, the transcript can lag days.
Per report, kind 'earnings', author 'auto':
  1. numbers (no LLM, tag src:8k:<T>:<date>): 2-day move vs usual + SPY; revenue + operating income y/y, margin; EPS vs estimate.
  2. bridge (Sonnet, tag src:8k): why EPS / FCF moved apart from operating income — non-operating swing, named one-offs, capex.
     Every number in the draft must appear in the packet (± rounding, millions ↔ billions) or it falls back to a template.
  3. the call (Haiku, tag src:transcript:<T>:<Q>): what management guided and what analysts pushed on — when the transcript lands.
     Without an 8-K packet (foreign filers) the transcript path also writes the v1 numbers note.
Neutral voice: facts and both sides, no opinion, no advice (notes are history, never a forecast — AGENTS.md read-next 7).

    .venv/bin/python earnings_notes.py            # write due notes
    .venv/bin/python earnings_notes.py --print    # show what would be written
"""
from __future__ import annotations

import json
import math
import re
import sys
from datetime import date


from build_plan import connect, rows

MAX = 280                 # = scripts/stock_notes.py MAX
BRIDGE_MODEL = "claude-sonnet-5-5"
BRIDGE_PROMPT = """Write ONE neutral note (at most 260 characters, count them) for an internal stock-notes log on {ticker}'s report of {date}.
Explain what separated EPS and free cash flow from operating income this quarter: the non-operating swing, any named one-off with its
$ amount, and capex. Use only numbers that appear in the JSON, in $ billions with one decimal when the JSON is in millions.
If a line is missing, leave it out silently — never mention the JSON, missing data, or what cannot be computed.
No opinion, no adjectives like strong/weak/great/disappointing, no advice, no price targets. Plain text, one or two sentences.
JSON (amounts in {unit}): {packet}"""
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


def _b(v: float | None, unit: float) -> str:
    """Release amount → '$12.3 B' / '$456 M'."""
    x = v * unit
    sign = "−" if x < 0 else ""
    return f"{sign}${abs(x) / 1e9:,.1f} B" if abs(x) >= 1e9 else f"{sign}${abs(x) / 1e6:,.0f} M"


def numbers_note_8k(pk: dict, x: dict) -> str:
    b, u, st = pk["bridge"], pk.get("unit") or 1e6, pk["street"]
    parts = [f"Report {date.fromisoformat(pk.get('filed') or pk['report_date']):%m-%d}: {x['move']:+.1f} % to the {x['to']:%m-%d} close"
             + (f" ({x['z']:.1f}× its usual 2-day move" if x["z"] is not None else " (")
             + (f"; SPY {x['spy']:+.1f} %)" if x["spy"] is not None else ")")]
    ra, re_ = st.get("finnhub_revenueActual"), st.get("finnhub_revenueEstimate")
    if b.get("revenue") is not None:
        parts.append(f"revenue {_b(b['revenue'], u)}" + (f" {b['revenue_yoy_pct']:+.1f} % y/y" if b.get("revenue_yoy_pct") is not None else "")
                     + (f" (est {_b(re_ / u, u)}, {100 * (ra / re_ - 1):+.1f} %)"   # same revenue basis as the 8-K only
                        if ra and re_ and abs(ra / (b["revenue"] * u) - 1) < 0.01 else ""))
    if b.get("operating_income") is not None:
        parts.append(f"op income {_b(b['operating_income'], u)}" + (f" {b['operating_income_yoy_pct']:+.1f} %" if b.get("operating_income_yoy_pct") is not None else "")
                     + (f", margin {b['op_margin_pct']:.1f} % vs {b['op_margin_prior_pct']:.1f} %" if b.get("op_margin_prior_pct") is not None else ""))
    # Street estimates are on the company's adjusted basis: compare like with like, show GAAP apart when they differ
    eps, adj = b.get("eps_diluted"), st.get("finnhub_epsActual")
    est = st.get("finnhub_epsEstimate") if adj is not None else st.get("eps_estimate")
    basis = adj if adj is not None else eps
    if basis is not None:
        gaap = f"GAAP EPS {eps:g}; " if eps is not None and adj is not None and abs(eps - adj) > 0.02 * max(abs(adj), 0.05) else ""
        parts.append(gaap + (f"{'adj ' if gaap else ''}EPS {basis:g}") + (f" vs est {est:.2f} ({100 * (basis - est) / abs(est):+.0f} %)" if est else ""))
    out = "; ".join(parts[:1] + [", ".join(parts[1:])]) + "." if len(parts) > 1 else parts[0] + "."
    return out if len(out) <= MAX else ". ".join(parts[:2]) + "."


META = re.compile(r"\bJSON\b|not (reported|broken out|available|disclosed|listed|given)|isn't|is not (reported|broken)|no (named )?one-offs?|"
                  r"cannot be|can't be|no bridge", re.I)   # the note states facts, never what the packet lacks
_NUM = re.compile(r"(?<![\w.])-?\d[\d,]*\.?\d*")


def _packet_numbers(pk: dict) -> set[float]:
    """Every number the bridge note may use: release lines, bridge, one-off sentences, highlights (as written, ÷1000, abs)."""
    vals: set[float] = set()
    def add(v):
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            for w in (v, v / 1000, v / 1e6, v / 1e9):
                vals.add(abs(round(w, 4)))
    for ln in pk["lines"].values():
        add(ln.get("cur")); add(ln.get("prior"))
    for v in pk["bridge"].values():
        add(v)
    for s in pk["one_offs"] + pk.get("highlights", []):
        for m in _NUM.findall(s):
            add(float(m.replace(",", "")))
    if pk["bridge"].get("fcf") is not None and pk["lines"].get("capex"):
        add(pk["lines"]["capex"]["cur"] - pk["lines"]["capex"]["prior"])   # capex change
    return vals


def numbers_ok(text: str, pk: dict) -> list[str]:
    """Numbers in the draft not traceable to the packet (rounded to the draft's own decimals). Years / quarter digits pass."""
    vals, bad = _packet_numbers(pk), []
    for m in _NUM.findall(text):
        n = abs(float(m.replace(",", "")))
        if 1990 <= n <= 2100 or n in (1, 2, 3, 4) or n == 0:
            continue
        d = len(m.split(".")[1]) if "." in m else 0
        if not any(abs(round(v, d) - n) < 10 ** -d / 2 + 1e-9 or abs(v - n) <= 0.051 * max(1, n) * (d == 0 and n >= 100) for v in vals):
            bad.append(m)
    return bad


def bridge_template(pk: dict) -> str:
    b, u = pk["bridge"], pk.get("unit") or 1e6
    parts = []
    if b.get("non_operating") is not None:
        parts.append(f"Non-operating {_b(b['non_operating'], u)}" + (f" vs {_b(b['non_operating_prior'], u)} a year ago" if b.get("non_operating_prior") is not None else "")
                     + (f" ({b['non_operating_share_of_pretax_pct']:.0f} % of pretax)" if b.get("non_operating_share_of_pretax_pct") is not None else ""))
    fcf, fp = (b.get("fcf_company"), b.get("fcf_company_prior")) if b.get("fcf_company_prior") is not None else (b.get("fcf"), b.get("fcf_prior"))
    if fcf is not None:
        cx = pk["lines"].get("capex") or {}
        parts.append(f"FCF {_b(fcf, u)}" + (f" vs {_b(fp, u)}" if fp is not None else "")
                     + (f", capex {_b(abs(cx['cur']), u)} vs {_b(abs(cx['prior']), u)}" if cx.get("prior") is not None else ""))
    out = "; ".join(parts) + "." if parts else ""
    if pk["one_offs"] and len(out) + 20 < MAX:
        o = pk["one_offs"][0]
        room = MAX - len(out) - 1
        out += " " + (o if len(o) <= room else o[:room - 1].rsplit(" ", 1)[0] + "…")
    return out.strip()


def bridge_note(pk: dict, ask) -> str:
    keep = {k: pk[k] for k in ("bridge", "one_offs", "lines")}
    keep["highlights"] = pk.get("highlights", [])[:12]
    p = BRIDGE_PROMPT.format(ticker=pk["ticker"], date=pk["report_date"], unit="millions" if (pk.get("unit") or 1e6) == 1e6 else "thousands",
                             packet=json.dumps(keep, default=str))
    try:
        txt = " ".join(ask(pk["ticker"], p, model=BRIDGE_MODEL).split())
        bad = numbers_ok(txt, pk) + (["meta talk"] if META.search(txt) else [])
        if len(txt) > MAX or bad:   # one retry, told exactly what failed
            why = (f"it was {len(txt)} characters (limit 260)" if len(txt) > MAX else "") + (f"; these numbers are not in the JSON: {bad}" if bad else "")
            txt = " ".join(ask(pk["ticker"], p + f"\n\nYour last draft failed because {why}. Rewrite it:\n{txt}", model=BRIDGE_MODEL).split())
        if len(txt) > MAX or numbers_ok(txt, pk) or META.search(txt):
            txt = ""
    except Exception:  # noqa: BLE001 — template from the deterministic bridge
        txt = ""
    return txt or bridge_template(pk)


def _insert(conn, t: str, q: str, body: str, as_of, src: str | None = None) -> None:
    tags = ["earnings", src or f"src:transcript:{t}:{q}"]
    conn.execute("""INSERT INTO fund_score_notes (ticker, as_of, body, author, tags, linked_snapshot_as_of)
                    SELECT %s, %s, %s, 'auto', %s::jsonb, %s
                    WHERE NOT EXISTS (SELECT 1 FROM fund_score_notes WHERE ticker = %s AND body = %s)""",
                 (t, as_of, body, json.dumps(tags), as_of, t, body))


def _due_8k(conn) -> list[dict]:
    """Universe reports in the last LOOKBACK_DAYS (before today) without an 8-K note; no_release packets retried ≤ 4 runs."""
    import earnings_packet
    conn.execute(earnings_packet.DDL)
    return rows(conn, """
        SELECT DISTINCT e.ticker, e.report_date FROM public.earnings_calendar e
        JOIN fmp_fundamentals f ON f.ticker = e.ticker
        LEFT JOIN watchlist_sync.earnings_packets p ON p.ticker = e.ticker AND p.report_date = e.report_date
        WHERE e.report_date BETWEEN CURRENT_DATE - %s AND CURRENT_DATE - 1
          AND NOT COALESCE(p.status = 'dup' OR p.status = 'no_release' AND p.tries >= 4, false)
          AND NOT EXISTS (SELECT 1 FROM fund_score_notes n WHERE n.ticker = e.ticker
                          AND n.tags @> jsonb_build_array('src:8k:' || e.ticker || ':' || e.report_date::text))
        ORDER BY e.report_date, e.ticker""", (LOOKBACK_DAYS,))


def run_8k(conn, ask, dry: bool = False, only: str | None = None) -> int:
    import earnings_packet
    n = 0
    for r in _due_8k(conn):
        t, rd = r["ticker"], r["report_date"]
        if only and t != only:
            continue
        x = _reaction(conn, t, rd)
        if not x:
            continue   # first close after the report not in yet → next run
        try:
            pk = earnings_packet.build(conn, t, rd)
        except Exception as e:  # noqa: BLE001 — one bad filing must not stop the rest
            conn.rollback()
            print(f"  packet {t} {rd}: {str(e)[:120]}")
            continue
        if not pk or not pk["bridge"].get("revenue") and not pk["bridge"].get("operating_income"):
            continue   # no 8-K yet, or a release without a parsable income statement → the transcript path covers it
        x = pk["reaction"]   # timed off the 8-K filing date (the calendar date can be a stale vendor date)
        if not x:
            continue
        v1 = rows(conn, """SELECT 1 FROM fund_score_notes WHERE ticker = %s AND author = 'auto' AND as_of BETWEEN %s AND %s::date + 7
                           AND tags::text LIKE '%%src:transcript:%%' LIMIT 1""", (t, rd, rd))
        a, b = (None if v1 else numbers_note_8k(pk, x)), bridge_note(pk, ask)   # a v1 numbers note already covers the move
        src = f"src:8k:{t}:{rd}"
        if dry:
            print(f"{t} {rd} (8-K {pk['filed']})\n  {a}\n  {b}")
        else:
            if a:
                _insert(conn, t, "", a, x["to"], src)
            if b:
                _insert(conn, t, "", b, x["to"], src)
            conn.commit()
        n += 1
    return n


def run(conn, ask, dry: bool = False) -> int:
    """Write due notes; returns how many reports got notes. `ask(ticker, prompt, model=…) -> str` = transcripts._summ_note."""
    n = run_8k(conn, ask, dry)
    for r in _due(conn):
        x = _reaction(conn, r["ticker"], r["report_date"])
        if not x:
            continue   # first close after the report not in yet → next run
        has_8k = rows(conn, """SELECT 1 FROM fund_score_notes WHERE ticker = %s AND tags @> jsonb_build_array(%s::text) LIMIT 1""",
                      (r["ticker"], f"src:8k:{r['ticker']}:{r['report_date']}"))
        a, b = (None if has_8k else numbers_note(r, x)), call_note(r, ask)
        if dry:
            print(f"{r['ticker']} {r['quarter']}\n  {a}\n  {b}")
        else:
            if a:
                _insert(conn, r["ticker"], r["quarter"], a, x["to"])
            _insert(conn, r["ticker"], r["quarter"], b, x["to"])
            conn.commit()
        n += 1
    return n


if __name__ == "__main__":
    import transcripts
    with connect() as c:
        if "--8k" in sys.argv:   # one ticker's 8-K notes: --8k GOOGL [--print]
            print(f"8-K notes: {run_8k(c, transcripts._summ_note, dry='--print' in sys.argv, only=sys.argv[sys.argv.index('--8k') + 1].upper())}")
        else:
            print(f"earnings notes: {run(c, transcripts._summ_note, dry='--print' in sys.argv)}")
