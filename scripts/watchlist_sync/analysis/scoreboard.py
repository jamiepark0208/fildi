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


CHECKS = [model_list, fair_value, assign_odds]


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
