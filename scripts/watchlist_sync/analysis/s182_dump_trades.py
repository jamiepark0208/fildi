"""S182 step 1 (watchlist venv): dump S003-grain monthly 30-DTE 0.20Δ put trades to a pickle for the Kronos venv.

Universe = Jamie's names (current holdings + traded, 11-10) + the 40 names with the richest median IV/RV
(most premium-selling opportunity). All entries kept; the Kronos script restricts to post-pretrain dates.
"""
import pickle, sys
from collections import defaultdict
from pathlib import Path
import numpy as np
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent))
import backtest_puts as B
from build_plan import connect

JAMIE = ["HOOD", "NVDA", "ONDS", "MP", "USAR", "RKLB", "RGTI", "OPEN", "POET", "JOBY", "AMZN"]
OUT = Path.home() / ".fildi/cache/s182_trades.pkl"

with connect() as conn:
    H, peer, er, sm = B.load(conn)
trades = B.build_trades(H, peer, er, sm, 0.85, 0.20)
by = defaultdict(list)
for t in trades:
    if t.get("iv_rv"):
        by[t["ticker"]].append(t["iv_rv"])
rich = sorted((k for k, v in by.items() if len(v) >= 24), key=lambda k: -float(np.median(by[k])))[:40]
names = list(dict.fromkeys([n for n in JAMIE if n in H] + rich))
keep = [t for t in trades if t["ticker"] in set(names)]
hist = {n: H[n] for n in names}
pickle.dump({"trades": keep, "names": names, "jamie": [n for n in JAMIE if n in H], "hist": hist}, open(OUT, "wb"))
print(f"{len(keep)} trades · {len(names)} names (jamie {sum(n in H for n in JAMIE)}/{len(JAMIE)}) · "
      f"entries {min(t['entry'] for t in keep)}..{max(t['entry'] for t in keep)} → {OUT}")
print("rich:", " ".join(rich))
