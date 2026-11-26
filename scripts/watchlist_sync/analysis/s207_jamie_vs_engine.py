#!/usr/bin/env python3
"""S207 — is the put engine better than Jamie's own short puts? (Jamie 11-26: "not enough evidence or proof
that our model is actually good … or even better than the trades that i placed")

Jamie side: every filled short-put open in portfolio_orders (RH, all accounts, 2025-03 →), one row per
(account, symbol, strike, expiry, open date), contract-weighted fill. Two grades, both % of strike:
  hold   = (fill − intrinsic at expiry close) / strike  (expired contracts only)
  actual = (fill − buy-to-close fill) / strike when he closed it, else hold
Engine side: A352 rebuilt book (weekly ~1σ puts, iv30-priced, net of fill cost, inputs known at entry);
champion = top third by the live option-score each week; random = every name that week (same-Δ comparator).
Fair unit: bp of strike per week held (cash-secured collateral = strike). Paired by ISO week (only weeks
Jamie opened ≥ 1 put AND the book has ≥ 20 names). Week-clustered t; halves; worst week.
Decomposition: "Jamie's names, engine structure" = book rows on the names Jamie sold that week
→ separates name choice from strike/DTE/exit choice.
Limits: engine side is model-priced (iv30 BS − fill cost), Jamie side is real fills; checked below by pricing
Jamie's own contracts with the same model (calibration line).

    cd scripts/watchlist_sync && .venv/bin/python analysis/s207_jamie_vs_engine.py [--book <pkl>]
"""
from __future__ import annotations

import argparse
import math
import pickle
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

from build_plan import connect  # noqa: E402

REPORT = HERE.parents[2] / "research" / "studies" / "s207-jamie-vs-engine.md"
MIN_NAMES = 20


def wk(d: date) -> date:
    return d - timedelta(days=d.weekday())


def load_jamie(c):
    cur = c.execute("""
        WITH o AS (SELECT DISTINCT ON (order_id) order_id, account, symbol t, option_strike::float k, option_expiration e,
                          created_at, avg_fill_price::float px, GREATEST(COALESCE(processed_qty, quantity), 0)::float q,
                          side, leg_effect
                   FROM portfolio_orders
                   WHERE state = 'filled' AND is_option AND option_side = 'put' AND avg_fill_price > 0
                   ORDER BY order_id, created_at DESC)
        SELECT account, t, k, e, created_at, px, q, side, leg_effect FROM o ORDER BY created_at""")
    opens, closes = defaultdict(list), defaultdict(list)
    for acct, t, k, e, ts, px, q, side, eff in cur.fetchall():
        q = q or 1.0
        key = (acct, t, round(k, 3), e)
        if side == "credit" and eff == "open":
            opens[key + (ts.date(),)].append((px, q))
        elif side == "debit" and eff == "close":
            closes[key].append((ts.date(), px, q))
    # FIFO: each buy-to-close fills the earliest still-open lot of the same contract opened on/before it
    lots = defaultdict(list)
    for (acct, t, k, e, d), fills in opens.items():
        q = sum(f[1] for f in fills)
        lots[(acct, t, k, e)].append({"acct": acct, "t": t, "k": k, "e": e, "d": d, "q": q,
                                       "px": sum(f[0] * f[1] for f in fills) / q, "closes": [], "left": q})
    for key, ls in lots.items():
        ls.sort(key=lambda r: r["d"])
        for cd, cpx, cq in sorted(closes.get(key, [])):
            for r in ls:
                if cq <= 1e-9:
                    break
                if r["d"] <= cd and r["left"] > 1e-9:
                    take = min(r["left"], cq)
                    r["closes"].append((cd, cpx, take)); r["left"] -= take; cq -= take
    rows = [r for ls in lots.values() for r in ls]
    return rows


def closes_for(c, tickers, d0):
    cur = c.execute("SELECT ticker, date, close::float FROM prices_historical WHERE ticker = ANY(%s) AND date >= %s",
                    (sorted(tickers), d0))
    out = defaultdict(dict)
    for t, d, cl in cur.fetchall():
        out[t][d] = cl
    return out


def close_on_or_before(series: dict, d: date):
    for i in range(6):
        v = series.get(d - timedelta(days=i))
        if v:
            return v
    return None


def grade_jamie(rows, px, last: date):
    out = []
    for r in rows:
        s = px.get(r["t"], {})
        spot = close_on_or_before(s, r["d"])
        if not spot or abs(r["k"] / spot - 1) > 0.6:   # bad print / split guard
            continue
        held_to = min(r["e"], last)
        hold = None
        if r["e"] <= last:
            se = close_on_or_before(s, r["e"])
            if se:
                hold = (r["px"] - max(0.0, r["k"] - se)) / r["k"]
        cq = min(sum(x[2] for x in r["closes"]), r["q"])
        rem = r["q"] - cq
        if rem > 1e-9 and hold is None:     # part still open, not expired → ungraded
            continue
        # $ per share-contract unit (×100 cancels): closed lots at their buy-back, the rest at expiry
        pnl = sum((r["px"] - cpx) * cqq for _, cpx, cqq in r["closes"]) + (rem * hold * r["k"] if rem > 1e-9 else 0.0)
        actual = pnl / (r["q"] * r["k"])
        days_c = sum(max((cd - r["d"]).days, 1) * cqq for cd, _, cqq in r["closes"])
        days_act = (days_c + rem * max((r["e"] - r["d"]).days, 1)) / r["q"]
        days_hold = max((r["e"] - r["d"]).days, 1)
        out.append({**r, "spot": spot, "otm": 1 - r["k"] / spot, "dte": (r["e"] - r["d"]).days,
                    "hold": hold, "actual": actual, "closed_early": cq >= 0.999 * r["q"],
                    # pooled units: $ P&L and $ collateral-weeks (strike × contracts × weeks held)
                    "pnl_act": pnl, "cw_act": r["k"] * r["q"] * days_act / 7,
                    "pnl_hold": None if hold is None else hold * r["k"] * r["q"],
                    "cw_hold": r["k"] * r["q"] * days_hold / 7,
                    "prem_k": r["px"] / r["k"]})
    return out


def tstat(x):
    x = np.asarray(x, float)
    if len(x) < 3 or x.std(ddof=1) == 0:
        return float("nan")
    return x.mean() / (x.std(ddof=1) / math.sqrt(len(x)))


def bp(x):
    return f"{x * 1e4:+.1f}"


def run(c, book):
    """→ (report lines, UI card dict). One home for the numbers (report + Track Record › Journal card)."""
    jam_raw = load_jamie(c)
    px = closes_for(c, {r["t"] for r in jam_raw}, min(r["d"] for r in jam_raw) - timedelta(days=10))
    last = max(max(s) for s in px.values() if s)
    J = grade_jamie(jam_raw, px, last)

    # engine weeks
    by = defaultdict(list)
    for e in book:
        by[wk(e["d"])].append(e)
    eng, rnd, names_in_book = {}, {}, {}
    for w, g in by.items():
        if len(g) < MIN_NAMES:
            continue
        g = sorted(g, key=lambda e: (-e["score"], e["t"]))
        n = max(1, len(g) // 3)
        # pooled: Σ pnl (fraction of strike, equal strike $) ÷ Σ collateral-weeks (dte / 7)
        pool = lambda xs: float(sum(e["pnl"] for e in xs) / sum(max(e["dte"], 1) / 7 for e in xs))  # noqa: E731
        eng[w], rnd[w] = pool(g[:n]), pool(g)
        names_in_book[w] = {e["t"]: e for e in g}
    book_end = max(eng)

    # Jamie weekly series (contract-weighted and per trade), on opens in book weeks
    jw_act, jw_hold, jw_names = defaultdict(list), defaultdict(list), defaultdict(list)
    for r in J:
        w = wk(r["d"])
        jw_act[w].append((r["pnl_act"], r["cw_act"]))
        if r["pnl_hold"] is not None:
            jw_hold[w].append((r["pnl_hold"], r["cw_hold"]))
        if w in names_in_book and r["t"] in names_in_book[w]:
            e = names_in_book[w][r["t"]]
            jw_names[w].append((e["pnl"], max(e["dte"], 1) / 7))

    def wmean(xs):  # Σ $ P&L ÷ Σ $ collateral-weeks
        return sum(x[0] for x in xs) / sum(x[1] for x in xs)

    weeks = sorted(w for w in jw_act if w in eng)
    L = []
    L.append(f"# S207 — Jamie's short puts vs the put engine, same weeks ({date.today()})\n")
    L.append(f"Jamie: {len(jam_raw)} open positions in RH orders ({min(r['d'] for r in jam_raw)} → {max(r['d'] for r in jam_raw)}), "
             f"{len(J)} gradable ({sum(r['hold'] is not None for r in J)} expired, {sum(r['closed_early'] for r in J)} closed early), "
             f"{len({r['t'] for r in J})} names. Engine book ends {book_end}; paired weeks {len(weeks)}.\n")

    # Jamie profile
    otm = np.array([r["otm"] for r in J]); dte = np.array([r["dte"] for r in J]); pk = np.array([r["prem_k"] for r in J])
    L.append(f"Jamie's typical put: {np.median(otm):.1%} OTM (IQR {np.percentile(otm,25):.1%}–{np.percentile(otm,75):.1%}), "
             f"{np.median(dte):.0f} DTE (IQR {np.percentile(dte,25):.0f}–{np.percentile(dte,75):.0f}), premium {np.median(pk):.2%} of strike. "
             f"Engine book: ~1σ OTM, 4–5 DTE weekly.\n")

    # all-trade outcome, Jamie only (whole history incl. weeks past book end)
    act = np.array([r["actual"] for r in J]); q = np.array([r["q"] for r in J])
    hold = np.array([r["hold"] for r in J if r["hold"] is not None])
    L.append("## Jamie, every trade (% of strike per trade)\n")
    L.append(f"- actual (with his early closes): mean {act.mean():+.2%}, contract-wtd {np.average(act, weights=q):+.2%}, "
             f"win {(act > 0).mean():.0%}, worst {act.min():+.1%}, n {len(act)}")
    L.append(f"- hold to expiry (expired only): mean {hold.mean():+.2%}, win {(hold > 0).mean():.0%}, worst {hold.min():+.1%}, n {len(hold)}")
    both = [r for r in J if r["hold"] is not None and r["closed_early"]]
    if both:
        d = np.array([r["actual"] - r["hold"] for r in both])
        L.append(f"- early closes vs holding the same contract: {d.mean():+.2%} of strike per trade (n {len(both)}, "
                 f"helped {(d > 0).mean():.0%})")

    # paired weekly
    L.append("\n## Same weeks, bp of strike per week held (paired by week, week-clustered t)\n")
    L.append("| Book | mean bp/wk | vs engine | t | weeks | worst week |")
    L.append("|---|---|---|---|---|---|")
    E = np.array([eng[w] for w in weeks]); R = np.array([rnd[w] for w in weeks])
    JA = np.array([wmean(jw_act[w]) for w in weeks])
    hw = [w for w in weeks if jw_hold[w]]
    JH = np.array([wmean(jw_hold[w]) for w in hw]); EH = np.array([eng[w] for w in hw])
    nw = [w for w in weeks if jw_names[w]]
    JN = np.array([wmean(jw_names[w]) for w in nw]); EN = np.array([eng[w] for w in nw])
    rows = [("Engine champion (top ⅓ by score)", E, E, weeks), ("Random same-Δ (all names)", R, E, weeks),
            ("Jamie actual (his strikes, DTE, exits)", JA, E, weeks), ("Jamie held to expiry", JH, EH, hw),
            ("Jamie's names, engine structure (1σ weekly)", JN, EN, nw)]
    for nm, x, base, ws in rows:
        diff = x - base
        L.append(f"| {nm} | {bp(x.mean())} | {'—' if x is base else bp(diff.mean())} | "
                 f"{'—' if x is base else f'{tstat(diff):+.1f}'} | {len(ws)} | {bp(x.min())} |")
    # halves
    if len(weeks) >= 8:
        h = len(weeks) // 2
        d = JA - E
        L.append(f"\nJamie actual − engine by half: first {bp(d[:h].mean())} (weeks {weeks[0]}…{weeks[h-1]}) · "
                 f"second {bp(d[h:].mean())} (…{weeks[-1]}); Jamie beat the engine in {(d > 0).mean():.0%} of weeks.")
    # risk per book (weekly series)
    L.append("\n## Risk, same weeks\n")
    L.append("| Book | median bp/wk | sd | mean ÷ sd | weeks < −100 bp | worst 3 weeks avg |")
    L.append("|---|---|---|---|---|---|")
    for nm, x in (("Engine champion", E), ("Random same-Δ", R), ("Jamie actual", JA)):
        L.append(f"| {nm} | {bp(np.median(x))} | {x.std(ddof=1) * 1e4:.0f} | {x.mean() / x.std(ddof=1):+.2f} | "
                 f"{(x < -0.01).sum()} | {bp(np.sort(x)[:3].mean())} |")
    worst = sorted(zip(JA - E, weeks))[:3]
    L.append("\nJamie's 3 worst weeks vs engine: " + " · ".join(f"{w} {bp(d)}" for d, w in worst))

    # $ cost of early closes
    both = [r for r in J if r["closed_early"] and r["pnl_hold"] is not None]
    usd = sum((r["pnl_hold"] - r["pnl_act"]) * 100 for r in both)
    wins = [r for r in both if r["pnl_act"] > 0]; loss = [r for r in both if r["pnl_act"] <= 0]
    L.append(f"\n## Early closes, $ (×100 multiplier)\n\n- holding every early-closed contract to expiry instead: {usd:+,.0f} $ "
             f"over {len(both)} positions · profit-takes {len(wins)} ({sum((r['pnl_hold'] - r['pnl_act']) * 100 for r in wins):+,.0f} $) · "
             f"loss closes {len(loss)} ({sum((r['pnl_hold'] - r['pnl_act']) * 100 for r in loss):+,.0f} $)")

    # calibration: engine model price (iv30 BS, no skew) vs Jamie's real fill on his own contract
    import s045_put_retest as S45
    ratio = []
    for r in J:
        e = names_in_book.get(wk(r["d"]), {}).get(r["t"])
        if not e or r["dte"] <= 0:
            continue
        m = S45.bs_put(r["spot"], r["k"], e["iv"], max(r["dte"], 1) / 365)
        if m > 0.01:
            ratio.append(r["px"] / m)
    if ratio:
        ra = np.array(ratio)
        L.append(f"\n## Calibration: Jamie's real fill ÷ engine model price at his strike\n\n- median {np.median(ra):.2f}× "
                 f"(IQR {np.percentile(ra, 25):.2f}–{np.percentile(ra, 75):.2f}), n {len(ra)} → "
                 + ("model under-prices OTM puts (flat iv30, no skew): engine premium is conservative" if np.median(ra) > 1.05
                    else "model over-prices: engine numbers are optimistic" if np.median(ra) < 0.95 else "model ≈ real fills"))
    card = {
        "asOf": str(date.today()), "bookEnd": str(book_end), "weeks": len(weeks),
        "jamieFrom": str(min(r["d"] for r in J)), "jamiePositions": len(J), "jamieNames": len({r["t"] for r in J}),
        "rows": [{"book": nm, "bpWk": float(x.mean() * 1e4), "medianBpWk": float(np.median(x) * 1e4),
                  "sdBp": float(x.std(ddof=1) * 1e4), "worst3Bp": float(np.sort(x)[:3].mean() * 1e4),
                  "vsEngineBp": None if x is base else float((x - base).mean() * 1e4),
                  "t": None if x is base else float(tstat(x - base)), "n": len(ws)}
                 for nm, x, base, ws in rows],
        "beatEngineWeeksPct": float(((JA - E) > 0).mean() * 100),
        "worstWeeks": [{"week": str(w), "vsEngineBp": float(d * 1e4)} for d, w in worst],
        "earlyClose": {"usdIfHeld": float(usd), "n": len(both), "profitTakesUsd": float(sum((r["pnl_hold"] - r["pnl_act"]) * 100 for r in wins)),
                       "lossClosesUsd": float(sum((r["pnl_hold"] - r["pnl_act"]) * 100 for r in loss))},
        "calibration": float(np.median(ra)) if ratio else None,
    }
    return L, card


def refresh(c, book=None) -> int:
    """Daily (learn_cells): recompute and store the card for GET /api/trade-journal."""
    import json
    if book is None:
        import a352_score_rank as A
        book = A.rebuild_book(c)
    L, card = run(c, book)
    REPORT.write_text("\n".join(L) + "\n")
    cur = c.cursor()
    cur.execute("CREATE TABLE IF NOT EXISTS watchlist_sync.jamie_vs_engine (id int PRIMARY KEY DEFAULT 1, card jsonb, updated_at timestamptz DEFAULT now())")
    cur.execute("INSERT INTO watchlist_sync.jamie_vs_engine (id, card) VALUES (1, %s) ON CONFLICT (id) DO UPDATE SET card = EXCLUDED.card, updated_at = now()",
                (json.dumps(card),))
    c.commit()
    return card["weeks"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--book", help="pickled A352 rebuild_book rows (saves ~25 s)")
    a = ap.parse_args()
    c = connect()
    book = pickle.load(open(a.book, "rb")) if a.book else None
    n = refresh(c, book)
    print(REPORT.read_text())
    print(f"→ {REPORT} · watchlist_sync.jamie_vs_engine ({n} weeks)")


if __name__ == "__main__":
    main()
