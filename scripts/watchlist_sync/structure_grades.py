"""A192 V2 (11-24): realized track record per Structures board structure → watchlist_sync.structure_grades.

Every expired board pick (structure_rank_daily, all tiers since 10-19), graded once:
  identity   first-issued row per (structure, ticker, legs incl. expiry); later re-listings of the same contract are dupes
  settle     close on the front expiry (≤ 4 calendar days back for weekends/holidays, else 'no close' — never 0)
  P&L        net credit + Σ qty × leg value at the front expiry; back legs (calendar) keep Black-Scholes time value at
             their own IV; collar adds the share move (same units as the board's prediction)
  units      realized = P&L ÷ the board's capital, whole trade. Predicted = board EV in the same units (CSP: ev_board —
             ev_rv_cap there is S088 bp/week since the A271 override, not comparable)
  big moves  |S/S0 − 1| > 60 %: optlab.splits or lseg corporate_action_log hit on/after entry → excluded (corporate action: the
             stored history is re-based vs the entry spot, e.g. SNDK ×0.125 on 11-20);
             no record → kept (a real crash stays in), flagged, and the mean without them is reported alongside
  stats      per structure × scope (primary / all tiers): n, entry dates, expiries, pred vs real mean, median, win,
             pooled ρ and within-entry-date ρ (descriptive), interval from per-expiry means (expiries share market risk,
             so they — not contracts — are the independent units), and a one-regime warning when every expiry
             cluster saw SPY move the same way.
Run by daily.py after the strategies board; table reads only in the API. No vendor calls.
    .venv/bin/python structure_grades.py [--print]
"""
from __future__ import annotations

import json
import math
import sys
from collections import defaultdict
from datetime import date, timedelta

import numpy as np

from build_plan import connect, rows
from structures import leg_value

BIG = 0.6
SETTLE_BACK = 4


def spearman(a, b) -> float | None:
    if len(a) < 4:
        return None
    ra, rb = np.argsort(np.argsort(a)), np.argsort(np.argsort(b))
    if np.std(ra) == 0 or np.std(rb) == 0:
        return None
    return float(np.corrcoef(ra, rb)[0, 1])


def settle_pnl(p: dict, S: float) -> float:
    e = p["expiry"]
    pnl = float(p["credit"])
    for lg in p["legs"]:
        x = date.fromisoformat(str(lg["expiry"])[:10])
        left = max((x - date.fromisoformat(e)).days, 0) / 365
        pnl += lg["qty"] * float(leg_value(S, {**lg, "strike": float(lg["strike"])}, left))
    if p.get("stock"):
        pnl += S - float(p["spot"])
    return pnl


def pred_of(sid: str, p: dict):
    if sid == "csp":
        return p.get("ev_board")   # whole-trade board EV; ev_rv_cap = S088 weekly bp since A271
    return p.get("ev_rv_cap")


def grade_rows(conn, today: date):
    raw = rows(conn, """SELECT as_of, structure, rank, ticker, payload FROM watchlist_sync.structure_rank_daily
                        WHERE (payload->>'expiry')::date < %s ORDER BY as_of, structure, rank""", (today,))
    if not raw:
        return [], {}
    tick = sorted({r["ticker"] for r in raw} | {"SPY"})
    lo = min(r["as_of"] for r in raw) - timedelta(days=7)
    px = defaultdict(dict)
    for t, d, c in conn.execute("""SELECT UPPER(ticker), date, close::float8 FROM prices_historical
                                   WHERE UPPER(ticker) = ANY(%s) AND date >= %s AND close > 0""", (tick, lo)).fetchall():
        px[t][d] = c
    splits = defaultdict(list)
    for t, d in conn.execute("SELECT UPPER(ticker), exec_date FROM optlab.splits WHERE exec_date >= %s", (lo,)).fetchall():
        splits[t].append(d)
    for t, d in conn.execute("""SELECT UPPER(ticker), detected_at::date FROM lseg_research.corporate_action_log
                                WHERE detected_at >= %s AND abs(ratio - 1) > 0.1""", (lo,)).fetchall():
        splits[t].append(d)
    ledger = {q for (q,) in conn.execute("""SELECT DISTINCT question_id FROM watchlist_sync.forecast_ledger
                                             WHERE qtype = 'sim_structure' AND question_id LIKE 'struct:%%'""").fetchall()}

    def close(t, d):
        for k in range(SETTLE_BACK + 1):
            v = px[t].get(d - timedelta(days=k))
            if v:
                return v
        return None

    seen, out, excl = set(), [], defaultdict(int)
    for r in raw:
        p, sid, t = r["payload"], r["structure"], r["ticker"]
        legs = p.get("legs") or []
        key = (sid, t, tuple(sorted((lg["side"], float(lg["strike"]), lg["qty"], str(lg["expiry"])[:10]) for lg in legs)))
        if not legs or key in seen:
            excl["duplicate listing" if legs else "no legs"] += 1
            continue
        seen.add(key)
        e = date.fromisoformat(p["expiry"])
        S, S0, cap = close(t, e), float(p.get("spot") or 0), float(p.get("capital") or 0)
        if not S:
            excl["no close" if (today - e).days > 5 else "pending close"] += 1
            continue
        if cap <= 0 or S0 <= 0:
            excl["no capital / spot"] += 1
            continue
        big = abs(S / S0 - 1) > BIG
        if big and any(d >= r["as_of"] for d in splits[t]):   # a re-based history after entry breaks spot vs close
            excl["corporate action"] += 1
            continue
        pnl = settle_pnl(p, S)
        spy0, spy1 = close("SPY", r["as_of"]), close("SPY", e)
        out.append({"structure": sid, "ticker": t, "tier": p.get("tier") or "primary", "as_of": r["as_of"], "expiry": e,
                    "pred": pred_of(sid, p), "real": pnl / cap, "win": pnl > 0, "big": big,
                    "spy": (spy1 / spy0 - 1) if spy0 and spy1 else None,
                    "ledger": f"struct:{sid}:{t}:{p['expiry']}:{r['as_of']}" in ledger})
    return out, dict(excl)


def summarize(g: list[dict]) -> dict:
    real = np.array([x["real"] for x in g])
    pp = [(x["pred"], x["real"]) for x in g if x["pred"] is not None and math.isfinite(x["pred"])]
    by_d, by_e = defaultdict(list), defaultdict(list)
    for x in g:
        by_e[x["expiry"]].append(x)
        if x["pred"] is not None:
            by_d[x["as_of"]].append((x["pred"], x["real"]))
    wd = [s for v in by_d.values() if (s := spearman([a for a, _ in v], [b for _, b in v])) is not None]
    em = np.array([np.mean([x["real"] for x in v]) for v in by_e.values()])
    k = len(em)
    ci = None
    if k >= 3:   # t interval over expiry-cluster means (t.975 for k−1 df, small-k table)
        tq = {2: 4.30, 3: 3.18, 4: 2.78, 5: 2.57, 6: 2.45, 7: 2.36, 8: 2.31, 9: 2.26}.get(k - 1, 2.0)
        h = tq * float(np.std(em, ddof=1)) / math.sqrt(k)
        ci = [round(float(em.mean()) - h, 4), round(float(em.mean()) + h, 4)]
    regimes = {("up" if np.nanmean([x["spy"] for x in v if x["spy"] is not None] or [np.nan]) >= 0 else "down")
               for v in by_e.values() if any(x["spy"] is not None for x in v)}
    nb = [x["real"] for x in g if not x["big"]]
    return {
        "n": len(g), "entry_dates": len({x["as_of"] for x in g}), "expiries": k,
        "first": str(min(x["as_of"] for x in g)), "last_expiry": str(max(x["expiry"] for x in g)),
        "pred_mean": round(float(np.mean([a for a, _ in pp])), 4) if pp else None,
        "real_mean": round(float(real.mean()), 4), "real_median": round(float(np.median(real)), 4),
        "win": round(float(np.mean([x["win"] for x in g])), 3),
        "rho": None if (s := spearman([a for a, _ in pp], [b for _, b in pp])) is None or len(pp) < 10 else round(s, 2),
        "rho_within_date": round(float(np.mean(wd)), 2) if wd else None, "rho_dates": len(wd),
        "ci_cluster": ci, "n_big": len(g) - len(nb),
        "real_mean_ex_big": round(float(np.mean(nb)), 4) if nb and len(nb) < len(g) else None,
        "regimes": sorted(regimes), "one_regime": len(regimes) < 2,
        "ledger_matched": sum(x["ledger"] for x in g),
    }


def main():
    today = date.today()
    with connect() as conn:
        g, excl = grade_rows(conn, today)
        conn.execute("""CREATE TABLE IF NOT EXISTS watchlist_sync.structure_grades (
          as_of date NOT NULL, structure text NOT NULL, scope text NOT NULL, payload jsonb NOT NULL,
          PRIMARY KEY (as_of, structure, scope))""")
        conn.execute("DELETE FROM watchlist_sync.structure_grades WHERE as_of = %s", (today,))
        by = defaultdict(list)
        for x in g:
            by[(x["structure"], "all")].append(x)
            if x["tier"] == "primary":
                by[(x["structure"], "primary")].append(x)
        res = {k: summarize(v) for k, v in by.items()}
        for (sid, scope), s in res.items():
            conn.execute("INSERT INTO watchlist_sync.structure_grades VALUES (%s, %s, %s, %s)",
                         (today, sid, scope, json.dumps(s)))
        conn.execute("INSERT INTO watchlist_sync.structure_grades VALUES (%s, '_run', 'all', %s)",
                     (today, json.dumps({"graded": len(g), "excluded": excl})))
        conn.commit()
    print(f"structure_grades: {len(g)} graded · excluded {excl} · {len(res)} structure×scope rows")
    if "--print" in sys.argv:
        for (sid, scope), s in sorted(res.items()):
            pm = "—" if s["pred_mean"] is None else f"{100 * s['pred_mean']:+.1f}%"
            print(f"  {sid:17s} {scope:7s} n {s['n']:4d} exp {s['expiries']:2d}  pred {pm:>8s}  real {100 * s['real_mean']:+6.1f}% "
                  f"med {100 * s['real_median']:+6.1f}%  win {100 * s['win']:3.0f}%  ρ {s['rho']}  ρ/date {s['rho_within_date']}  "
                  f"ci {s['ci_cluster']}  big {s['n_big']}  {'ONE REGIME' if s['one_regime'] else ''}  ledger {s['ledger_matched']}")


if __name__ == "__main__":
    main()
