import json, statistics, sys
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))
import openjev_news as N
rows = []
for r in map(json.loads, (N.DATA / "answers_v0.jsonl").open()):
    f = N.feats(r)
    if f: rows.append({**r, **f, "z": r["abn"]/r["sd"], "kw": N.kw_dir(r["headline"]), "big": abs(r["abn"]) > 2*r["sd"]})
pre = [r for r in rows if r["pre"]]
rel = [r for r in pre if r["rel"] > .5]
ic = lambda k: (lambda rs: N.spearman([r[k] for r in rs], [r["z"] for r in rs]))
def z01(rs, k):
    rk = N.rank([r[k] for r in rs]); n = len(rs)
    return [x / n for x in rk]
for lab, rs in (("pre", pre), ("pre rel", rel)):
    d = lambda s: ic("dir")(s) - ic("kw")(s)
    print(lab, "IC(dir) - IC(kw):", N.fmt(N.boot(rs, d)))
    # combined: rank-average of dir and kw
    for r, a, b in zip(rs, z01(rs, "dir"), z01(rs, "kw")): r["combo"] = a + b
    print(lab, "IC(combo) - IC(kw):", N.fmt(N.boot(rs, lambda s: ic("combo")(s) - ic("kw")(s))))
    # among headlines where keywords say nothing
    nk = [r for r in rs if r["kw"] == 0]
    print(lab, f"kw silent n={len(nk)} IC(dir):", N.fmt(N.boot(nk, ic("dir"))))
# materiality ticker-day: mat vs count vs combo
agg = {}
for r in rel: agg.setdefault((r["t"], r["day"]), []).append(r)
td = [{"day": k[1], "mat": max(x["mat"] for x in v), "n": len(v), "big": v[0]["big"]} for k, v in agg.items()]
au = lambda k: (lambda rs: N.auc([r[k] for r in rs], [r["big"] for r in rs]))
for r, a, b in zip(td, z01(td, "mat"), z01(td, "n")): r["combo"] = a + b
print("AUC mat - count:", N.fmt(N.boot(td, lambda s: au("mat")(s) - au("n")(s))))
print("AUC combo - count:", N.fmt(N.boot(td, lambda s: au("combo")(s) - au("n")(s))), "combo", N.fmt(N.boot(td, au("combo"))))
# alert detail
hits = [r for r in pre if r["rel"] > .5 and r["bad"] > .5 and r["mat"] > .5]
for r in sorted(hits, key=lambda r: r["z"]): print(f"  z{r['z']:+.1f} {r['t']:5s} {r['day']} {r['cat']:8s} {r['headline'][:95]}")
