import psycopg, json, sys, collections, numpy as np
url=[l.split('=',1)[1].strip() for l in open('/Users/jamiepark/Cursor/fildi/.env.local') if l.startswith('DATABASE_URL=')][0]
c=psycopg.connect(url)
rows=c.execute("""select as_of, structure, ticker, payload from watchlist_sync.structure_rank_daily
  where (payload->>'expiry')::date < current_date order by as_of""").fetchall()
px={(t,d):float(v) for t,d,v in c.execute("select ticker,date,close from prices_historical where date>='2026-10-15'")}
def close_on(t,d):
    import datetime
    for k in range(6):
        v=px.get((t,d-datetime.timedelta(days=k)))
        if v: return v
seen=set(); out=collections.defaultdict(list); skipped=collections.Counter()
for as_of,sid,t,p in rows:
    if sid in ('calendar','collar','covered_call'): continue
    legs=p.get('legs') or []
    if not legs or any(l['expiry']!=p['expiry'] for l in legs): skipped['multi-exp']+=1; continue
    key=(sid,t,p['expiry'],tuple(sorted((l['side'],l['strike'],l['qty']) for l in legs)))
    if key in seen: continue
    seen.add(key)
    import datetime; e=datetime.date.fromisoformat(p['expiry']); S=close_on(t,e)
    if not S: skipped['no px']+=1; continue
    S0=p.get('spot'); 
    if S0 and abs(S/S0-1)>0.6: skipped['split?']+=1; continue
    pay=sum(l['qty']*(max(S-l['strike'],0) if l['side']=='call' else max(l['strike']-S,0)) for l in legs)
    pnl=p['credit']+pay; cap=p['capital']
    if not cap or cap<=0: continue
    out[(sid,p.get('tier') or '-')].append((p['ev_rv_cap'],pnl/cap,as_of))
print(f"{'structure':18}{'tier':8}{'n':>4} {'pred EV':>9} {'real mean':>10} {'real med':>9} {'win':>5}  names/dates")
tot=collections.defaultdict(list)
for (sid,tier),v in sorted(out.items(), key=lambda x:(x[0][0],x[0][1])):
    pr=np.array([a for a,_,_ in v]); re=np.array([b for _,b,_ in v]); dates=len({d for *_,d in v})
    print(f"{sid:18}{tier:8}{len(v):4} {np.mean(pr)*100:+8.1f}% {np.mean(re)*100:+9.1f}% {np.median(re)*100:+8.1f}% {np.mean(re>0)*100:4.0f}%  {dates} days")
    tot[sid]+= [(a,b) for a,b,_ in v]
print('skipped',dict(skipped))
print('\nAll tiers: rank corr pred vs real per structure')
from scipy.stats import spearmanr
for sid,v in tot.items():
    if len(v)>=15:
        a=np.array(v); r=spearmanr(a[:,0],a[:,1]).correlation; print(f"  {sid:18} n={len(v):3} rho={r:+.2f}  pred {a[:,0].mean()*100:+.1f}% real {a[:,1].mean()*100:+.1f}%")
