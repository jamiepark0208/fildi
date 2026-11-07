"""A356: grade local vs Codiv headline `cat` against keyword truth (headlines matching exactly one unambiguous category)."""
import json, re, subprocess, sys
from pathlib import Path
ROOT = Path("/Users/jamiepark/Cursor/fildi")
sys.path.insert(0, str(ROOT / "scripts/watchlist_sync")); sys.path.insert(0, str(ROOT / "scripts"))
import oj, oj_server
from openjev_desk_headlines import label_one

RX = {
    "analyst": r"\b(upgrades?|downgrades?|upgraded|downgraded|price target|initiates? coverage|initiated at|raises? (?:pt|target)|cuts? (?:pt|target)|reiterates?)\b",
    "earnings": r"\b(q[1-4] (?:earnings|results|revenue|eps)|quarterly (?:results|earnings)|earnings (?:beat|miss|call)|beats? estimates|misses estimates|raises? (?:guidance|outlook)|cuts? (?:guidance|outlook))\b",
    "capital": r"\b(buyback|share repurchase|dividend|stock offering|debt offering|notes offering|convertible notes)\b",
    "legal": r"\b(lawsuit|sues|sued|class action|investigation|probe|recall|antitrust|settlement)\b",
    "people": r"\b(ceo|cfo|chief executive|steps down|resigns|appoints|names .* (?:ceo|cfo)|insider)\b",
}
N = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
url = oj._env_local()["DATABASE_URL"]
q = f"select distinct ticker, headline from watchlist_sync.openjev_headline_labels order by 1, 2 limit {N}"
rows = [r.split("\x1f") for r in subprocess.run(["psql", url, "-qAt", "-F", "\x1f", "-c", q],
        capture_output=True, text=True, timeout=30).stdout.strip().splitlines()]
truth = []
for t, h in rows:
    hits = [c for c, rx in RX.items() if re.search(rx, h, re.I)]
    if len(hits) == 1:
        truth.append((t, h, hits[0]))
# cap per class so one class doesn't dominate
per = {}
items = [x for x in truth if per.setdefault(x[2], 0) < 40 and not per.update({x[2]: per[x[2]] + 1})]
res = {}
for prov in ("codiv", "local"):
    oj.PROVIDER = prov
    port = 0 if prov == "codiv" else oj_server.ensure(min_free=0, who="claude-catgrade")
    res[prov] = [label_one(port, t, t, {"headline": h}) for t, h, _ in items]
out = {"n": len(items), "per_class": per}
for prov, labs in res.items():
    ok = [(l["cat"] == c) for l, (_, _, c) in zip(labs, items) if l]
    by = {}
    for l, (_, _, c) in zip(labs, items):
        if l:
            a = by.setdefault(c, [0, 0]); a[0] += l["cat"] == c; a[1] += 1
    out[prov] = {"acc": round(sum(ok) / len(ok), 3), "by_class": {c: f"{a}/{b}" for c, (a, b) in by.items()}}
agree = sum(a and b and a["cat"] == b["cat"] for a, b in zip(res["codiv"], res["local"]))
out["agree"] = round(agree / len(items), 3)
print(json.dumps(out))
