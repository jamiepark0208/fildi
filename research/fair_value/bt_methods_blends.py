"""Fair-value backtest: methods + blending schemes, point-in-time, monthly, 2020-2026.
Target: does log(V/P) rank future peer-relative returns (rel_63 / rel_126)?  Plus accuracy & stability."""
import sys, math, pickle, statistics as st
import numpy as np
from collections import defaultdict
S=sys.argv[1]; P=pickle.load(open(f"{S}/panel.pkl","rb"))
EXCL={"speculative_pre_revenue","pre_revenue_ok","speculative_ok","speculative_crypto","reit"}
ERP, LTG_CAP = 0.05, 0.20
P=[r for r in P if r["mode"] not in EXCL and r["e1"] and r["e1"]>0 and r["px"]>0]
by_date=defaultdict(list)
for r in P: by_date[r["d"]].append(r)
dates=sorted(by_date)
clamp=lambda x,lo,hi: max(lo,min(hi,x))
def g_short(r):
    return (r["e2"]/r["e1"]-1) if r["e2"] and r["e2"]>0 else None
def g_long(r):
    c=[x for x in (r["ltg"], g_short(r)) if x is not None]
    return clamp(st.mean(c),0.0,LTG_CAP) if c else None
def sector(r): return (r["grp"] or "x").split(".")[0]

def peer_values(rows):
    """Leave-self-out peer forward P/E: group (>=5) → sector (>=5) → universe. Median and harmonic."""
    pe={r["t"]:r["px"]/r["e1"] for r in rows if 0<r["px"]/r["e1"]<150}
    byg=defaultdict(list); bys=defaultdict(list)
    for r in rows:
        if r["t"] in pe: byg[r["grp"]].append(r["t"]); bys[sector(r)].append(r["t"])
    out={}
    for r in rows:
        for pool in (byg[r["grp"]], bys[sector(r)], list(pe)):
            peers=[pe[t] for t in pool if t!=r["t"]]
            if len(peers)>=5: break
        if len(peers)<5: continue
        med=st.median(peers); harm=len(peers)/sum(1/x for x in peers)
        out[r["t"]]=(r["e1"]*med, r["e1"]*harm)
    return out
def warranted(rows):
    """Bhojraj-Lee style: cross-sectional OLS of log fwd P/E on sector dummies + short & long growth (leave-self-out)."""
    xs=[r for r in rows if 0<r["px"]/r["e1"]<150 and g_long(r) is not None]
    if len(xs)<30: return {}
    secs=sorted({sector(r) for r in xs})
    def feat(r):
        gs=g_short(r); gs=clamp(gs,-0.5,1.0) if gs is not None else g_long(r)
        return [1.0]+[1.0 if sector(r)==s else 0.0 for s in secs[1:]]+[gs, g_long(r)]
    X=np.array([feat(r) for r in xs]); y=np.array([math.log(r["px"]/r["e1"]) for r in xs])
    out={}
    for i,r in enumerate(xs):
        m=np.ones(len(xs),bool); m[i]=False
        b,*_=np.linalg.lstsq(X[m],y[m],rcond=None)
        out[r["t"]]=r["e1"]*math.exp(X[i]@b)
    return out
def graham(r):
    g=g_long(r)
    if g is None or not r["aaa"]: return None
    return r["e1"]*(8.5+2*g*100)*4.4/(r["aaa"]*100)
def oj(r):
    """Ohlson-Juettner abnormal-earnings-growth model on FY1/FY2 + LTG."""
    if not r["e2"] or r["e2"]<=0 or not r["rf"]: return None
    beta=clamp(r["beta"] if r["beta"] is not None else 1.0,0.6,2.0)
    k=r["rf"]+beta*ERP; gl=clamp(r["rf"]-0.03,0.0,0.03)
    c=[x for x in (g_short(r), r["ltg"]) if x is not None]
    gs=clamp(st.mean(c),0.0,0.30)
    return r["e1"]/k + r["e1"]*(gs-gl)/(k*(k-gl))
def lynch(r):
    g=g_long(r)
    return r["e1"]*g*100 if g and g>0.02 else None

METHODS=["peer_pe_median","peer_pe_harmonic","warranted_pe","graham_fwd","ohlson_juettner","lynch"]
V={}   # (t,d) -> {method: log(V/P)}
for d in dates:
    rows=by_date[d]; pv=peer_values(rows); wv=warranted(rows)
    for r in rows:
        v={}
        if r["t"] in pv: v["peer_pe_median"],v["peer_pe_harmonic"]=pv[r["t"]]
        if r["t"] in wv: v["warranted_pe"]=wv[r["t"]]
        for k,f in (("graham_fwd",graham),("ohlson_juettner",oj),("lynch",lynch)):
            x=f(r)
            if x and x>0: v[k]=x
        V[(r["t"],d)]={k:math.log(x/r["px"]) for k,x in v.items() if x>0}
R={(r["t"],r["d"]):r for r in P}

# ── per-date cross-sectional method stats (for learned weights, used out-of-sample only) ──
def spearman(a,b):
    if len(a)<15: return None
    ra=np.argsort(np.argsort(a)); rb=np.argsort(np.argsort(b))
    return float(np.corrcoef(ra,rb)[0,1])
date_ic={m:{} for m in METHODS}; date_var={m:{} for m in METHODS}
for d in dates:
    for m in METHODS:
        pts=[(V[(r["t"],d)][m], r["rel126"]) for r in by_date[d] if m in V[(r["t"],d)] and r["rel126"] is not None]
        xs=[V[(r["t"],d)][m] for r in by_date[d] if m in V[(r["t"],d)]]
        if len(xs)>=15: date_var[m][d]=float(np.var(xs))
        if pts: date_ic[m][d]=spearman([p[0] for p in pts],[p[1] for p in pts])
def trailing(dct,d,months_gap=6,window=24):
    """Use only info knowable at d: rel126 outcome needs ~6 months to realize, so skip the last 6 dates."""
    i=dates.index(d); past=dates[max(0,i-months_gap-window):max(0,i-months_gap)]
    vals=[dct[x] for x in past if dct.get(x) is not None]
    return st.mean(vals) if len(vals)>=6 else None

# ── blending schemes (all in log space: x = log(V/P)) ──
def comb(xs,how,d=None):
    ks=[k for k in METHODS if k in xs]; v=[xs[k] for k in ks]
    if len(v)<2: return None
    if how=="mean_arith": return math.log(st.mean(math.exp(x) for x in v))
    if how=="mean_geo": return st.mean(v)
    if how=="median": return st.median(v)
    if how=="harmonic": return -math.log(st.mean(math.exp(-x) for x in v))
    if how=="trimmed": 
        s=sorted(v); return st.mean(s[1:-1]) if len(s)>=4 else st.median(s)
    if how=="winsor":
        s=sorted(v); 
        if len(s)>=4: s[0]=s[1]; s[-1]=s[-2]
        return st.mean(s)
    if how=="mad_filter":
        med=st.median(v); mad=st.median(abs(x-med) for x in v)*1.4826 or 0.10
        keep=[x for x in v if abs(x-med)<=2.5*mad]; return st.mean(keep)
    if how in ("inv_var","ic_weight","ic_invvar"):
        w=[]
        for k in ks:
            var=trailing(date_var[k],d); ic=trailing(date_ic[k],d)
            if how=="inv_var": w.append(1/var if var else 0)
            elif how=="ic_weight": w.append(max(ic,0) if ic is not None else 0)
            else: w.append(max(ic,0)/var if ic is not None and var else 0)
        if sum(w)<=0: return st.mean(v)
        return sum(a*b for a,b in zip(w,v))/sum(w)
    raise ValueError(how)
SCHEMES=["mean_arith","mean_geo","median","harmonic","trimmed","winsor","mad_filter","inv_var","ic_weight","ic_invvar"]
for key,xs in V.items():
    for s in SCHEMES:
        c=comb(xs,s,key[1])
        if c is not None: xs["B:"+s]=c
# stacked regression (out-of-sample): weights from trailing pooled OLS of rel126 on method values (rows with all core methods)
CORE=["peer_pe_harmonic","warranted_pe","graham_fwd","ohlson_juettner"]
for i,d in enumerate(dates):
    past=dates[max(0,i-30):max(0,i-6)]
    tr=[(V[(r["t"],x)],r["rel126"]) for x in past for r in by_date[x] if r["rel126"] is not None and all(k in V[(r["t"],x)] for k in CORE)]
    if len(tr)<200: continue
    X=np.array([[1]+[v[k] for k in CORE] for v,_ in tr]); y=np.array([o for _,o in tr])
    b,*_=np.linalg.lstsq(X,y,rcond=None)
    w=np.clip(b[1:],0,None)
    if w.sum()<=0: continue
    w=w/w.sum()
    for r in by_date[d]:
        v=V[(r["t"],d)]
        if all(k in v for k in CORE): v["B:stacked_ols"]=float(sum(wi*v[k] for wi,k in zip(w,CORE)))

# ── evaluation ──
def evaluate(name, horizon="rel126"):
    ics=[]; spreads=[]; n=0; absdev=[]; within=[]
    for d in dates:
        pts=[(V[(r["t"],d)][name], r[horizon]) for r in by_date[d] if name in V[(r["t"],d)] and r[horizon] is not None]
        allx=[V[(r["t"],d)][name] for r in by_date[d] if name in V[(r["t"],d)]]
        n+=len(allx); absdev+= [abs(x) for x in allx]; within+=[abs(x)<=math.log(1.15) for x in allx]
        if len(pts)<20: continue
        x=[p[0] for p in pts]; y=[p[1] for p in pts]
        ics.append(spearman(x,y))
        o=np.argsort(x); q=max(1,len(o)//5)
        spreads.append(np.mean([y[j] for j in o[-q:]])-np.mean([y[j] for j in o[:q]]))
    if not ics: return None
    overlap={"rel126":6,"rel63":3}[horizon]
    t=st.mean(ics)/(st.pstdev(ics)/math.sqrt(len(ics)/overlap)) if st.pstdev(ics)>0 else 0
    # stability: month-over-month change in log V (price-free) for same ticker
    chg=[]
    for (tk,d),v in V.items():
        if name not in v: continue
        i=dates.index(d)
        if i==0: continue
        pv=V.get((tk,dates[i-1]))
        if pv and name in pv:
            chg.append(abs((v[name]+math.log(R[(tk,d)]["px"]))-(pv[name]+math.log(R[(tk,dates[i-1])]["px"]))))
    return dict(rows=n, ic=st.mean(ics), t=t, hit=sum(i>0 for i in ics)/len(ics), q5q1=st.mean(spreads)*100,
                mad=st.median(absdev), w15=sum(within)/len(within), stab=st.median(chg) if chg else float('nan'), ndates=len(ics))
print(f"panel rows (eligible) {len(P)} | dates {len(dates)} | tickers {len({r['t'] for r in P})}")
for h in ("rel126","rel63"):
    print(f"\n== target {h} (peer-relative forward return) ==")
    print(f"{'method/scheme':22s} {'rows':>5s} {'IC':>6s} {'t':>5s} {'IC>0':>5s} {'Q5-Q1%':>7s} {'|logV/P|':>8s} {'±15%':>5s} {'Δ/mo':>5s}")
    names=METHODS+["B:"+s for s in SCHEMES]+["B:stacked_ols"]
    out=[]
    for nm in names:
        e=evaluate(nm,h)
        if e: out.append((nm,e))
    for nm,e in out:
        print(f"{nm:22s} {e['rows']:5d} {e['ic']:6.3f} {e['t']:5.2f} {e['hit']:5.0%} {e['q5q1']:7.2f} {e['mad']:8.2f} {e['w15']:5.0%} {e['stab']:5.2f}")
pickle.dump({"V":V,"dates":dates}, open(f"{S}/bt_V.pkl","wb"))
