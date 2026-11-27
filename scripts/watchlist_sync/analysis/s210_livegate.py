# S210 (11-27) — run from scripts/watchlist_sync: .venv/bin/python analysis/s210_livegate.py <book.pkl from a352_score_rank.rebuild_book> [out]
import sys, json, numpy as np
from collections import defaultdict
sys.path.insert(0, ".")
from build_plan import connect, rows
import put_recs as PR
c = connect()
recs = rows(c, """SELECT as_of, ticker, payload FROM watchlist_sync.put_recs_daily WHERE pass AND as_of >= '2026-10-20' AND as_of < '2026-11-26'""")
by = defaultdict(list)
for r in recs:
    p = r["payload"]; by[r["as_of"]].append({"ticker": r["ticker"], "pass_": True, "strike": p.get("strike"), "iv": p.get("iv"),
        "expiry": p.get("expiry"), "bid": p.get("bid"), "ask": p.get("ask"), "spot": p.get("spot")})
close = {(t, d): c_ for t, d, c_ in c.execute("SELECT ticker, date, close::float8 FROM prices_historical WHERE date >= '2026-10-20'").fetchall()}
res = defaultdict(list)
for d, rs in sorted(by.items()):
    PR.pick_grade(c, rs, d)
    for r in rs:
        if None in (r["strike"], r["expiry"], r["bid"], r["ask"]): continue
        from datetime import date as D
        e = D.fromisoformat(r["expiry"]); sc = close.get((r["ticker"], e))
        if sc is None or abs(sc / r["spot"] - 1) > .35: continue
        ret = (r["bid"] + .23 * (r["ask"] - r["bid"]) - max(r["strike"] - sc, 0)) / r["strike"]
        g = (r.get("pick_grade") or {}).get("grade", "ungraded (<6 picks)")
        res[g].append(ret * 1e4 / (max((e - d).days, 7) / 7))
for g, v in res.items():
    a = np.array(v); print(f"{g:<20} n {len(a):>3}  bp/wk {a.mean():+6.0f}  loss {(a<0).mean():.0%}")
allv = np.concatenate([np.array(v) for v in res.values()]); keep = np.concatenate([np.array(v) for g, v in res.items() if g != "weak"])
print(f"all {allv.mean():+.0f} bp/wk (n {len(allv)}) → with gate {keep.mean():+.0f} (n {len(keep)})")
