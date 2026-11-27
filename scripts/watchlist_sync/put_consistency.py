#!/usr/bin/env python3
"""A277 §3: every surface shows the engine's sold put (put_recs_daily). Mismatches print as WARN lines (daily.py publish).

Checks for the latest day: Model List sell_puts (plan_items, re-struck from the table) and Structures CSP rows carry the
same strike + expiry as watchlist_sync.put_recs_daily. Rankings / Live read the table directly (no copy to compare).
10-26: the yes/no must agree too. Every engine pass reaches the Model List's L1 and passes it unless an account check
(ACCOUNT_CHECKS) blocks it, and no L1 pass is an engine fail; a Structures CSP is "fit" exactly when the engine passes.
    .venv/bin/python put_consistency.py
"""
from __future__ import annotations

import sys

from build_plan import connect, rows

ACCOUNT_CHECKS = {"collateral_fits", "not_on_trim", "list_cap", "existing_exposure"}   # yours, not the market's


def main():
    with connect() as conn:
        eng = {r["ticker"]: (float(r["payload"]["strike"]), r["payload"]["expiry"]) for r in rows(conn, """
            SELECT ticker, payload FROM watchlist_sync.put_recs_daily
            WHERE as_of = (SELECT MAX(as_of) FROM watchlist_sync.put_recs_daily) AND payload->>'strike' IS NOT NULL""")}
        surfaces = {
            "Model List": rows(conn, """SELECT pi.ticker, pi.strike::float8 strike, pi.expiry::text expiry, pi.l1_checks
                                       FROM watchlist_sync.plan_items pi WHERE pi.plan_id = (SELECT MAX(id) FROM watchlist_sync.plans)
                                       AND pi.list_key = 'sell_puts' AND pi.l1_pass"""),
            # what the app's Model List actually shows (published copy, not the plan)
            "Model List (published)": rows(conn, """SELECT i.ticker, (i.contract->>'strike')::float8 strike, i.contract->>'expiry' expiry,
                                       i.contract->>'eligibility_source' eligibility_source
                                       FROM watchlist_sync.model_items i WHERE i.folder_key = 'sell_puts'
                                       AND i.run_id = (SELECT MAX(id) FROM watchlist_sync.model_runs)"""),
            "Structures CSP": rows(conn, """SELECT ticker, (payload->'legs'->0->>'strike')::float8 strike, payload->'legs'->0->>'expiry' expiry
                                           FROM watchlist_sync.structure_rank_daily WHERE structure = 'csp'
                                           AND as_of = (SELECT MAX(as_of) FROM watchlist_sync.structure_rank_daily)"""),
        }
        bad = 0
        if not eng:
            print("WARN put consistency: put_recs_daily has 0 priced engine picks — empty engine cannot pass strict check")
            bad += 1
        for name, rs in surfaces.items():
            for r in rs:
                source = r.get("eligibility_source") or next((x.get("detail", "") for x in r.get("l1_checks") or []
                                                             if x.get("check") == "eligibility_source"), "")
                if source.startswith("strategy:"):
                    print(f"INFO put consistency: {name} {r['ticker']} is separately assessed by {source}")
                    continue
                e = eng.get(r["ticker"])
                if not e:
                    print(f"WARN put consistency: {name} shows {r['ticker']} but the engine has no pick"); bad += 1
                elif (r["strike"], str(r["expiry"])[:10]) != (e[0], str(e[1])[:10]):
                    print(f"WARN put consistency: {name} {r['ticker']} {r['strike']:g} {str(r['expiry'])[:10]} ≠ engine {e[0]:g} {e[1]}"); bad += 1
        ok = {r["ticker"] for r in rows(conn, """SELECT ticker FROM watchlist_sync.put_recs_daily
                 WHERE as_of = (SELECT MAX(as_of) FROM watchlist_sync.put_recs_daily) AND pass""")}
        # Model List "passes" = L1 and not failed on live quotes (that fail is written onto the engine row as live_check)
        l1 = {r["ticker"]: r for r in rows(conn, """SELECT ticker, l1_pass AND verify_status IS DISTINCT FROM 'fail' AS l1_pass, l1_checks
                                                   FROM watchlist_sync.plan_items
                 WHERE plan_id = (SELECT MAX(id) FROM watchlist_sync.plans) AND list_key = 'sell_puts'""")}
        for t in sorted(ok):
            r = l1.get(t)
            why = [] if not r or r["l1_pass"] else [x["check"] for x in r["l1_checks"] or []
                                                  if not x.get("pass") and x.get("severity") != "warn" and x["check"] not in ACCOUNT_CHECKS]
            if not r or why:
                print(f"WARN put consistency: engine passes {t} but the Model List " + ("never saw it" if not r else f"blocks it: {why}")); bad += 1
        for t, r in l1.items():
            separate = any(x.get("check") == "eligibility_source" and x.get("detail", "").startswith("strategy:")
                           for x in r["l1_checks"] or [])
            if r["l1_pass"] and t not in ok and not separate:
                print(f"WARN put consistency: Model List passes {t} but the engine gates it"); bad += 1
        # Check the published consumer, not only its upstream plan. Cautions must survive publication.
        for r in rows(conn, """SELECT i.ticker, i.folder_key, i.contract, e.pass, e.payload
                FROM watchlist_sync.model_items i JOIN watchlist_sync.put_recs_daily e ON e.ticker=i.ticker
                AND e.as_of=(SELECT MAX(as_of) FROM watchlist_sync.put_recs_daily)
                WHERE i.run_id=(SELECT MAX(id) FROM watchlist_sync.model_runs)
                AND i.folder_key IN ('sell_puts','review') AND i.contract->>'type'='put'"""):
            c, p = r["contract"], r["payload"]
            exact = c.get("strike") == p.get("strike") and c.get("expiry") == p.get("expiry")
            if exact and p.get("quality_policy"):
                missing = set(p.get("cautions") or []) - set(c.get("cautions") or [])
                if missing:
                    print(f"WARN put consistency: published {r['ticker']} loses producer cautions: {sorted(missing)}"); bad += 1
                if r["folder_key"] == "sell_puts" and not r["pass"]:
                    print(f"WARN put consistency: published {r['ticker']} is engine-ineligible"); bad += 1
        for r in rows(conn, """SELECT ticker, (payload->>'fit')::bool fit FROM watchlist_sync.structure_rank_daily WHERE structure = 'csp'
                               AND as_of = (SELECT MAX(as_of) FROM watchlist_sync.structure_rank_daily)"""):
            if r["fit"] is not None and r["fit"] != (r["ticker"] in ok):
                print(f"WARN put consistency: Structures CSP {r['ticker']} fit={r['fit']} vs engine pass={r['ticker'] in ok}"); bad += 1
        # 10-28: Rankings / Live / Model List showed 0 or another strike's score — every ranked pick carries its own contract's score
        uns = [r["ticker"] for r in rows(conn, """SELECT ticker FROM watchlist_sync.put_recs_daily WHERE rank IS NOT NULL
                 AND as_of = (SELECT MAX(as_of) FROM watchlist_sync.put_recs_daily) AND NOT payload ? 'option_score'""")]
        if uns:
            print(f"WARN put consistency: {len(uns)} engine picks have no option score ({', '.join(uns[:10])}) → put_recs.py score_picks"); bad += 1
        # 10-28: put_edge_daily was written after put_recs → the engine capped bands on yesterday's quintiles
        e_day, pe_day = conn.execute("""SELECT (SELECT MAX(as_of) FROM watchlist_sync.put_recs_daily),
                                               (SELECT MAX(as_of) FROM watchlist_sync.put_edge_daily)""").fetchone()
        late = conn.execute("""SELECT MIN(computed_at) FROM watchlist_sync.put_recs_daily WHERE as_of = %s""", (e_day,)).fetchone()[0]
        if pe_day and e_day and pe_day < e_day:
            print(f"WARN put consistency: engine {e_day} ran on put-edge grades from {pe_day} → run put_edge.py before put_recs.py"); bad += 1
        print(f"put consistency: {sum(len(v) for v in surfaces.values())} surface rows vs {len(eng)} engine picks · {bad} mismatch(es)"
              f" · engine ran {late:%H:%M}" if late else "")
        if "--strict" in sys.argv[1:] and bad:
            sys.exit(1)
        # 10-27 (RDDT): a name blocked only because an input is missing is a data gap, not a judgment — say so every day
        gap = [t for t, g in conn.execute("""SELECT ticker, payload->'gates' FROM watchlist_sync.put_recs_daily
                                            WHERE as_of = (SELECT MAX(as_of) FROM watchlist_sync.put_recs_daily)""")
               if any("unknown" in x for x in g or [])]
        if gap:
            print(f"WARN put data gap: {len(gap)} names blocked only by a missing input (LSEG history / IV / tech): {', '.join(sorted(gap))}"
                  " → research/lseg/coverage.py + sync_daily_history.py")


if __name__ == "__main__":
    main()
