"""Scoreboard (Claude, user 2026-10-15): for every adopted score/rule, what the backtest promised vs what has happened since it
went live. Answers "is this actually helping?" on data nobody tuned on. → watchlist_sync.scoreboard → Settings › Research.

Verdicts: holding (live agrees with the promise) · drifting (live worse, not yet significant) · failed (live contradicts, enough
data) · too early (< MIN_EXPIRIES independent weeks; short-put outcomes cluster by week, so weeks are the sample, not trades)
· no live check (nothing recorded to check against; that itself is the finding).

    .venv/bin/python analysis/scoreboard.py      # nightly via option_history.py; idempotent
"""
from __future__ import annotations

import json
import sys
from bisect import bisect_right
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from statistics import median

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from build_plan import connect  # noqa: E402
from grade_weeks import expiry_week_from_detail, format_n, week_cluster_metrics  # noqa: E402

MIN_EXPIRIES = 8

DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.scoreboard (item text PRIMARY KEY, source text, promised text, live text,
  n text, verdict text, detail jsonb, checked_at timestamptz DEFAULT now())"""

# Stable identity for upsert (A121 follow-up). Failure used to key by f.__name__, success by label → twins.
CHECK_LABELS = {
    "model_list": "Model List put score (fit-1.4.3)",
    "options_shadow": "Options champion vs shadow (parent)",
    "fair_value": "Fair value (fv-1.2.0)",
    "assign_odds": "Assignment odds (pm_alerts)",
    "own_vs_avoid": "Own − Avoid, vol-matched (fit-1.4)",
    "fv_spread": "Fair value cheap − rich (fv-1.1.0)",
    "ira_vs_benchmark": "IRA puts vs naive SPY/QQQ 1σ puts",
    "engine_puts": "Band engine sell puts (S101)",
    "pace_takes": "Sold-put pace takes (S103)",
    "rich_puts": "Rich puts — your rule (S109)",
}
# Old label strings that still appear in DB (version bumps etc.) → check_key
LABEL_ALIASES = {
    "Fair value (fv-1.1.0)": "fair_value",
    "Fair value cheap − rich (fv-1.1.0)": "fv_spread",
}


def _round(x, n=3):
    return None if x is None else round(float(x), n)


def _mean(xs: list[float]) -> float | None:
    xs = [float(x) for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def _strike_key(v):
    try:
        return round(float(v), 4)
    except (TypeError, ValueError):
        return v


def dedupe_first_snapshot(rows: list[dict], date_key: str = "snapshot_date", id_key: str = "id") -> list[dict]:
    """One row per (ticker, expiry, strike): earliest snapshot, then lowest id. A352."""
    best: dict[tuple, tuple] = {}
    for r in rows:
        key = (r.get("ticker"), r.get("expiry"), _strike_key(r.get("strike")))
        stamp = (r.get(date_key) is None, r.get(date_key), r.get(id_key) or 0)
        prev = best.get(key)
        if prev is None or stamp < prev[0]:
            best[key] = (stamp, r)
    return [v[1] for v in best.values()]


def ntile_partition(rows: list[dict], partition: str, order_key: str, buckets: int = 3, id_key: str = "id") -> list[dict]:
    """PostgreSQL ntile: order within each partition; remainder rows go to the lower buckets. A352."""
    groups: dict = defaultdict(list)
    for r in rows:
        if r.get(order_key) is None:
            continue
        groups[r.get(partition)].append(r)
    out = []
    for g in groups.values():
        g = sorted(g, key=lambda r: (r.get(order_key), r.get(id_key) or 0))
        n = len(g)
        base, rem = divmod(n, buckets)
        sizes = [base + 1] * rem + [base] * (buckets - rem)
        idx = 0
        for tercile, sz in enumerate(sizes, start=1):
            for _ in range(sz):
                if idx >= n:
                    break
                row = dict(g[idx])
                row["tercile"] = tercile
                out.append(row)
                idx += 1
    return out


def weeks_inverted(weeks: list[dict], lo: str = "t1_excess", hi: str = "t3_excess") -> tuple[bool, int, int]:
    """True when the high tercile's excess is worse than the low tercile's on at least 2/3 of weeks."""
    usable = [w for w in weeks if w.get(lo) is not None and w.get(hi) is not None]
    if not usable:
        return False, 0, 0
    bad = sum(1 for w in usable if w[hi] < w[lo])
    return bad * 3 >= 2 * len(usable), bad, len(usable)


def _on_or_before(days: list, d):
    if d is None or not days:
        return None
    i = bisect_right(days, d) - 1
    return days[i] if i >= 0 else None


def _as_date(v):
    if isinstance(v, date):
        return v
    if v is None:
        return None
    return date.fromisoformat(str(v)[:10])


def attach_universe_excess(conn, picks: list[dict], start_key: str = "snapshot_date", end_key: str = "expiry") -> None:
    """excess = LSEG stock return − fmp_fundamentals median over the same trading-day window. Percent points."""
    spy = [r[0] for r in conn.execute(
        "SELECT date FROM lseg_research.daily_history WHERE ticker = 'SPY' AND close > 0 ORDER BY date"
    ).fetchall()]
    for p in picks:
        p["d0"] = _on_or_before(spy, _as_date(p.get(start_key)))
        p["d1"] = _on_or_before(spy, _as_date(p.get(end_key)))
    dates = sorted({p["d0"] for p in picks if p.get("d0")} | {p["d1"] for p in picks if p.get("d1")})
    uni_px: dict[str, dict] = defaultdict(dict)
    px: dict[tuple, float] = {}
    if dates:
        for t, d, c in conn.execute(
            """SELECT h.ticker, h.date, h.close::float8
               FROM lseg_research.daily_history h
               JOIN fmp_fundamentals f ON f.ticker = h.ticker
               WHERE h.date = ANY(%s) AND h.close > 0""",
            (dates,),
        ).fetchall():
            uni_px[t][d] = c
            px[(t, d)] = c
        need = list({p["ticker"] for p in picks if p.get("ticker")})
        if need:
            for t, d, c in conn.execute(
                """SELECT ticker, date, close::float8 FROM lseg_research.daily_history
                   WHERE ticker = ANY(%s) AND date = ANY(%s) AND close > 0""",
                (need, dates),
            ).fetchall():
                px[(t, d)] = c
    windows: dict[tuple, float | None] = {}
    for p in picks:
        key = (p.get("d0"), p.get("d1"))
        if key in windows or not key[0] or not key[1] or key[0] >= key[1]:
            continue
        rets = []
        for series in uni_px.values():
            a, b = series.get(key[0]), series.get(key[1])
            if a and b and a > 0:
                rets.append(b / a - 1.0)
        windows[key] = median(rets) if rets else None
    for p in picks:
        a, b = px.get((p.get("ticker"), p.get("d0"))), px.get((p.get("ticker"), p.get("d1")))
        if a and b and a > 0:
            p["stock_ret_pct"] = (b / a - 1.0) * 100.0
        elif p.get("spot") and p.get("settle_close") and float(p["spot"]) > 0:
            p["stock_ret_pct"] = (float(p["settle_close"]) / float(p["spot"]) - 1.0) * 100.0
        else:
            p["stock_ret_pct"] = None
        med = windows.get((p.get("d0"), p.get("d1")))
        p["uni_med_pct"] = med * 100.0 if med is not None else None
        if p["stock_ret_pct"] is not None and p["uni_med_pct"] is not None:
            p["excess_pct"] = p["stock_ret_pct"] - p["uni_med_pct"]
        else:
            p["excess_pct"] = None


def grade_week_table(picks: list[dict]) -> list[dict]:
    """One row per expiry: mean excess, short-put P&L, long-put mirror, within-expiry tercile excess."""
    by: dict = defaultdict(list)
    for p in picks:
        by[p.get("expiry")].append(p)
    weeks = []
    for exp in sorted(by, key=lambda x: str(x)):
        g = by[exp]
        terc: dict = defaultdict(list)
        for p in g:
            if p.get("tercile") is not None:
                terc[p["tercile"]].append(p.get("excess_pct"))
        pnl = [p.get("pnl_pct") for p in g if p.get("pnl_pct") is not None]
        weeks.append({
            "expiry": str(exp)[:10],
            "n": len(g),
            "pick_ret_pct": _round(_mean([p.get("stock_ret_pct") for p in g])),
            "universe_median_pct": _round(_mean([p.get("uni_med_pct") for p in g])),
            "excess_pct": _round(_mean([p.get("excess_pct") for p in g])),
            "put_pnl_pct": _round(_mean(pnl)),
            "mirror_pnl_pct": _round(-_mean(pnl) if pnl else None),
            "t1_excess": _round(_mean(terc.get(1) or [])),
            "t2_excess": _round(_mean(terc.get(2) or [])),
            "t3_excess": _round(_mean(terc.get(3) or [])),
        })
    return weeks


def _tercile_summary(picks: list[dict]) -> list[dict]:
    by: dict = defaultdict(list)
    for p in picks:
        by[p["tercile"]].append(p)
    out = []
    for t in sorted(by):
        g = by[t]
        pnl = [p["pnl_pct"] for p in g if p.get("pnl_pct") is not None]
        out.append({
            "tercile": t,
            "n": len(g),
            "win": round(sum(x >= 0 for x in pnl) / len(pnl), 2) if pnl else None,
            "pnl_pct": _round(_mean(pnl)),
            "excess_pct": _round(_mean([p.get("excess_pct") for p in g])),
            "mirror_pnl_pct": _round(-_mean(pnl) if pnl else None),
        })
    return out


def _grade_verdict(weeks: list[dict], n_expiries: int, summary: list[dict]) -> str:
    inverted, _, _ = weeks_inverted(weeks)
    if inverted:
        return "inverted"
    if n_expiries < MIN_EXPIRIES:
        return "too early"
    if summary and summary[-1].get("excess_pct") is not None and summary[0].get("excess_pct") is not None:
        return "holding" if summary[-1]["excess_pct"] >= summary[0]["excess_pct"] else "drifting"
    return "too early"


def model_list(conn) -> tuple:
    """Model List option score (fit-1.4.3, S008). A352: deduped, terciles within expiry, excess vs universe."""
    raw_rows = conn.execute(
        """SELECT id, snapshot_date, ticker, expiry, strike::float8, option_score::float8,
                  spot::float8, settle_close::float8, pnl_pct::float8
           FROM model_recs
           WHERE graded_at IS NOT NULL AND side = 'put' AND option_score IS NOT NULL"""
    ).fetchall()
    raw = [{
        "id": i, "snapshot_date": sd, "ticker": t, "expiry": ex, "strike": k,
        "option_score": sc, "spot": spot, "settle_close": st, "pnl_pct": None if pnl is None else float(pnl),
    } for i, sd, t, ex, k, sc, spot, st, pnl in raw_rows]
    picks = dedupe_first_snapshot(raw)
    attach_universe_excess(conn, picks)
    terc = ntile_partition(picks, "expiry", "option_score")
    weeks = grade_week_table(terc)
    summary = _tercile_summary(terc)
    n_exp = len({p["expiry"] for p in picks})
    verdict = _grade_verdict(weeks, n_exp, summary)
    bits = []
    for x in summary:
        if x.get("pnl_pct") is None:
            continue
        ex = f" excess {x['excess_pct']:+.2f}pp" if x.get("excess_pct") is not None else ""
        mir = f" mirror {x['mirror_pnl_pct']:+.2f}%" if x.get("mirror_pnl_pct") is not None else ""
        bits.append(f"T{x['tercile']}{ex} P&L {x['pnl_pct']:+.2f}%{mir}")
    live = " · ".join(bits) if bits else "no graded picks"
    dupes = len(raw) - len(picks)
    if verdict == "inverted":
        live = "inverted · " + live
    return ("Model List put score (fit-1.4.3)", "S008",
            "Top-third scores beat bottom third on stock excess vs the universe, same expiry",
            live, f"{len(picks)} puts · {n_exp} expiries · {dupes} dupes dropped", verdict,
            {"terciles": summary, "weeks": weeks, "deduped": dupes, "n_raw": len(raw), "ask": "A352"})


def options_shadow(conn) -> tuple:
    """A172: champion put score vs parent (shadow) score on the same graded strikes — top-tercile P&L."""
    r = conn.execute("""
        SELECT count(DISTINCT expiry), count(*) FROM model_recs
        WHERE graded_at IS NOT NULL AND side = 'put' AND shadow_score IS NOT NULL""").fetchone()
    weeks, n = r[0] or 0, r[1] or 0
    item = "Options champion vs shadow (parent)"
    promised = "Champion top-tercile put P&L ≥ shadow top-tercile on same strikes (A172 / S045)"
    if n == 0:
        return (item, "A172", promised, "no graded puts with shadow_score yet", "0", "too early", {})

    def terciles(col: str):
        return conn.execute(f"""
            SELECT t, count(*), avg((pnl_per_share >= 0)::int), avg(pnl_pct) FROM (
              SELECT *, ntile(3) OVER (ORDER BY {col}) t FROM model_recs
              WHERE graded_at IS NOT NULL AND side = 'put' AND shadow_score IS NOT NULL) x
            GROUP BY t ORDER BY t""").fetchall()

    champ = terciles("option_score")
    shadow = terciles("shadow_score")
    c_top = float(champ[-1][3]) if champ else None
    s_top = float(shadow[-1][3]) if shadow else None
    live = (f"champ T3 P&L {c_top:+.2f}% · shadow T3 P&L {s_top:+.2f}% · {n} puts"
            if c_top is not None and s_top is not None else "incomplete terciles")
    if weeks < MIN_EXPIRIES or n < 100:
        verdict = "too early"
    elif c_top is not None and s_top is not None:
        verdict = "holding" if c_top >= s_top else "drifting"
    else:
        verdict = "no live check"
    return (item, "A172", promised, live, f"{n} puts · {weeks} expiries", verdict,
            {"champ_terciles": [{"t": t, "n": k, "win": float(w), "pnl": float(p)} for t, k, w, p in champ],
             "shadow_terciles": [{"t": t, "n": k, "win": float(w), "pnl": float(p)} for t, k, w, p in shadow]})


def fair_value(conn) -> tuple:
    """fv-1.2.0 is display-only (S009: cheapness gaps don't predict) → live check = health, not returns."""
    r = conn.execute("""WITH l AS (SELECT DISTINCT ON (ticker) * FROM fair_value_snapshots ORDER BY ticker, as_of DESC)
                        SELECT count(*), count(fair_value), count(*) FILTER (WHERE price_to_fair < 0.25 OR price_to_fair > 4) FROM l""").fetchone()
    tot, valued, extreme = r
    verdict = "holding" if extreme <= 0.01 * valued else "drifting"
    return ("Fair value (fv-1.2.0)", "S009", "Display only; no return prediction. Health: few absurd values",
            f"{valued}/{tot} valued · {extreme} outside 0.25–4× price (A102 list)", f"{valued} names", verdict,
            {"extreme": extreme})


def assign_odds(conn) -> tuple:
    """pm_alerts P(assign) (S016; backtest 18 % predicted vs 21 % real). Live: last prediction made before each expiry day vs
    whether the expiry close finished below the strike (prices_historical)."""
    graded = conn.execute("""
        WITH p AS (SELECT a.generated_at, x->>'account' acct, x->>'ticker' t, (x->>'strike')::float k, (x->>'expiry')::date e,
                          (x->>'p_assign')::float pa
                   FROM watchlist_sync.pm_alerts a, jsonb_array_elements(a.payload->'predictions') x
                   WHERE a.payload ? 'predictions'),
             last AS (SELECT DISTINCT ON (acct, t, k, e) * FROM p WHERE generated_at::date < e ORDER BY acct, t, k, e, generated_at DESC)
        SELECT l.e, l.pa, (h.close::float < l.k)::int FROM last l
        JOIN prices_historical h ON h.ticker = l.t AND h.date = l.e""").fetchall()
    if not graded:
        n_pred = conn.execute("SELECT count(*) FROM watchlist_sync.pm_alerts WHERE payload ? 'predictions'").fetchone()[0]
        return ("Assignment odds (pm_alerts)", "S016", "Predicted P(assign) matches realized (backtest 18 % vs 21 %)",
                "per-put odds stored from 10-15; first grade after the 10-16 expiry" if n_pred else "per-put odds not stored",
                "0 graded", "too early" if n_pred else "no live check", {})
    weeks = len({e for e, _, _ in graded})
    pred = sum(pa for _, pa, _ in graded) / len(graded)
    real = sum(y for _, _, y in graded) / len(graded)
    verdict = "too early" if weeks < MIN_EXPIRIES else "holding" if abs(pred - real) <= 0.10 else "drifting"
    return ("Assignment odds (pm_alerts)", "S016", "Predicted P(assign) matches realized (backtest 18 % vs 21 %)",
            f"predicted {pred:.0%} vs assigned {real:.0%}", f"{len(graded)} puts · {weeks} expiries", verdict,
            {"pred": pred, "real": real})


def own_vs_avoid(conn) -> tuple:
    """A171 (S044 #1): Own − Avoid 5-day return vs SPY, volatility-matched (60d realized-vol terciles across both folders)."""
    g = conn.execute("""
        WITH g AS (SELECT gr.folder_key f, gr.ticker t, gr.vs_spy::float v, r.created_at::date d
                   FROM watchlist_sync.grades gr JOIN watchlist_sync.model_runs r ON r.id = gr.run_id
                   WHERE gr.horizon = '5d' AND gr.folder_key IN ('own', 'avoid') AND gr.bucket <> 'data' AND gr.vs_spy IS NOT NULL),
             vol AS (SELECT g.t, g.d, stddev(ln(h.close / h.prev)) sd FROM g
                     JOIN LATERAL (SELECT close::float, lag(close::float) OVER (ORDER BY date) prev FROM prices_historical
                                   WHERE ticker = g.t AND date < g.d AND date >= g.d - 90) h ON h.prev > 0
                     GROUP BY 1, 2)
        SELECT g.f, g.v, g.d, vol.sd FROM g JOIN vol USING (t, d) WHERE vol.sd IS NOT NULL""").fetchall()
    item, promised = "Own − Avoid, vol-matched (fit-1.4)", "Own beats Avoid on 5d return vs SPY within the same volatility tercile"
    if not g:
        return (item, "S044", promised, "no 5d grades yet", "0", "no live check", {})
    sds = sorted(x[3] for x in g)
    cut = [sds[len(sds) // 3], sds[2 * len(sds) // 3]]
    terc = lambda s: 0 if s <= cut[0] else 1 if s <= cut[1] else 2
    diffs = []
    for k in range(3):
        o = [v for f, v, _, s in g if f == "own" and terc(s) == k]
        a = [v for f, v, _, s in g if f == "avoid" and terc(s) == k]
        if o and a:
            diffs.append(sum(o) / len(o) - sum(a) / len(a))
    weeks = len({d.isocalendar()[:2] for _, _, d, _ in g})
    raw_o = [v for f, v, _, _ in g if f == "own"]
    raw_a = [v for f, v, _, _ in g if f == "avoid"]
    raw = (sum(raw_o) / len(raw_o) if raw_o else 0) - (sum(raw_a) / len(raw_a) if raw_a else 0)
    spread = sum(diffs) / len(diffs) if diffs else None
    live = f"raw {raw * 100:+.1f} pp · vol-matched {spread * 100:+.1f} pp" if spread is not None else f"raw {raw * 100:+.1f} pp"
    verdict = "too early" if weeks < MIN_EXPIRIES else "holding" if (spread or 0) > 0 else "drifting"
    return (item, "S044", promised, live, f"{len(raw_o)} own · {len(raw_a)} avoid · {weeks} weeks", verdict,
            {"raw": raw, "vol_matched": spread, "terciles": diffs})


def fv_spread(conn) -> tuple:
    """A171 (S044 #2): fair value cheapest − richest quintile, forward ~1 month (21 trading days ≈ 30 calendar days)."""
    rows_ = conn.execute("""
        WITH s AS (SELECT ticker, as_of, price::float p, price_to_fair::float ptf FROM fair_value_snapshots
                   WHERE fair_value IS NOT NULL AND price > 0 AND as_of <= current_date - 30),
             f AS (SELECT s.*, (SELECT price::float FROM fair_value_snapshots x WHERE x.ticker = s.ticker AND x.price > 0
                                AND x.as_of BETWEEN s.as_of + 28 AND s.as_of + 35 ORDER BY x.as_of LIMIT 1) p1 FROM s)
        SELECT as_of, ptf, p1 / p - 1 FROM f WHERE p1 IS NOT NULL""").fetchall()
    item, promised = "Fair value cheap − rich (fv-1.2.0)", "Cheapest quintile beats richest over ~1 month (S009 says it won't — testing)"
    if not rows_:
        first = conn.execute("SELECT min(as_of) FROM fair_value_snapshots WHERE fair_value IS NOT NULL").fetchone()[0]
        return (item, "S044", promised, f"first 1-month read ~{first + __import__('datetime').timedelta(days=31)} "
                f"(12-day read 10-18: +6.8 pp, partial IC −0.15 after vol/mom)", "0 months", "too early", {})
    by = {}
    for d, ptf, r in rows_:
        by.setdefault(d, []).append((ptf, r))
    spreads = []
    for d, xs in sorted(by.items()):
        if len(xs) < 50:
            continue
        xs.sort()
        q = len(xs) // 5
        spreads.append(sum(r for _, r in xs[:q]) / q - sum(r for _, r in xs[-q:]) / q)
    months = len({(d.year, d.month) for d in by})
    m = sum(spreads) / len(spreads) if spreads else 0
    verdict = "too early" if months < 3 else "holding" if m > 0 else "drifting"
    return (item, "S044", promised, f"cheap − rich {m * 100:+.1f} pp / month (mean of {len(spreads)} dates)",
            f"{months} month(s)", verdict, {"spreads": spreads[-20:]})


def ira_vs_benchmark(conn) -> tuple:
    """A171 (S044 #4, the ROI number): Jamie's IRA short puts held to expiry, pnl per $ collateral per expiry week, vs a naive
    1σ-IV put on SPY and QQQ over the same open→expiry dates (BS at LSEG iv30_put, no skew — understates the benchmark's
    real premium ~25 %, S021). Selection skill, not exit timing (most trades close early; S017: holding ≥ closing)."""
    import math
    tr = conn.execute("""
        SELECT t.d0, t.expiry, t.strike::float, t.premium::float, t.qty::float,
               (SELECT close::float FROM prices_historical h WHERE h.ticker = t.ticker AND h.date <= t.expiry ORDER BY h.date DESC LIMIT 1)
        FROM optlab.trades t WHERE t.account = 'IRA' AND t.expiry < current_date""").fetchall()
    tr = [x for x in tr if x[5] is not None and x[2] > 0]
    item, promised = "IRA puts vs naive SPY/QQQ 1σ puts", "Jamie's app-guided put picks earn more per $ collateral than index puts"
    if not tr:
        return (item, "S044", promised, "no closed IRA trades with prices", "0", "no live check", {})
    lh = {}
    for t in ("SPY", "QQQ"):
        lh[t] = {d: (float(c), float(iv) if iv else None) for d, c, iv in conn.execute(
            "SELECT date, close, iv30_put FROM lseg_research.daily_history WHERE ticker = %s AND date >= '2026-01-01'", (t,)).fetchall()}

    def ncdf(x):
        return 0.5 * (1 + math.erf(x / math.sqrt(2)))

    def bench(d0, e):
        out = []
        for t in ("SPY", "QQQ"):
            h = lh[t]
            d0s = [d for d in h if d <= d0]
            es = [d for d in h if d <= e]
            if not d0s or not es:
                continue
            (S, iv), (ST, _) = h[max(d0s)], h[max(es)]
            if not iv:
                continue
            v, tt = iv / 100, max(1, (e - d0).days) / 365
            K = S * math.exp(-v * math.sqrt(tt))
            sd = v * math.sqrt(tt)
            d1 = (math.log(S / K) + 0.5 * sd * sd) / sd
            prem = K * ncdf(-(d1 - sd)) - S * ncdf(-d1)
            out.append((prem - max(0.0, K - ST)) / K)
        return sum(out) / len(out) if out else None

    # Model List went live 2026-10-05: earlier trades are Jamie's own selection; later ones are app-guided → split them.
    import datetime as _dt
    app_start = _dt.date(2026, 10, 5)
    n_app = sum(1 for x in tr if x[0] >= app_start)
    weeks = {}
    for d0, e, k, prem, q, close in tr:
        wk = e.isocalendar()[:2]
        w = weeks.setdefault(wk, {"pnl": 0.0, "coll": 0.0, "bench": bench(d0, e)})
        w["pnl"] += (prem - max(0.0, k - close)) * q  # same open→expiry window as the benchmark → no time scaling
        w["coll"] += k * q
    j = [w["pnl"] / w["coll"] for w in weeks.values() if w["coll"] > 0]
    b = [w["bench"] for w in weeks.values() if w["bench"] is not None]
    jm, bm = sum(j) / len(j), (sum(b) / len(b) if b else 0)
    sd = lambda x, m: (sum((v - m) ** 2 for v in x) / max(1, len(x) - 1)) ** 0.5
    js, bs = sd(j, jm), (sd(b, bm) if b else 0)
    jr, br = (jm / js if js else 0), (bm / bs if bs else 0)  # per-week return ÷ per-week risk: index puts carry far less risk
    worst = min(j)
    # Verdict on risk-adjusted return — raw bp alone flatters high-IV names (more premium AND more risk than an index put).
    verdict = "too early" if len(j) < MIN_EXPIRIES else "holding" if jr > br else "drifting"
    return (item, "S044", promised,
            f"IRA {jm * 1e4:+.1f} bp (sd {js * 1e4:.0f}, return/risk {jr:.2f}, worst week {worst * 1e4:+.0f}) vs SPY/QQQ "
            f"{bm * 1e4:+.1f} bp (sd {bs * 1e4:.0f}, return/risk {br:.2f}) per trade on collateral, same dates, held to expiry",
            f"{len(tr)} puts · {len(j)} expiry weeks · {n_app} since Model List (10-05; before = Jamie's own picks)", verdict,
            {"ira_bp": jm * 1e4, "bench_bp": bm * 1e4, "ira_sd_bp": js * 1e4, "bench_sd_bp": bs * 1e4, "ira_rr": jr, "bench_rr": br})


def engine_puts(conn) -> tuple:
    """Band engine (S101): graded Model List puts per collateral-week, by the market state the engine saw (from 10-26 publishes)."""
    rs = conn.execute("""SELECT ret::float8, detail FROM watchlist_sync.grades WHERE folder_key = 'sell_puts' AND horizon = 'expiry'
                         AND bucket <> 'data' AND jsonb_typeof(detail->'engine') = 'object'""").fetchall()
    wk, st = {}, {}
    for ret, d in rs:
        bp = 1e4 * ret / (max(d.get("days") or 7, 1) / 7)
        wk.setdefault(d.get("expiry"), []).append(bp)
        s = st.setdefault(d["engine"].get("market_state") or "?", {"n": 0, "bp": 0.0, "kept": 0})
        s["n"] += 1; s["bp"] += bp; s["kept"] += (d.get("premium_kept") or 0) >= 0.999
    means = [sum(v) / len(v) for v in wk.values()]
    item, promised = "Band engine sell puts (S101)", "+29.6 bp per collateral-week OOS, worst week -31 bp (S101 standard band)"
    if not means:
        return (item, "S101", promised, "no graded engine picks yet (first expiry 10-30)", "0", "too early", {})
    m = sum(means) / len(means)
    se = (sum((x - m) ** 2 for x in means) / max(len(means) - 1, 1)) ** 0.5 / len(means) ** 0.5
    by = {k: {"n": v["n"], "bp_wk": round(v["bp"] / v["n"], 1), "kept": round(v["kept"] / v["n"], 2)} for k, v in st.items()}
    live = f"{m:+.1f} bp/wk, worst week {min(means):+.0f} · " + " · ".join(f"{k} {v['bp_wk']:+.0f} (n {v['n']})" for k, v in by.items())
    verdict = ("too early" if len(means) < MIN_EXPIRIES else "failed" if m + 2 * se < 0 else
               "holding" if m >= 29.6 - 2 * se else "drifting")
    return (item, "S101", promised, live, format_n(len(rs), len(means)), verdict,
            {"by_state": by, "weeks": {str(k): round(sum(v) / len(v), 1) for k, v in wk.items()}})


def pace_takes(conn) -> tuple:
    """put_manage (S103): a weekly take at ≥ 4× plan pace vs holding the same put to expiry (excludes the re-sell's income)."""
    item, promised = "Sold-put pace takes (S103)", "taking beats holding by +0.018-0.021 % of strike per trade on real quotes"
    if not conn.execute("SELECT to_regclass('watchlist_sync.put_manage_daily')").fetchone()[0]:
        return (item, "S103", promised, "put_manage not run yet", "0", "too early", {})
    rs = conn.execute("""SELECT DISTINCT ON (m.ticker, m.strike, m.expiry) m.ticker, m.strike, m.expiry, (m.payload->>'buy_back')::float8,
                           (SELECT h.close::float8 FROM lseg_research.daily_history h WHERE h.ticker = m.ticker AND h.date <= m.expiry
                            ORDER BY h.date DESC LIMIT 1)
                         FROM watchlist_sync.put_manage_daily m WHERE m.payload->>'action' = 'take + re-sell' AND m.expiry < CURRENT_DATE
                         ORDER BY m.ticker, m.strike, m.expiry, m.as_of""").fetchall()
    d = [{"ticker": t, "strike": k, "expiry": str(e), "gain_pct": round(100 * (max(0.0, k - c) - b) / k, 3)}
         for t, k, e, b, c in rs if c is not None and b is not None]
    if not d:
        return (item, "S103", promised, "no expired takes yet", "0", "too early", {})
    g = sum(x["gain_pct"] for x in d) / len(d)
    weeks = len({x["expiry"] for x in d})
    verdict = "too early" if weeks < MIN_EXPIRIES else "holding" if g > 0 else "drifting"
    return (item, "S103", promised, f"take − hold {g:+.3f} % of strike per trade (re-sell income not counted)",
            f"{len(d)} takes · {weeks} expiries", verdict, {"takes": d})


def _perf(bps: list[float]) -> dict:
    """n, bp/wk, kept %, Sharpe and Sortino (per-put, not annualised) — the learning view per tier / sector / name."""
    n = len(bps)
    m = sum(bps) / n
    sd = (sum((x - m) ** 2 for x in bps) / max(n - 1, 1)) ** 0.5
    dn = (sum(min(x, 0) ** 2 for x in bps) / n) ** 0.5
    return {"n": n, "bp_wk": round(m, 1), "kept": round(100 * sum(x >= 0 for x in bps) / n), "worst": round(min(bps)),
            "sharpe": round(m / sd, 2) if sd else None, "sortino": round(m / dn, 2) if dn else None}


def _rich_pick(rid, ticker, ret, detail, graded_at) -> dict | None:
    d = detail or {}
    x = d.get("rich") or {}
    exp = _as_date(d.get("expiry") or x.get("expiry"))
    if exp is None:
        return None
    days = int(d.get("days") or x.get("days") or 7)
    score = x.get("score")
    return {
        "id": rid,
        "ticker": ticker,
        "expiry": exp,
        "strike": x.get("strike") if x.get("strike") is not None else d.get("strike"),
        "snapshot_date": exp - timedelta(days=max(days, 1)),
        "graded_at": graded_at,
        "option_score": None if score is None else float(score),
        "pnl_pct": None if ret is None else float(ret) * 100.0,
        "spot": d.get("spot_entry") or x.get("spot"),
        "settle_close": d.get("close_expiry"),
        "tier": x.get("tier") or "?",
        "sector": x.get("sector") or "?",
        "group": (x.get("group") or {}).get("id"),
        "days": days,
        "ret": ret,
    }


def rich_puts(conn) -> tuple:
    """Rich-crash lane (S109). A352: same dedupe, within-expiry terciles, and universe excess as the Model List."""
    rs = conn.execute(
        """SELECT id, ticker, ret::float8, detail, graded_at FROM watchlist_sync.grades
           WHERE folder_key = 'rich_puts' AND horizon = 'expiry' AND jsonb_typeof(detail->'rich') = 'object'"""
    ).fetchall()
    item, promised = "Rich puts — your rule (S109)", "high tier +185 / mid +87 / low +34 bp per collateral-week on real quotes, worst-5 % week −81 / −384 / −425"
    parsed = [p for p in (_rich_pick(*row) for row in rs) if p]
    picks = dedupe_first_snapshot(parsed)
    if not picks:
        return (item, "S109", promised, "no graded rich-lane puts yet (first expiry 10-30)", "0", "too early", {})
    tier, sec, name, cl = defaultdict(list), defaultdict(list), defaultdict(list), defaultdict(list)
    for p in picks:
        bp = 1e4 * p["ret"] / (max(p["days"] or 7, 1) / 7)
        tier[p["tier"]].append(bp)
        sec[p["sector"]].append(bp)
        name[p["ticker"]].append(bp)
        g = p["group"]
        cl[(str(p["expiry"])[:10], f"g{g}" if g is not None else p["sector"] or p["ticker"])].append(bp)
    bets = [sum(v) / len(v) for v in cl.values()]
    by = {k: _perf(v) for k, v in tier.items()}
    n_exp = len({p["expiry"] for p in picks})
    m = sum(bets) / len(bets)
    se = (sum((x - m) ** 2 for x in bets) / max(len(bets) - 1, 1)) ** 0.5 / len(bets) ** 0.5
    attach_universe_excess(conn, picks)
    terc = ntile_partition(picks, "expiry", "option_score")
    weeks = grade_week_table(terc)
    summary = _tercile_summary(terc)
    base = ("too early" if n_exp < MIN_EXPIRIES else "failed" if m + 2 * se < 0 else
            "holding" if (by.get("high") or {}).get("bp_wk", -1e9) >= (by.get("low") or {}).get("bp_wk", 1e9) else "drifting")
    verdict = "inverted" if weeks_inverted(weeks)[0] else base
    live = f"{m:+.1f} bp/wk per group-week bet · " + " · ".join(f"{k} {v['bp_wk']:+.0f} (n {v['n']})" for k, v in sorted(by.items()))
    if summary and summary[0].get("excess_pct") is not None and summary[-1].get("excess_pct") is not None:
        live += f" · T1 excess {summary[0]['excess_pct']:+.2f}pp T3 {summary[-1]['excess_pct']:+.2f}pp"
    if verdict == "inverted":
        live = "inverted · " + live
    dupes = len(parsed) - len(picks)
    return (item, "S109", promised, live, format_n(len(picks), n_exp) + f" · {dupes} dupes dropped", verdict,
            {"by_tier": by, "by_sector": {k: _perf(v) for k, v in sec.items()}, "by_name": {k: _perf(v) for k, v in name.items()},
             "terciles": summary, "weeks": weeks, "deduped": dupes, "ask": "A352"})


def blocked_gate_checks(conn) -> list[tuple]:
    """Per L1 gate: week-clustered P&L of blocked ideas vs sell_puts kept (shown) ideas."""
    rows_ = conn.execute(
        """SELECT folder_key, ret::float8, detail FROM watchlist_sync.grades
           WHERE horizon = 'expiry' AND bucket <> 'data'
             AND (folder_key LIKE 'blocked:%' OR folder_key = 'sell_puts')"""
    ).fetchall()
    kept_raw, by_gate = [], defaultdict(list)
    for fk, ret, detail in rows_:
        d = detail or {}
        wk = expiry_week_from_detail(d)
        if wk is None:
            continue
        row = {"ret": ret, "week": wk, "breach": bool(d.get("breach"))}
        if fk == "sell_puts":
            kept_raw.append(row)
        elif fk.startswith("blocked:"):
            by_gate[fk.split(":", 1)[1]].append(row)
    kept = week_cluster_metrics(kept_raw)
    out = []
    for gate, blocked in sorted(by_gate.items()):
        rem = week_cluster_metrics(blocked)
        item = f"Blocked gate: {gate}"
        promised = "Gate removes losers, not winners (week-clustered kept vs removed P&L)"
        k_m, r_m = kept.get("week_mean_ret"), rem.get("week_mean_ret")
        live = (
            f"kept {k_m:+.2%}/trade · removed {r_m:+.2%}/trade · breach removed {rem.get('breach_rate') or 0:.0%}"
            if k_m is not None and r_m is not None
            else "insufficient paired data"
        )
        n_label = format_n(rem["n_trades"], rem["n_weeks"])
        verdict = "too early" if rem["n_weeks"] < MIN_EXPIRIES else (
            "drifting" if k_m is not None and r_m is not None and r_m >= k_m else "holding"
        )
        out.append((f"blocked_{gate}", item, "A327", promised, live, n_label, verdict,
                    {"kept": kept, "removed": rem, "gate": gate}))
    return out


CHECKS = [model_list, options_shadow, fair_value, assign_odds, own_vs_avoid, fv_spread, ira_vs_benchmark, engine_puts, pace_takes,
          rich_puts]


def _ensure_check_key(conn) -> None:
    """A121: one active row per check_key; merge legacy f.__name__ twins into the label row."""
    conn.execute("ALTER TABLE watchlist_sync.scoreboard ADD COLUMN IF NOT EXISTS check_key text")
    conn.commit()
    # Map known labels (+ aliases) → key; function-name rows → that key
    label_to_key = {v: k for k, v in CHECK_LABELS.items()}
    label_to_key.update(LABEL_ALIASES)
    rows = conn.execute("SELECT item, source, promised, live, n, verdict, detail, checked_at FROM watchlist_sync.scoreboard").fetchall()
    by_item = {r[0]: r for r in rows}
    for key, label in CHECK_LABELS.items():
        fn_row = by_item.get(key)
        # Prefer current label; fall back to alias label still in DB
        label_row = by_item.get(label)
        if label_row is None:
            for alias, ak in LABEL_ALIASES.items():
                if ak == key and alias in by_item:
                    label_row = by_item[alias]
                    break
        if fn_row and label_row and fn_row[0] != label_row[0]:
            # Keep label row; copy last_error from fn-name failure if present
            det = dict(label_row[6] or {}) if isinstance(label_row[6], dict) else {}
            if (fn_row[5] or "") == "no live check" and fn_row[3]:
                det.setdefault("last_error", str(fn_row[3])[:200])
                det.setdefault("last_error_at", str(fn_row[7]))
                det["error_active"] = True
            conn.execute(
                """UPDATE watchlist_sync.scoreboard SET check_key = %s, detail = %s::jsonb WHERE item = %s""",
                (key, json.dumps(det), label_row[0]),
            )
            conn.execute("DELETE FROM watchlist_sync.scoreboard WHERE item = %s", (key,))
            conn.commit()
        elif fn_row and not label_row:
            conn.execute(
                """UPDATE watchlist_sync.scoreboard SET check_key = %s, item = %s WHERE item = %s""",
                (key, label, key),
            )
            conn.commit()
        elif label_row:
            conn.execute("UPDATE watchlist_sync.scoreboard SET check_key = %s WHERE item = %s", (key, label_row[0]))
            conn.commit()
    # Backfill any remaining by alias / exact label
    for item, *_rest in conn.execute("SELECT item FROM watchlist_sync.scoreboard WHERE check_key IS NULL").fetchall():
        k = label_to_key.get(item) or (item if item in CHECK_LABELS else None)
        if k:
            conn.execute("UPDATE watchlist_sync.scoreboard SET check_key = %s WHERE item = %s", (k, item))
            conn.commit()
    conn.execute(
        """CREATE UNIQUE INDEX IF NOT EXISTS scoreboard_check_key_uidx
           ON watchlist_sync.scoreboard (check_key) WHERE check_key IS NOT NULL"""
    )
    conn.commit()


def _upsert(conn, check_key: str, item: str, src: str, promised: str, live: str, n: str, verdict: str, detail: dict) -> None:
    prev = conn.execute(
        "SELECT detail FROM watchlist_sync.scoreboard WHERE check_key = %s", (check_key,)
    ).fetchone()
    prev_d = dict(prev[0] or {}) if prev and isinstance(prev[0], dict) else {}
    # Preserve last_error provenance across success; clear error_active on success
    if verdict == "no live check":
        detail = {
            **prev_d,
            **detail,
            "last_error": (detail.get("last_error") or live or "")[:200],
            "last_error_at": detail.get("last_error_at") or __import__("datetime").datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "error_active": True,
        }
    else:
        detail = {
            **detail,
            "error_active": False,
            "last_error": prev_d.get("last_error"),
            "last_error_at": prev_d.get("last_error_at"),
        }
    conn.execute(
        """INSERT INTO watchlist_sync.scoreboard
             (check_key, item, source, promised, live, n, verdict, detail, checked_at)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s::jsonb, now())
           ON CONFLICT (check_key) WHERE check_key IS NOT NULL DO UPDATE SET
             item = excluded.item, source = excluded.source, promised = excluded.promised,
             live = excluded.live, n = excluded.n, verdict = excluded.verdict,
             detail = excluded.detail, checked_at = now()""",
        (check_key, item, src, promised, live, n, verdict, json.dumps(detail)),
    )
    # Also clear any stale primary-key twin keyed by old item label / fn name
    conn.execute(
        "DELETE FROM watchlist_sync.scoreboard WHERE check_key IS DISTINCT FROM %s AND (item = %s OR item = %s)",
        (check_key, item, check_key),
    )
    conn.commit()


def main() -> None:
    conn = connect()
    # DDL + each check get their own commit. A failed check used to rollback the
    # whole transaction (undoing CREATE TABLE + earlier rows), then INSERT anyway
    # → first-run undefined_table crash / later runs silently stale (A121).
    conn.execute(DDL)
    conn.commit()
    _ensure_check_key(conn)
    for f in CHECKS:
        key = f.__name__
        label = CHECK_LABELS[key]
        try:
            item, src, promised, live, n, verdict, detail = f(conn)
            _upsert(conn, key, item, src, promised, live, n, verdict, dict(detail or {}))
        except Exception as e:  # one broken check must not hide the others
            conn.rollback()
            live = f"check failed: {e}"[:200]
            _upsert(conn, key, label, "", "", live, "", "no live check", {"last_error": live})
            item, verdict = label, "no live check"
        print(f"{verdict:14} {item}: {live}")
    for check_key, item, src, promised, live, n, verdict, detail in blocked_gate_checks(conn):
        try:
            _upsert(conn, check_key, item, src, promised, live, n, verdict, dict(detail or {}))
        except Exception as e:  # noqa: BLE001
            conn.rollback()
            _upsert(conn, check_key, item, "", "", f"check failed: {e}"[:200], "", "no live check", {})
        print(f"{verdict:14} {item}: {live}")


if __name__ == "__main__":
    main()
