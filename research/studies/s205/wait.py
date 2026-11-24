import pickle,sys,math,pandas as pd,numpy as np
from scipy.stats import norm
S=sys.argv[1]; C=pickle.load(open('/Users/jamiepark/.fildi/cache/fast_screen_bars_2003.pkl','rb'))['c']
vix=pd.to_numeric(pd.read_csv(f'{S}/fred/VIXCLS.csv',index_col=0,parse_dates=True).iloc[:,0],errors='coerce')
v3=pd.to_numeric(pd.read_csv(f'{S}/fred/VXVCLS.csv',index_col=0,parse_dates=True).iloc[:,0],errors='coerce')
def bs(S0,K,T,iv,call=True):
    if T<=1e-6: return max(S0-K,0) if call else max(K-S0,0)
    s=iv*math.sqrt(T);d1=(math.log(S0/K)+.5*s*s)/s;d2=d1-s
    return S0*norm.cdf(d1)-K*norm.cdf(d2) if call else K*norm.cdf(-d2)-S0*norm.cdf(-d1)
for tk,mult in (('SPY',.9),('QQQ',1.04)):
  df=pd.DataFrame({'c':C[tk].dropna()}).join(vix.rename('v')).join(v3.rename('v3')).dropna()
  df['hi20']=df.c.rolling(20).max(); df['r']=df.v/df.v3
  trig=(df.v>=30)&(df.r>=1)&(df.c<=df.hi20*.93); ix=list(df.index); last=-99; rows=[]
  def leg(i,h=20):
    s0,iv0=df.c.iloc[i],df.v.iloc[i]/100*mult; j=min(i+h,len(ix)-1); sh,ivh=df.c.iloc[j],df.v.iloc[j]/100*mult
    Th=max(30/365-(ix[j]-ix[i]).days/365,0); c0=bs(s0,s0,30/365,iv0); c5=bs(s0,s0*1.05,30/365,iv0-.02)
    ch=bs(sh,s0,Th,ivh); c5h=bs(sh,s0*1.05,Th,ivh-.02); p0=bs(s0,s0*.95,30/365,iv0+.04,False); ph=bs(sh,s0*.95,Th,ivh+.04,False)
    return ch/c0-1,(ch-c5h)/(c0-c5)-1,(p0-ph)/(s0*.95),sh/s0-1
  for i in range(len(ix)-60):
    if not trig.iloc[i] or i-last<10: 
      if trig.iloc[i]: last=i
      continue
    last=i; k=next((k for k in range(i+1,i+40) if df.r.iloc[k]<1),None)
    if k is None: continue
    a=leg(i); b=leg(k); rows.append(dict(date=ix[i].date(),wait=k-i,cP=a[0],sP=a[1],pP=a[2],kP=a[3],cU=b[0],sU=b[1],pU=b[2],kU=b[3],pxgap=df.c.iloc[k]/df.c.iloc[i]-1))
  r=pd.DataFrame(rows); print(f'{tk} n={len(r)} median wait {r.wait.median():.0f}td, price at un-invert vs panic day {r.pxgap.mean():+.1%} (median {r.pxgap.median():+.1%})')
  for lab,c in (('call','c'),('callspread','s'),('short put %cash','p'),('stock','k')):
    P,U=r[c+'P'],r[c+'U']; print(f'  {lab:16} panic-day mean {P.mean():+.1%} med {P.median():+.1%} win {(P>0).mean():.0%} | at un-invert mean {U.mean():+.1%} med {U.median():+.1%} win {(U>0).mean():.0%}')
  h=len(r)//2; print('  halves call panic/uninvert:',[f'{r.cP[:h].mean():+.0%}/{r.cU[:h].mean():+.0%}',f'{r.cP[h:].mean():+.0%}/{r.cU[h:].mean():+.0%}'])
