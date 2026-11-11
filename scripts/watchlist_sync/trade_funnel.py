"""Trade funnel — step 3 of research/common/trade-funnel-plan.md (Jamie 11-09).

S175/S176: neither market regime nor sector/movers can cut the search without losing winners (recall 12 % / lift ≈ 1).
So: price EVERY name × family cheaply (daily bars + LSEG iv30, $0) → rank on tested stock-level edge + cheap vol EV,
regime only as a prior → real Schwab chains (skew_survey) for the top of the ranking only → one ranked Today list.

  shortlist (before skew_survey):  regime → universe → cheap price → rank → shortlist   (stages logged)
  today     (after the boards):    every live/candidate/paper pick (put_recs, structures primary, strategy_signals)
                                   → one ranked list, stage 'today'

Every stage writes watchlist_sync.trade_funnel_daily (as_of, stage, ticker, family, kept, reason, score, payload) so the
end-of-day audit (step 4) can say which stage dropped a missed winner. Score weights below are NOT validated — the
step-4 recall of the 'shortlist' stage is the test; change them only through that audit.

    .venv/bin/python trade_funnel.py [shortlist|today] [--dry] [--as-of=YYYY-MM-DD]   (as-of = replay, eod_audit step 4)
"""
from __future__ import annotations

import json
import math
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from statistics import NormalDist

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "analysis"))
from build_plan import connect, rows  # noqa: E402

S175 = HERE.parent.parent / "research/studies/data/s175_regime_structures.json"
DTE = 30
FILL = 0.05            # cheap stage: lose 5 % of premium to the spread each way (RH fill ≈ bid + 23 % of spread)
K = {"short_put": 80, "long_call": 50, "long_put": 30}      # chains for the top K per family (+ forced names)
DELTA = {"short_put": 0.20, "long_call": 0.50, "long_put": 0.50}
S175_ID = {"short_put": "csp", "long_call": "long_call", "long_put": "long_put"}
OFF_PRIOR = 0.7        # family not allowed in today's S175 regime cell → score × 0.7 (prior, never a cut — S175 recall 12 %)
N = NormalDist()

DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.trade_funnel_daily (
  as_of date NOT NULL, stage text NOT NULL, ticker text NOT NULL, family text NOT NULL DEFAULT '',
  kept boolean NOT NULL, reason text, score double precision, payload jsonb, run_at timestamptz DEFAULT now(),
  PRIMARY KEY (as_of, stage, ticker, family))"""


def bs(S, K_, v, t, put):
    if v <= 0 or t <= 0:
        return max(K_ - S, 0.0) if put else max(S - K_, 0.0)
    d1 = (math.log(S / K_) + 0.5 * v * v * t) / (v * math.sqrt(t))
    d2 = d1 - v * math.sqrt(t)
    return K_ * N.cdf(-d2) - S * N.cdf(-d1) if put else S * N.cdf(d1) - K_ * N.cdf(d2)


def strike_at(S, v, t, delta, put):
    """Strike with |Δ| = delta at vol v (r = 0)."""
    d1 = N.inv_cdf(1 - delta) if put else N.inv_cdf(delta)
    return S * math.exp(-d1 * v * math.sqrt(t) + 0.5 * v * v * t)


# ── stage 0: regime (same labels as S175, live inputs) ──────────────────────────────────────────────────────────────
def regime(conn, d0: date | None = None) -> dict:
    d0 = d0 or date.today()
    c = conn.execute("""SELECT a.date, a.value / b.value, a.value FROM watchlist_sync.macro_daily a
                        JOIN watchlist_sync.macro_daily b ON b.date = a.date AND b.series = 'vix3m'
                        WHERE a.series = 'vix' AND b.value > 0 AND a.date <= %s ORDER BY a.date DESC LIMIT 15""", (d0,)).fetchall()[::-1]
    spy = [float(x) for (x,) in conn.execute("""SELECT close FROM lseg_research.daily_history WHERE ticker = 'SPY' AND close > 0 AND date <= %s
                                                ORDER BY date DESC LIMIT 201""", (d0,)).fetchall()][::-1]
    if not c:
        return {"label": "other", "why": "no VIX curve"}
    d, r, vix = c[-1][0], float(c[-1][1]), float(c[-1][2])
    ratios = [float(x[1]) for x in c]
    run, uninv_ago = 0, None
    for k in range(len(ratios) - 1, -1, -1):        # sessions since the last un-invert (≥ 2 inverted then < 1)
        if k >= 2 and ratios[k] < 1 and ratios[k - 1] >= 1 and ratios[k - 2] >= 1:
            uninv_ago = len(ratios) - 1 - k
            break
    st = {"date": str(d), "vix_ratio": round(r, 3), "vix": round(vix, 1)}
    if r >= 1:
        return {**st, "label": "panic"}
    if uninv_ago is not None and uninv_ago < 10:
        return {**st, "label": "bottom", "uninvert_sessions_ago": uninv_ago}
    if len(spy) >= 64 and spy[-1] / spy[-64] - 1 <= -0.08:
        return {**st, "label": "sharp_drop", "spy_63d": round(spy[-1] / spy[-64] - 1, 3)}
    if len(spy) >= 200 and spy[-1] > sum(spy[-200:]) / 200 and vix < 20:
        return {**st, "label": "calm_up"}
    return {**st, "label": "other"}


def allowed(label: str) -> set[str]:
    try:
        return set(json.loads(S175.read_text())["allowed"].get(label, []))
    except Exception:
        return set()


def pct_rank(d: dict) -> dict:
    ks = sorted(d, key=lambda k: d[k])
    n = max(len(ks) - 1, 1)
    return {k: i / n for i, k in enumerate(ks)}


def log(conn, as_of, out):
    conn.execute(DDL)
    stages = sorted({o[0] for o in out})
    conn.execute("DELETE FROM watchlist_sync.trade_funnel_daily WHERE as_of = %s AND stage = ANY(%s)", (as_of, stages))
    with conn.cursor() as cur:
        cur.executemany("""INSERT INTO watchlist_sync.trade_funnel_daily (as_of, stage, ticker, family, kept, reason, score, payload)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
                        [(as_of, s, t, f, k, r, sc, json.dumps(p, default=str)) for s, t, f, k, r, sc, p in out])


# ── shortlist mode ────────────────────────────────────────────────────────────────────────────────────────────────
def shortlist(conn, dry: bool, d0: date | None = None):
    today = d0 or date.today()
    reg = regime(conn, today)
    ok_s = allowed(reg["label"])
    out = [("regime", "MARKET", "", True, reg["label"], None, {**reg, "allowed": sorted(ok_s)})]
    hist = defaultdict(list)
    ivs = {}
    ivh = defaultdict(list)   # call iv30 history → IV percentile (S177)
    for t, d, c, ip, ic in conn.execute("""SELECT ticker, date, close::float8, iv30_put::float8, iv30_call::float8
                                           FROM lseg_research.daily_history WHERE date BETWEEN %s::date - 420 AND %s AND close > 0
                                           ORDER BY ticker, date""", (today, today)):
        hist[t].append(c)
        if ic:
            ivh[t].append(ic / 100)
        if ip and ic and d >= today - timedelta(days=6):
            ivs[t] = (ip / 100, ic / 100, d)
    edge = {t: float(b) for t, b in conn.execute("""SELECT ticker, pnl_bp FROM watchlist_sync.put_edge_daily
              WHERE as_of = (SELECT MAX(as_of) FROM watchlist_sync.put_edge_daily WHERE as_of <= %s) AND pnl_bp IS NOT NULL""", (today,))}
    board = conn.execute("SELECT payload->'overlap' FROM watchlist_sync.long_option_board WHERE as_of <= %s ORDER BY as_of DESC LIMIT 1", (today,)).fetchone()
    ov = {"long_call": dict((board[0] or {}).get("call", [])) if board else {},
          "long_put": dict((board[0] or {}).get("put", [])) if board else {}}
    T = DTE / 365
    call_edge, call_terms = {}, {}
    priced = {f: {} for f in K}
    for t, cl in hist.items():
        why = ("history < 260 closes" if len(cl) < 260 else "no iv30 in 6 d" if t not in ivs
               else "price < $5" if cl[-1] < 5 else None)
        out.append(("universe", t, "", why is None, why or "ok", None, {}))
        if why:
            continue
        S = cl[-1]
        # S177 (11-09) long-call entry terms: IV pctile vs own year (Q1 +23.8 % → Q5 −2.3 %, both eras), single-name crash
        # ret20 ≤ −15 % (−9.0 % vs +10.8 %, both eras), at a 52w high (−0.2 %), z50 ≥ +1.44 (Q5 +1.9 %)
        ih = ivh[t][-252:]
        ivp = sum(v <= ih[-1] for v in ih) / len(ih) if len(ih) >= 120 else 0.5
        m50 = sum(cl[-50:]) / 50
        s50 = (sum((x - m50) ** 2 for x in cl[-50:]) / 50) ** 0.5 or 1
        ret20, off_hi, z50 = S / cl[-21] - 1, S / max(cl[-252:]) - 1, (S - m50) / s50
        # S179 (11-09): ramps, not steps — pnl is a gradient across each cut (ret20 −16 % ≈ −14 %); same top-fifth within noise
        ramp = lambda x: min(max(x, 0.0), 1.0)
        call_edge[t] = ((1 - ivp) - 0.5 * ramp((-0.10 - ret20) / 0.20) - 0.3 * ramp((off_hi + 0.05) / 0.05)
                        - 0.2 * ramp((z50 - 1.0) / 0.9))
        call_terms[t] = {"ivp": round(ivp, 2), "ret20": round(ret20, 3), "off_hi": round(off_hi, 3), "z50": round(z50, 2)}
        lr = [math.log(cl[i] / cl[i - 1]) for i in range(len(cl) - 20, len(cl))]
        rv = (sum(x * x for x in lr) / len(lr) - (sum(lr) / len(lr)) ** 2) ** 0.5 * math.sqrt(252)
        ip, ic, _ = ivs[t]
        for f in K:
            put = f != "long_call"
            iv = ip if put else ic
            Kx = strike_at(S, iv, T, DELTA[f], put)
            p_iv, p_rv = bs(S, Kx, iv, T, put), bs(S, Kx, rv, T, put)
            if f == "short_put":   # $ kept per $ collateral over the month, zero drift, at RV
                ev = (p_iv * (1 - FILL) - p_rv) / Kx
            else:                  # long premium: expected payoff ÷ debit − 1
                ev = p_rv / (p_iv * (1 + FILL)) - 1 if p_iv > 0 else -1
            priced[f][t] = {**(call_terms[t] if f == "long_call" else {}), "spot": round(S, 2), "strike": round(Kx, 2), "iv": round(iv, 3), "rv20": round(rv, 3),
                            "prem": round(p_iv, 3), "ev": round(ev, 4)}
    shortlist_names: dict[str, float] = {}
    for f, px in priced.items():
        e_src = edge if f == "short_put" else call_edge if f == "long_call" else ov[f]   # calls: S177 terms (S086 overlap had no skill, eod_audit 11-09)
        pe = pct_rank({t: v["ev"] for t, v in px.items()})
        pg = pct_rank({t: e_src[t] for t in px if t in e_src})
        prior = 1.0 if S175_ID[f] in ok_s else OFF_PRIOR
        score = {t: prior * (0.5 * pe[t] + 0.5 * pg.get(t, 0.0)) for t in px}
        ranked = sorted(score, key=lambda t: -score[t])
        for i, t in enumerate(ranked, 1):
            p = {**px[t], "rank": i, "ev_pct": round(pe[t], 3), "edge_pct": round(pg[t], 3) if t in pg else None,
                 "edge": e_src.get(t), "prior": prior}
            keep = i <= K[f]
            out.append(("shortlist", t, f, keep, f"rank {i} ≤ {K[f]}" if keep else f"rank {i} > {K[f]}", round(score[t], 4), p))
            if keep:
                shortlist_names[t] = max(shortlist_names.get(t, 0), score[t])
    n_uni = sum(1 for o in out if o[0] == "universe" and o[3])
    print(f"trade_funnel shortlist: regime {reg['label']} (VIX÷VIX3M {reg.get('vix_ratio')}, allowed {sorted(ok_s) or '—'}) · "
          f"universe {n_uni}/{len(hist)} priced × {len(K)} families · shortlist {len(shortlist_names)} names "
          f"({', '.join(f'{f} {K[f]}' for f in K)})")
    for f in K:
        top = [o for o in out if o[0] == "shortlist" and o[2] == f and o[3]][:6]
        print(f"  {f:10s} " + ", ".join(f"{o[1]} {o[5]:.2f}" for o in top))
    if not dry:
        log(conn, today, out)
        conn.commit()


def chain_names(conn) -> list[str]:
    """Today's shortlist, best first (skew_survey reads this instead of put-edge Q4+). [] when the funnel hasn't run."""
    try:
        return [t for (t,) in conn.execute("""SELECT ticker FROM watchlist_sync.trade_funnel_daily
                   WHERE as_of = CURRENT_DATE AND stage = 'shortlist' AND kept GROUP BY 1 ORDER BY MAX(score) DESC""").fetchall()]
    except Exception:
        conn.rollback()
        return []


# ── today mode ────────────────────────────────────────────────────────────────────────────────────────────────────
TIER = {"live": 3, "candidate": 2, "board": 2, "paper": 1}



def provisional(conn, items) -> None:
    """11-11 (Jamie: TEAM 'sell put' with no strike): a rule that fired is priced for grading off the NEXT close (no
    look-ahead), so on the day it can be traded it has no contract. Show a provisional put from today's skew-survey chain at
    the rule's delta (21-50 DTE, two-sided quote); no chain → logged as a data issue for review."""
    need = [it for it in items if it["family"] == "short_put" and it.get("strike") is None]
    if not need:
        return
    try:
        from strategy_signals import SHADOW
    except Exception:  # noqa: BLE001
        SHADOW = {}
    import data_issues as DI
    for it in need:
        td = abs((SHADOW.get(it["source"]) or {}).get("delta", -0.20))
        r = conn.execute("""SELECT expiry, strike::float8, bid::float8, ask::float8 FROM optlab.skew_survey
                            WHERE ticker = %s AND side = 'put' AND as_of = (SELECT MAX(as_of) FROM optlab.skew_survey WHERE ticker = %s)
                              AND as_of >= CURRENT_DATE - 1 AND expiry BETWEEN CURRENT_DATE + 21 AND CURRENT_DATE + 50
                              AND delta IS NOT NULL AND bid > 0 AND ask - bid <= 0.5 * (ask + bid) / 2
                            ORDER BY abs(abs(delta) - %s), abs(expiry - (CURRENT_DATE + 35)) LIMIT 1""",
                         (it["ticker"], it["ticker"], td)).fetchone()
        if not r:
            if it["tier"] in ("live", "candidate"):
                DI.record("trade_funnel.py", "no_live_chain", ticker=it["ticker"], field=it["source"],
                          detail="fired live rule, no same-day chain in skew_survey → no provisional strike")
            continue
        e, k, b, a = r
        it.update(strike=k, expiry=str(e), bid=round((b + a) / 2, 2), provisional=True)
        it["chips"] = [*it.get("chips", []), f"provisional {td:.2f}Δ (today's chain; graded at next close)"]

def today_list(conn, dry: bool, d0: date | None = None):
    today = d0 or date.today()
    lib = {r["strategy_id"]: r for r in rows(conn, "SELECT strategy_id, status, name FROM watchlist_sync.strategies")}
    fscore = {(t, f): s for t, f, s in conn.execute("""SELECT ticker, family, score FROM watchlist_sync.trade_funnel_daily
               WHERE as_of = (SELECT MAX(as_of) FROM watchlist_sync.trade_funnel_daily WHERE stage = 'shortlist' AND as_of <= %s)
               AND stage = 'shortlist'""", (today,)).fetchall()}
    items = []
    # 1. the sold-put engine (put_recs_daily, gates empty = pass) — the live IRA/FILDI strategy
    for r in rows(conn, """SELECT ticker, payload p FROM watchlist_sync.put_recs_daily
                           WHERE as_of = (SELECT MAX(as_of) FROM watchlist_sync.put_recs_daily WHERE as_of <= %s)
                           AND jsonb_array_length(COALESCE(payload->'gates', '[]'::jsonb)) = 0""", (today,)):
        p = r["p"]
        items.append({"ticker": r["ticker"], "family": "short_put", "structure": "csp", "source": "put engine",
                      "tier": "live", "strike": p.get("strike"), "expiry": p.get("expiry"), "bid": p.get("bid"),
                      "metric": p.get("income_wk_pct"), "metric_label": "%/wk", "why": p.get("why"),
                      "chips": [c for c in ("s054" if p.get("s054") else None, "rich" if p.get("rich") else None) if c]})
    # 2. Strategies board primary tier (regime-fit + EV > 0 on real ladders)
    for r in rows(conn, """SELECT structure, ticker, payload p FROM watchlist_sync.structure_rank_daily
                           WHERE as_of = (SELECT MAX(as_of) FROM watchlist_sync.structure_rank_daily WHERE as_of <= %s) AND payload->>'tier' = 'primary'""", (today,)):
        p = r["p"]
        if r["structure"] == "csp" and any(i["ticker"] == r["ticker"] and i["family"] == "short_put" for i in items):
            continue   # same pick as the put engine (A277: one sold-put engine)
        fam = "short_put" if r["structure"] in ("csp", "put_spread", "jade_lizard") else \
              "long_call" if r["structure"] in ("long_call", "bull_call_spread") else \
              "long_put" if r["structure"] in ("long_put", "bear_put_spread") else r["structure"]
        legs = p.get("legs") or []
        items.append({"ticker": r["ticker"], "family": fam, "structure": r["structure"], "source": "strategies board",
                      "tier": "board", "strike": legs[0].get("strike") if legs else None, "expiry": p.get("expiry"),
                      "metric": round(100 * p["ev_rv_cap"], 2) if p.get("ev_rv_cap") is not None else None,
                      "metric_label": "EV %", "why": p.get("fit_why"), "chips": []})
    # 3. every registered rule firing (strategy_signals open/priced in the last 3 sessions; 'listed' = model-priced extras, skipped)
    for r in rows(conn, """SELECT DISTINCT ON (strategy_id, ticker) strategy_id, ticker, trigger, occ, expiry, strike, entry_mid, status, details
                           FROM watchlist_sync.strategy_signals WHERE status IN ('open', 'priced', 'graded', 'settled') AND as_of <= %(d)s
                           AND as_of >= (SELECT MIN(d) FROM (SELECT DISTINCT as_of d FROM watchlist_sync.strategy_signals
                                         WHERE as_of <= %(d)s ORDER BY 1 DESC LIMIT 2) x)       -- fired in the last 2 signal days, not last week's
                           AND (expiry IS NULL OR expiry >= %(d)s) ORDER BY strategy_id, ticker, as_of DESC""", {"d": today}):
        sid = r["strategy_id"]
        st = (lib.get(sid) or {}).get("status")
        if st == "failed":
            continue
        put = "put" in sid
        items.append({"ticker": r["ticker"], "family": "short_put" if put else "long_call", "structure": "csp" if put else "rule",
                      "source": sid, "tier": st if st in TIER else "paper", "strike": r["strike"],
                      "expiry": str(r["expiry"]) if r["expiry"] else None, "bid": r["entry_mid"],
                      "metric": None, "metric_label": "", "why": r["trigger"], "chips": [r["status"]]})
    # 4. long-option paper boards in forecast_ledger (S172 index calls at the un-invert = PASS → candidate; S171 = underpowered → paper)
    for r in rows(conn, """SELECT subject, forecaster, meta FROM watchlist_sync.forecast_ledger
                           WHERE qtype = 'long_call_ts' AND made_on BETWEEN %s::date - 3 AND %s
                           AND (outcome IS NULL OR %s < CURRENT_DATE)""", (today, today, today)):
        m = r["meta"] or {}
        put = m.get("side") == "put"
        items.append({"ticker": r["subject"], "family": "long_put" if put else "long_call", "structure": m.get("structure", "long_call"),
                      "source": r["forecaster"], "tier": "candidate" if r["forecaster"] == "S172" else "paper",
                      "strike": m.get("strike"), "expiry": m.get("expiry"), "bid": m.get("debit"), "metric": None,
                      "metric_label": "", "why": m.get("rule"), "chips": []})
    provisional(conn, items)
    # one row per (ticker, family): keep the highest tier, merge sources
    best: dict = {}
    for it in items:
        k = (it["ticker"], it["family"])
        # 11-11: same tier → the row with a contract wins (TEAM: unpriced put_z50 'open' hid the priced panic-puts 130P → "— —")
        if k not in best or TIER[it["tier"]] > TIER[best[k]["tier"]] or (
                TIER[it["tier"]] == TIER[best[k]["tier"]] and best[k].get("strike") is None and it.get("strike") is not None):
            it["sources"] = sorted({it["source"], *(best[k]["sources"] if k in best else [])})
            best[k] = it
        else:
            best[k]["sources"] = sorted({*best[k]["sources"], it["source"]})
    reg = regime(conn, today)
    ok_s = allowed(reg["label"])
    for it in best.values():
        it["regime_fit"] = it["structure"] in ok_s or S175_ID.get(it["family"]) in ok_s
    # tier (evidence) first; inside a tier the S175 regime prior, then agreeing rules, then the funnel score
    ranked = sorted(best.values(), key=lambda i: (-TIER[i["tier"]], not i["regime_fit"], -len(i["sources"]),
                                                  -(fscore.get((i["ticker"], i["family"])) or 0), i["ticker"]))
    out = []
    for n, it in enumerate(ranked, 1):
        it["rank"] = n
        it["funnel_score"] = fscore.get((it["ticker"], it["family"]))
        out.append(("today", it["ticker"], it["family"], True, it["tier"], it["funnel_score"], it))
    by_tier = defaultdict(int)
    for it in ranked:
        by_tier[it["tier"]] += 1
    miss = sum(1 for it in ranked if it["funnel_score"] is None)
    print(f"trade_funnel today: {len(ranked)} picks ({', '.join(f'{k} {v}' for k, v in sorted(by_tier.items()))}) · "
          f"{miss} not in the funnel ranking (no iv30 / index)")
    for it in ranked[:8]:
        print(f"  {it['rank']:2d} {it['ticker']:6s} {it['family']:10s} {it['tier']:9s} {'+'.join(it['sources'])}")
    if not dry:
        log(conn, today, out)
        conn.commit()


if __name__ == "__main__":
    mode = next((a for a in sys.argv[1:] if not a.startswith("--")), "shortlist")
    d = next((date.fromisoformat(a.split("=", 1)[1]) for a in sys.argv if a.startswith("--as-of=")), None)   # replay a past day
    with connect() as c:
        (today_list if mode == "today" else shortlist)(c, "--dry" in sys.argv, d)
