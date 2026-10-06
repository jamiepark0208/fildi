"""Anchor + convergence analysis: analyst PT bias, blend-with-anchor weights, 12m convergence slope."""
import os, sys, math, pickle, statistics as st, psycopg, numpy as np
from bisect import bisect_right
from collections import defaultdict
S=sys.argv[1]
B=pickle.load(open(f"{S}/bt_V.pkl","rb")); V,dates=B["V"],B["dates"]
panel={(r["t"],r["d"]):r for r in pickle.load(open(f"{S}/panel.pkl","rb"))}
c=psycopg.connect(os.environ["DATABASE_URL"])
pt=defaultdict(list)
for t,d,v in c.execute("select ticker, obs_date, value::float from lseg_research.starmine_history where metric='pt_mean' order by ticker, obs_date").fetchall(): pt[t].append((d,v))
px=defaultdict(list)
for t,d,cl in c.execute("select ticker, date, close::float from lseg_research.daily_history where close is not null order by ticker, date").fetchall(): px[t].append((d,cl))
def price_after(t,d,days):
    s=px[t]; ds=[x[0] for x in s]; i=bisect_right(ds,d)-1
    j=i+days
    return (s[i][1], s[j][1]) if i>=0 and j<len(s) else (None,None)
def pt_at(t,d):
    s=pt[t]; i=bisect_right([x[0] for x in s],d)
    return s[i-1][1] if i and (d-s[i-1][0]).days<=45 else None
# attach PT upside and 12m forward (raw, peer-relative)
fwd={}
for (t,d),v in V.items():
    p0,p1=price_after(t,d,252)
    if p0 and p1: fwd[(t,d)]=math.log(p1/p0)
    a=pt_at(t,d); r=panel[(t,d)]
    if a and a>0: v["analyst_pt"]=math.log(a/r["px"])
# peer-relative 12m: minus same-date median of eligible names in same sector
bydate=defaultdict(list)
for k in fwd: bydate[k[1]].append(k)
rel12={}
for d,ks in bydate.items():
    sec=defaultdict(list)
    for k in ks: sec[(panel[k]["grp"] or "x").split(".")[0]].append(fwd[k])
    allm=st.median(fwd[k] for k in ks)
    for k in ks:
        pool=sec[(panel[k]["grp"] or "x").split(".")[0]]
        rel12[k]=fwd[k]-(st.median(pool) if len(pool)>=4 else allm)

# 1) analyst target bias
ups=[v["analyst_pt"] for k,v in V.items() if "analyst_pt" in v and k in fwd]
real=[fwd[k] for k,v in V.items() if "analyst_pt" in v and k in fwd]
print(f"analyst PT: n={len(ups)}  mean implied 12m log-upside {st.mean(ups):.3f} ({math.exp(st.mean(ups))-1:.1%})  "
      f"mean realized 12m {st.mean(real):.3f} ({math.exp(st.mean(real))-1:.1%})  -> optimism bias {st.mean(ups)-st.mean(real):.3f}")
print(f"  PT reached within 12m (end price >= PT): {sum(r>=u for u,r in zip(ups,real))/len(ups):.0%}")
# rolling, out-of-sample bias estimate (only targets whose 12m has elapsed by date d)
def oos_bias(d):
    xs=[V[k]["analyst_pt"]-fwd[k] for k in fwd if "analyst_pt" in V[k] and (d-k[1]).days>=380 and (d-k[1]).days<=380+3*365]
    return st.median(xs) if len(xs)>=200 else None

def trimmed(xs):
    s=sorted(xs); return st.mean(s[1:-1]) if len(s)>=4 else st.median(s)
INTERNAL=["peer_pe_median","peer_pe_harmonic","warranted_pe","graham_fwd","ohlson_juettner","lynch"]
for k,v in V.items():
    xs=[v[m] for m in INTERNAL if m in v]
    if len(xs)>=2: v["internal_trim"]=trimmed(xs)
    if "analyst_pt" in v:
        b=oos_bias(k[1])
        if b is not None: v["analyst_debiased"]=v["analyst_pt"]-b
    if "internal_trim" in v and "analyst_debiased" in v:
        for w in (0.25,0.5,0.75):
            v[f"anchor_w{int(w*100)}"]=(1-w)*v["internal_trim"]+w*v["analyst_debiased"]
        # anchor as just one more voter inside the trimmed mean
        v["trim_incl_anchor"]=trimmed(xs+[v["analyst_debiased"]])

def sp(a,b):
    ra=np.argsort(np.argsort(a)); rb=np.argsort(np.argsort(b)); return float(np.corrcoef(ra,rb)[0,1])
def stats(name):
    ks=[k for k in V if name in V[k] and k in rel12]
    if len(ks)<300: return None
    # convergence slope: pooled OLS of 12m peer-relative log return on log(V/P); 1.0 = gap fully closes
    x=np.array([V[k][name] for k in ks]); y=np.array([rel12[k] for k in ks])
    slope=float(np.polyfit(x,y,1)[0])
    ics=[]
    by=defaultdict(list)
    for k in ks: by[k[1]].append(k)
    for d,kk in by.items():
        if len(kk)>=20: ics.append(sp([V[k][name] for k in kk],[rel12[k] for k in kk]))
    t=st.mean(ics)/(st.pstdev(ics)/math.sqrt(len(ics)/12))
    absdev=st.median(abs(V[k][name]) for k in ks)
    return len(ks), st.mean(ics), t, slope, absdev
print(f"\n12-month horizon, peer-relative | rows with analyst history only where noted")
print(f"{'estimate':20s} {'rows':>5s} {'IC12m':>6s} {'t':>5s} {'conv.slope':>10s} {'|logV/P|':>8s}")
for nm in INTERNAL+["internal_trim","analyst_pt","analyst_debiased","anchor_w25","anchor_w50","anchor_w75","trim_incl_anchor"]:
    s=stats(nm)
    if s: print(f"{nm:20s} {s[0]:5d} {s[1]:6.3f} {s[2]:5.2f} {s[3]:10.3f} {s[4]:8.2f}")
# same comparison restricted to rows that have every estimate (apples to apples)
common=[k for k in V if k in rel12 and all(m in V[k] for m in ("internal_trim","analyst_debiased"))]
print(f"\napples-to-apples subset (rows with both internal + analyst): {len(common)}")
for nm in ["internal_trim","analyst_pt","analyst_debiased","anchor_w25","anchor_w50","anchor_w75","trim_incl_anchor"]:
    x=np.array([V[k][nm] for k in common]); y=np.array([rel12[k] for k in common])
    print(f"  {nm:18s} slope {np.polyfit(x,y,1)[0]:6.3f}  corr {np.corrcoef(x,y)[0,1]:6.3f}  |logV/P| {np.median(np.abs(x)):.2f}")
pickle.dump({"V":V,"rel12":rel12}, open(f"{S}/bt_V2.pkl","wb"))
