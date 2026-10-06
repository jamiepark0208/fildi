"""Load point-in-time panel for fair-value backtest → pickle. Monthly sample (first lab as_of per month)."""
import os, sys, csv, pickle, psycopg, json
from datetime import datetime
from bisect import bisect_right
from collections import defaultdict
S = sys.argv[1]
SPLITS = json.load(open(f"{S}/splits.json"))
c = psycopg.connect(os.environ["DATABASE_URL"])
def fred(name):
    out=[]
    for r in csv.reader(open(f"{S}/fred_{name}.csv")):
        if r[0][:1].isdigit() and r[1] not in (".",""): out.append((r[0], float(r[1])/100))
    return out
AAA, GS10 = fred("AAA"), fred("GS10")
grp = {t:(g,m) for t,g,m in c.execute("""select r.ticker, r.primary_peer_group_id, coalesce(g.scoring_mode,'standard')
    from ticker_registry r left join peer_groups g on g.id=r.primary_peer_group_id""").fetchall()}
# IBES consensus by ticker: sorted list of (statpers, fpi, meanest, numest)
ibes = defaultdict(lambda: defaultdict(list))
for t, sp, fpi, me, ne in c.execute("""select ticker, statpers, fpi, meanest::float, numest from wrds_research.ibes_statsum
        where measure='EPS' and fpi in ('0','1','2') and meanest is not null order by ticker, statpers""").fetchall():
    ibes[t][fpi].append((sp, me, ne))
# prices
px = defaultdict(dict)
for t, d, cl in c.execute("select ticker, date, close::float from lseg_research.daily_history where close is not null and date >= '2019-06-01'").fetchall():
    px[t][d] = cl
# lab outcomes: monthly sample
rows = c.execute("select ticker, as_of, outcomes, features from watchlist_sync.lab_outcomes order by as_of").fetchall()
first_of_month = {}
for _, a, _, _ in rows:
    k=(a.year,a.month); first_of_month.setdefault(k, a)
keep = set(first_of_month.values())
def latest(lst, d):
    i = bisect_right([x[0] for x in lst], d)
    return lst[i-1] if i else None
def series_at(ser, d):
    ds=[x[0] for x in ser]; i=bisect_right(ds, d.isoformat()); return ser[i-1][1] if i else None
panel=[]
for t, a, o, f in rows:
    if a not in keep or t not in grp: continue
    p = px[t].get(a)
    if p is None:
        prior=[d for d in px[t] if d<=a]
        if not prior: continue
        p = px[t][max(prior)]
    rec={"t":t,"d":a,"px":p,"grp":grp[t][0],"mode":grp[t][1],"beta":(f or {}).get("beta"),
         "rel63":o.get("rel_63"),"rel126":o.get("rel_126"),"ret126":o.get("ret_126"),
         "aaa":series_at(AAA,a),"rf":series_at(GS10,a)}
    for fpi,key in (("1","e1"),("2","e2"),("0","ltg")):
        x = latest(ibes[t][fpi], a) if t in ibes else None
        # stale consensus (>100 days) treated as missing
        ok = x and (a - x[0]).days <= 100
        rec[key] = x[1] if ok else None
        rec[key+"_sp"] = x[0] if ok else None
    if rec["ltg"] is not None: rec["ltg"] /= 100
    # IBES statsum is per-share as of statpers; LSEG closes are split-adjusted to today.
    # Restate EPS in today's shares: divide by every split ratio dated after statpers.
    for key in ("e1","e2"):
        if rec[key] is not None:
            sp = rec[key+"_sp"]; ts = datetime.combine(sp, datetime.min.time()).timestamp()
            for when, ratio in SPLITS.get(t, []):
                if when > ts: rec[key] /= ratio
    panel.append(rec)
pickle.dump(panel, open(f"{S}/panel.pkl","wb"))
from collections import Counter
print("rows", len(panel), "dates", len({r['d'] for r in panel}), "tickers", len({r['t'] for r in panel}))
print("have e1", sum(r['e1'] is not None for r in panel), "e2", sum(r['e2'] is not None for r in panel), "ltg", sum(r['ltg'] is not None for r in panel), "rel126", sum(r['rel126'] is not None for r in panel))
print("modes", Counter(r['mode'] for r in panel).most_common())
