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
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from build_plan import connect  # noqa: E402

MIN_EXPIRIES = 8

DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.scoreboard (item text PRIMARY KEY, source text, promised text, live text,
  n text, verdict text, detail jsonb, checked_at timestamptz DEFAULT now())"""


def model_list(conn) -> tuple:
    """Model List option score (fit-1.4.3, S008): higher score should mean better graded outcome."""
    r = conn.execute("""SELECT count(DISTINCT expiry), count(*) FROM model_recs WHERE graded_at IS NOT NULL AND side = 'put'""").fetchone()
    weeks, n = r
    terc = conn.execute("""SELECT t, count(*), avg((pnl_per_share >= 0)::int), avg(pnl_pct) FROM (
                             SELECT *, ntile(3) OVER (ORDER BY option_score) t FROM model_recs
                             WHERE graded_at IS NOT NULL AND side = 'put') x GROUP BY t ORDER BY t""").fetchall()
    d = [{"tercile": t, "n": k, "win": round(float(w), 2), "pnl_pct": round(float(p), 3)} for t, k, w, p in terc]
    live = " · ".join(f"T{x['tercile']} win {x['win']:.0%} P&L {x['pnl_pct']:+.2f}%" for x in d) if d else "no graded picks"
    if weeks < MIN_EXPIRIES:
        verdict = "too early"
    else:
        verdict = "holding" if d and d[-1]["pnl_pct"] >= d[0]["pnl_pct"] else "drifting"
    return ("Model List put score (fit-1.4.3)", "S008", "Top-third scores beat bottom third on graded P&L",
            live, f"{n} puts · {weeks} expiries", verdict, {"terciles": d})


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
    """fv-1.1.0 is display-only (S009: cheapness gaps don't predict) → live check = health, not returns."""
    r = conn.execute("""WITH l AS (SELECT DISTINCT ON (ticker) * FROM fair_value_snapshots ORDER BY ticker, as_of DESC)
                        SELECT count(*), count(fair_value), count(*) FILTER (WHERE price_to_fair < 0.25 OR price_to_fair > 4) FROM l""").fetchone()
    tot, valued, extreme = r
    verdict = "holding" if extreme <= 0.01 * valued else "drifting"
    return ("Fair value (fv-1.1.0)", "S009", "Display only; no return prediction. Health: few absurd values",
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
    item, promised = "Fair value cheap − rich (fv-1.1.0)", "Cheapest quintile beats richest over ~1 month (S009 says it won't — testing)"
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


CHECKS = [model_list, options_shadow, fair_value, assign_odds, own_vs_avoid, fv_spread, ira_vs_benchmark]


def main() -> None:
    conn = connect()
    # DDL + each check get their own commit. A failed check used to rollback the
    # whole transaction (undoing CREATE TABLE + earlier rows), then INSERT anyway
    # → first-run undefined_table crash / later runs silently stale (A121).
    conn.execute(DDL)
    conn.commit()
    for f in CHECKS:
        try:
            item, src, promised, live, n, verdict, detail = f(conn)
            conn.execute("""INSERT INTO watchlist_sync.scoreboard (item, source, promised, live, n, verdict, detail, checked_at)
                            VALUES (%s,%s,%s,%s,%s,%s,%s, now()) ON CONFLICT (item) DO UPDATE SET source = excluded.source,
                            promised = excluded.promised, live = excluded.live, n = excluded.n, verdict = excluded.verdict,
                            detail = excluded.detail, checked_at = now()""",
                         (item, src, promised, live, n, verdict, json.dumps(detail)))
            conn.commit()
        except Exception as e:  # one broken check must not hide the others
            conn.rollback()
            item, src, promised, live, n, verdict, detail = (f.__name__, "", "", f"check failed: {e}"[:200], "", "no live check", {})
            conn.execute("""INSERT INTO watchlist_sync.scoreboard (item, source, promised, live, n, verdict, detail, checked_at)
                            VALUES (%s,%s,%s,%s,%s,%s,%s, now()) ON CONFLICT (item) DO UPDATE SET source = excluded.source,
                            promised = excluded.promised, live = excluded.live, n = excluded.n, verdict = excluded.verdict,
                            detail = excluded.detail, checked_at = now()""",
                         (item, src, promised, live, n, verdict, json.dumps(detail)))
            conn.commit()
        print(f"{verdict:14} {item}: {live}")


if __name__ == "__main__":
    main()
