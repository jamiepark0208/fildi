"""Scenario / robustness analysis on today's live cross-section."""
import os, math, random, statistics as st, psycopg, sys
import numpy as np
random.seed(7)
c = psycopg.connect(os.environ["DATABASE_URL"])
rows = c.execute("""
with px as (select distinct on (ticker) ticker, close::float px from prices_historical order by ticker, date desc),
sm as (select distinct on (ticker) ticker, price_to_intrinsic::float p2i, pt_mean::float pt, eps_mean_fy1::float fy1
       from lseg_research.signals_daily order by ticker, as_of desc),
ib as (select distinct on (ticker, fpi) ticker, fpi, meanest::float me from wrds_research.ibes_statsum
       where measure='EPS' and fpi in ('0','2') and statpers > now() - interval '120 days' order by ticker, fpi, statpers desc)
select f.ticker, split_part(r.primary_peer_group_id,'.',1), r.primary_peer_group_id, coalesce(g.scoring_mode,'standard'), px.px,
  f.earnings_per_share::float, f.forward_pe::float, f.free_cash_flow::float, f.shares_outstanding::float,
  f.total_debt::float, f.cash_and_equivalents::float, f.wacc::float, f.ebitda::float, f.total_stockholders_equity::float,
  f.return_on_equity::float, f.beta::float, f.analyst_target_price::float, f.revenue_growth_yoy::float, f.ffo_proxy::float,
  sm.p2i, sm.pt, sm.fy1, (select me from ib where ib.ticker=f.ticker and fpi='2'), (select me from ib where ib.ticker=f.ticker and fpi='0')
from ticker_fundamentals f join ticker_registry r using (ticker) join px using (ticker)
left join peer_groups g on g.id=r.primary_peer_group_id left join sm using (ticker)
where coalesce(r.is_active,true)""").fetchall()
cols="t sector grp mode px eps fpe fcf sh debt cash wacc ebitda eq roe beta tgt revg ffo p2i pt fy1 e2 ltg".split()
D=[dict(zip(cols,r)) for r in rows]
SPEC={"speculative_pre_revenue","pre_revenue_ok","speculative_ok","speculative_crypto"}
fin=lambda d: d["mode"] in ("financial","insurance","financial_mixed")
reit=lambda d: d["mode"]=="reit"
std=lambda d: not fin(d) and not reit(d)
clamp=lambda x,lo,hi: max(lo,min(hi,x))

def run(AAA=0.0603, RF=0.0528, CAP=0.20, ERP=0.05, TG=0.025, peer_stat="median", corrupt=None):
    def fe(d):
        if d["fy1"]: return d["fy1"]
        if d["fpe"] and d["fpe"]>0: return d["px"]/d["fpe"]
    def e2(d):
        return d["e2"] if d["e2"] and d["e2"]>0 else None
    def gshort(d):
        f=fe(d); return (e2(d)/f-1) if f and f>0 and e2(d) else None
    def glong(d):
        cands=[x for x in ((d["ltg"]/100 if d["ltg"] is not None else None), gshort(d)) if x is not None]
        if not cands:
            f,e=fe(d),d["eps"]
            if f and e and e>0: cands.append(f/e-1)
            if d["revg"] is not None: cands.append(d["revg"])
        return clamp(st.mean(cands),0.0,CAP) if cands else None
    coe=lambda d: RF+clamp(d["beta"] if d["beta"] is not None else 1.0,0.6,2.0)*ERP
    def pm(key):
        byg,bys={},{}
        for d in D:
            v=key(d)
            if v is not None and 0<v<150: byg.setdefault(d["grp"],[]).append((d["t"],v)); bys.setdefault(d["sector"],[]).append((d["t"],v))
        out={}
        for d in D:
            for pool in (byg.get(d["grp"],[]), bys.get(d["sector"],[])):
                vals=[v for t,v in pool if t!=d["t"]]
                if len(vals)>=5: break
            if len(vals)<5: continue
            out[d["t"]]=st.median(vals) if peer_stat=="median" else len(vals)/sum(1/v for v in vals)
        return out
    ev=lambda d: d["px"]*d["sh"]+(d["debt"] or 0)-(d["cash"] or 0) if d["sh"] else None
    SPE=pm(lambda d: d["px"]/fe(d) if fe(d) and fe(d)>0 and not reit(d) else None)
    SEV=pm(lambda d: ev(d)/d["ebitda"] if std(d) and ev(d) and d["ebitda"] and d["ebitda"]>0 else None)
    SPF=pm(lambda d: d["px"]*d["sh"]/d["ffo"] if reit(d) and d["ffo"] and d["ffo"]>0 and d["sh"] else None)
    def m(d):
        out={}
        if d["mode"] in SPEC: return out
        f=fe(d); g=glong(d)
        if not reit(d) and f and f>0 and SPE.get(d["t"]): out["peer_pe"]=f*SPE[d["t"]]
        if not reit(d) and f and f>0 and g is not None: out["graham"]=f*(8.5+2*g*100)*4.4/(AAA*100)
        if not reit(d) and f and f>0 and e2(d):
            k=coe(d); gl=clamp(RF-0.03,0.0,0.03); gs=clamp(st.mean([x for x in (gshort(d), d["ltg"]/100 if d["ltg"] is not None else None) if x is not None]),0,0.30)
            out["ohlson_juettner"]=f/k+f*(gs-gl)/(k*(k-gl))
        if std(d) and d["fcf"] and d["fcf"]>0 and d["sh"]:
            r=clamp(d["wacc"] if d["wacc"] else coe(d),0.07,0.14); g0=clamp(g if g is not None else 0.03,-0.10,CAP)
            x=d["fcf"]; pv=0
            for y in range(1,11): x*=1+g0+(TG-g0)*(y-1)/9; pv+=x/(1+r)**y
            out["dcf"]=(pv+x*(1+TG)/(r-TG)/(1+r)**10)/d["sh"]
        if std(d) and SEV.get(d["t"]) and d["ebitda"] and d["ebitda"]>0 and d["sh"]:
            v=(SEV[d["t"]]*d["ebitda"]-(d["debt"] or 0)+(d["cash"] or 0))/d["sh"]
            if v>0: out["peer_ev_ebitda"]=v
        if fin(d) and d["eq"] and d["sh"] and d["roe"] is not None:
            bv=d["eq"]/d["sh"]; k=coe(d); v=bv+(clamp(d["roe"],-0.05,0.25)-k)*bv/(k-TG)
            if v>0: out["excess_returns"]=v
        if reit(d) and SPF.get(d["t"]) and d["ffo"] and d["ffo"]>0 and d["sh"]: out["reit_pffo"]=SPF[d["t"]]*d["ffo"]/d["sh"]
        return {k:math.log(v/d["px"]) for k,v in out.items() if v>0}
    res={}
    for d in D:
        x=m(d)
        if corrupt: x=corrupt(d["t"],x)
        ext={}
        a=d["pt"] or d["tgt"]
        if a and a>0: ext["analyst"]=math.log(a/d["px"])
        if d["p2i"] and d["p2i"]>0: ext["starmine"]=math.log(1/d["p2i"])
        res[d["t"]]=(x,ext)
    return res
def blend(x,ext,how):
    v=list(x.values())
    if how.endswith("+ext"): v=v+list(ext.values()); how=how[:-4]
    if len(v)<2: return None
    if how=="mean_arith": return math.log(st.mean(math.exp(a) for a in v))
    if how=="geo": return st.mean(v)
    if how=="median": return st.median(v)
    if how=="trimmed": s=sorted(v); return st.mean(s[1:-1]) if len(s)>=4 else st.median(s)
    if how=="winsor":
        s=sorted(v)
        if len(s)>=4: s[0],s[-1]=s[1],s[-2]
        return st.mean(s)
    if how=="mad":
        med=st.median(v); mad=st.median(abs(a-med) for a in v)*1.4826 or 0.10
        return st.mean([a for a in v if abs(a-med)<=2.5*mad])
SCH=["mean_arith","geo","median","trimmed","winsor","mad","median+ext","trimmed+ext","mad+ext"]
def table(res):
    out={}
    for s in SCH:
        out[s]={t:b for t,(x,e) in res.items() if (b:=blend(x,e,s)) is not None}
    return out
base=run(); B=table(base)
N=len(D)
print(f"universe {N}  speculative/pre-revenue (no model value): {sum(d['mode'] in SPEC for d in D)}")
print("\n== baseline by scheme ==")
print(f"{'scheme':14s} {'cover':>6s} {'medV/P':>7s} {'p10':>5s} {'p90':>5s} {'±25%':>5s} {'>3x':>4s} {'<1/3':>5s}")
for s,v in B.items():
    r=[math.exp(x) for x in v.values()]; q=st.quantiles(r,n=10)
    print(f"{s:14s} {len(r)/N:6.0%} {st.median(r):7.2f} {q[0]:5.2f} {q[8]:5.2f} {sum(.75<=x<=1.25 for x in r)/len(r):5.0%} {sum(x>3 for x in r):4d} {sum(x<1/3 for x in r):5d}")

def delta(A,Bd):
    ks=[k for k in A if k in Bd]; return st.median(abs(A[k]-Bd[k]) for k in ks), np.percentile([abs(A[k]-Bd[k]) for k in ks],95)
print("\n== robustness: corrupt ONE method on 15% of names (x10, x0.1, or 'wild' random) — change in blend (log pts; 0.10 ≈ 10%) ==")
for label,fn in [("x10",lambda v:v+math.log(10)),("x0.1",lambda v:v-math.log(10)),("wild",lambda v:v+random.choice([-1,1])*random.uniform(1,3))]:
    def corrupt(t,x,fn=fn):
        if x and random.random()<0.15:
            k=random.choice(list(x)); x=dict(x); x[k]=fn(x[k])
        return x
    random.seed(11); C=table(run(corrupt=corrupt))
    print(f"  {label:5s} " + "  ".join(f"{s}: med {delta(B[s],C[s])[0]:.3f}/p95 {delta(B[s],C[s])[1]:.2f}" for s in ("mean_arith","geo","median","trimmed","mad","trimmed+ext")))
print("\n== sensitivity: per-method median shift, and blend: mean|Δ| / share of names moved >2% ==")
def per_method(base,alt,k):
    xs=[alt[t][0][k]-base[t][0][k] for t in base if k in base[t][0] and t in alt and k in alt[t][0]]
    return st.median(xs) if xs else float("nan")
for label,kw in [("AAA +100bp",dict(AAA=0.0703)),("AAA -100bp",dict(AAA=0.0503)),("RF +100bp",dict(RF=0.0628)),("RF -100bp",dict(RF=0.0428)),
                 ("growth cap 15%",dict(CAP=0.15)),("growth cap 30%",dict(CAP=0.30)),("ERP 4%",dict(ERP=0.04)),("ERP 6%",dict(ERP=0.06)),
                 ("terminal g 2%",dict(TG=0.02)),("terminal g 3%",dict(TG=0.03)),("harmonic peers",dict(peer_stat="harmonic"))]:
    R=run(**kw); C=table(R)
    mshift=" ".join(f"{k[:6]}{per_method(base,R,k):+.2f}" for k in ("graham","dcf","ohlson_juettner","excess_returns","peer_pe"))
    out=[]
    for sch in ("geo","median","trimmed","trimmed+ext"):
        ks=[t for t in B[sch] if t in C[sch]]; dd=[abs(C[sch][t]-B[sch][t]) for t in ks]
        out.append(f"{sch} {st.mean(dd):.3f}/{sum(x>0.02 for x in dd)/len(dd):.0%}")
    print(f"  {label:15s} [{mshift}]  " + "  ".join(out))
print("\n== leave-one-method-out (trimmed): how much the blend depends on each method ==")
for k in ["peer_pe","graham","ohlson_juettner","dcf","peer_ev_ebitda","excess_returns","reit_pffo"]:
    C=table(run(corrupt=lambda t,x,k=k: {a:b for a,b in x.items() if a!=k}))
    d=delta(B["trimmed"],C["trimmed"]); print(f"  drop {k:16s} med|Δ| {d[0]:.3f}  p95 {d[1]:.2f}  coverage {len(C['trimmed'])/N:.0%}")
print("\n== method agreement: cross-method spread (stdev of log V/P) per name, by mode ==")
sp={}
for t,(x,e) in base.items():
    if len(x)>=3: sp.setdefault(next(d['mode'] for d in D if d['t']==t),[]).append(st.pstdev(x.values()))
for mo,v in sorted(sp.items(), key=lambda z:-len(z[1])): print(f"  {mo:20s} n={len(v):3d} median spread {st.median(v):.2f}")
