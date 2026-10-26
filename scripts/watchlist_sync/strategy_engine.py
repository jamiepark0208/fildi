"""Strategy rules engine (Jamie 10-24: one rules engine; same inputs for every strategy, direction flips; sell rich / buy cheap).

Reads strategy_rules.json `engine` (the one home) and applies it to option-structure candidates. Three calls for structures.py
(and, through Cursor's Model List ↔ Structures unification, the Model List):

  I = load_inputs(conn, tickers)          # same inputs on every row: IV rank (resolver), put-edge Q, Model List verdict/OWN,
                                          #   credit, StarMine ARM (revisions), 60-day return
  ok, why = fit(c, I, ctx)                # hard gates of the candidate's strategy (c = structures.py candidate dict)
  key = rank_key(cands, strategy)         # sign-weighted within-day ranks of the strategy's rank inputs
  csp_band_legs(chain, ...)               # put strike per |Δ| band (ladder) — default band + re-strike from the rules file

  .venv/bin/python strategy_engine.py     # before/after on today's structures candidates (read-only, writes nothing)
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
RULES = json.loads((HERE / "strategy_rules.json").read_text())
ENGINE = RULES["engine"]


def strategy_of(structure: str) -> str:
    return ENGINE["structure_strategy"].get(structure, "none")


def load_inputs(conn, tickers) -> dict[str, dict]:
    tickers = sorted(set(tickers))
    I: dict[str, dict] = {t: {} for t in tickers}
    q = [
        ("iv_pctile", """SELECT DISTINCT ON (ticker) ticker, pctile::float8 FROM watchlist_sync.iv_rank_daily
                         WHERE ticker = ANY(%s) AND date >= current_date - 7 ORDER BY ticker, date DESC"""),
        ("put_edge_q", """SELECT ticker, quintile FROM watchlist_sync.put_edge_daily
                          WHERE ticker = ANY(%s) AND as_of = (SELECT max(as_of) FROM watchlist_sync.put_edge_daily)"""),
    ]
    for k, sql in q:
        for t, v in conn.execute(sql, (tickers,)).fetchall():
            I[t][k] = v
    for t, verdict, own, arm, credit in conn.execute(
            """SELECT DISTINCT ON (ticker) ticker, verdict, own, (inputs->>'arm')::float8, (inputs->>'credit')::float8
               FROM watchlist_sync.fit_score_history WHERE ticker = ANY(%s) AND computed_at > now() - interval '7 days'
               ORDER BY ticker, id DESC""", (tickers,)).fetchall():
        I[t].update(verdict=verdict or None, own=own, arm=arm, credit=credit)
    for t, c0, c60 in conn.execute(
            """SELECT ticker, (array_agg(close ORDER BY date DESC))[1]::float8, (array_agg(close ORDER BY date DESC))[61]::float8
               FROM lseg_research.daily_history WHERE ticker = ANY(%s) AND date > current_date - 120 AND close > 0 GROUP BY 1""",
            (tickers,)).fetchall():
        if c0 and c60:
            I[t]["ret60"] = c0 / c60 - 1
    return I


def _val(c, I, k):
    return c[k] if k in c and c[k] is not None else I.get(c["ticker"], {}).get(k)


def fit(c, I, ctx) -> tuple[bool, list[str]]:
    """All gates of the candidate's strategy. ctx = {'iv_median': today's median IV rank across priced names}."""
    st = ENGINE["strategies"].get(strategy_of(c["structure"]))
    if not st:
        return True, []
    why, ok = [], True
    for g in st["gates"]:
        v = _val(c, I, g["input"])
        if v is None:
            if g.get("if_known"):
                continue
            ok = False
            why.append(f"{g['input']} unknown")
            continue
        if "not_in" in g and v in g["not_in"]:
            ok = False
        elif "min" in g and v < g["min"]:
            ok = False
        elif g.get("below") == "median" and not (ctx.get("iv_median") is not None and v < ctx["iv_median"]):
            ok = False
        else:
            continue
        why.append(g["why"])
    return ok, why


def rank_key(cands, strategy) -> dict[int, float]:
    """id(candidate) → score (higher = better) from the strategy's rank inputs; missing input = middle rank."""
    st = ENGINE["strategies"].get(strategy)
    if not st or not cands:
        return {}
    tot = np.zeros(len(cands))
    for k, s in st["rank"]:
        v = np.array([float(x) if (x := c.get(k, c.get("_in", {}).get(k))) is not None else np.nan for c in cands], float)
        r = np.full(len(v), 0.5)
        ok = np.isfinite(v)
        if ok.sum() > 1:
            o = np.argsort(v[ok]); rr = np.empty(ok.sum()); rr[o] = np.arange(ok.sum()) / (ok.sum() - 1)
            r[ok] = rr
        tot += s * r
    return {id(c): float(x) for c, x in zip(cands, tot)}


def ladder_picks(conn, horizon="1w") -> dict[str, dict]:
    """{ticker: {band: put-ladder pick}} from the latest watchlist_sync.put_ladder (S088 write_put_ladder)."""
    r = conn.execute("SELECT payload FROM watchlist_sync.put_ladder ORDER BY as_of DESC LIMIT 1").fetchone()
    out: dict[str, dict] = {}
    for b in ((r[0] if r else {}) or {}).get("horizons", {}).get(horizon, []):
        for p in b["picks"]:
            out.setdefault(p["ticker"], {})[b["band"]] = p
    return out


def band_bounds(key: str) -> tuple[float, float]:
    lo, hi = key.split("-")
    return float(lo), float(hi)


def put_band(credit_rank) -> str:
    s = ENGINE["strategies"]["sell_put"]["strike"]
    r = s["restrike"]
    return r["band"] if credit_rank is not None and credit_rank < r["below"] else s["default_band"]


# ---------------------------------------------------------------- sold-put band by market × stock state (A277 §8, S101)

_BAND_TABLE: dict | None = None


def band_table() -> dict:
    """band_engine.py's per-state band history (refit weekly by daily.py 'band table'); {} if never built."""
    global _BAND_TABLE
    if _BAND_TABLE is None:
        p = HERE / "out" / "opt" / "band_engine.json"
        _BAND_TABLE = json.loads(p.read_text())["table"] if p.exists() else {}
    return _BAND_TABLE


def band_states(conn, tickers) -> tuple[dict, dict]:
    """(market {state, spy_3m, spy_6m, spy_dd52, vix, vix_ratio}, {ticker: {state, dd52, rel_3m}}) at the last LSEG close,
    with band_engine's definitions (one home for the thresholds)."""
    import band_engine as BE
    want = sorted(set(tickers) | {"SPY"})
    ser: dict[str, tuple[list, list]] = {}
    for t, c, h in conn.execute(
            "SELECT ticker, close::float8, COALESCE(high, close)::float8 FROM lseg_research.daily_history WHERE ticker = ANY(%s) "
            "AND close > 0 AND date >= (SELECT MAX(date) FROM lseg_research.daily_history) - 400 ORDER BY ticker, date", (want,)):
        ser.setdefault(t, ([], []))[0].append(c)
        ser[t][1].append(h)

    def feats(t):
        c, h = ser.get(t, ([], []))
        if len(c) < 127:
            return None
        return {"3m": c[-1] / c[-64] - 1, "6m": c[-1] / c[-127] - 1, "dd52": c[-1] / max(h[-252:]) - 1}
    m = feats("SPY") or {"3m": 0.0, "6m": 0.0, "dd52": 0.0}
    vix = dict(conn.execute("SELECT DISTINCT ON (index) index, close::float8 FROM wrds_research.cboe_daily "
                            "WHERE index IN ('VIX','VIX3M') ORDER BY index, date DESC").fetchall())
    mf = {"spy_3m": m["3m"], "spy_6m": m["6m"], "spy_dd52": m["dd52"], "vix": vix.get("VIX"),
          "vix_ratio": vix["VIX"] / vix["VIX3M"] if vix.get("VIX") and vix.get("VIX3M") else 0.0}
    mf["state"] = BE.market_state(mf)
    names = {}
    sec = BE.sector_now(conn, tickers)
    for t in tickers:
        f = feats(t)
        if f:
            nf = {"stk_dd52": f["dd52"], "rel_3m": f["3m"] - m["3m"]}
            e, dd = sec.get(t, (None, None))
            names[t] = {"state": BE.name_state(nf), "dd52": f["dd52"], "rel_3m": nf["rel_3m"], "sector": e, "sec_dd52": dd,
                        "market_state": BE.market_state(mf | {"sec_dd52": dd})}   # SPY state, or sector_drop for this name
    return mf, names


def engine_put_band(market: dict, name: dict | None, credit_rank=None) -> tuple[str | None, str]:
    """(band, reason) for a sold put. None = no new puts (panic). Falls back to the rules' default band when the table is
    missing or the name has no history. Weak credit → one band farther (rules restrike). Capped at 0.20Δ (S071 /
    rules.PUT_DELTA); callers floor the target at rules.PUT_DELTA's 0.05."""
    import band_engine as BE
    s = ENGINE["strategies"]["sell_put"]["strike"]
    ms, ns = (name or {}).get("market_state", market["state"]), (name or {}).get("state", "normal")
    tab = band_table()
    b = BE.choose(tab, ms, ns, BE.FLOORS[s.get("risk", "standard")]) if tab else s["default_band"]
    if b is None:
        if ms == "panic":
            return None, f"panic (VIX ÷ VIX3M {market['vix_ratio']:.2f} ≥ 1) → no new puts until the curve normalises (S101)"
        b = s["default_band"]
    bands = s["bands"]
    lo_cap = 0
    hi_cap = max(i for i, x in enumerate(bands) if band_bounds(x)[1] <= 0.20 + 1e-9)
    i = min(max(bands.index(b), lo_cap), hi_cap)
    r = s["restrike"]
    weak = credit_rank is not None and credit_rank < r["below"]
    if weak and i > lo_cap:
        i -= 1
    b = bands[i]
    h = tab.get(f"{ms}|{ns}|{b}") if tab else None
    hist = f" (history {h['bp']:+.0f} bp/wk, worst 5 % {h['w5']:+.0f})" if h else ""
    if ms == "sector_drop":
        ms_txt = f"SPY {market['state']} but {name['sector']} {name['sec_dd52']:+.0%} off high → sector drop"
    else:
        ms_txt = f"market {ms.replace('_', ' ')}"
    return b, f"{ms_txt} · stock {ns} → {b}Δ{hist}" + (f" · credit {credit_rank} < {r['below']} → one band farther" if weak else "")


def csp_band_legs(chain, pick, leg, front):
    """{band: leg} — the listed put whose |Δ| is nearest each band's midpoint and inside the band (structures._pick/_leg)."""
    out = {}
    for b in ENGINE["strategies"]["sell_put"]["strike"]["bands"]:
        lo, hi = band_bounds(b)
        r = pick(chain, "put", (lo + hi) / 2)
        if r and r.get("delta") is not None and lo <= abs(r["delta"]) < hi:
            out[b] = leg(r, -1, front)
    return out


# ---------------------------------------------------------------- before/after (read-only)

def before_after():
    """Rebuild today's structures candidates with structures.py's own pricing (nothing written), then compare
    the current board's primary picks with the engine's: CSP at the rules' band (default 0.08–0.10Δ, re-strike on weak credit),
    gates per strategy, rank per strategy."""
    from collections import defaultdict
    from datetime import timedelta

    import structures as SX
    from build_plan import connect, rows

    class _Stop(Exception):
        pass
    captured = {}

    def grab(cands, trim):
        captured["cands"], captured["trim"] = cands, trim
        raise _Stop
    real_pick = SX.pick_board
    SX.pick_board = grab
    try:
        SX.main()
    except _Stop:
        pass
    finally:
        SX.pick_board = real_pick
    cands, trim = captured["cands"], captured["trim"]
    before = real_pick(cands, trim)

    with connect() as conn:
        I = load_inputs(conn, {c["ticker"] for c in cands})
        as_of = conn.execute("SELECT MAX(as_of) FROM optlab.skew_survey").fetchone()[0]
        q = rows(conn, """SELECT ticker, expiry, side, strike, spot, bid, ask, iv, delta FROM optlab.skew_survey
                          WHERE as_of = %s AND bid IS NOT NULL AND ask > 0 AND side = 'put'""", (as_of,))
        rv, hist = {}, {}
        for t, cl in SX.rows_closes(conn):
            if len(cl) >= 260:
                rv[t] = float(np.std(np.diff(np.log(cl[-21:]))) * math.sqrt(252))
                hist[t] = np.log(np.asarray(cl[-505:], float))
    chains = defaultdict(list)
    for r in q:
        chains[(r["ticker"], r["expiry"])].append(r)
    # CSP = the put ladder's pick (S088 walk-forward model, one engine for sold puts) at the rules' band for that name
    # (default 0.08–0.10Δ; weak credit → one band farther); every band's pick attached so the row shows the ladder
    with connect() as conn:
        lad_rows = ladder_picks(conn)
    new = [c for c in cands if c["structure"] != "csp"]
    ladders = {}
    for t, bands in lad_rows.items():
        want = put_band(I.get(t, {}).get("credit"))
        p = bands.get(want)
        if not p or t not in {c["ticker"] for c in cands}:
            continue
        src = next((x for x in cands if x["ticker"] == t and x["structure"] == "csp"), None)
        ladders[t] = bands
        new.append({"structure": "csp", "ticker": t, "spot": p["spot"], "legs": [{"side": "put", "strike": p["strike"], "qty": -1}],
                    "credit": p["credit"], "capital": p["strike"], "ev_rv_cap": p["expPnlBpWk"] / 1e4, "ev_rv": p["expPnlBpWk"],
                    "worst5": float("nan"), "p_rv": p["pKept"], "iv_rv": src["iv_rv"] if src else None,
                    "earnings": "yes" if p["earningsInWindow"] else None, "edge_q": src["edge_q"] if src else I.get(t, {}).get("put_edge_q"),
                    "band": want, "ladder": bands, "restruck": want != put_band(None)})
    ivs = [v["iv_pctile"] for v in I.values() if v.get("iv_pctile") is not None]
    ctx = {"iv_median": float(np.median(ivs)) if ivs else None}
    for c in new:
        c["_in"] = I.get(c["ticker"], {})
        c["fit"], c["fit_why_engine"] = fit(c, I, ctx)
    # same order as structures.pick_board primary (fit, CSP by put-edge Q, then score) — the engine only swaps the score
    # for strategies whose rank inputs are not EV (long calls: ARM + 60-day return, S100)
    pool = [c for c in new if SX._clean(c, trim) and c["fit"] and SX.CATALOG[c["structure"]][4] in ("pass", "untested")
            and c["structure"] not in SX.MARGIN]
    by = defaultdict(list)
    for c in pool:
        by[c["structure"]].append(c)
    for sid, cs in by.items():
        stg = strategy_of(sid)
        k = rank_key(cs, stg) if [r for r, _ in ENGINE["strategies"].get(stg, {}).get("rank", [])] != ["put_edge_q", "ev_rv_cap"] else {}
        for c in cs:
            c["_score"] = k.get(id(c), c["ev_rv_cap"])
    pool.sort(key=lambda c: (-(c["edge_q"] or 0) if c["structure"] == "csp" else 0, -c["_score"]))
    after, used = defaultdict(list), set()
    for c in pool:
        if c["ticker"] in used or len(after[c["structure"]]) >= SX.TOP:
            continue
        after[c["structure"]].append(c)
        used.add(c["ticker"])
    print(f"engine before/after · skew survey {as_of} · {len(cands)} candidates · IV-rank median {ctx['iv_median']:.2f}")
    for sid in sorted(set(before) | set(after)):
        b = [c for c in before.get(sid, []) if c.get("tier") == "primary"]
        a = after.get(sid, [])
        if not b and not a:
            continue
        m = lambda xs, k: np.mean([x[k] for x in xs]) * 100 if xs else float("nan")  # noqa: E731
        print(f"{sid:16s} before {len(b):2d} EV {m(b, 'ev_rv_cap'):+.2f}% worst5 {m(b, 'worst5'):+.1f}% | after {len(a):2d} EV {m(a, 'ev_rv_cap'):+.2f}% "
              f"worst5 {m(a, 'worst5'):+.1f}% · kept {len({x['ticker'] for x in b} & {x['ticker'] for x in a})}")
        print(f"   before: {' '.join(x['ticker'] for x in b)}")
        print(f"   after:  {' '.join(x['ticker'] + ('*' if x.get('restruck') else '') for x in a)}")
    gated = defaultdict(int)
    for c in new:
        for w in c["fit_why_engine"]:
            gated[(strategy_of(c["structure"]), w)] += 1
    print("gate hits:", "; ".join(f"{s}: {w} ×{n}" for (s, w), n in sorted(gated.items(), key=lambda z: -z[1])[:12]))
    lad = next(iter(ladders.items()), None)
    if lad:
        print("ladder example", lad[0], json.dumps(lad[1]))


if __name__ == "__main__":
    before_after()
