#!/usr/bin/env python3
"""A277 §3: every surface shows the engine's sold put (put_recs_daily). Mismatches print as WARN lines (daily.py publish).

Checks for the latest day: Model List sell_puts (plan_items, re-struck from the table) and Structures CSP rows carry the
same strike + expiry as watchlist_sync.put_recs_daily. Rankings / Live read the table directly (no copy to compare).
10-26: the yes/no must agree too. Every engine pass reaches the Model List's L1 and passes it unless an account check
(ACCOUNT_CHECKS) blocks it, and no L1 pass is an engine fail; a Structures CSP is "fit" exactly when the engine passes.
    .venv/bin/python put_consistency.py
"""
from __future__ import annotations

from build_plan import connect, rows

ACCOUNT_CHECKS = {"collateral_fits", "not_on_trim", "list_cap", "existing_exposure"}   # yours, not the market's


def main():
    with connect() as conn:
        eng = {r["ticker"]: (float(r["payload"]["strike"]), r["payload"]["expiry"]) for r in rows(conn, """
            SELECT ticker, payload FROM watchlist_sync.put_recs_daily
            WHERE as_of = (SELECT MAX(as_of) FROM watchlist_sync.put_recs_daily) AND payload->>'strike' IS NOT NULL""")}
        surfaces = {
            "Model List": rows(conn, """SELECT pi.ticker, pi.strike::float8 strike, pi.expiry::text expiry
                                       FROM watchlist_sync.plan_items pi WHERE pi.plan_id = (SELECT MAX(id) FROM watchlist_sync.plans)
                                       AND pi.list_key = 'sell_puts' AND pi.l1_pass"""),
            "Structures CSP": rows(conn, """SELECT ticker, (payload->'legs'->0->>'strike')::float8 strike, payload->'legs'->0->>'expiry' expiry
                                           FROM watchlist_sync.structure_rank_daily WHERE structure = 'csp'
                                           AND as_of = (SELECT MAX(as_of) FROM watchlist_sync.structure_rank_daily)"""),
        }
        bad = 0
        for name, rs in surfaces.items():
            for r in rs:
                e = eng.get(r["ticker"])
                if not e:
                    print(f"WARN put consistency: {name} shows {r['ticker']} but the engine has no pick"); bad += 1
                elif (r["strike"], str(r["expiry"])[:10]) != (e[0], str(e[1])[:10]):
                    print(f"WARN put consistency: {name} {r['ticker']} {r['strike']:g} {str(r['expiry'])[:10]} ≠ engine {e[0]:g} {e[1]}"); bad += 1
        ok = {r["ticker"] for r in rows(conn, """SELECT ticker FROM watchlist_sync.put_recs_daily
                 WHERE as_of = (SELECT MAX(as_of) FROM watchlist_sync.put_recs_daily) AND pass""")}
        l1 = {r["ticker"]: r for r in rows(conn, """SELECT ticker, l1_pass, l1_checks FROM watchlist_sync.plan_items
                 WHERE plan_id = (SELECT MAX(id) FROM watchlist_sync.plans) AND list_key = 'sell_puts'""")}
        for t in sorted(ok):
            r = l1.get(t)
            why = [] if not r or r["l1_pass"] else [x["check"] for x in r["l1_checks"] or []
                                                  if not x.get("pass") and x.get("severity") != "warn" and x["check"] not in ACCOUNT_CHECKS]
            if not r or why:
                print(f"WARN put consistency: engine passes {t} but the Model List " + ("never saw it" if not r else f"blocks it: {why}")); bad += 1
        for t, r in l1.items():
            if r["l1_pass"] and t not in ok:
                print(f"WARN put consistency: Model List passes {t} but the engine gates it"); bad += 1
        for r in rows(conn, """SELECT ticker, (payload->>'fit')::bool fit FROM watchlist_sync.structure_rank_daily WHERE structure = 'csp'
                               AND as_of = (SELECT MAX(as_of) FROM watchlist_sync.structure_rank_daily)"""):
            if r["fit"] is not None and r["fit"] != (r["ticker"] in ok):
                print(f"WARN put consistency: Structures CSP {r['ticker']} fit={r['fit']} vs engine pass={r['ticker'] in ok}"); bad += 1
        print(f"put consistency: {sum(len(v) for v in surfaces.values())} surface rows vs {len(eng)} engine picks · {bad} mismatch(es)")


if __name__ == "__main__":
    main()
