"""Forecast ledger (A129 OpenJev / A124 Pythia / A74 calibration; Claude 10-16).

One table of question · forecaster · probability · outcome, so any forecaster (market odds today, OpenJev / Pythia next)
is scored on the same resolved questions with a Brier score. No new pricing math: every probability is reused.

  put_otm         open short puts in the live book · market_iv = 1 − pm_alerts P(assign)
  model_pick_otm  new Model List put picks          · model_winrate = contract.win.rate (S007 table)
                                                     · market_delta = 1 − contract.win.delta
  index_up_week   SPY / QQQ up this week (Fri→Fri)  · base_rate = historical weekly up-rate (lseg daily_history)

Resolution (day after resolves_on, so the close is final): official close from lseg_research.daily_history, else
prices_historical. Put OTM when close ≥ strike (same rule as scoreboard.py). Brier uses each question's last forecast made
before resolves_on (expiry-day forecasts are near-certain and would flatter every forecaster).

    .venv/bin/python forecast_ledger.py --log        # today's questions (idempotent: one row per question/forecaster/day)
    .venv/bin/python forecast_ledger.py --resolve    # fill outcomes for past resolves_on
    .venv/bin/python forecast_ledger.py --report     # Brier per forecaster × qtype + reliability bins
    .venv/bin/python forecast_ledger.py --backfill   # seed from pm_alerts per-put odds stored since 10-15
Called at the end of every pm_alerts.py run (log + resolve, failures never break pm_alerts).
"""
from __future__ import annotations

import datetime as dt
import json
import sys
from zoneinfo import ZoneInfo

from build_plan import connect

PT = ZoneInfo("America/Los_Angeles")
INDEXES = ("SPY", "QQQ")

DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.forecast_ledger (
  id bigserial PRIMARY KEY,
  question_id text NOT NULL,
  question text NOT NULL,
  qtype text NOT NULL,
  subject text NOT NULL,
  forecaster text NOT NULL,
  prob real NOT NULL CHECK (prob >= 0 AND prob <= 1),
  made_at timestamptz NOT NULL,
  made_on date NOT NULL,
  resolves_on date NOT NULL,
  outcome boolean,
  resolved_at timestamptz,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (question_id, forecaster, made_on));
CREATE INDEX IF NOT EXISTS forecast_ledger_open ON watchlist_sync.forecast_ledger (resolves_on) WHERE outcome IS NULL;"""

UPSERT = """INSERT INTO watchlist_sync.forecast_ledger
  (question_id, question, qtype, subject, forecaster, prob, made_at, made_on, resolves_on, meta)
  VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
  ON CONFLICT (question_id, forecaster, made_on) DO UPDATE
  SET prob = excluded.prob, made_at = excluded.made_at, meta = excluded.meta
  WHERE watchlist_sync.forecast_ledger.outcome IS NULL AND excluded.made_at >= watchlist_sync.forecast_ledger.made_at"""


# ---------- pure helpers (tested) ----------

def brier(pairs: list[tuple[float, bool]]) -> float | None:
    return sum((p - float(y)) ** 2 for p, y in pairs) / len(pairs) if pairs else None


def put_otm(close: float, strike: float) -> bool:
    return close >= strike


def week_friday(d: dt.date) -> dt.date:
    return d + dt.timedelta(days=(4 - d.weekday()) % 7) if d.weekday() <= 4 else d + dt.timedelta(days=4 - d.weekday() + 7)


def weekly_up_rate(closes: list[tuple[dt.date, float]]) -> tuple[float, int]:
    """Share of calendar weeks whose last close beat the previous week's last close."""
    last: dict[tuple[int, int], float] = {}
    for d, c in sorted(closes):
        last[d.isocalendar()[:2]] = c
    vals = [last[k] for k in sorted(last)]
    ups = [b > a for a, b in zip(vals, vals[1:])]
    return (sum(ups) / len(ups), len(ups)) if ups else (0.5, 0)


def reliability(pairs: list[tuple[float, bool]], bins: int = 5) -> list[dict]:
    out = []
    for i in range(bins):
        lo, hi = i / bins, (i + 1) / bins
        b = [(p, y) for p, y in pairs if lo <= p < hi or (i == bins - 1 and p == 1.0)]
        if b:
            out.append({"bin": f"{lo:.1f}–{hi:.1f}", "n": len(b), "pred": sum(p for p, _ in b) / len(b),
                        "real": sum(y for _, y in b) / len(b)})
    return out


# ---------- DB ----------

def put_question(acct: str, t: str, k: float, e: str) -> tuple[str, str]:
    return f"put:{acct}:{t}:{k:g}:{e}", f"Will {t} {k:g}P ({acct}) expire OTM on {e}?"


def _rows_from_predictions(preds: list[dict], made_at: dt.datetime) -> list[tuple]:
    rows = []
    for x in preds:
        qid, q = put_question(x["account"], x["ticker"], float(x["strike"]), x["expiry"])
        rows.append((qid, q, "put_otm", x["ticker"], "market_iv", round(1 - float(x["p_assign"]), 4), made_at,
                     made_at.astimezone(PT).date(), x["expiry"],
                     json.dumps({"strike": float(x["strike"]), "account": x["account"], "src": "pm_alerts"})))
    return rows


def log(conn, now: dt.datetime | None = None) -> dict:
    now = now or dt.datetime.now(PT)
    today = now.astimezone(PT).date()
    rows: list[tuple] = []
    # 1. open puts: latest pm_alerts per-put odds
    r = conn.execute("""SELECT generated_at, payload->'predictions' FROM watchlist_sync.pm_alerts
                        WHERE payload ? 'predictions' ORDER BY generated_at DESC LIMIT 1""").fetchone()
    if r and r[1]:
        rows += _rows_from_predictions(r[1], r[0])
    # 2. new Model List put picks (latest run; held positions are already in #1)
    run = conn.execute("SELECT id, created_at FROM watchlist_sync.model_runs ORDER BY id DESC LIMIT 1").fetchone()
    if run:
        for t, c in conn.execute("""SELECT ticker, contract FROM watchlist_sync.model_items
                                    WHERE run_id = %s AND role IS NULL AND contract->>'type' = 'put'
                                      AND contract ? 'win'""", (run[0],)).fetchall():
            k, e, w = float(c["strike"]), c["expiry"], c["win"]
            if e < str(today):
                continue
            qid, q = f"pick:{t}:{k:g}:{e}", f"Will Model List pick {t} {k:g}P expire OTM on {e}?"
            meta = json.dumps({"strike": k, "run_id": run[0], "account": c.get("account")})
            if w.get("rate") is not None:
                rows.append((qid, q, "model_pick_otm", t, "model_winrate", float(w["rate"]), run[1], today, e, meta))
            if w.get("delta") is not None:
                rows.append((qid, q, "model_pick_otm", t, "market_delta", round(1 - abs(float(w["delta"])), 4), run[1], today, e, meta))
    # 3. SPY / QQQ up this week — historical base rate
    if today.weekday() <= 4:
        fri = week_friday(today)
        for t in INDEXES:
            closes = conn.execute("SELECT date, close::float FROM lseg_research.daily_history WHERE ticker = %s AND close > 0",
                                  (t,)).fetchall()
            p, n = weekly_up_rate(closes)
            if n:
                rows.append((f"upweek:{t}:{fri}", f"Will {t} close the week of {fri} above last week's close?", "index_up_week",
                             t, "base_rate", round(p, 4), now, today, fri, json.dumps({"weeks": n})))
    for row in rows:
        conn.execute(UPSERT, row)
    conn.commit()
    counts: dict[str, int] = {}
    for row in rows:
        counts[row[2]] = counts.get(row[2], 0) + 1
    return counts


def backfill(conn) -> int:
    n = 0
    for gen, preds in conn.execute("""SELECT DISTINCT ON ((generated_at AT TIME ZONE 'America/Los_Angeles')::date)
                                             generated_at, payload->'predictions' FROM watchlist_sync.pm_alerts
                                      WHERE payload ? 'predictions'
                                      ORDER BY (generated_at AT TIME ZONE 'America/Los_Angeles')::date, generated_at DESC""").fetchall():
        for row in _rows_from_predictions(preds or [], gen):
            conn.execute(UPSERT, row)
            n += 1
    conn.commit()
    return n


def _close_on_or_before(conn, t: str, d: dt.date) -> tuple[float, str, dt.date] | None:
    """Close on d (LSEG official first). If d was a market holiday (no SPY bar), the last close before it."""
    holiday = not conn.execute("SELECT 1 FROM prices_historical WHERE ticker = 'SPY' AND date = %s", (d,)).fetchone()
    for table in ("lseg_research.daily_history", "prices_historical"):
        r = conn.execute(f"""SELECT close::float, date FROM {table} WHERE ticker = %s AND date <= %s AND date > %s AND close > 0
                             ORDER BY date DESC LIMIT 1""", (t, d, d - dt.timedelta(days=5))).fetchone()
        if r and (r[1] == d or holiday):
            return r[0], table, r[1]
    return None


def resolve(conn, now: dt.datetime | None = None) -> int:
    today = (now or dt.datetime.now(PT)).astimezone(PT).date()
    done = 0
    open_q = conn.execute("""SELECT DISTINCT question_id, qtype, subject, resolves_on, meta FROM watchlist_sync.forecast_ledger
                             WHERE outcome IS NULL AND resolves_on < %s""", (today,)).fetchall()
    for qid, qtype, t, d, meta in open_q:
        c = _close_on_or_before(conn, t, d)
        if not c:
            continue
        if qtype in ("put_otm", "model_pick_otm"):
            y = put_otm(c[0], float(meta["strike"]))
            info = {"close": c[0], "close_src": c[1], "close_date": str(c[2])}
        else:  # index_up_week: last close of the week vs last close before its Monday
            monday = d - dt.timedelta(days=d.weekday())
            prev = _close_on_or_before_any(conn, t, monday - dt.timedelta(days=1))
            if not prev:
                continue
            y = c[0] > prev[0]
            info = {"close": c[0], "prev_close": prev[0], "close_src": c[1]}
        conn.execute("""UPDATE watchlist_sync.forecast_ledger SET outcome = %s, resolved_at = now(), meta = meta || %s
                        WHERE question_id = %s AND outcome IS NULL""", (y, json.dumps(info), qid))
        done += 1
    conn.commit()
    return done


def _close_on_or_before_any(conn, t: str, d: dt.date) -> tuple[float, str] | None:
    for table in ("lseg_research.daily_history", "prices_historical"):
        r = conn.execute(f"""SELECT close::float FROM {table} WHERE ticker = %s AND date <= %s AND date > %s AND close > 0
                             ORDER BY date DESC LIMIT 1""", (t, d, d - dt.timedelta(days=7))).fetchone()
        if r:
            return r[0], table
    return None


def report(conn) -> list[dict]:
    rows = conn.execute("""SELECT DISTINCT ON (question_id, forecaster) qtype, forecaster, prob, outcome
                           FROM watchlist_sync.forecast_ledger
                           WHERE outcome IS NOT NULL AND made_on < resolves_on
                           ORDER BY question_id, forecaster, made_at DESC""").fetchall()
    groups: dict[tuple[str, str], list[tuple[float, bool]]] = {}
    for qt, f, p, y in rows:
        groups.setdefault((qt, f), []).append((float(p), bool(y)))
    out = []
    for (qt, f), pairs in sorted(groups.items()):
        out.append({"qtype": qt, "forecaster": f, "n": len(pairs), "brier": brier(pairs),
                    "pred": sum(p for p, _ in pairs) / len(pairs), "real": sum(y for _, y in pairs) / len(pairs),
                    "bins": reliability(pairs)})
    return out


def run_after_pm_alerts(conn) -> None:
    """Hook for pm_alerts.py: log today's questions + resolve past ones. Never raises."""
    try:
        conn.execute(DDL)
        conn.commit()
        log(conn)
        resolve(conn)
    except Exception as e:  # ledger must never break the alerts run
        conn.rollback()
        print(f"forecast_ledger: skipped ({e})", file=sys.stderr)


def main() -> None:
    conn = connect()
    conn.execute(DDL)
    conn.commit()
    if "--backfill" in sys.argv:
        print("backfill rows:", backfill(conn))
    if "--log" in sys.argv:
        print("logged:", log(conn))
    if "--resolve" in sys.argv:
        print("resolved questions:", resolve(conn))
    if "--report" in sys.argv:
        n_all, n_res = conn.execute("""SELECT count(DISTINCT question_id), count(DISTINCT question_id) FILTER (WHERE outcome IS NOT NULL)
                                       FROM watchlist_sync.forecast_ledger""").fetchone()
        print(f"questions {n_all} · resolved {n_res}")
        for r in report(conn):
            print(f"{r['qtype']:15} {r['forecaster']:14} n={r['n']:4} brier={r['brier']:.3f} pred {r['pred']:.0%} real {r['real']:.0%}")


if __name__ == "__main__":
    main()
