#!/usr/bin/env python3
"""OpenJev local (A129 v5, Jamie 10-16: local 26B on MLX — no fildi data leaves the Mac).

Daily batch: resource guard → start the local OpenJev server → ask typed questions per ticker → write
watchlist_sync.forecast_ledger rows (forecaster 'openjev:local-26b' + the baseline forecaster for the same
question_id) → stop the server (load → answer → unload). Graded later by forecast_ledger.py --resolve / --report.

Privacy: the state sent to the model (even locally) is built ONLY from STATE_ALLOWLIST (public market data +
fildi model outputs). Never holdings, quantities, cost basis, account names/values, P&L or transactions —
check_state() enforces it; tests/test_openjev_local.py fails if anything slips. Keeps the hosted option open.

Run (venv scripts/watchlist_sync/.venv; server from research/openjev/.venv):
    .venv/bin/python openjev_local.py --tick                # LaunchAgent entry (freeze 05:30, retry in windows)
    .venv/bin/python openjev_local.py --freeze              # snapshot today's states + questions (idempotent)
    .venv/bin/python openjev_local.py --answer [--ablate]   # answer the frozen batch (+ drop-one-field-group pass)
    .venv/bin/python openjev_local.py --ask-needs           # ask the model which state fields help / are noise
    .venv/bin/python openjev_local.py --bias-check          # blank-state A/B position-bias probe
    .venv/bin/python openjev_local.py --dry-run             # build states + questions, no model
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import random
import re
import signal
import statistics
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "scripts"))

PT = ZoneInfo("America/Los_Angeles")
FORECASTER = "openjev:local-26b"
MODEL = "openjev-latest"
HOST, PORT = "127.0.0.1", 8080
BASE = f"http://{HOST}:{PORT}"
OJ_PY = ROOT / "research/openjev/.venv/bin/python"
LAST_FILE = Path("/tmp/fildi-logs/openjev-last.json")
NEEDS_MD = ROOT / "research/common/asks/A129-needs.md"
SERVER_ENV = {
    "OPENJEV_BACKEND": "mlx",
    "OPENJEV_HOST": HOST, "OPENJEV_PORT": str(PORT),
    "OPENJEV_MLX_CACHE_LIMIT_GB": "4",      # MLX buffer-pool cap (README: 36 GB unbounded → 23.5 GB capped)
    "OPENJEV_MLX_PROMPT_CACHE": "2",        # each ticker state is unique; a big prefill cache only holds RAM
    "OPENJEV_MLX_MAX_PROMPT": "8192",
    "HF_HUB_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1",   # weights already downloaded; no network at runtime
}
S018_BIGGER_THAN_PRICED = 0.33   # S018: realized earnings move > implied in 33 % of 363 reports
ADVISORY_HORIZON_DAYS = 3650     # advisory rows are never resolved

# ---------- privacy -------------------------------------------------------------------------------------------
STATE_ALLOWLIST: dict[str, tuple[str, ...]] = {
    "market": ("as_of", "spot", "ret_20d_pct", "ret_60d_pct", "iv30_put_pct", "rv20_pct", "iv_rank", "sigma_20d_pct"),
    "options": ("put_strike", "put_expiry", "put_delta", "put_premium", "otm_pct", "option_score", "components",
                "iv_vs_realized", "earnings_days_out"),
    "scores": ("fund_total", "fund_value", "fund_growth", "fund_quality", "fund_safety", "style_bucket",
               "fund_confidence", "fund_top_metrics", "tech_total", "tech_components", "falling_knife",
               "fit_verdict", "fit_flags", "fit_why"),
    "weights": ("fund_family_weights", "tech_weights", "options_strike_weights", "fv_methods", "versions"),
    "fair_value": ("fair_value", "adjusted_fair_value", "fv_low", "fv_high", "price_to_fair", "fv_confidence",
                   "fv_mode", "implied_growth", "value_trap", "cyclical", "fv_votes"),
    "street": ("pt_mean", "starmine_alpha_rank", "starmine_pred_surprise_pct", "recent_analyst_actions"),
    "short_interest": ("days_to_cover", "short_interest_chg_pct"),
    "earnings": ("next_report", "past_moves_pct", "implied_vs_realized_ratios", "last_surprise_pct"),
    "guidance": ("quarter", "guidance", "risks", "tone"),
    "model_list": ("rec", "rank", "score", "win_rate", "ev"),
}
DENY_KEY = re.compile(r"account|acct|quantity|qty|contracts?_held|shares_held|cost|basis|pnl|p&l|profit|loss|"
                      r"position|holding|market_value|equity|buying_power|transaction|fill|trade_id|order", re.I)
DENY_VALUE = re.compile(r"traditional ira|roth ira|\bFILDI\b|open position|cost basis|unrealized|realized p&l|"
                        r"buying power|\b\d+ contracts\b|\b\d+ shares\b", re.I)


class PrivacyError(ValueError):
    pass


def check_state(state: dict, extra_deny: tuple[str, ...] = ()) -> None:
    """Raise if any group/field is outside the allowlist or any value looks like holdings/account data."""
    for g, fields in state.items():
        if g not in STATE_ALLOWLIST:
            raise PrivacyError(f"group not allowed: {g}")
        if not isinstance(fields, dict):
            raise PrivacyError(f"group {g} must be a dict")
        for k, v in fields.items():
            if k not in STATE_ALLOWLIST[g] or DENY_KEY.search(k) and k not in ("fund_top_metrics",):
                raise PrivacyError(f"field not allowed: {g}.{k}")
            blob = json.dumps(v, default=str)
            if DENY_VALUE.search(blob):
                raise PrivacyError(f"holdings/account-like value in {g}.{k}")
            for word in extra_deny:
                if word and re.search(rf"\b{re.escape(word)}\b", blob, re.I):
                    raise PrivacyError(f"account name in {g}.{k}")


def render_state(ticker: str, state: dict, drop: str | None = None) -> str:
    """Compact plain-text state. drop = a field group left out (ablation)."""
    lines = [f"Stock: {ticker}. Data from fildi (a put-selling research app): public market data plus fildi's own "
             f"model outputs. Scores are 0-100 (higher = better). Today: {state.get('market', {}).get('as_of')}."]
    for g, fields in state.items():
        if g == drop or not fields:
            continue
        parts = [f"{k}={json.dumps(v, default=str, separators=(',', ':'))}" for k, v in fields.items() if v is not None]
        if parts:
            lines.append(f"[{g}] " + "; ".join(parts))
    return "\n".join(lines)


def est_tokens(text: str) -> int:
    return max(1, len(text) // 4)


# ---------- state builder (DB only) --------------------------------------------------------------------------
def _f(x, nd=2):
    try:
        return None if x is None else round(float(x), nd)
    except (TypeError, ValueError):
        return None


def closes(conn, t: str, n: int = 260) -> list[tuple[dt.date, float, float | None, float | None, float | None]]:
    rows = conn.execute("""SELECT date, close::float, iv30_put::float, high::float, low::float FROM lseg_research.daily_history
                           WHERE ticker = %s AND close > 0 ORDER BY date DESC LIMIT %s""", (t, n)).fetchall()
    if not rows:
        rows = conn.execute("""SELECT date, close::float, NULL::float, high::float, low::float FROM prices_historical
                               WHERE ticker = %s AND close > 0 ORDER BY date DESC LIMIT %s""", (t, n)).fetchall()
    return list(reversed(rows))


def sigma_daily(cl: list[float], n: int = 60) -> float | None:
    if len(cl) < n + 1:
        return None
    r = [math.log(cl[i] / cl[i - 1]) for i in range(len(cl) - n, len(cl))]
    return statistics.pstdev(r)


def build_state(conn, t: str, ctx: dict) -> dict:
    s: dict[str, dict] = {g: {} for g in STATE_ALLOWLIST}
    h = closes(conn, t)
    if h:
        cl = [x[1] for x in h]
        spot = cl[-1]
        sd = sigma_daily(cl)
        rv20 = statistics.pstdev([math.log(cl[i] / cl[i - 1]) for i in range(len(cl) - 20, len(cl))]) * math.sqrt(252) \
            if len(cl) > 21 else None
        s["market"] = {"as_of": str(h[-1][0]), "spot": _f(spot),
                       "ret_20d_pct": _f((spot / cl[-21] - 1) * 100, 1) if len(cl) > 21 else None,
                       "ret_60d_pct": _f((spot / cl[-61] - 1) * 100, 1) if len(cl) > 61 else None,
                       "iv30_put_pct": _f(h[-1][2], 1), "rv20_pct": _f(rv20 * 100, 1) if rv20 else None,
                       "sigma_20d_pct": _f(sd * math.sqrt(20) * 100, 1) if sd else None}
    o = conn.execute("""SELECT strike, expiry, delta, premium, otm_pct, option_score, component_scores, iv_vs_realized,
                               earnings_days_out FROM option_score_snapshots WHERE ticker = %s AND side = 'put'
                        ORDER BY as_of DESC, option_score DESC NULLS LAST LIMIT 1""", (t,)).fetchone()
    if o:
        s["options"] = {"put_strike": _f(o[0]), "put_expiry": str(o[1]), "put_delta": _f(o[2], 3), "put_premium": _f(o[3]),
                        "otm_pct": _f(o[4], 1), "option_score": _f(o[5], 1),
                        "components": {k: _f(v, 1) for k, v in (o[6] or {}).items() if isinstance(v, (int, float))},
                        "iv_vs_realized": _f(o[7]), "earnings_days_out": o[8]}
    fs = conn.execute("""SELECT fund_total, fund_value, fund_growth, fund_quality, fund_safety, style_bucket, confidence,
                                top_metrics, model_version FROM fund_score_snapshots WHERE ticker = %s
                         ORDER BY as_of DESC LIMIT 1""", (t,)).fetchone()
    ts = conn.execute("""SELECT tech_total, components, falling_knife, model_version FROM tech_score_snapshots
                         WHERE ticker = %s ORDER BY as_of DESC LIMIT 1""", (t,)).fetchone()
    fit = conn.execute("SELECT verdict, flags, why, model_version FROM watchlist_sync.fit_scores WHERE ticker = %s",
                       (t,)).fetchone()
    sc: dict = {}
    if fs:
        sc.update({"fund_total": _f(fs[0], 1), "fund_value": _f(fs[1], 1), "fund_growth": _f(fs[2], 1),
                   "fund_quality": _f(fs[3], 1), "fund_safety": _f(fs[4], 1), "style_bucket": fs[5],
                   "fund_confidence": fs[6],
                   "fund_top_metrics": [{"key": m.get("key"), "peerPct": m.get("peerPct"), "family": m.get("family")}
                                        for m in (fs[7] or [])[:5]]})
    if ts:
        sc.update({"tech_total": _f(ts[0], 1), "tech_components": ts[1], "falling_knife": ts[2]})
    if fit:
        sc.update({"fit_verdict": fit[0], "fit_flags": fit[1], "fit_why": fit[2]})
    s["scores"] = sc
    fv = conn.execute("""SELECT fair_value, adjusted_fair_value, low, high, price_to_fair, confidence, mode, implied_growth,
                                value_trap, cyclical, votes, model_version FROM fair_value_snapshots WHERE ticker = %s
                         ORDER BY as_of DESC LIMIT 1""", (t,)).fetchone()
    if fv:
        votes = fv[10]
        if isinstance(votes, list):
            votes = [{k: v.get(k) for k in ("method", "value", "weight") if k in v} for v in votes[:8]
                     if isinstance(v, dict)]
        elif isinstance(votes, dict):
            votes = {k: (_f(v) if isinstance(v, (int, float)) else v) for k, v in list(votes.items())[:8]}
        s["fair_value"] = {"fair_value": _f(fv[0]), "adjusted_fair_value": _f(fv[1]), "fv_low": _f(fv[2]),
                           "fv_high": _f(fv[3]), "price_to_fair": _f(fv[4]), "fv_confidence": fv[5], "fv_mode": fv[6],
                           "implied_growth": _f(fv[7], 3), "value_trap": fv[8], "cyclical": fv[9], "fv_votes": votes}
    w = ctx["weights"]
    s["weights"] = {"fund_family_weights": w["fund"].get("styleFamilyWeights", {}).get((fs or [None] * 6)[5] or "blend"),
                    "tech_weights": w["tech"].get("weights"), "options_strike_weights": w["options"].get("strikeWeights"),
                    "fv_methods": w["fair_value"].get("methodsByMode", {}).get(fv[6] if fv else "standard"),
                    "versions": {"fund": fs[8] if fs else None, "tech": ts[3] if ts else None,
                                 "fit": fit[3] if fit else None, "fv": fv[11] if fv else None}}
    sm = {m: v for m, v in conn.execute("""SELECT DISTINCT ON (metric) metric, value FROM lseg_research.starmine_history
                                           WHERE ticker = %s ORDER BY metric, obs_date DESC""", (t,)).fetchall()}
    acts = conn.execute("""SELECT event_date, firm, action, to_grade, price_target FROM analyst_events WHERE ticker = %s
                           ORDER BY event_date DESC LIMIT 4""", (t,)).fetchall()
    s["street"] = {"pt_mean": _f(sm.get("pt_mean")), "starmine_alpha_rank": _f(sm.get("combined_alpha_rank"), 0),
                   "starmine_pred_surprise_pct": _f(sm.get("pred_surprise_pct_fq1"), 2),
                   "recent_analyst_actions": [f"{a[0]} {a[1]} {a[2]} {a[3] or ''} PT {_f(a[4])}".strip() for a in acts]}
    si = conn.execute("""SELECT short_interest, days_to_cover FROM short_interest_history WHERE ticker = %s
                         ORDER BY settlement_date DESC LIMIT 2""", (t,)).fetchall()
    if si:
        chg = (si[0][0] / si[1][0] - 1) * 100 if len(si) > 1 and si[1][0] else None
        s["short_interest"] = {"days_to_cover": _f(si[0][1], 1), "short_interest_chg_pct": _f(chg, 1)}
    nxt = conn.execute("""SELECT report_date FROM earnings_calendar WHERE ticker = %s AND report_date >= current_date
                          ORDER BY report_date LIMIT 1""", (t,)).fetchone()
    moves = conn.execute("""SELECT move_pct FROM lseg_research.earnings_moves WHERE ticker = %s ORDER BY report_date DESC
                            LIMIT 4""", (t,)).fetchall()
    ratios = conn.execute("""SELECT ratio FROM optlab.earnings_moves WHERE ticker = %s AND ratio IS NOT NULL
                             ORDER BY report_date DESC LIMIT 4""", (t,)).fetchall()
    sur = conn.execute("""SELECT surprise_pct FROM earnings_calendar WHERE ticker = %s AND surprise_pct IS NOT NULL
                          ORDER BY report_date DESC LIMIT 1""", (t,)).fetchone()
    s["earnings"] = {"next_report": str(nxt[0]) if nxt else None,
                     "past_moves_pct": [_f(m[0], 1) for m in moves] or None,
                     "implied_vs_realized_ratios": [_f(r[0]) for r in ratios] or None,
                     "last_surprise_pct": _f(sur[0], 1) if sur else None}
    tr = conn.execute("""SELECT quarter, summary FROM watchlist_sync.earnings_transcripts WHERE ticker = %s
                         AND summary IS NOT NULL ORDER BY fetched_at DESC LIMIT 1""", (t,)).fetchone()
    if tr and isinstance(tr[1], dict):
        sm2 = tr[1]
        s["guidance"] = {"quarter": tr[0], "guidance": str(sm2.get("guidance") or "")[:400] or None,
                         "risks": str(sm2.get("risks") or "")[:300] or None,
                         "tone": str(sm2.get("tone_prepared") or "")[:120] or None}
    ml = ctx["model_list"].get(t)
    if ml:
        s["model_list"] = ml
    s = {g: {k: v for k, v in f.items() if v not in (None, "", [], {})} for g, f in s.items()}
    check_state(s, ctx.get("account_names", ()))
    return s


def load_weights(conn) -> dict:
    out = {"fund": {}, "tech": {}, "options": {}, "fair_value": {}}
    for lane, params in conn.execute("SELECT lane, params FROM scorecard_params WHERE status = 'champion'").fetchall():
        if lane in out:
            out[lane] = params or {}
    return out


# ---------- universe -----------------------------------------------------------------------------------------
def held_puts(conn) -> list[dict]:
    r = conn.execute("""SELECT payload->'predictions' FROM watchlist_sync.pm_alerts WHERE payload ? 'predictions'
                        ORDER BY generated_at DESC LIMIT 1""").fetchone()
    return list(r[0] or []) if r else []


def model_list(conn) -> tuple[dict, list[dict]]:
    """{ticker: public rec summary} for non-held rows + new put picks (strike/expiry/win)."""
    run = conn.execute("SELECT id FROM watchlist_sync.model_runs ORDER BY id DESC LIMIT 1").fetchone()
    recs, picks = {}, []
    if not run:
        return recs, picks
    for t, rank, verdict, score, c in conn.execute(
            """SELECT ticker, rank, verdict, score, contract FROM watchlist_sync.model_items
               WHERE run_id = %s AND role IS NULL""", (run[0],)).fetchall():
        rec = {"rec": verdict, "rank": rank, "score": _f(score, 1)}
        if isinstance(c, dict) and c.get("type") == "put" and isinstance(c.get("win"), dict):
            rec.update({"win_rate": _f(c["win"].get("rate"), 3), "ev": _f(c["win"].get("ev"))})
            picks.append({"ticker": t, "strike": float(c["strike"]), "expiry": c["expiry"], "premium": c.get("premium"),
                          "win_rate": c["win"].get("rate"), "delta": c["win"].get("delta"), "rank": rank})
        recs[t] = {k: v for k, v in rec.items() if v is not None}
    return recs, picks


def build_universe(conn, held: list[str], recs: dict, picks: list[dict], today: dt.date, n_extra: int = 14) -> list[str]:
    hs = sorted(set(held))
    extra = [p["ticker"] for p in picks]
    extra += [t for t, r in sorted(recs.items(), key=lambda kv: -(kv[1].get("score") or 0)) if r.get("rec") == "green"]
    extra += [t for (t,) in conn.execute("""SELECT ticker FROM option_score_snapshots WHERE side = 'put'
                 AND as_of = (SELECT max(as_of) FROM option_score_snapshots) ORDER BY option_score DESC NULLS LAST
                 LIMIT 40""").fetchall()]
    seen, non_held = set(hs), []
    for t in extra:
        if t not in seen:
            seen.add(t)
            non_held.append(t)
    need = max(n_extra, 2 * len(hs))
    u = hs + non_held[:need]
    random.Random(str(today)).shuffle(u)
    return u


# ---------- questions ----------------------------------------------------------------------------------------
def add_trading_days(d: dt.date, n: int) -> dt.date:
    while n > 0:
        d += dt.timedelta(days=1)
        if d.weekday() < 5:
            n -= 1
    return d


def up_rate(cl: list[float], h: int) -> float | None:
    if len(cl) < h + 60:
        return None
    ups = [cl[i + h] > cl[i] for i in range(len(cl) - h)]
    return sum(ups) / len(ups)


def drop_rate(cl: list[float], h: int = 20, k: float = 2.0) -> float | None:
    """Historical P(min close within h days ≤ spot·(1 − k·σ√h)) using a trailing 60-day σ."""
    hits = n = 0
    for i in range(61, len(cl) - h, 5):
        sd = sigma_daily(cl[: i + 1])
        if not sd:
            continue
        thr = cl[i] * (1 - k * sd * math.sqrt(h))
        hits += min(cl[i + 1: i + 1 + h]) <= thr
        n += 1
    return hits / n if n >= 20 else None


def implied_earnings_move(conn, t: str, report: dt.date) -> float | None:
    """≈ ATM straddle ÷ spot from the latest chain snapshot: nearest OTM put + nearest OTM call, first expiry ≥ report."""
    r = conn.execute("""WITH c AS (SELECT * FROM option_chain_history WHERE ticker = %s
                          AND as_of = (SELECT max(as_of) FROM option_chain_history WHERE ticker = %s)
                          AND expiry >= %s),
                        e AS (SELECT min(expiry) x FROM c)
                        SELECT side, strike::float, spot::float, bid::float, ask::float FROM c, e WHERE c.expiry = e.x""",
                     (t, t, report)).fetchall()
    if not r:
        return None
    spot = r[0][2]
    best = {}
    for side, k, _, b, a in r:
        mid = (b + a) / 2 if a else b
        d = abs(k - spot)
        if mid and (side not in best or d < best[side][0]):
            best[side] = (d, mid)
    if "put" not in best or "call" not in best or not spot:
        return None
    return (best["put"][1] + best["call"][1]) / spot


def p_from_answer(q: dict, a: dict) -> float | None:
    """Ledger probability for the question's 'yes' event from an OpenJev answer."""
    if q["oj"]["type"] == "noul":
        return a.get("noul")
    probs = a.get("probabilities") or {}
    yes = q.get("yes_keys") or []
    if q.get("ratio_keys"):   # P(a) / (P(a) + P(b)) — e.g. fund-right vs tech-right
        x, y = (probs.get(k, 0.0) for k in q["ratio_keys"])
        return x / (x + y) if x + y > 0 else None
    return sum(probs.get(k, 0.0) for k in yes) if probs else None


def questions_for(conn, t: str, state: dict, ctx: dict, today: dt.date) -> list[dict]:
    qs: list[dict] = []
    mk = state.get("market", {})
    spot = mk.get("spot")
    h = closes(conn, t, 1300)
    cl = [x[1] for x in h]

    def add(qid, qtype, text, oj, resolves_on, baseline, meta, **kw):
        if any(q["question_id"] == qid for q in qs):
            return
        qs.append({"question_id": qid, "qtype": qtype, "question": text, "oj": oj, "resolves_on": resolves_on,
                   "baseline": baseline, "meta": meta, "subject": t, **kw})

    # 1 + 3. put OTM at expiry, strike touch — held puts (ids match forecast_ledger's market_iv rows), picks, scanner
    puts: list[tuple[str, float, str, tuple[str, float], str]] = []
    for p in ctx["held_by_ticker"].get(t, []):
        qid = f"put:{p['account']}:{t}:{float(p['strike']):g}:{p['expiry']}"      # local DB id only; never sent
        puts.append((qid, float(p["strike"]), p["expiry"], ("market_iv", 1 - float(p["p_assign"])), "put_otm"))
    for p in ctx["picks_by_ticker"].get(t, []):
        if p.get("win_rate") is not None:
            puts.append((f"pick:{t}:{p['strike']:g}:{p['expiry']}", p["strike"], p["expiry"],
                         ("model_winrate", float(p["win_rate"])), "model_pick_otm"))
    o = state.get("options", {})
    if not puts and o.get("put_strike") and o.get("put_delta") is not None:
        puts.append((f"scan:{t}:{o['put_strike']:g}:{o['put_expiry']}", o["put_strike"], o["put_expiry"],
                     ("market_delta", 1 - abs(float(o["put_delta"]))), "put_otm"))
    for qid, k, e, base, qtype in puts:
        if e <= str(today):
            continue
        add(qid, qtype, f"Will {t} close above ${k:g} on {e}?",
            {"type": "noul", "instructions": f"Will {t} close above ${k:g} on {e} (so a ${k:g} put expires worthless)?"},
            e, base, {"strike": k})
        p_itm = 1 - base[1]
        add(f"touch:{t}:{k:g}:{e}", "strike_touch", f"Will {t} trade at or below ${k:g} before {e}?",
            {"type": "noul", "instructions": f"Will {t}'s daily low touch ${k:g} or lower on any day before {e}?"},
            e, ("path_reflection", round(min(1.0, 2 * p_itm), 4)), {"strike": k, "from": str(today)})
    # 2. rec quality — only meaningful with ≥ 3 picks to form a median
    if len(ctx["picks"]) >= 3 and t in ctx["picks_by_ticker"]:
        p = ctx["picks_by_ticker"][t][0]
        r = sorted(x["rank"] for x in ctx["picks"])
        base = 1 - (r.index(p["rank"]) / max(1, len(r) - 1))
        add(f"recmed:{t}:{p['expiry']}", "rec_beats_median",
            f"Will Model List pick {t} beat the median pick's return on collateral by {p['expiry']}?",
            {"type": "noul", "instructions": f"This week fildi's Model List has {len(r)} put picks. Will the {t} "
                                             f"${p['strike']:g} put (expiry {p['expiry']}) earn more per dollar of "
                                             f"collateral than the median pick?"},
            p["expiry"], ("model_rank", round(base, 4)),
            {"strike": p["strike"], "expiry": p["expiry"], "premium": p.get("premium"),
             "picks": [{"ticker": x["ticker"], "strike": x["strike"], "premium": x.get("premium")} for x in ctx["picks"]]})
    # 4. direction 5d / 20d
    if spot:
        for hz in (5, 20):
            br = up_rate(cl, hz)
            if br is not None:
                d = add_trading_days(today, hz)
                add(f"dir{hz}:{t}:{today}", f"direction_{hz}d", f"Will {t} close above ${spot:g} on {d}?",
                    {"type": "noul", "instructions": f"Will {t} close above today's ${spot:g} on {d} ({hz} trading days)?"},
                    str(d), ("base_rate", round(br, 4)), {"spot": spot, "from": str(today)})
    # 5. earnings move vs implied
    nr = state.get("earnings", {}).get("next_report")
    if nr:
        rd = dt.date.fromisoformat(nr)
        if 0 <= (rd - today).days <= 14:
            im = implied_earnings_move(conn, t, rd)
            if im:
                add(f"earn:{t}:{nr}", "earnings_vs_implied",
                    f"Will {t}'s earnings move ({nr}) exceed the option-implied ±{im * 100:.1f}%?",
                    {"type": "noul", "instructions": f"{t} reports on {nr}. Options price a ±{im * 100:.1f}% move. "
                                                     f"Will the actual one-day move be bigger than that?"},
                    str(rd + dt.timedelta(days=4)), ("S018_base", S018_BIGGER_THAN_PRICED),
                    {"implied": round(im, 4), "report_date": nr})
    # 6. fair value vs street PT (graded by the 60-day PT revision direction, S009)
    fv = state.get("fair_value", {}).get("adjusted_fair_value") or state.get("fair_value", {}).get("fair_value")
    pt = state.get("street", {}).get("pt_mean")
    if fv and pt and spot:
        d = today + dt.timedelta(days=60)
        add(f"fvpt:{t}:{today}", "fv_vs_pt", f"Will the street PT for {t} move toward fildi's fair value ${fv:g} by {d}?",
            {"type": "choice", "instructions": f"fildi's fair value for {t} is ${fv:g}; the street consensus target is "
                                               f"${pt:g}; price ${spot:g}. Over the next 60 days, is fildi's fair value "
                                               f"too high, about right, or too low?",
             "criteria": {"too_high": "fildi's fair value is too high", "about_right": "fildi's fair value is about right",
                          "too_low": "fildi's fair value is too low"}},
            str(d), ("coin", 0.5), {"fv": fv, "pt0": pt},
            # event = street PT moves toward fildi's FV; it fails when fildi's FV is wrong in the street's direction
            yes_keys=["about_right", "too_high"] if fv < pt else ["about_right", "too_low"])
    # 7. fund vs tech disagreement
    sc = state.get("scores", {})
    ft, tt = sc.get("fund_total"), sc.get("tech_total")
    if ft is not None and tt is not None and spot and ((ft >= 60 and tt <= 40) or (ft <= 40 and tt >= 60)):
        d = add_trading_days(today, 20)
        fund_up = ft > tt
        add(f"disagree:{t}:{today}", "score_disagree",
            f"{t}: fund {ft:g} vs tech {tt:g} — will the fund side be right by {d}?",
            {"type": "choice", "instructions": f"fildi's fundamental score for {t} is {ft:g} and its technical score is "
                                               f"{tt:g}; they disagree. Which will be right about the price 20 trading "
                                               f"days from now ({d})?",
             "criteria": {"fund": f"fundamental score is right ({'higher' if fund_up else 'lower'} price)",
                          "tech": f"technical score is right ({'lower' if fund_up else 'higher'} price)",
                          "neither": "price roughly flat (within 1%)"}},
            str(d), ("coin", 0.5), {"spot": spot, "fund_up": fund_up, "from": str(today)}, ratio_keys=["fund", "tech"])
    # 8. biggest risk — scored as P(≥ 2σ drop within 20 trading days); cause stored for manual grading
    sig = mk.get("sigma_20d_pct")
    br = drop_rate(cl) if sig else None
    if sig and spot and br is not None:
        d = add_trading_days(today, 20)
        thr = spot * (1 - 2 * sig / 100)
        add(f"drop20:{t}:{today}", "drop_2sigma",
            f"Will {t} close at or below ${thr:.2f} (−{2 * sig:.1f}%) any day by {d}?",
            {"type": "noul", "instructions": f"Will {t} close at or below ${thr:.2f} (a {2 * sig:.1f}% drop, 2 sigma) on "
                                             f"any trading day before {d}?"},
            str(d), ("base_rate", round(br, 4)), {"threshold": round(thr, 4), "from": str(today)},
            cause={"type": "choice", "instructions": f"If {t} drops sharply in the next 20 trading days, the most likely "
                                                     f"cause is:",
                   "criteria": {"earnings": "earnings result", "guidance": "guidance cut", "macro": "macro / market",
                                "sector": "sector move", "legal": "legal / regulatory", "none": "no sharp drop"}})
    # advisory (never resolved)
    far = str(today + dt.timedelta(days=ADVISORY_HORIZON_DAYS))
    add(f"adv_w:{t}:{today}", "advisory_weights", f"Are fildi's score weights sensible for {t}?",
        {"type": "score", "instructions": f"Given {t}'s profile, how sensible are fildi's score weights (see [weights])?",
         "criteria": ["clearly wrong", "questionable", "neutral", "sensible", "very sensible"]},
        far, None, {"advisory": True}, yes_keys=["3", "4"])
    if fv:
        add(f"adv_fv:{t}:{today}", "advisory_fv", f"Are fildi's fair-value assumptions for {t} plausible?",
            {"type": "choice", "instructions": f"Are the assumptions behind fildi's fair value for {t} (methods, implied "
                                               f"growth, confidence) too optimistic, about right, or too conservative?",
             "criteria": {"optimistic": "too optimistic", "about_right": "about right", "conservative": "too conservative"}},
            far, None, {"advisory": True}, yes_keys=["about_right"])
    return qs


# ---------- server lifecycle + metrics -----------------------------------------------------------------------
def _get(path: str, timeout: float = 5.0):
    with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
        return json.loads(r.read())


def _post(path: str, body: dict, timeout: float = 600.0):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


PEAK_CAP_GB = 24.0           # target peak footprint; watchdog kills the server above cap + 4 GB
HARD_STOP_S = 15 * 60        # watchdog: one run never exceeds 15 min
CACHE_STEPS_GB = (4.0, 2.0, 1.0, 0.5)   # MLX buffer-pool cap; guard lowers it one step when headroom is short


class Sampler(threading.Thread):
    """Peak memory of the server process tree, sampled every second (RSS + macOS phys_footprint).
    Watchdog: kills ONLY the OpenJev server's process group when the run passes HARD_STOP_S or PEAK_CAP_GB + 4."""

    def __init__(self, pid: int, t0: float):
        super().__init__(daemon=True)
        self.pid, self.t0, self.peak_gb, self.stop_ev, self.killed = pid, t0, 0.0, threading.Event(), None

    def sample(self) -> float:
        out = subprocess.run(["ps", "-o", "rss=", "-g", str(os.getpgid(self.pid))], capture_output=True,
                             text=True, timeout=5).stdout
        gb = sum(int(x) for x in out.split()) / 1048576
        fp = subprocess.run(["footprint", "-p", str(self.pid)], capture_output=True, text=True, timeout=10).stdout
        m = re.search(r"phys_footprint:\s*([\d.]+)\s*([KMG])B", fp) or re.search(r"Footprint:\s*([\d.]+)\s*([KMG])B", fp)
        if m:
            gb = max(gb, float(m.group(1)) / {"K": 1048576, "M": 1024, "G": 1}[m.group(2)])
        return gb

    def run(self):
        while not self.stop_ev.is_set():
            try:
                gb = self.sample()
                self.peak_gb = max(self.peak_gb, gb)
                why = (f"run > {HARD_STOP_S // 60} min" if time.time() - self.t0 > HARD_STOP_S
                       else f"memory {gb:.1f} GB > {PEAK_CAP_GB + 4:.0f} GB" if gb > PEAK_CAP_GB + 4 else None)
                if why:
                    self.killed = why
                    os.killpg(os.getpgid(self.pid), signal.SIGKILL)
                    print(f"openjev watchdog: killed server ({why})", file=sys.stderr)
                    return
            except (ProcessLookupError, PermissionError):
                return
            except Exception:
                pass
            self.stop_ev.wait(1.0)


class Server:
    def __init__(self, cache_gb: float = CACHE_STEPS_GB[0]):
        self.proc = None
        self.load_s = None
        self.sampler = None
        self.cache_gb = cache_gb

    def __enter__(self):
        try:
            _get("/health", 2)
            raise RuntimeError(f"something already listens on {BASE}; refusing to share it")
        except (urllib.error.URLError, ConnectionError, OSError):
            pass
        env = {**os.environ, **SERVER_ENV, "OPENJEV_MLX_CACHE_LIMIT_GB": str(self.cache_gb)}
        os.makedirs("/tmp/fildi-logs", exist_ok=True)
        log = open("/tmp/fildi-logs/openjev-server.log", "w")
        t0 = time.time()
        self.proc = subprocess.Popen([str(OJ_PY), "-m", "openjev"], cwd=str(ROOT / "research/openjev/src"), env=env,
                                     stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        self.sampler = Sampler(self.proc.pid, t0)
        self.sampler.start()
        while time.time() - t0 < HARD_STOP_S:
            if self.proc.poll() is not None:
                raise RuntimeError(f"openjev server exited during load ({self.sampler.killed or 'see openjev-server.log'})")
            try:
                _get("/health", 2)
                _post("/v1/systemone", {"model": MODEL, "state": "warmup",
                                        "questions": {"w": {"type": "noul", "instructions": "Is this a test?"}}}, 600)
                self.load_s = round(time.time() - t0, 1)
                return self
            except (urllib.error.URLError, ConnectionError, OSError, json.JSONDecodeError):
                time.sleep(2)
        raise RuntimeError("openjev server not ready within the 15-min hard stop")

    def __exit__(self, *exc):
        if self.proc and self.proc.poll() is None:
            os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
            try:
                self.proc.wait(30)
            except subprocess.TimeoutExpired:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)
        if self.sampler:
            self.sampler.stop_ev.set()
        return False


def ask(state_text: str, qs: list[dict]) -> tuple[dict, float, int]:
    questions = {}
    for i, q in enumerate(qs):
        questions[f"q{i}"] = q["oj"]
        if q.get("cause"):
            questions[f"c{i}"] = q["cause"]
    t0 = time.time()
    r = _post("/v1/systemone", {"model": MODEL, "state": state_text, "questions": questions})
    return r.get("answers", {}), time.time() - t0, int((r.get("usage") or {}).get("input_tokens") or 0)


# ---------- ledger writes ------------------------------------------------------------------------------------
def ledger_rows(qs: list[dict], answers: dict, made_at: dt.datetime, extra_meta: dict | None = None) -> list[tuple]:
    rows = []
    made_on = made_at.astimezone(PT).date()
    for i, q in enumerate(qs):
        a = answers.get(f"q{i}")
        p = p_from_answer(q, a) if a else None
        meta = {**q["meta"], **(extra_meta or {})}
        if a and a.get("probabilities"):
            meta["probabilities"] = a["probabilities"]
        if answers.get(f"c{i}"):
            meta["cause"] = answers[f"c{i}"].get("probabilities")
            meta["cause_grade"] = "pending manual"
        if p is not None:
            rows.append((q["question_id"], q["question"], q["qtype"], q["subject"], FORECASTER,
                         round(min(1.0, max(0.0, float(p))), 4), made_at, made_on, q["resolves_on"], json.dumps(meta)))
        if q["baseline"]:
            f, bp = q["baseline"]
            rows.append((q["question_id"], q["question"], q["qtype"], q["subject"], f, round(float(bp), 4), made_at,
                         made_on, q["resolves_on"], json.dumps(q["meta"])))
    return rows


def write_rows(conn, rows: list[tuple]) -> None:
    import forecast_ledger as fl
    conn.execute(fl.DDL)
    for r in rows:
        conn.execute(fl.UPSERT, r)
    conn.commit()


ABL_DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.openjev_ablation (
  id bigserial PRIMARY KEY, run_at timestamptz NOT NULL, ticker text NOT NULL, question_id text NOT NULL,
  qtype text NOT NULL, dropped text NOT NULL, prob real, full_prob real, shift real, input_tokens int)"""
RUN_DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.openjev_runs (
  id bigserial PRIMARY KEY, run_at timestamptz NOT NULL, ok boolean NOT NULL, detail text, tickers int, questions int,
  answered int, load_s real, total_s real, peak_gb real, per_q_ms real, input_tokens bigint, stats jsonb)"""
# Frozen daily inputs (coordinator 10-16): states + questions snapshotted at 05:30; answers always use this snapshot.
BATCH_DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.openjev_batches (
  made_on date PRIMARY KEY, frozen_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'frozen',
  items jsonb NOT NULL, attempts jsonb NOT NULL DEFAULT '[]'::jsonb, answered_at timestamptz, detail text)"""
FREEZE_AT = dt.time(5, 30)
WINDOWS = ((dt.time(5, 30), dt.time(9, 0)), (dt.time(21, 0), dt.time(23, 30)))   # retry every 15 min inside these
HEADROOM_GB = 8.0
DEFAULT_PEAK_GB = 24.0       # until a run has been measured


# ---------- run ----------------------------------------------------------------------------------------------
def build_ctx(conn, today: dt.date) -> dict:
    held = held_puts(conn)
    recs, picks = model_list(conn)
    held_by: dict[str, list] = {}
    for p in held:
        if p.get("expiry", "") > str(today):
            held_by.setdefault(p["ticker"], []).append(p)
    held_t = sorted({p["ticker"] for p in held})
    picks_by: dict[str, list] = {}
    for p in picks:
        picks_by.setdefault(p["ticker"], []).append(p)
    accts = tuple(sorted({p.get("account") for p in held if p.get("account")}))
    return {"held": held_t, "held_by_ticker": held_by, "picks": picks, "picks_by_ticker": picks_by,
            "model_list": {t: r for t, r in recs.items()}, "weights": load_weights(conn), "account_names": accts,
            "universe": build_universe(conn, held_t, recs, picks, today)}


def prepare(conn, today: dt.date) -> tuple[dict, list[tuple[str, dict, list[dict]]]]:
    ctx = build_ctx(conn, today)
    batch = []
    for t in ctx["universe"]:
        st = build_state(conn, t, ctx)
        qs = [q for q in questions_for(conn, t, st, ctx, today) if q["resolves_on"] > str(today)]   # forward-only
        if qs:
            batch.append((t, st, qs))
    return ctx, batch


def freeze(conn, now: dt.datetime | None = None) -> dict:
    """Snapshot today's states + questions once (idempotent). made_at for every answer = frozen_at."""
    now = now or dt.datetime.now(PT)
    today = now.date()
    conn.execute(BATCH_DDL)
    r = conn.execute("SELECT frozen_at, status, jsonb_array_length(items) FROM watchlist_sync.openjev_batches "
                     "WHERE made_on = %s", (today,)).fetchone()
    if r:
        return {"made_on": str(today), "frozen_at": str(r[0]), "status": r[1], "tickers": r[2], "new": False}
    ctx, batch = prepare(conn, today)
    items = [{"ticker": t, "state": st, "state_text": render_state(t, st), "questions": qs,
              "held": t in ctx["held"]} for t, st, qs in batch]
    conn.execute("INSERT INTO watchlist_sync.openjev_batches (made_on, frozen_at, items) VALUES (%s, %s, %s)",
                 (today, now, json.dumps(items, default=str)))
    conn.commit()
    return {"made_on": str(today), "frozen_at": str(now), "status": "frozen", "tickers": len(items),
            "questions": sum(len(i["questions"]) for i in items), "new": True}


def write_last(ok: bool, detail: str) -> None:
    try:
        LAST_FILE.parent.mkdir(parents=True, exist_ok=True)
        LAST_FILE.write_text(json.dumps({"ts": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
                                         "ok": ok, "detail": detail}))
    except OSError:
        pass


def free_ram_gb() -> float | None:
    vm = subprocess.run(["memory_pressure", "-Q"], capture_output=True, text=True).stdout
    m = re.search(r"free percentage:\s*(\d+)", vm)
    total = int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True).stdout.strip() or 0)
    return round(int(m.group(1)) / 100 * total / 2 ** 30, 1) if m and total else None


def on_ac() -> bool:
    return "AC Power" in subprocess.run(["pmset", "-g", "batt"], capture_output=True, text=True).stdout


def measured_peak(conn) -> tuple[float, float | None]:
    """(peak GB of the last good run, the MLX cache cap it ran with)."""
    conn.execute(RUN_DDL)
    r = conn.execute("""SELECT peak_gb, (stats->>'cache_gb')::float FROM watchlist_sync.openjev_runs
                        WHERE ok AND peak_gb > 0 ORDER BY run_at DESC LIMIT 1""").fetchone()
    return (float(r[0]), r[1]) if r else (DEFAULT_PEAK_GB, None)


def guard(conn) -> tuple[bool, str, float]:
    """free RAM ≥ measured peak + 8 GB headroom AND on AC. Short on headroom → lower the MLX cache cap one step and
    re-check. Returns (ok, why, cache_gb to run with). Never touches other apps."""
    peak, ran_cache = measured_peak(conn)
    free, ac = free_ram_gb(), on_ac()
    if not ac:
        return False, "on battery", CACHE_STEPS_GB[0]
    if free is None:
        return False, "free RAM unknown", CACHE_STEPS_GB[0]
    base = ran_cache if ran_cache is not None else CACHE_STEPS_GB[0]
    for cache in CACHE_STEPS_GB:
        need = peak - max(0.0, base - cache) + HEADROOM_GB
        if free >= need:
            return True, f"ok: free {free} GB ≥ need {need:.1f} GB (peak {peak} GB, cache cap {cache} GB)", cache
    return False, f"free {free} GB < need {peak - (base - CACHE_STEPS_GB[-1]) + HEADROOM_GB:.1f} GB at the lowest cap", \
        CACHE_STEPS_GB[-1]


def in_window(t: dt.time) -> bool:
    return any(a <= t < b for a, b in WINDOWS)


def answer(conn, made_on: dt.date | None = None, ablate: bool = False, force: bool = False) -> dict:
    """Answer a frozen batch (default today). Uses the frozen state + frozen_at as made_at."""
    conn.execute(BATCH_DDL)
    made_on = made_on or dt.datetime.now(PT).date()
    b = conn.execute("SELECT frozen_at, status, items FROM watchlist_sync.openjev_batches WHERE made_on = %s",
                     (made_on,)).fetchone()
    if not b:
        return {"error": f"no frozen batch for {made_on}"}
    frozen_at, status, items = b
    if status == "answered" and not force:
        return {"status": "already answered", "made_on": str(made_on)}
    ok, why, cache = guard(conn)
    attempt = {"t": dt.datetime.now(PT).isoformat(timespec="seconds"), "ok": ok or force, "why": why}
    conn.execute("UPDATE watchlist_sync.openjev_batches SET attempts = attempts || %s::jsonb WHERE made_on = %s",
                 (json.dumps([attempt]), made_on))
    conn.commit()
    if not ok and not force:
        write_last(True, f"waiting: {why}")
        return {"waiting": why}
    t0 = time.time()
    stats = {"by_type": {}, "latency_ms": [], "guard": why, "cache_gb": cache}
    rows: list[tuple] = []
    tokens = answered = 0
    nq = sum(len(i["questions"]) for i in items)
    abl: list[tuple] = []
    srv = Server(cache)
    try:
        with srv:
            for it in items:
                qs = it["questions"]
                ans, sec, tok = ask(it["state_text"], qs)
                tokens += tok
                stats["latency_ms"].append(round(sec * 1000 / max(1, len(qs)), 1))
                rows += ledger_rows(qs, ans, frozen_at)
                for i, q in enumerate(qs):
                    if f"q{i}" in ans:
                        answered += 1
                        stats["by_type"][q["qtype"]] = stats["by_type"].get(q["qtype"], 0) + 1
            if ablate:
                abl = ablation([(i["ticker"], i["state"], i["questions"]) for i in items[:6]], frozen_at)
    except Exception as e:
        killed = srv.sampler.killed if srv.sampler else None
        _record_run(conn, frozen_at, False, f"{killed or e}"[:300], len(items), nq, 0, srv.load_s,
                    round(time.time() - t0, 1), srv.sampler.peak_gb if srv.sampler else 0, None, tokens, stats, 0)
        write_last(False, f"failed: {killed or e}"[:300])
        raise
    write_rows(conn, rows)
    conn.execute(ABL_DDL)
    for r in abl:
        conn.execute("""INSERT INTO watchlist_sync.openjev_ablation (run_at, ticker, question_id, qtype, dropped, prob,
                        full_prob, shift, input_tokens) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""", r)
    total = round(time.time() - t0, 1)
    per_q = round(statistics.mean(stats["latency_ms"]), 1) if stats["latency_ms"] else None
    peak = srv.sampler.peak_gb if srv.sampler else 0
    _record_run(conn, frozen_at, True, why, len(items), nq, answered, srv.load_s, total, peak, per_q, tokens, stats, len(abl))
    conn.execute("""UPDATE watchlist_sync.openjev_batches SET status = 'answered', answered_at = now(), detail = %s
                    WHERE made_on = %s""", (f"{answered}/{nq} answered", made_on))
    conn.commit()
    out = {"made_on": str(made_on), "tickers": len(items), "held": sum(1 for i in items if i["held"]), "questions": nq,
           "answered": answered, "load_s": srv.load_s, "total_s": total, "peak_gb": round(peak, 2), "per_q_ms": per_q,
           "input_tokens": tokens, "cache_gb": cache, "by_type": stats["by_type"], "ablation_rows": len(abl)}
    write_last(True, f"{answered}/{nq} answered, {len(items)} tickers, peak {out['peak_gb']} GB, {total}s")
    return out


def _record_run(conn, run_at, ok, detail, tickers, nq, answered, load_s, total, peak, per_q, tokens, stats, n_abl):
    conn.execute(RUN_DDL)
    conn.execute("""INSERT INTO watchlist_sync.openjev_runs (run_at, ok, detail, tickers, questions, answered, load_s,
                    total_s, peak_gb, per_q_ms, input_tokens, stats) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                 (run_at, ok, detail, tickers, nq, answered, load_s, total, round(peak or 0, 2), per_q, tokens,
                  json.dumps({k: v for k, v in stats.items() if k != "latency_ms"} | {"ablation_rows": n_abl})))
    conn.commit()


def tick(conn, now: dt.datetime | None = None) -> dict:
    """LaunchAgent entry (every 15 min + on load/wake): freeze at ≥ 05:30; answer inside a window (under
    `caffeinate -s` = stay awake only while on AC, only for the run); after the last window, mark the day missed."""
    now = now or dt.datetime.now(PT)
    today, t = now.date(), now.time()
    conn.execute(BATCH_DDL)
    # yesterday (or older) still frozen after its last window → missed
    conn.execute("""UPDATE watchlist_sync.openjev_batches SET status = 'missed', detail = 'both windows failed'
                    WHERE status = 'frozen' AND made_on < %s""", (today,))
    conn.commit()
    if t < FREEZE_AT:
        return {"idle": "before 05:30"}
    fz = freeze(conn, now)
    if fz["status"] != "frozen":
        return {"done": fz["status"]}
    if t >= WINDOWS[-1][1]:
        conn.execute("""UPDATE watchlist_sync.openjev_batches SET status = 'missed', detail = 'both windows failed'
                        WHERE made_on = %s AND status = 'frozen'""", (today,))
        conn.commit()
        write_last(False, "missed: both windows failed")
        return {"missed": str(today)}
    if not in_window(t):
        return {"waiting": "between windows"}
    ok, why, _ = guard(conn)
    if not ok:
        conn.execute("UPDATE watchlist_sync.openjev_batches SET attempts = attempts || %s::jsonb WHERE made_on = %s",
                     (json.dumps([{"t": now.isoformat(timespec="seconds"), "ok": False, "why": why}]), today))
        conn.commit()
        write_last(True, f"waiting: {why}")
        return {"waiting": why}
    # run the answer step in a child under caffeinate -s so the Mac stays awake (on AC) only for the run
    cmd = ["/usr/bin/caffeinate", "-s", sys.executable, str(Path(__file__).resolve()), "--answer"]
    r = subprocess.run(cmd, cwd=str(HERE), capture_output=True, text=True, timeout=HARD_STOP_S + 120)
    return {"answer_exit": r.returncode, "tail": (r.stdout or r.stderr)[-400:]}


def ablation(batch, now) -> list[tuple]:
    rows = []
    for t, st, qs in batch:
        scored = [q for q in qs if not q["qtype"].startswith("advisory")]
        if not scored:
            continue
        full, _, _ = ask(render_state(t, st), scored)
        fullp = {i: p_from_answer(q, full[f"q{i}"]) for i, q in enumerate(scored) if f"q{i}" in full}
        for g in st:
            if not st[g]:
                continue
            a, _, tok = ask(render_state(t, st, drop=g), scored)
            for i, q in enumerate(scored):
                if f"q{i}" in a and i in fullp and fullp[i] is not None:
                    p = p_from_answer(q, a[f"q{i}"])
                    if p is not None:
                        rows.append((now, t, q["question_id"], q["qtype"], g, round(p, 4), round(fullp[i], 4),
                                     round(p - fullp[i], 4), tok))
    return rows


def bias_check() -> dict:
    with Server():
        a = _post("/v1/systemone", {"model": MODEL, "state": "",
                                    "questions": {"ab": {"type": "choice", "instructions": "Pick one.",
                                                         "criteria": {"A": "option A", "B": "option B"}},
                                                  "ba": {"type": "choice", "instructions": "Pick one.",
                                                         "criteria": {"B": "option B", "A": "option A"}}}})
    return a.get("answers", {})


def ask_needs(conn) -> str:
    today = dt.datetime.now(PT).date()
    ctx, batch = prepare(conn, today)
    seen, out = {}, []
    for t, st, qs in batch:
        for q in qs:
            seen.setdefault(q["qtype"], (t, st, q))
    with Server():
        for qtype, (t, st, q) in sorted(seen.items()):
            prompt = (f"{render_state(t, st)}\n\nQuestion you will be asked: {q['oj']['instructions']}\n\n"
                      "For answering this question as accurately as possible: (1) which of the data groups above "
                      "([market], [options], [scores], [weights], [fair_value], [street], [short_interest], [earnings], "
                      "[guidance], [model_list]) help most, (2) which are noise you would drop, (3) what missing data "
                      "would help most. Answer in at most 8 short bullet lines.")
            r = _post("/v1/chat/completions", {"model": "diffusiongemma-26b", "max_tokens": 300, "temperature": 0,
                                                "messages": [{"role": "user", "content": prompt}]})
            txt = r["choices"][0]["message"]["content"].strip()
            out.append(f"## {qtype} (sample ticker {t})\n{txt}\n")
    md = (f"# A129 — what OpenJev says it needs (local 26B, {today})\n"
          "Self-report only: a hint. The ablation pass (`openjev_local.py --ablate`, table "
          "`watchlist_sync.openjev_ablation`) decides which field groups stay.\n\n" + "\n".join(out))
    NEEDS_MD.write_text(md)
    return md


def dry_run(conn) -> dict:
    today = dt.datetime.now(PT).date()
    ctx, batch = prepare(conn, today)
    toks = [est_tokens(render_state(t, st)) for t, st, _ in batch]
    by: dict[str, int] = {}
    for _, _, qs in batch:
        for q in qs:
            by[q["qtype"]] = by.get(q["qtype"], 0) + 1
    if batch:
        t, st, qs = batch[0]
        p = Path(os.environ.get("TMPDIR", "/tmp")) / "openjev-sample.json"
        p.write_text(json.dumps({"state": render_state(t, st), "questions": {f"q{i}": q["oj"] for i, q in enumerate(qs)}},
                                indent=1))
    return {"tickers": len(batch), "held": len(ctx["held"]), "questions": sum(by.values()), "by_type": by,
            "state_tokens_avg": round(statistics.mean(toks)) if toks else 0, "state_tokens_max": max(toks or [0])}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--freeze", action="store_true", help="snapshot today's states + questions (idempotent)")
    ap.add_argument("--answer", action="store_true", help="answer today's frozen batch (guarded)")
    ap.add_argument("--tick", action="store_true", help="LaunchAgent entry: freeze / retry-in-window / missed")
    ap.add_argument("--ablate", action="store_true")
    ap.add_argument("--force", action="store_true", help="ignore the resource guard")
    ap.add_argument("--ask-needs", action="store_true")
    ap.add_argument("--bias-check", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    from build_plan import connect
    conn = connect()
    try:
        if a.dry_run:
            print(json.dumps(dry_run(conn), indent=1))
        if a.bias_check:
            print(json.dumps(bias_check(), indent=1))
        if a.freeze:
            print(json.dumps(freeze(conn), indent=1, default=str))
        if a.answer:
            print(json.dumps(answer(conn, ablate=a.ablate, force=a.force), indent=1, default=str))
        if a.tick:
            print(json.dumps(tick(conn), indent=1, default=str))
        if a.ask_needs:
            print(ask_needs(conn))
    except Exception as e:
        write_last(False, f"failed: {e}"[:300])
        raise


if __name__ == "__main__":
    main()
