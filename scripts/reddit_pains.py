#!/usr/bin/env python3
"""Pull r/thetagang + r/Optionswheel posts/comments via Reddit's official API (app-only OAuth)
and count trader pain points. Research only (monetization notes, 2026-11-07).

Auth: REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET in .env.local (Reddit "script" app).
Usage: python3 scripts/reddit_pains.py fetch [--subs thetagang Optionswheel] [--comments 150]
       python3 scripts/reddit_pains.py tally          # pain-point counts + example titles
Raw JSON → ~/.fildi/cache/reddit/ (not committed).
"""
import argparse, base64, json, os, re, sys, time, urllib.parse, urllib.request
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = Path.home() / ".fildi/cache/reddit"
UA = "script:fildi-research:v0.1 (research)"
SEARCHES = [  # pain-shaped queries, run per sub
    "tool OR app OR tracker OR spreadsheet", "wish there was", "frustrated OR frustrating",
    "cost basis", "roll OR rolling", "assigned OR assignment", "earnings", "lost OR blew up OR loss",
    "screener", "taxes OR wash sale", "strike selection OR which delta", "covered call", "spread OR iron condor",
]
# pain buckets: label → regex over title + body + comments (lowercased)
BUCKETS = {
    "tracking / cost basis / journal": r"cost basis|track(ing|er)|spreadsheet|journal|adjusted basis|premium collected",
    "rolling / when to close": r"\broll(ing|ed)?\b|close early|take profit|50 ?%|21 ?dte|when to close|manage",
    "assignment / stuck bagholding": r"assign(ed|ment)|bag ?hold|stuck with|called away|underwater",
    "tail loss / crash / blew up": r"blew up|blow ?up|wiped|crash|max loss|lost (all|everything)|black swan|tail",
    "earnings / events": r"earnings|\ber\b|fomc|cpi|ex-?div",
    "strike / expiry / delta choice": r"which (strike|delta|expir)|strike selection|delta|\bdte\b|probability of profit|\bpop\b",
    "ticker selection / screener": r"screener|which (stock|ticker)s?|watchlist|scan(ner)?|iv rank|ivr",
    "taxes / wash sales": r"tax(es)?|wash sale|short[- ]term gain|ira",
    "broker / fills / fees": r"fill(ed|s)?|bid[- ]ask|spread is wide|slippage|commission|fees?|broker|margin call|buying power",
    "sizing / allocation / margin": r"position siz|allocation|too much|margin|leverage|% of (my )?(account|portfolio)",
    "returns vs SPY / is it worth it": r"vs\.? ?spy|beat the market|underperform|worth it|just buy (spy|voo)|annualized",
    "spreads / multi-leg": r"spread|iron condor|strangle|straddle|calendar|diagonal|pmcc|poor man",
}


def env(k):
    if os.environ.get(k):
        return os.environ[k]
    for p in (ROOT / ".env.local", ROOT / ".env"):
        if p.exists():
            for line in p.read_text().splitlines():
                if line.startswith(k + "="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def token():
    cid, sec = env("REDDIT_CLIENT_ID"), env("REDDIT_CLIENT_SECRET")
    if not (cid and sec):
        raise SystemExit("REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET missing in .env.local")
    req = urllib.request.Request(
        "https://www.reddit.com/api/v1/access_token",
        data=b"grant_type=client_credentials",
        headers={"Authorization": "Basic " + base64.b64encode(f"{cid}:{sec}".encode()).decode(), "User-Agent": UA},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)["access_token"]


class Api:
    def __init__(self):
        self.tok, self.calls = token(), 0

    def get(self, path, **q):
        url = "https://oauth.reddit.com" + path + "?" + urllib.parse.urlencode({**q, "raw_json": 1})
        req = urllib.request.Request(url, headers={"Authorization": f"bearer {self.tok}", "User-Agent": UA})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=25) as r:
                    self.calls += 1
                    rem = float(r.headers.get("x-ratelimit-remaining") or 50)
                    time.sleep(0.7 if rem > 10 else 6)  # stay well under 100 req/min
                    return json.load(r)
            except urllib.error.HTTPError as e:
                if e.code == 429 and attempt < 2:
                    time.sleep(30)
                    continue
                raise


def listing(api, path, n, **q):
    out, after = [], None
    while len(out) < n:
        d = api.get(path, limit=100, after=after, **q) if after else api.get(path, limit=100, **q)
        kids = d["data"]["children"]
        out += [k["data"] for k in kids if k["kind"] == "t3"]
        after = d["data"].get("after")
        if not after or not kids:
            break
    return out[:n]


def fetch(a):
    CACHE.mkdir(parents=True, exist_ok=True)
    api = Api()
    for sub in a.subs:
        posts = {}
        for t in ("year", "all"):
            for p in listing(api, f"/r/{sub}/top", 500, t=t):
                posts[p["id"]] = p
        for qs in SEARCHES:
            for p in listing(api, f"/r/{sub}/search", 100, q=qs, restrict_sr=1, sort="top", t="all"):
                posts[p["id"]] = p
        ranked = sorted(posts.values(), key=lambda p: -p.get("num_comments", 0))
        comments = {}
        for p in ranked[: a.comments]:
            d = api.get(f"/r/{sub}/comments/{p['id']}", limit=60, depth=1, sort="top")
            comments[p["id"]] = [c["data"].get("body", "") for c in d[1]["data"]["children"] if c["kind"] == "t1"]
        slim = [{k: p.get(k) for k in ("id", "title", "selftext", "score", "num_comments", "created_utc", "permalink", "link_flair_text")} for p in posts.values()]
        (CACHE / f"{sub}.json").write_text(json.dumps({"posts": slim, "comments": comments}))
        print(f"{sub}: {len(slim)} posts, {len(comments)} comment threads, api calls so far {api.calls}")


def tally(a):
    rows = []
    for f in sorted(CACHE.glob("*.json")):
        d = json.loads(f.read_text())
        for p in d["posts"]:
            text = (p["title"] + " " + (p.get("selftext") or "") + " " + " ".join(d["comments"].get(p["id"], []))).lower()
            rows.append((f.stem, p, text))
    if not rows:
        raise SystemExit("no cache — run fetch first")
    cnt, wcnt, ex = Counter(), Counter(), defaultdict(list)
    for sub, p, text in rows:
        for b, rx in BUCKETS.items():
            if re.search(rx, text):
                cnt[b] += 1
                wcnt[b] += max(1, p.get("score") or 0)
                ex[b].append((p.get("score") or 0, p["title"][:90], sub))
    print(f"{len(rows)} posts. bucket | posts | % | upvote-weighted share | top titles")
    tw = sum(wcnt.values()) or 1
    for b, n in cnt.most_common():
        top = "; ".join(f"[{s}] {t}" for _, t, s in sorted(ex[b], reverse=True)[:3])
        print(f"{b} | {n} | {100*n/len(rows):.0f}% | {100*wcnt[b]/tw:.0f}% | {top}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    f = sp.add_parser("fetch"); f.add_argument("--subs", nargs="+", default=["thetagang", "Optionswheel"]); f.add_argument("--comments", type=int, default=150)
    sp.add_parser("tally")
    a = ap.parse_args()
    {"fetch": fetch, "tally": tally}[a.cmd](a)
