import sys,runpy,ast,subprocess,json,hashlib
from pathlib import Path
sys.argv=['study','--bs']
p=Path('scripts/watchlist_sync/analysis/s064_buy_zone.py')
g=runpy.run_path(str(p),run_name='review_only')
old=dict(g);src=subprocess.check_output(['git','show','HEAD:'+str(p)],text=True)
exec(compile(ast.Module(body=[n for n in ast.parse(src).body if isinstance(n,ast.FunctionDef) and n.name in ('pick_expiry','sell_put','trade')],type_ignores=[]),'baseline','exec'),old)
c=g['connect']();c.execute('SET TRANSACTION READ ONLY');c.execute("SET LOCAL statement_timeout='20s'")
try:
 bars,fund,sm,peer,firsts,rf=g['load'](c,['AAPL','AMD','MU','SHOP','CAVA']);gates=g['gate_table'](fund,peer,sm,firsts);firsts=set(firsts)
 before=[];after=[]
 for t,rows in bars.items():
  for i,r in enumerate(rows):
   if r[0] in firsts and i>=60:
    args=(None,c,t,rows,i,gates.get((t,r[0]),(False,'no_fwd_growth')),sm,rf)
    before+=old['trade'](*args);after+=g['trade'](*args)
 key=lambda x:(x['t'],str(x['d']),x['anchor'])
 b={key(x):x for x in before};a={key(x):x for x in after};same=set(a)&set(b)
 changed=sum(any(a[k][f]!=b[k][f] for f in ('e','K','Se','S63','put_x')) for k in same)
 report={'names':sorted(bars),'baseline_trades':len(before),'corrected_trades':len(after),'removed':len(set(b)-set(a)),'added':len(set(a)-set(b)),'matched':len(same),'matched_changed':changed,'source_sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'scope':'Five-name modeled-fill mechanics smoke on identical current cached inputs; no vendor calls or economic validation.'}
 Path('/tmp/fildi-s064-compare.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
finally:c.rollback();c.close()
