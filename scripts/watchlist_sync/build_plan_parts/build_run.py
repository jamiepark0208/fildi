"""Persist plan rows to watchlist_sync.plans / plan_items."""
from __future__ import annotations

import json

import rules as R

from build_plan_parts.checks import _edge_q, _edge_relax, option_checks, trim_checks
from build_plan_parts.context import load_context
from build_plan_parts.db import chk, connect, ensure_schema

def build(show_rejected: bool) -> int:
    with connect() as conn:
        ensure_schema(conn)
        ctx = load_context(conn)
        close = R.last_close_date()
        inputs = {
            "model_recs_snapshot": str(ctx["model_date"]),
            "priced_from": str(ctx["snapshot_date"]),
            "portfolio_snapshot": f"#{ctx['portfolio_snapshot']['id']} {ctx['portfolio_snapshot']['imported_at']:%Y-%m-%d %H:%M}",
            "last_close": str(close),
            "regime": ctx["recs"][0]["macro_regime"] if ctx["recs"] else None,
        }
        pid = conn.execute("INSERT INTO watchlist_sync.plans (close_date, inputs) VALUES (%s, %s) RETURNING id",
                           (close, json.dumps(inputs))).fetchone()[0]

        items: list[tuple] = []
        try:
            import openjev_shortlist as ojs
            news_why = ojs.reason_map(conn)
        except Exception:
            news_why = {}
        held = sorted({s["ticker"] for s in ctx["shares"]})
        trims = {t: trim_checks(t, ctx) for t in held}
        # 2026-10-19 (Jamie): RKLB was on trim AND sell-puts in one list. Never tell him to sell shares and to buy more via puts.
        ctx["trim"] = {t for t, (c, _) in trims.items() if c[0]["pass"]}
        for side, key in (("put", "sell_puts"), ("call", "sell_calls")):
            best: dict[str, dict] = {}
            # Evidence-backed panic puts (S049/S054) first; option_score alone has ~0 skill over IV (S014).
            for rec in sorted((r for r in ctx["recs"] if r["side"] == side), key=lambda r: (not r.get("strategy"), -_edge_q(ctx, r), -(r["option_score"] or 0))):
                # A243: weekly put lane needs put_edge (LSEG daily_history + lab_tech). ~66/180 candidates had no RIC in
                # research_common.security_map → always "no put-edge inputs" and polluted the missing-input health check.
                # Panic/strategy puts keep their own lane. Carried names stay for an explicit edge/exit check.
                if (side == "put" and not rec.get("strategy") and not rec.get("carried") and not rec.get("restruck")
                        and not ctx.get("edge_demoted") and rec["ticker"] not in ctx.get("edge", {})):
                    continue
                checks, account = option_checks(rec, ctx)
                ok = all(c["pass"] or c["severity"] == "warn" for c in checks)
                prev = best.get(rec["ticker"])
                # One contract per ticker: the best-scoring one that passes; else keep the best failure for explanation.
                if prev is None or (ok and not prev["ok"]):
                    best[rec["ticker"]] = {"rec": rec, "checks": checks, "ok": ok, "account": account}
            # S059: rank weekly puts by simulated edge quintile first (option_score alone ≈ IV, S014), then option_score
            if side == "put":   # A277 (Jamie 10-26): one order everywhere — the engine's rank (put_recs: put-edge Q, ev_rv_cap)
                ranked = sorted(best.values(), key=lambda b: (not b["ok"], not b["rec"].get("strategy"),
                                                              b["rec"].get("engine_rank") or 10 ** 6, -_edge_q(ctx, b["rec"])))
            else:
                ranked = sorted(best.values(), key=lambda b: (not b["ok"], not b["rec"].get("strategy"), -_edge_q(ctx, b["rec"]),
                                                              -(b["rec"]["option_score"] or 0)))
            cap = R.MAX_ITEMS_PUTS if side == "put" else R.MAX_ITEMS
            rank = 0
            for b in ranked:
                r = b["rec"]
                if b["ok"]:
                    rank += 1
                    if rank > cap:
                        b["ok"] = False
                        b["checks"].append(chk("list_cap", False, f"beyond top {cap}"))
                reasons = [f"Fildi option score {r['option_score']:.0f}" if r["option_score"] is not None else
                           "engine pick (no option score)" if r.get("restruck") else "strategy pick (no option score)", f"{r['weekly_income_pct']:.2f}%/week at ${r['strike']:g} ({r['dte']:.0f} DTE, Δ {r['delta']:+.2f})"]
                e = ctx.get("edge", {}).get(r["ticker"]) if side == "put" else None
                if e:
                    reasons.append(f"put edge Q{e['quintile']}/5: simulated {e['pnl_bp']:+.0f} bp/wk, breach {100 * e['breach']:.0f} % "
                                   f"(IV/RV {e['iv_rv']:.2f}, S059 holdout, all markets)"
                                   + (" · in a sector drop Q1–Q3 earn too (S102) → band capped instead"
                                      if e["quintile"] < 4 and r.get("engine_market") in _edge_relax() else ""))
                if r.get("repriced"):
                    reasons.append(r["repriced"])
                if news_why.get(r["ticker"]):
                    reasons.append(news_why[r["ticker"]])
                items.append((pid, key, r["ticker"], rank if b["ok"] else None, r["option_score"], "option", side, r["strike"], r["expiry"],
                              b["account"], r["premium"], r["spot"], r["delta"], r["strike_iv"], b["ok"], json.dumps(b["checks"], default=str),
                              json.dumps(reasons), "pending" if b["ok"] else "not_required"))

        rank = 0
        for t in held:
            checks, flags = trims[t]
            ok = checks[0]["pass"]
            if ok:
                rank += 1
            if news_why.get(t):
                flags = [*flags, news_why[t]]
            items.append((pid, "trim_risk", t, rank if ok else None, len(flags), "stock", None, None, None, None, None, None, None, None,
                          ok, json.dumps(checks), json.dumps(flags), "pending" if ok else "not_required"))

        with conn.cursor() as cur:
            cur.executemany("""
                INSERT INTO watchlist_sync.plan_items (plan_id, list_key, ticker, rank, score, kind, option_type, strike, expiry, account,
                  model_premium, model_spot, model_delta, model_iv, l1_pass, l1_checks, reasons, verify_status)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""", items)
        summary = {}
        for it in items:
            s = summary.setdefault(it[1], {"candidates": 0, "l1_pass": 0})
            s["candidates"] += 1
            s["l1_pass"] += 1 if it[14] else 0
        conn.execute("UPDATE watchlist_sync.plans SET summary = %s WHERE id = %s", (json.dumps(summary), pid))
        conn.commit()

        print(f"plan #{pid} for close {close} · inputs {inputs}")
        for key, s in summary.items():
            print(f"  {key:11s} {s['l1_pass']:3d} pass L1 / {s['candidates']} candidates")
        fails: dict[str, int] = {}
        for it in items:
            for c in json.loads(it[15]):
                if not c["pass"] and c["severity"] == "block":
                    fails[c["check"]] = fails.get(c["check"], 0) + 1
        print("  blocked by:", ", ".join(f"{k} {v}" for k, v in sorted(fails.items(), key=lambda x: -x[1])))
        if show_rejected:
            for it in items:
                if not it[14]:
                    bad = [c["check"] + ": " + c["detail"] for c in json.loads(it[15]) if not c["pass"] and c["severity"] == "block"]
                    print(f"    ✗ {it[1]:10s} {it[2]:6s} {'; '.join(bad)[:160]}")
        return pid
