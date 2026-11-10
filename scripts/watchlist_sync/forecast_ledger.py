"""Forecast ledger (A129 OpenJev / A124 Pythia / A74 calibration; Claude 10-16).

One table of question · forecaster · probability · outcome, so any forecaster (market odds today, OpenJev next)
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
import math
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


EARNINGS_UP_BASE = 0.48
_SKEW_DELTA_PUT, _SKEW_DELTA_CALL, _SKEW_DELTA_BAND = -0.25, 0.25, 0.05


def clip_prob(p: float, lo: float = 0.35, hi: float = 0.65) -> float:
    return max(lo, min(hi, p))


def starmine_up_prob(pred_surprise_pct: float | None) -> tuple[float, dict]:
    if pred_surprise_pct is None:
        return clip_prob(0.5), {"pred_surprise_pct_fq1": None}
    p = 1 / (1 + math.exp(-0.08 * pred_surprise_pct))
    return clip_prob(p), {"pred_surprise_pct_fq1": round(float(pred_surprise_pct), 4)}


def skew_up_prob(skew_vol_pts: float, median_vol_pts: float) -> tuple[float, dict]:
    """A308 / S127 forward: higher put-minus-call skew → lower P(reaction up)."""
    p = 0.5 - 2 * (float(skew_vol_pts) - float(median_vol_pts))
    return clip_prob(p), {"skew_vol_pts": round(float(skew_vol_pts), 4),
                          "skew_median_vol_pts": round(float(median_vol_pts), 4)}


def _vol_pts(iv: float) -> float:
    return iv * 100.0 if iv < 3 else iv


def _pick_delta_leg(rows: list[tuple], side: str, target: float) -> float | None:
    """rows: (side, delta, iv, oi, strike) — best quote by |delta−target| within band."""
    best = None
    for s, delta, iv, oi, _k in rows:
        if s != side or delta is None or iv is None or iv <= 0:
            continue
        dist = abs(float(delta) - target)
        if dist > _SKEW_DELTA_BAND:
            continue
        key = (dist, -(oi or 0))
        if best is None or key < best[0]:
            best = (key, _vol_pts(float(iv)))
    return None if best is None else best[1]


def skew_25x25_vol_pts(legs: list[tuple]) -> float | None:
    """25Δ put IV − 25Δ call IV in vol points (A308 spec)."""
    put_iv = _pick_delta_leg(legs, "put", _SKEW_DELTA_PUT)
    call_iv = _pick_delta_leg(legs, "call", _SKEW_DELTA_CALL)
    if put_iv is None or call_iv is None:
        return None
    return put_iv - call_iv


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


_UPCOMING_EARNINGS = """SELECT ticker, MIN(d)::date AS report_date FROM (
  SELECT UPPER(ticker) AS ticker, event_date AS d FROM lseg_research.events
    WHERE event_type = 'EarningsReleases' AND event_date BETWEEN %s AND %s
  UNION ALL
  SELECT UPPER(ticker), report_date::date FROM earnings_calendar
    WHERE report_date::date BETWEEN %s AND %s AND is_confirmed = true
) x GROUP BY ticker ORDER BY 2, 1"""


def _upcoming_earnings(conn, today: dt.date, horizon: int = 7) -> list[tuple[str, dt.date]]:
    end = today + dt.timedelta(days=horizon)
    return conn.execute(_UPCOMING_EARNINGS, (today, end, today, end)).fetchall()


def _pred_surprise(conn, ticker: str, as_of: dt.date) -> float | None:
    r = conn.execute("""SELECT pred_surprise_pct_fq1::float FROM lseg_research.signals_daily
                        WHERE ticker = %s AND as_of <= %s AND pred_surprise_pct_fq1 IS NOT NULL
                        ORDER BY as_of DESC LIMIT 1""", (ticker, as_of)).fetchone()
    return float(r[0]) if r and r[0] is not None else None


def _skew_survey_legs(conn, ticker: str, as_of: dt.date, report_date: dt.date) -> tuple[float | None, dict]:
    """Skew from optlab.skew_survey on `as_of`, expiry = nearest after the report."""
    r = conn.execute("""SELECT side, delta::float, iv::float, COALESCE(oi, 0), strike::float, expiry::date
                        FROM optlab.skew_survey WHERE ticker = %s AND as_of = %s AND expiry > %s""",
                     (ticker, as_of, report_date)).fetchall()
    if not r:
        return None, {"skew_as_of": str(as_of), "skew_src": "optlab.skew_survey", "skew_missing": "no_ladder_rows"}
    by_exp: dict[dt.date, list] = {}
    for row in r:
        by_exp.setdefault(row[5], []).append(row[:5])
    expiry = min(by_exp)
    legs = []
    for s, d, iv, oi, k in by_exp[expiry]:
        side = "put" if str(s).lower().startswith("p") else "call"
        legs.append((side, d, iv, oi, k))
    skew = skew_25x25_vol_pts(legs)
    meta = {"skew_as_of": str(as_of), "skew_expiry": str(expiry), "skew_src": "optlab.skew_survey"}
    if skew is None:
        meta["skew_missing"] = "no_25d_legs"
        return None, meta
    if abs(skew) > 40:
        meta["skew_missing"] = "skew_outlier"
        return None, meta
    meta["skew_vol_pts"] = round(skew, 4)
    return skew, meta


def _earnings_up_rows(conn, now: dt.datetime, today: dt.date) -> list[tuple]:
    upcoming = _upcoming_earnings(conn, today)
    if not upcoming:
        return []
    skew_by: dict[str, tuple[float | None, dict]] = {}
    signal_days: dict[str, dt.date] = {}
    for ticker, report_date in upcoming:
        day_before = report_date - dt.timedelta(days=1)
        signal_days[ticker] = day_before
        if today < day_before:
            skew_by[ticker] = (None, {"skew_as_of": str(day_before), "skew_missing": "pending_day_before"})
        else:
            skew_by[ticker] = _skew_survey_legs(conn, ticker, day_before, report_date)
    medians: dict[dt.date, float] = {}
    for sig in set(signal_days.values()):
        vals = [v[0] for t, v in skew_by.items() if signal_days[t] == sig and v[0] is not None]
        if vals:
            vals.sort()
            medians[sig] = vals[len(vals) // 2]
    out: list[tuple] = []
    for ticker, report_date in upcoming:
        qid = f"earnup:{ticker}:{report_date}"
        question = f"Will {ticker} earnings reaction (LSEG move_pct) be up on {report_date}?"
        sig = signal_days[ticker]
        ps = _pred_surprise(conn, ticker, today)
        skew, sk_meta = skew_by[ticker]
        base_meta = {"report_date": str(report_date), "signal_day": str(sig)}
        if skew is None or sig not in medians:
            base_meta["skew_missing"] = sk_meta.get("skew_missing", "no_median")
        out.append((qid, question, "earnings_up", ticker, "base_rate", EARNINGS_UP_BASE, now, today, report_date,
                    json.dumps({**base_meta, "src": "S127"})))
        sp, sm_meta = starmine_up_prob(ps)
        out.append((qid, question, "earnings_up", ticker, "starmine", round(sp, 4), now, today, report_date,
                    json.dumps({**base_meta, **sm_meta})))
        if skew is None or sig not in medians:
            continue
        sp_sk, sk_pmeta = skew_up_prob(skew, medians[sig])
        out.append((qid, question, "earnings_up", ticker, "skew", round(sp_sk, 4), now, today, report_date,
                    json.dumps({**base_meta, **sk_meta, **sk_pmeta})))
    return out


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
    rows += _earnings_up_rows(conn, now, today)
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


def _meta_dict(meta) -> dict:
    if meta is None:
        return {}
    if isinstance(meta, str):
        return json.loads(meta) if meta else {}
    return dict(meta)


def _resolve_one(conn, qid: str, qtype: str, t: str, d: dt.date, meta) -> bool:
    """Resolve one question. Raises on corrupt meta; returns False if not yet resolvable."""
    meta = _meta_dict(meta)
    if qtype in EXTRA_RESOLVERS:   # A129 v5 OpenJev question types
        r = EXTRA_RESOLVERS[qtype](conn, t, d, meta)
        if r is None:
            return False
        y, info = r
        conn.execute("""UPDATE watchlist_sync.forecast_ledger SET outcome = %s, resolved_at = now(), meta = meta || %s
                        WHERE question_id = %s AND outcome IS NULL""", (y, json.dumps(info), qid))
        return True
    c = _close_on_or_before(conn, t, d)
    if not c:
        return False
    if qtype in ("put_otm", "model_pick_otm", "sim_put_otm"):
        y = put_otm(c[0], float(meta["strike"]))
        info = {"close": c[0], "close_src": c[1], "close_date": str(c[2])}
    else:  # index_up_week: last close of the week vs last close before its Monday
        monday = d - dt.timedelta(days=d.weekday())
        prev = _close_on_or_before_any(conn, t, monday - dt.timedelta(days=1))
        if not prev:
            return False
        y = c[0] > prev[0]
        info = {"close": c[0], "prev_close": prev[0], "close_src": c[1]}
    conn.execute("""UPDATE watchlist_sync.forecast_ledger SET outcome = %s, resolved_at = now(), meta = meta || %s
                    WHERE question_id = %s AND outcome IS NULL""", (y, json.dumps(info), qid))
    return True


def resolve(conn, now: dt.datetime | None = None) -> int:
    """Resolve past questions. A258: SAVEPOINT per question so one bad meta cannot abort the batch."""
    today = (now or dt.datetime.now(PT)).astimezone(PT).date()
    done = 0
    open_q = conn.execute("""SELECT DISTINCT question_id, qtype, subject, resolves_on, meta FROM watchlist_sync.forecast_ledger
                             WHERE outcome IS NULL AND resolves_on < %s""", (today,)).fetchall()
    seen: set[str] = set()
    for qid, qtype, t, d, meta in open_q:
        if qid in seen or qtype.startswith("advisory"):
            continue
        seen.add(qid)
        m = _meta_dict(meta)
        if m.get("resolve_error"):
            continue  # parked permanently after a prior corrupt-meta failure
        sp = f"fl_r_{done}_{abs(hash(qid)) % 10_000_000}"
        try:
            conn.execute(f"SAVEPOINT {sp}")
            if _resolve_one(conn, qid, qtype, t, d, m):
                done += 1
            conn.execute(f"RELEASE SAVEPOINT {sp}")
        except Exception as e:
            conn.execute(f"ROLLBACK TO SAVEPOINT {sp}")
            err = f"{type(e).__name__}: {e}"
            print(f"forecast_ledger.resolve skip {qid}: {err}", file=sys.stderr)
            # Park the question so the same corrupt row cannot abort every night (A258).
            try:
                conn.execute("""UPDATE watchlist_sync.forecast_ledger SET meta = meta || %s
                                WHERE question_id = %s AND outcome IS NULL""",
                             (json.dumps({"resolve_error": err[:500]}), qid))
            except Exception as e2:
                print(f"forecast_ledger.resolve could not park {qid}: {e2}", file=sys.stderr)
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


def _r_earnings_up(conn, t, d, m):
    rd = dt.date.fromisoformat(m["report_date"])
    r = conn.execute("""SELECT move_pct::float FROM lseg_research.earnings_moves WHERE ticker = %s
                        AND report_date BETWEEN %s AND %s ORDER BY report_date LIMIT 1""",
                     (t, rd - dt.timedelta(days=1), rd + dt.timedelta(days=1))).fetchone()
    if not r:
        return None
    move = float(r[0])
    return (move > 0, {"move_pct": round(move, 4)})


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


def _aligned_closes(conn, ticker: str, lo: dt.date, hi: dt.date) -> list[tuple]:
    for table in ("lseg_research.daily_history", "prices_historical"):
        rows = conn.execute(
            f"""SELECT date, close::float FROM {table}
                WHERE ticker = %s AND date >= %s AND date <= %s AND close > 0 ORDER BY date""",
            (ticker, lo, hi)).fetchall()
        if len(rows) >= 40:
            return rows
    return rows


def _r_abn_1s_5d(conn, t, d, m):
    """A261: |5-day beta-residual return| > 1σ. Meta carries the start session (`from`) and horizon."""
    from openjev_shortlist import abn_exceeds_1s
    start = dt.date.fromisoformat(m["from"])
    horizon = int(m.get("horizon") or 5)
    lo = start - dt.timedelta(days=140)
    stock = _aligned_closes(conn, t, lo, d)
    spy = {r[0]: r[1] for r in _aligned_closes(conn, "SPY", lo, d)}
    xs, xm = [], []
    for day, px in stock:
        if day in spy:
            xs.append(px)
            xm.append(spy[day])
    flag = abn_exceeds_1s(xs, xm, horizon=horizon)
    if flag is None:
        return None
    return flag, {"n": len(xs), "horizon": horizon}


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


def _r_structure(conn, t, d, m):
    """structures.py (A192): pnl at the front expiry close = net credit + Σ qty × intrinsic (+ share move for collars) > 0."""
    c = _close_on_or_before(conn, t, d)
    if not c:
        return None
    S = c[0]
    pnl = float(m["credit"])
    for lg in m["legs"]:
        k = float(lg["strike"])
        pnl += lg["qty"] * (max(S - k, 0) if lg["side"] == "call" else max(k - S, 0))
    if m.get("stock"):
        pnl += S - float(m["spot"])
    return (pnl > 0, {"close": S, "pnl_per_share": round(pnl, 3)})


def _r_long_call_ts(conn, t, d, m):
    """s171_paper.py (A244 S171): long call sold at the day-`d` Schwab bid (latest snapshot ≤ d after entry).
    outcome = call P&L > same-Δ stock P&L (Δ × ΔS), both per $ debit. No quote → not resolvable yet; after 5 days
    without one, mark at intrinsic and flag it (never silently)."""
    entry = dt.date.fromisoformat(m["entry_date"])
    q = conn.execute("""SELECT as_of, bid::float, spot::float FROM option_chain_history
                        WHERE ticker = %s AND side = 'call' AND expiry = %s AND strike = %s AND source = 'schwab'
                          AND as_of > %s AND as_of <= %s AND bid IS NOT NULL
                        ORDER BY as_of DESC LIMIT 1""", (t, m["expiry"], m["strike"], entry, d)).fetchone()
    c = _close_on_or_before(conn, t, d)
    if not c:
        return None
    S1, S0, debit, delta = c[0], float(m["spot"]), float(m["debit"]), float(m["delta"])
    if q:
        exit_px, fill = q[1], f"schwab bid {q[0]}"
    elif (dt.date.today() - d).days > 5:
        exit_px, fill = max(S1 - float(m["strike"]), 0.0), "intrinsic (no quote)"
    else:
        return None
    pnl, pnl_d = exit_px - debit, delta * (S1 - S0)
    return (pnl > pnl_d, {"close": S1, "exit_px": round(exit_px, 4), "exit_fill": fill,
                          "pnl_per_share": round(pnl, 4), "ret_call": round(pnl / debit, 4),
                          "ret_delta_stock": round(pnl_d / debit, 4), "vs_delta": round((pnl - pnl_d) / debit, 4)})


EXTRA_RESOLVERS = {"sim_structure": _r_structure, "long_call_ts": _r_long_call_ts,"index_up_21d": _r_index21, "index_tail_21d": _r_index21, "strike_touch": _r_touch, "direction_5d": _r_direction, "direction_20d": _r_direction,
                   "drop_2sigma": _r_drop, "score_disagree": _r_disagree, "earnings_vs_implied": _r_earnings, "earnings_up": _r_earnings_up,
                   "fv_vs_pt": _r_fvpt, "rec_beats_median": _r_recmed, "abn_1s_5d": _r_abn_1s_5d}


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



def run_after_pm_alerts(conn) -> None:
    """Hook for pm_alerts.py: log today's questions + resolve past ones. Never raises."""
    try:
        conn.execute(DDL)
        conn.commit()
        log(conn)
        # A124 Pythia hook retired 10-26 (bare llama3.2 prompt, no inputs, Ollama never installed; 0 rows ever).
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
        for r in paired_vs_baseline(conn):
            lo, hi = r["ci90"]
            print(f"openjev vs {r['baseline']:15} {r['qtype']:20} n={r['n']:4} Δbrier={r['brier_diff']:+.3f} "
                  f"90% CI [{lo:+.3f}, {hi:+.3f}]")


if __name__ == "__main__":
    main()
