import sys,pickle,random; sys.path[:0]=['.','analysis']
from strategy_live_grade import monday
from collections import defaultdict
from statistics import mean
book=pickle.load(open('/private/tmp/claude-501/-Users-jamiepark-Cursor-fildi/d93909f0-f3bc-4dfb-8136-eb6c7b2c0262/scratchpad/book.pkl','rb'))
by=defaultdict(list)
for e in book: by[monday(e['d'])].append(e)
random.seed(7)
def bp(g): return 1e4*sum(e['pnl'] for e in g)/sum(max(e['dte'],1)/7 for e in g)
res=defaultdict(list)
weeks=[w for w in sorted(by) if len(by[w])>=60]
for w in weeks:
    top=sorted(by[w],key=lambda e:(-e['score'],e['t']))[:len(by[w])//3]
    for K in (3,7,15,30,len(top)):
        k=min(K,len(top))
        vals=[bp(random.sample(top,k)) for _ in range(200)] if k<len(top) else [bp(top)]
        res[K if K<len(top) else 'all'].extend(vals)
for K,v in res.items():
    v=sorted(v); n=len(v)
    print(f"{str(K):>4} names: mean {mean(v):+6.1f} bp/wk · worst 5% week {v[int(.05*n)]:+7.0f} · worst 1% {v[int(.01*n)]:+7.0f} · weeks < -300bp {sum(x<-300 for x in v)/n:.1%}")
print(len(weeks),'weeks', min(weeks), max(weeks))
