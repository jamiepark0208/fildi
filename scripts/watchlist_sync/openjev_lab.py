"""OpenJev lab (A129 v2, Jamie 10-16): why are local-26B answers extreme, and which question form fixes it?

    .venv/bin/python openjev_lab.py --variants            # today's frozen batch × question variants (no outcomes)
    .venv/bin/python openjev_lab.py --backtest            # point-in-time states 09-08 → 10-05, known outcomes
    .venv/bin/python openjev_lab.py --summary             # print both result sets

Local only: the OpenJev server runs on 127.0.0.1; nothing leaves the Mac. Results → watchlist_sync.openjev_lab.

Variants (same frozen state, same event; only the question form / read options change):
  v0  current production wording (batched per ticker)
  v1  neutral wording + explicit noul criteria (yes = event happens / no = it doesn't)
  v1i v1 asked one question per request (no batching)
  v2  v1 + reference odds in the question (market-implied / historical base rate)
  v3  range: 'score' over probability buckets → expected p + p10/p90
  v1s v1 + samples=8 (averaged noise draws)
  v1t v1 + think=128 (short thought before the read)
  v1k v1 + steps=4 (more denoise passes)
  v4  deviation framing: 'is the TRUE probability HIGHER than the reference X%?' (noul;
      prob = P(higher), scored on direction-vs-baseline, not absolute level)
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import statistics
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import openjev_local as oj  # noqa: E402
from build_plan import connect  # noqa: E402

BUCKETS = ["0-10%", "10-30%", "30-50%", "50-70%", "70-90%", "90-100%"]
MIDS = [0.05, 0.20, 0.40, 0.60, 0.80, 0.95]
EDGES = [0.0, 0.10, 0.30, 0.50, 0.70, 0.90, 1.0]
VARIANTS = ("v0", "v1", "v1i", "v2", "v3", "v4", "v1s", "v1t", "v1k")
OPTS = {"v1s": {"samples": 8}, "v1t": {"think": 128}, "v1k": {"steps": 4}}
LAB_DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.openjev_lab (
  id bigserial PRIMARY KEY, run_at timestamptz NOT NULL DEFAULT now(), mode text NOT NULL, variant text NOT NULL,
  made_on date NOT NULL, question_id text NOT NULL, qtype text NOT NULL, subject text NOT NULL, prob real,
  p10 real, p90 real, baseline real, baseline_name text, outcome boolean, secs real, meta jsonb)"""
NEUTRAL_CRIT = {"true": "Yes: the event described happens.", "false": "No: the event described does not happen."}


# ---------- question forms ------------------------------------------------------------------------------------
def event_text(q: dict) -> str:
    """The plain event (production's ledger text is already neutral: 'Will X close above $K on D?')."""
    if q["qtype"] == "fv_vs_pt":
        m = q["meta"]
        return (f"Will the street consensus price target for {q['subject']} move closer to ${m['fv']:g} "
                f"(from ${m['pt0']:g}) by {q['resolves_on']}?")
    if q["qtype"] == "score_disagree":
        m = q["meta"]
        return f"Will {q['subject']} close {'above' if m['fund_up'] else 'below'} ${m['spot']:g} on {q['resolves_on']}?"
    return q["question"]


def ref_text(q: dict) -> str:
    b = q.get("baseline")
    if not b:
        return ""
    name, p = b
    label = {"market_iv": "options-market implied", "market_delta": "options-market implied (delta)",
             "base_rate": "historical base rate for this stock", "model_winrate": "fildi model win rate",
             "path_reflection": "options-implied (reflection rule)", "S018_base": "historical base rate",
             "model_rank": "fildi model rank", "coin": "no-information prior"}.get(name, name)
    return f" Reference: {label} probability is {p * 100:.0f}%."


def form(q: dict, variant: str) -> tuple[dict, str]:
    """→ (OpenJev question, how to read it: 'noul' | 'range' | 'v0')."""
    if variant == "v0":
        return q["oj"], "v0"
    ev = event_text(q)
    if variant == "v3":
        return {"type": "score", "instructions": f"How likely is this? {ev}", "criteria": BUCKETS}, "range"
    if variant == "v4":
        # Deviation framing (Muse 10-17): don't ask for the absolute probability — ask whether the
        # TRUE probability is HIGHER than the reference. prob = P(higher). Scored on direction.
        b = q.get("baseline")
        if not b or b[1] is None:
            return {"type": "noul", "instructions": ev, "criteria": NEUTRAL_CRIT}, "noul"
        name, bp = b
        label = {"market_iv": "options-market implied", "market_delta": "options-market implied (delta)",
                 "base_rate": "historical base rate for this stock", "model_winrate": "fildi model win rate",
                 "path_reflection": "options-implied (reflection rule)", "S018_base": "historical base rate",
                 "model_rank": "fildi model rank", "coin": "no-information prior"}.get(name, name)
        txt = (f"{ev} The {label} probability is {bp * 100:.0f}%. Given all the data above, "
               f"is the TRUE probability of this event HIGHER than {bp * 100:.0f}%?")
        return {"type": "noul", "instructions": txt,
                "criteria": {"true": "Yes: the true probability is higher than the reference.",
                             "false": "No: the true probability is at or below the reference."}}, "noul"
    txt = ev + (ref_text(q) if variant == "v2" else "")
    return {"type": "noul", "instructions": txt, "criteria": NEUTRAL_CRIT}, "noul"


def read(q: dict, how: str, a: dict | None) -> tuple[float | None, float | None, float | None]:
    if not a:
        return None, None, None
    if how == "v0":
        return oj.p_from_answer(q, a), None, None
    if how == "noul":
        return a.get("noul"), None, None
    return range_stats([float((a.get("probabilities") or {}).get(str(i), 0.0)) for i in range(len(BUCKETS))])


def range_stats(ps: list[float]) -> tuple[float | None, float | None, float | None]:
    """Bucket distribution → expected probability + p10 / p90 (linear inside a bucket)."""
    s = sum(ps)
    if s <= 0:
        return None, None, None
    ps = [x / s for x in ps]
    exp = sum(m * x for m, x in zip(MIDS, ps))

    def q_at(level: float) -> float:
        c = 0.0
        for i, x in enumerate(ps):
            if c + x >= level and x > 0:
                return EDGES[i] + (EDGES[i + 1] - EDGES[i]) * (level - c) / x
            c += x
        return 1.0
    return round(exp, 4), round(q_at(0.10), 4), round(q_at(0.90), 4)


def ask_item(state_text: str, qs: list[dict], variant: str) -> list[tuple[float | None, float | None, float | None, float]]:
    opts = OPTS.get(variant, {})
    forms = [form(q, variant) for q in qs]
    if variant == "v1i":
        out = []
        for (f, how), q in zip(forms, qs):
            t0 = time.time()
            r = oj._post("/v1/systemone", {"model": oj.MODEL, "state": state_text, "questions": {"q0": f}})
            out.append((*read(q, how, r.get("answers", {}).get("q0")), time.time() - t0))
        return out
    t0 = time.time()
    r = oj._post("/v1/systemone", {"model": oj.MODEL, "state": state_text,
                                   "questions": {f"q{i}": f for i, (f, _) in enumerate(forms)}, **opts})
    sec = (time.time() - t0) / max(1, len(qs))
    ans = r.get("answers", {})
    return [(*read(q, how, ans.get(f"q{i}")), sec) for i, ((f, how), q) in enumerate(zip(forms, qs))]


def scored(q: dict) -> bool:
    return not q["qtype"].startswith("advisory")


# ---------- live: today's frozen batch -----------------------------------------------------------------------
def run_variants(conn, made_on: dt.date, variants=VARIANTS) -> int:
    conn.execute(oj.BATCH_DDL)
    conn.execute(LAB_DDL)
    b = conn.execute("SELECT items FROM watchlist_sync.openjev_batches WHERE made_on = %s", (made_on,)).fetchone()
    if not b:
        raise SystemExit(f"no frozen batch for {made_on}")
    items = b[0]
    conn.execute("DELETE FROM watchlist_sync.openjev_lab WHERE mode = 'live' AND made_on = %s", (made_on,))
    n = 0
    oj.HARD_STOP_S = 45 * 60
    with oj.Server():
        for v in variants:
            for it in items:
                qs = [q for q in it["questions"] if scored(q)]
                if not qs:
                    continue
                for q, (p, lo, hi, sec) in zip(qs, ask_item(it["state_text"], qs, v)):
                    base = q.get("baseline") or [None, None]
                    conn.execute("""INSERT INTO watchlist_sync.openjev_lab (mode, variant, made_on, question_id, qtype,
                                    subject, prob, p10, p90, baseline, baseline_name, secs) VALUES
                                    ('live',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                                 (v, made_on, q["question_id"], q["qtype"], q["subject"], p, lo, hi, base[1], base[0],
                                  round(sec, 3)))
                    n += 1
            conn.commit()
            print(f"variant {v} done", flush=True)
    return n


# ---------- backtest: point-in-time states with known outcomes ----------------------------------------------
BT_DATES = [dt.date(2026, 9, 8), dt.date(2026, 9, 14), dt.date(2026, 9, 21), dt.date(2026, 9, 28), dt.date(2026, 10, 5)]
LONG_OK = {dt.date(2026, 9, 8), dt.date(2026, 9, 14)}      # 20-trading-day questions resolve by 10-13


def ncdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def hist(conn, t: str, upto: dt.date, n: int = 1300):
    rows = conn.execute("""SELECT date, close::float, iv30_put::float, COALESCE(low, close)::float
                           FROM lseg_research.daily_history WHERE ticker = %s AND date <= %s AND close > 0
                           ORDER BY date DESC LIMIT %s""", (t, upto, n)).fetchall()
    return rows[::-1]


def future(conn, t: str, after: dt.date, n: int):
    return conn.execute("""SELECT date, close::float, COALESCE(low, close)::float FROM lseg_research.daily_history
                           WHERE ticker = %s AND date > %s AND close > 0 ORDER BY date LIMIT %s""", (t, after, n)).fetchall()


def nice_strike(x: float) -> float:
    step = 0.5 if x < 50 else 1.0 if x < 200 else 5.0
    return round(math.floor(x / step) * step, 2)


def pit_state(conn, t: str, asof: dt.date, h) -> tuple[dict, dict] | None:
    """Only fields with as-of history: market (LSEG closes + IV30), synthetic put, StarMine, analyst actions,
    short interest, earnings history. Scores / fair value / weights / guidance / Model List have no history → omitted."""
    cl = [r[1] for r in h]
    if len(cl) < 80 or not h[-1][2]:
        return None
    spot, iv = cl[-1], h[-1][2] / 100
    sd = oj.sigma_daily(cl)
    rv20 = statistics.pstdev([math.log(cl[i] / cl[i - 1]) for i in range(len(cl) - 20, len(cl))]) * math.sqrt(252)
    fri = asof + dt.timedelta(days=(4 - asof.weekday()) % 7)
    T = max(1, (fri - asof).days) / 365
    k = nice_strike(spot * math.exp(-0.67 * iv * math.sqrt(T)))
    d1 = (math.log(spot / k) + 0.5 * iv * iv * T) / (iv * math.sqrt(T))
    d2 = d1 - iv * math.sqrt(T)
    s = {"market": {"as_of": str(asof), "spot": round(spot, 2), "ret_20d_pct": round((spot / cl[-21] - 1) * 100, 1),
                    "ret_60d_pct": round((spot / cl[-61] - 1) * 100, 1), "iv30_put_pct": round(iv * 100, 1),
                    "rv20_pct": round(rv20 * 100, 1), "sigma_20d_pct": round(sd * math.sqrt(20) * 100, 1)},
         "options": {"put_strike": k, "put_expiry": str(fri), "put_delta": round(ncdf(d1) - 1, 3),
                     "otm_pct": round((1 - k / spot) * 100, 1)}}
    sm = {m: v for m, v in conn.execute("""SELECT DISTINCT ON (metric) metric, value FROM lseg_research.starmine_history
                                           WHERE ticker = %s AND obs_date <= %s ORDER BY metric, obs_date DESC""",
                                        (t, asof)).fetchall()}
    acts = conn.execute("""SELECT event_date, firm, action, to_grade, price_target FROM analyst_events WHERE ticker = %s
                           AND event_date <= %s ORDER BY event_date DESC LIMIT 4""", (t, asof)).fetchall()
    s["street"] = {k2: v for k2, v in {"pt_mean": oj._f(sm.get("pt_mean")),
                                       "starmine_alpha_rank": oj._f(sm.get("combined_alpha_rank"), 0),
                                       "recent_analyst_actions": [f"{a[0]} {a[1]} {a[2]} {a[3] or ''} PT {oj._f(a[4])}".strip()
                                                                  for a in acts]}.items() if v not in (None, [])}
    si = conn.execute("""SELECT short_interest, days_to_cover FROM short_interest_history WHERE ticker = %s
                         AND settlement_date <= %s ORDER BY settlement_date DESC LIMIT 2""", (t, asof)).fetchall()
    if si:
        s["short_interest"] = {"days_to_cover": oj._f(si[0][1], 1)}
    moves = conn.execute("""SELECT move_pct FROM lseg_research.earnings_moves WHERE ticker = %s AND report_date < %s
                            ORDER BY report_date DESC LIMIT 4""", (t, asof)).fetchall()
    nxt = conn.execute("""SELECT min(report_date) FROM earnings_calendar WHERE ticker = %s AND report_date >= %s""",
                       (t, asof)).fetchone()
    s["earnings"] = {k2: v for k2, v in {"next_report": str(nxt[0]) if nxt and nxt[0] else None,
                                         "past_moves_pct": [oj._f(m[0], 1) for m in moves] or None}.items() if v}
    return {g: f for g, f in s.items() if f}, {"strike": k, "expiry": fri, "p_otm": ncdf(d2), "sd": sd}


def pit_questions(conn, t: str, asof: dt.date, h, st: dict, aux: dict) -> list[dict]:
    """Same production wording (v0) and events as openjev_local.questions_for, with outcomes attached."""
    cl = [r[1] for r in h]
    spot = st["market"]["spot"]
    qs = []
    k, e = aux["strike"], aux["expiry"]
    fut = future(conn, t, asof, 25)
    exp_close = [r for r in fut if r[0] <= e]
    if exp_close and exp_close[-1][0] >= e - dt.timedelta(days=3):
        qs.append({"question_id": f"bt:put:{t}:{asof}", "qtype": "put_otm", "subject": t,
                   "question": f"Will {t} close above ${k:g} on {e}?", "resolves_on": str(e),
                   "oj": {"type": "noul", "instructions": f"Will {t} close above ${k:g} on {e} (so a ${k:g} put expires worthless)?"},
                   "baseline": ["market_iv", round(aux["p_otm"], 4)], "meta": {"strike": k},
                   "outcome": exp_close[-1][1] > k})
        lows = [r[2] for r in exp_close]
        qs.append({"question_id": f"bt:touch:{t}:{asof}", "qtype": "strike_touch", "subject": t,
                   "question": f"Will {t} trade at or below ${k:g} before {e}?", "resolves_on": str(e),
                   "oj": {"type": "noul", "instructions": f"Will {t}'s daily low touch ${k:g} or lower on any day before {e}?"},
                   "baseline": ["path_reflection", round(min(1.0, 2 * (1 - aux["p_otm"])), 4)], "meta": {"strike": k},
                   "outcome": min(lows) <= k})
    for hz in (5, 20):
        if hz == 20 and asof not in LONG_OK:
            continue
        if len(fut) < hz:
            continue
        br = oj.up_rate(cl, hz)
        d = fut[hz - 1][0]
        qs.append({"question_id": f"bt:dir{hz}:{t}:{asof}", "qtype": f"direction_{hz}d", "subject": t,
                   "question": f"Will {t} close above ${spot:g} on {d}?", "resolves_on": str(d),
                   "oj": {"type": "noul", "instructions": f"Will {t} close above today's ${spot:g} on {d} ({hz} trading days)?"},
                   "baseline": ["base_rate", round(br, 4)], "meta": {"spot": spot}, "outcome": fut[hz - 1][1] > spot})
    sig = st["market"]["sigma_20d_pct"]
    br = oj.drop_rate(cl)
    if asof in LONG_OK and len(fut) >= 20 and br is not None:
        thr = spot * (1 - 2 * sig / 100)
        d = fut[19][0]
        qs.append({"question_id": f"bt:drop:{t}:{asof}", "qtype": "drop_2sigma", "subject": t,
                   "question": f"Will {t} close at or below ${thr:.2f} (−{2 * sig:.1f}%) any day by {d}?",
                   "resolves_on": str(d),
                   "oj": {"type": "noul", "instructions": f"Will {t} close at or below ${thr:.2f} (a {2 * sig:.1f}% drop, 2 sigma) on any trading day before {d}?"},
                   "baseline": ["base_rate", round(br, 4)], "meta": {"threshold": thr},
                   "outcome": min(r[1] for r in fut[:20]) <= thr})
    return qs


def bt_tickers(conn) -> list[str]:
    b = conn.execute("SELECT items FROM watchlist_sync.openjev_batches ORDER BY made_on DESC LIMIT 1").fetchone()
    ts = [i["ticker"] for i in (b[0] if b else [])]
    extra = [r[0] for r in conn.execute("""SELECT ticker FROM lseg_research.daily_history WHERE date = '2026-10-05'
                                           AND iv30_put IS NOT NULL GROUP BY ticker ORDER BY ticker""").fetchall()]
    for t in extra:            # pad to 30 names with a fixed, alphabetical (not cherry-picked) list
        if len(ts) >= 30:
            break
        if t not in ts and t not in ("SPY", "QQQ"):
            ts.append(t)
    return ts


def run_backtest(conn, variants=("v0", "v1", "v3", "v4", "v1s")) -> int:
    conn.execute(LAB_DDL)
    conn.execute("DELETE FROM watchlist_sync.openjev_lab WHERE mode = 'backtest'")
    items = []
    for t in bt_tickers(conn):
        for asof in BT_DATES:
            h = hist(conn, t, asof)
            got = pit_state(conn, t, asof, h)
            if not got:
                continue
            st, aux = got
            qs = pit_questions(conn, t, asof, h, st, aux)
            if qs:
                items.append((t, asof, oj.render_state(t, st), qs))
    print(f"backtest: {len(items)} states, {sum(len(i[3]) for i in items)} questions", flush=True)
    n = 0
    oj.HARD_STOP_S = 60 * 60
    with oj.Server():
        for v in variants:
            for t, asof, text, qs in items:
                for q, (p, lo, hi, sec) in zip(qs, ask_item(text, qs, v)):
                    conn.execute("""INSERT INTO watchlist_sync.openjev_lab (mode, variant, made_on, question_id, qtype,
                                    subject, prob, p10, p90, baseline, baseline_name, outcome, secs) VALUES
                                    ('backtest',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                                 (v, asof, q["question_id"], q["qtype"], t, p, lo, hi, q["baseline"][1], q["baseline"][0],
                                  q["outcome"], round(sec, 3)))
                    n += 1
            conn.commit()
            print(f"variant {v} done", flush=True)
    return n


# ---------- scoring ------------------------------------------------------------------------------------------
def logit(p: float) -> float:
    p = min(1 - 1e-4, max(1e-4, p))
    return math.log(p / (1 - p))


def platt_fit(xs: list[float], ys: list[bool], iters: int = 300) -> tuple[float, float]:
    """1-D logistic regression on logit(p) (Newton); returns (a, b): p' = σ(a·logit(p) + b)."""
    a, b = 1.0, 0.0
    for _ in range(iters):
        ga = gb = haa = hab = hbb = 0.0
        for x, y in zip(xs, ys):
            z = a * x + b
            p = 1 / (1 + math.exp(-max(-30, min(30, z))))
            w = p * (1 - p)
            ga += (p - y) * x
            gb += (p - y)
            haa += w * x * x + 1e-6
            hab += w * x
            hbb += w + 1e-6
        det = haa * hbb - hab * hab
        if abs(det) < 1e-12:
            break
        da, db = (hbb * ga - hab * gb) / det, (haa * gb - hab * ga) / det
        a, b = a - da, b - db
        if abs(da) + abs(db) < 1e-8:
            break
    return a, b


def platt_apply(p: float, ab: tuple[float, float]) -> float:
    z = ab[0] * logit(p) + ab[1]
    return 1 / (1 + math.exp(-max(-30, min(30, z))))


def brier(ps, ys) -> float:
    return sum((p - y) ** 2 for p, y in zip(ps, ys)) / len(ps)


def summarize(conn) -> dict:
    out = {"live": [], "backtest": []}
    for mode in ("live", "backtest"):
        rows = conn.execute("""SELECT variant, qtype, made_on, prob, p10, p90, baseline, outcome FROM watchlist_sync.openjev_lab
                               WHERE mode = %s AND prob IS NOT NULL ORDER BY variant, qtype""", (mode,)).fetchall()
        by: dict = {}
        for v, qt, d, p, lo, hi, b, y in rows:
            by.setdefault((v, qt), []).append((d, p, lo, hi, b, y))
        for (v, qt), xs in sorted(by.items()):
            ps = [x[1] for x in xs]
            r = {"variant": v, "qtype": qt, "n": len(xs), "mean_p": round(statistics.mean(ps), 3),
                 "extreme_pct": round(100 * sum(p < 0.05 or p > 0.95 for p in ps) / len(ps)),
                 "mean_baseline": round(statistics.mean([x[4] for x in xs if x[4] is not None]), 3)
                 if any(x[4] is not None for x in xs) else None}
            if any(x[2] is not None for x in xs):
                r["mean_range_width"] = round(statistics.mean([x[3] - x[2] for x in xs if x[2] is not None]), 3)
            if mode == "backtest":
                ys = [bool(x[5]) for x in xs]
                bs = [x[4] for x in xs]
                r["brier"] = round(brier(ps, ys), 4)
                r["brier_baseline"] = round(brier(bs, ys), 4) if all(b is not None for b in bs) else None
                r["base_rate_realized"] = round(sum(ys) / len(ys), 3)
                if all(b is not None for b in bs):
                    # Ensemble (Muse 10-17): logit-average OpenJev with the baseline. A weak
                    # forecaster with uncorrelated errors still helps in a blend — this is the
                    # "adds information on top of the market" test.
                    blend = [1 / (1 + math.exp(-(logit(p) + logit(b)) / 2)) for p, b in zip(ps, bs)]
                    r["brier_ensemble"] = round(brier(blend, ys), 4)
                    # Deviation direction (Muse 10-17): when the model says higher/lower than the
                    # baseline, is it right? v4 asks this directly (prob = P(true p > baseline));
                    # other variants imply it via prob - baseline. excess = realized rate in the
                    # bucket minus that bucket's mean baseline. Discriminating model => hi > 0, lo < 0.
                    dev = [p - 0.5 if v == "v4" else p - b for p, b in zip(ps, bs)]
                    for tag, sel in (("hi", [d > 0.1 for d in dev]), ("lo", [d < -0.1 for d in dev])):
                        s_ys = [y for y, s in zip(ys, sel) if s]
                        s_bs = [b for b, s in zip(bs, sel) if s]
                        if s_ys:
                            r[f"dev_{tag}_n"] = len(s_ys)
                            r[f"dev_{tag}_excess"] = round(
                                sum(s_ys) / len(s_ys) - sum(s_bs) / len(s_bs), 3)
                # leave-one-date-out Platt calibration → honest calibrated Brier
                dates = sorted({x[0] for x in xs})
                cal = []
                for d in dates:
                    tr = [x for x in xs if x[0] != d]
                    te = [x for x in xs if x[0] == d]
                    if len({bool(x[5]) for x in tr}) < 2 or len(tr) < 10:
                        cal += [(x[1], bool(x[5])) for x in te]
                        continue
                    ab = platt_fit([logit(x[1]) for x in tr], [bool(x[5]) for x in tr])
                    cal += [(platt_apply(x[1], ab), bool(x[5])) for x in te]
                r["brier_calibrated_lodo"] = round(brier([c[0] for c in cal], [c[1] for c in cal]), 4)
            out[mode].append(r)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--variants", action="store_true")
    ap.add_argument("--backtest", action="store_true")
    ap.add_argument("--summary", action="store_true")
    ap.add_argument("--made-on", default=None)
    ap.add_argument("--only", default=None, help="comma list of variants")
    a = ap.parse_args()
    conn = connect()
    vs = tuple(a.only.split(",")) if a.only else None
    if a.variants:
        d = dt.date.fromisoformat(a.made_on) if a.made_on else dt.datetime.now(oj.PT).date()
        print(run_variants(conn, d, vs or VARIANTS), "live rows")
    if a.backtest:
        print(run_backtest(conn, vs or ("v0", "v1", "v3", "v1s")), "backtest rows")
    if a.summary or a.variants or a.backtest:
        print(json.dumps(summarize(conn), indent=1, default=str))


if __name__ == "__main__":
    main()
