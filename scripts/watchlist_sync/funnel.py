"""Model List funnel in one command (Claude 10-20): pool → L1 blocks → L2 fails → publish holds → shown, per side.
Replaces ~12 ad-hoc queries per "why so few puts?" question. Latest plan + latest model run by default.

    .venv/bin/python funnel.py [--plan N] [--run N] [--side puts|calls] [--ticker CRWV]
"""
from __future__ import annotations

import argparse
from collections import Counter

from build_plan import connect, rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", type=int)
    ap.add_argument("--run", type=int)
    ap.add_argument("--side", choices=["puts", "calls"], default="puts")
    ap.add_argument("--ticker")
    a = ap.parse_args()
    key = f"sell_{a.side}"
    with connect() as conn:
        plan = a.plan or conn.execute("SELECT MAX(id) FROM watchlist_sync.plans").fetchone()[0]
        run = a.run or conn.execute("SELECT MAX(id) FROM watchlist_sync.model_runs").fetchone()[0]
        items = rows(conn, "SELECT ticker, l1_pass, l1_checks, verify_status, verify_checks FROM watchlist_sync.plan_items "
                           "WHERE plan_id = %s AND list_key = %s", (plan, key))
        pub = {r["ticker"]: r for r in rows(conn, "SELECT ticker, folder_key, status, why FROM watchlist_sync.model_items "
                                                  "WHERE run_id = %s AND folder_key IN (%s, 'review')", (run, key))}
    if a.ticker:
        t = a.ticker.upper()
        it = next((i for i in items if i["ticker"] == t), None)
        if not it:
            print(f"{t}: not in plan {plan}'s {key} pool (pool = fresher of model_recs / option_score_snapshots; check fit verdict)")
            return
        bad = [f"{c['check']} ({c['severity']}): {c['detail']}" for c in it["l1_checks"] if not c["pass"]]
        print(f"{t} plan {plan}: L1 {'pass' if it['l1_pass'] else 'BLOCK'}", *bad, sep="\n  ")
        print(f"  L2 {it['verify_status']}:", "; ".join(c["check"] for c in it["verify_checks"] or [] if not c["pass"]) or "—")
        p = pub.get(t)
        print(f"  publish run {run}:", f"{p['folder_key']} [{p['status']}] {p['why'][0]}" if p else "not published")
        return
    blocks = Counter(c["check"] for i in items if not i["l1_pass"] for c in i["l1_checks"] if not c["pass"] and c["severity"] == "block")
    l1 = [i for i in items if i["l1_pass"]]
    l2 = Counter(i["verify_status"] for i in l1)
    shown = [t for t, p in pub.items() if p["folder_key"] == key]
    held = {t: p["why"][0][:90] for t, p in pub.items() if p["folder_key"] == "review" and any(i["ticker"] == t for i in l1)}
    print(f"{key} · plan {plan} · run {run}")
    print(f"  pool {len(items)} → L1 pass {len(l1)} → L2 {dict(l2)} → shown {len(shown)}: {', '.join(shown) or '—'}")
    print("  L1 blocks (a name can hit several):", ", ".join(f"{k} {v}" for k, v in blocks.most_common()))
    print("  L2 fails:", ", ".join(i["ticker"] for i in l1 if i["verify_status"] == "fail") or "—")
    for t, w in held.items():
        print(f"  held {t}: {w}")


if __name__ == "__main__":
    main()
