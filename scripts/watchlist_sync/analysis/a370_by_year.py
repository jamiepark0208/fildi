src=open(__import__('os').path.join(__import__('os').path.dirname(__file__),'a370_put_timing_smoke.py')).read()
exec(src.split("print(f\"shift=")[0])
w = df.sort_values('d').groupby(['t','wk']).head(1).copy()
w['y']=pd.to_datetime(w.d).dt.year
print("coverage: names with IV / weekly rows / median iv / base VRP(all) / VRP top-IV  by year")
for y,x in w.groupby('y'):
    top=x[x.ivx>=2/3]
    print(y, x.t.nunique(), len(x), f"{x.iv.median():.2f}", f"{x.vrp.mean()*100:+.1f}", f"{top.vrp.mean()*100:+.1f}", f"breach-like share rv5f>iv {(x.rv5f>x.iv).mean():.0%}")
top=w[w.ivx>=2/3].dropna(subset=['vrp'])
rel=top.vrp-top.groupby('wk').vrp.transform('mean')
print("\nTop-IV tercile: filter effect (vol pts vs same week) by year")
print('year ', ' '.join(f"{f:>9}" for f in ['st_bear','below200','drop5','squeeze','rsi_hi','relvol']))
for y in sorted(top.y.unique()):
    m=top.y==y
    print(y, ' '.join(f"{rel[m & top[f]].mean()*100:+9.1f}" for f in ['st_bear','below200','drop5','squeeze','rsi_hi','relvol']))
# was the same set of names covered? names in 2019 vs 2024
s19=set(w[w.y==2019].t); s24=set(w[w.y==2024].t)
print(f"\nnames 2019 {len(s19)}, 2024 {len(s24)}, both {len(s19&s24)}")
# restrict to names present both eras
both=s19&s24; tb=top[top.t.isin(both)]; rb=tb.vrp-tb.groupby('wk').vrp.transform('mean')
for era,m in [('pre23',tb.y<2023),('23+',tb.y>=2023)]:
    print('same-names', era, ' '.join(f"{f}:{rb[m & tb[f]].mean()*100:+.1f}" for f in ['st_bear','below200','drop5']))
