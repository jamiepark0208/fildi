"""S149 (11-03): after SMH falls >= 9 % in 2 sessions, next-21-session SMH/SPY returns vs base. Data: Yahoo chart API adjclose."""
import os, subprocess, statistics as st
import json, urllib.request, datetime as dt
def px(t):  # Yahoo chart API, adjusted close, full history (same source as S148)
    u=f"https://query1.finance.yahoo.com/v8/finance/chart/{t}?period1=946684800&period2=1793000000&interval=1d&events=div,split"
    r=json.load(urllib.request.urlopen(urllib.request.Request(u,headers={"User-Agent":"Mozilla/5.0"}),timeout=30))["chart"]["result"][0]
    ts=r["timestamp"]; c=r["indicators"]["adjclose"][0]["adjclose"]
    return {dt.datetime.utcfromtimestamp(a).strftime("%Y-%m-%d"):v for a,v in zip(ts,c) if v}
smh,spy=px('SMH'),px('SPY'); d=[x for x in sorted(smh) if x in spy]
def fwd(s,i,h=21): return s[d[i+h]]/s[d[i]]-1
def mdd(s,i,h=21): return min(s[d[j]] for j in range(i+1,i+h+1))/s[d[i]]-1
ev=[];last=-99
for i in range(2,len(d)-21):
    if smh[d[i]]/smh[d[i-2]]-1<=-0.09 and i-last>21: ev.append(i); last=i
base=range(2,len(d)-21)
def row(name,idx,s):
    r=[fwd(s,i) for i in idx]; m=[mdd(s,i) for i in idx]
    return f"{name}: n={len(r)} median21={st.median(r)*100:+.1f}% up={sum(x>0 for x in r)/len(r)*100:.0f}% P(dd>=5%)={sum(x<=-0.05 for x in m)/len(m)*100:.0f}%"
print("history", d[0],"→",d[-1])
for s,n in((smh,'SMH'),(spy,'SPY')):
    print(row(n+' after',ev,s)); print(row(n+' base ',base,s))
print("episodes:", ", ".join(d[i] for i in ev))
ev2=[i for i in ev if d[i]>='2003']
for s,n in((smh,'SMH'),(spy,'SPY')): print(row(n+' after, 2003+',ev2,s))
