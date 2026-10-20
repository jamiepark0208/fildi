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
    seen: set[str] = set()
    for qid, qtype, t, d, meta in open_q:
        if qid in seen or qtype.startswith("advisory"):
            continue
        seen.add(qid)
        if qtype in EXTRA_RESOLVERS:   # A129 v5 OpenJev question types
            r = EXTRA_RESOLVERS[qtype](conn, t, d, meta)
            if r is None:
                continue
            y, info = r
            conn.execute("""UPDATE watchlist_sync.forecast_ledger SET outcome = %s, resolved_at = now(), meta = meta || %s
                            WHERE question_id = %s AND outcome IS NULL""", (y, json.dumps(info), qid))
            done += 1
            continue
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


# ---------- A129 v5 resolvers (OpenJev question types; pure rules tested in tests/test_openjev_local.py) ----------
def _window(conn, t: str, start: dt.date, end: dt.date) -> list[tuple[dt.date, float, float]]:
    """(date, close, low) for start < date ≤ end, LSEG first."""
    for table in ("lseg_research.daily_history", "prices_historical"):
        rows = conn.execute(f"""SELECT date, close::float, COALESCE(low, close)::float FROM {table}
                                WHERE ticker = %s AND date > %s AND date <= %s AND close > 0 ORDER BY date""",
                            (t, start, end)).fetchall()
        if rows:
            return rows
    return []


def _has_bar(conn, t: str, d: dt.date) -> bool:
    c = _close_on_or_before(conn, t, d)
    return bool(c)


def touched(lows: list[float], strike: float) -> bool:
    return any(x <= strike for x in lows)


def dropped(closes_: list[float], threshold: float) -> bool:
    return any(x <= threshold for x in closes_)


def moved_toward(fv: float, pt0: float, pt1: float) -> bool:
    return abs(fv - pt1) < abs(fv - pt0)


def _r_touch(conn, t, d, m):
    if not _has_bar(conn, t, d):
        return None
    w = _window(conn, t, dt.date.fromisoformat(m["from"]), d)
    return (touched([x[2] for x in w], float(m["strike"])), {"min_low": min(x[2] for x in w)}) if w else None


def _r_direction(conn, t, d, m):
    c = _close_on_or_before(conn, t, d)
    return (c[0] > float(m["spot"]), {"close": c[0], "close_date": str(c[2])}) if c else None


def _r_drop(conn, t, d, m):
    if not _has_bar(conn, t, d):
        return None
    w = _window(conn, t, dt.date.fromisoformat(m["from"]), d)
    return (dropped([x[1] for x in w], float(m["threshold"])), {"min_close": min(x[1] for x in w)}) if w else None


def _r_disagree(conn, t, d, m):
    c = _close_on_or_before(conn, t, d)
    if not c:
        return None
    up = c[0] > float(m["spot"])
    return (up == bool(m["fund_up"]), {"close": c[0], "ret": round(c[0] / float(m["spot"]) - 1, 4)})


def _r_earnings(conn, t, d, m):
    rd = dt.date.fromisoformat(m["report_date"])
    r = conn.execute("""SELECT move_pct::float FROM lseg_research.earnings_moves WHERE ticker = %s
                        AND report_date BETWEEN %s AND %s ORDER BY report_date LIMIT 1""",
                     (t, rd - dt.timedelta(days=1), rd + dt.timedelta(days=1))).fetchone()
    if not r:
        return None
    mv = abs(r[0]) / 100   # move_pct is in percent
    return (mv > float(m["implied"]), {"realized": round(mv, 4)})


def _r_fvpt(conn, t, d, m):
    r = conn.execute("""SELECT value, obs_date FROM lseg_research.starmine_history WHERE ticker = %s AND metric = 'pt_mean'
                        AND obs_date <= %s ORDER BY obs_date DESC LIMIT 1""", (t, d)).fetchone()
    if not r or r[1] < d - dt.timedelta(days=10):
        return None
    return (moved_toward(float(m["fv"]), float(m["pt0"]), float(r[0])), {"pt1": r[0], "pt1_date": str(r[1])})


def _r_recmed(conn, t, d, m):
    rets = {}
    for p in m.get("picks", []):
        c = _close_on_or_before(conn, p["ticker"], d)
        if not c or p.get("premium") is None:
            return None
        rets[p["ticker"]] = (float(p["premium"]) - max(0.0, float(p["strike"]) - c[0])) / float(p["strike"])
    if t not in rets or len(rets) < 3:
        return None
    med = sorted(rets.values())[len(rets) // 2]
    return (rets[t] > med, {"ret": round(rets[t], 4), "median": round(med, 4)})


def _r_index21(conn, t, d, m):
    """house_view.py (S057): index_up_21d = close at resolves_on > start close; index_tail_21d = any close in the window ≤ 0.95 × start."""
    if not _has_bar(conn, t, d):
        return None
    w = _window(conn, t, dt.date.fromisoformat(m["from"]), d)
    if not w:
        return None
    s = float(m["start_close"])
    if m.get("kind") == "tail":
        return (min(x[1] for x in w) <= 0.95 * s, {"min_close": min(x[1] for x in w)})
    return (w[-1][1] > s, {"close": w[-1][1]})


EXTRA_RESOLVERS = {"index_up_21d": _r_index21, "index_tail_21d": _r_index21, "strike_touch": _r_touch, "direction_5d": _r_direction, "direction_20d": _r_direction,
                   "drop_2sigma": _r_drop, "score_disagree": _r_disagree, "earnings_vs_implied": _r_earnings,
                   "fv_vs_pt": _r_fvpt, "rec_beats_median": _r_recmed}


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


def paired_vs_baseline(conn, forecaster: str = "openjev:local-26b", n_boot: int = 2000, seed: int = 7) -> list[dict]:
    """Per qtype: Brier(forecaster) − Brier(baseline) on the same resolved questions, bootstrap 90 % CI.
    Negative = forecaster better. Baseline = the non-openjev forecaster logged for the same question_id."""
    import random
    rows = conn.execute("""SELECT DISTINCT ON (question_id, forecaster) question_id, qtype, forecaster, prob, outcome
                           FROM watchlist_sync.forecast_ledger WHERE outcome IS NOT NULL
                           ORDER BY question_id, forecaster, made_at DESC""").fetchall()
    by: dict[str, dict] = {}
    for qid, qt, f, p, y in rows:
        by.setdefault(qid, {"qtype": qt, "f": {}})["f"][f] = (float(p), bool(y))
    groups: dict[tuple[str, str], list[float]] = {}
    for q in by.values():
        if forecaster not in q["f"]:
            continue
        p, y = q["f"][forecaster]
        for b, (bp, _) in q["f"].items():
            if b == forecaster or b.startswith("openjev:"):
                continue
            groups.setdefault((q["qtype"], b), []).append((p - y) ** 2 - (bp - y) ** 2)
    rnd, out = random.Random(seed), []
    for (qt, b), d in sorted(groups.items()):
        means = sorted(sum(rnd.choice(d) for _ in d) / len(d) for _ in range(n_boot))
        out.append({"qtype": qt, "baseline": b, "n": len(d), "brier_diff": sum(d) / len(d),
                    "ci90": (means[int(0.05 * n_boot)], means[int(0.95 * n_boot)])})
    return out



def log_pythia(conn, now: dt.datetime | None = None) -> int:
    """A124 — Ollama local forecaster on SPY/QQQ up-week (forecaster=pythia). Soft-fail if Ollama down."""
    import urllib.request
    now = now or dt.datetime.now(PT)
    today = now.astimezone(PT).date()
    if today.weekday() > 4:
        return 0
    fri = week_friday(today)
    n = 0
    for t in INDEXES:
        prompt = (
            f"Reply with ONLY a JSON object {{\"p\": <float 0-1>}} — probability that {t} "
            f"closes the week ending {fri} above last Friday's close. No prose."
        )
        try:
            req = urllib.request.Request(
                "http://127.0.0.1:11434/api/generate",
                data=json.dumps({"model": "llama3.2", "prompt": prompt, "stream": False, "format": "json"}).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=45) as resp:
                body = json.loads(resp.read().decode())
            raw = body.get("response") or "{}"
            try:
                parsed = json.loads(raw) if isinstance(raw, str) else raw
            except json.JSONDecodeError:
                continue
            p = float(parsed.get("p", parsed.get("prob", -1)))
            if not (0 <= p <= 1):
                continue
            qid = f"upweek:{t}:{fri}"
            q = f"Will {t} close the week of {fri} above last week's close?"
            conn.execute(UPSERT, (qid, q, "index_up_week", t, "pythia", round(p, 4), now, today, fri,
                                  json.dumps({"model": body.get("model") or "llama3.2", "src": "ollama"})))
            n += 1
        except Exception as e:
            print(f"pythia: skip {t} ({e})", file=sys.stderr)
            continue
    if n:
        conn.commit()
    return n


def run_after_pm_alerts(conn) -> None:
    """Hook for pm_alerts.py: log today's questions + resolve past ones. Never raises."""
    try:
        conn.execute(DDL)
        conn.commit()
        log(conn)
        try:
            log_pythia(conn)
        except Exception as e:
            print(f"forecast_ledger: pythia skipped ({e})", file=sys.stderr)
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
    if "--pythia" in sys.argv:
        print("pythia rows:", log_pythia(conn))
    if "--resolve" in sys.argv:
        print("resolved questions:", resolve(conn))
    if "--report" in sys.argv:
        n_all, n_res = conn.execute("""SELECT count(DISTINCT question_id), count(DISTINCT question_id) FILTER (WHERE outcome IS NOT NULL)
                                       FROM watchlist_sync.forecast_ledger""").fetchone()
        print(f"questions {n_all} · resolved {n_res}")
        for r in report(conn):
            print(f"{r['qtype']:15} {r['forecaster']:14} n={r['n']:4} brier={r['brier']:.3f} pred {r['pred']:.0%} real {r['real']:.0%}")
        for r in paired_vs_baseline(conn):
            lo, hi = r["ci90"]
            print(f"openjev vs {r['baseline']:15} {r['qtype']:20} n={r['n']:4} Δbrier={r['brier_diff']:+.3f} "
                  f"90% CI [{lo:+.3f}, {hi:+.3f}]")


if __name__ == "__main__":
    main()
