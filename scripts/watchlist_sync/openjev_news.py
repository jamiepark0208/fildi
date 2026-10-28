#!/usr/bin/env python3
"""OpenJev use-case study U1 (A129, Jamie 10-17: find what OpenJev is good for, copy how others use it).

Copies Lopez-Lira & Tang (2023, "Can ChatGPT forecast stock price movements?"): an LLM reads each company
headline (good / bad / unknown for the stock) → does its answer line up with the stock's move vs SPY?
Also the uses public Jev projects actually ship (awesome-jev): relevance gate, event-type routing,
materiality triage. Every answer is graded right away by prices_historical → thousands of labels in one run.

Leak guard: headlines from 16:00 ET (prior day) to 09:30 ET are graded on that day's move (gap included);
intraday headlines (e.g. "Why X is trading up today") are graded only on the NEXT day (close → close).

    .venv/bin/python openjev_news.py --fetch            # Finnhub news for a cap-stratified 90-ticker subset → cache
    .venv/bin/python openjev_news.py --run [--limit N] [--variant v0]   # ask OpenJev (local 26B), cache answers
    .venv/bin/python openjev_news.py --report           # grade vs abnormal returns + keyword baseline
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import random
import re
import statistics
import sys
import time
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
import vendor_gate  # noqa: E402  (A303 shared cross-process budget)
from build_plan import connect  # noqa: E402

ET = ZoneInfo("America/New_York")
DATA = ROOT / "research/openjev/news"          # gitignored cache (raw vendor text stays local)
START, END = dt.date(2026, 7, 15), dt.date(2026, 10, 15)
SEED = 17


def env(k: str) -> str:
    for line in (ROOT / ".env.local").read_text().splitlines():
        if line.startswith(k + "="):
            return line.split("=", 1)[1].strip().strip('"')
    return os.environ.get(k, "")


def fh(path: str) -> object:
    url = f"https://finnhub.io/api/v1/{path}&token={env('FINNHUB_API_KEY')}"
    for i in range(4):
        try:
            vendor_gate.wait("Finnhub")
            with urllib.request.urlopen(url, timeout=30) as r:
                return json.loads(r.read())
        except Exception as e:  # 429 / transient
            time.sleep(5 * (i + 1))
            err = e
    raise RuntimeError(f"finnhub {path}: {err}")


def pick_tickers(conn, n_per: int = 30) -> list[str]:
    """Cap proxy = median dollar volume Jul–Oct; 30 random per tercile (Lopez-Lira: effect biggest in small names)."""
    with conn.cursor() as c:
        c.execute("""select ticker, percentile_cont(0.5) within group (order by close*volume) dv, count(*) n
                     from prices_historical where date between %s and %s and ticker !~ '[^A-Z.]'
                     group by ticker having count(*) > 55 order by dv""", (START, END))
        rows = [r for r in c.fetchall() if r[0] not in ("SPY", "QQQ", "IWM", "DIA")]
    k = len(rows) // 3
    rnd = random.Random(SEED)
    out = []
    for i, tier in enumerate((rows[:k], rows[k:2 * k], rows[2 * k:])):
        out += [(t, i) for t, _, _ in rnd.sample(tier, min(n_per, len(tier)))]
    return out


def fetch(conn) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    meta_f = DATA / "tickers.json"
    meta = json.loads(meta_f.read_text()) if meta_f.exists() else {}
    for t, tier in pick_tickers(conn):
        if t in meta and (DATA / f"{t}.json").exists():
            continue
        prof = fh(f"stock/profile2?symbol={t}") or {}
        items, d = {}, START
        while d <= END:
            e = min(d + dt.timedelta(days=13), END)
            for x in fh(f"company-news?symbol={t}&from={d}&to={e}") or []:
                items[x.get("id") or x["headline"]] = {k: x.get(k) for k in ("datetime", "headline", "summary", "source", "related")}
            d = e + dt.timedelta(days=1)
            time.sleep(1.05)
        (DATA / f"{t}.json").write_text(json.dumps(list(items.values())))
        meta[t] = {"tier": tier, "name": prof.get("name") or t, "industry": prof.get("finnhubIndustry")}
        meta_f.write_text(json.dumps(meta, indent=0))
        print(t, tier, len(items), flush=True)


# ---------- grading targets ---------------------------------------------------------------------------

def price_map(conn, tickers: list[str]) -> dict[str, dict[dt.date, tuple[float, float]]]:
    with conn.cursor() as c:
        c.execute("select ticker, date, open, close from prices_historical where ticker = any(%s) and date between %s and %s",
                  (tickers + ["SPY"], START - dt.timedelta(days=120), END + dt.timedelta(days=10)))
        out: dict = {}
        for t, d, o, cl in c.fetchall():
            out.setdefault(t, {})[d] = (float(o or cl), float(cl))
    return out


def targets(px: dict, t: str, ts: int) -> dict | None:
    """Pre-open headline → day D move (close D-1 → close D, gap incl.). Intraday/after-close → next session D+1."""
    days = sorted(d for d in px.get("SPY", {}) if d in px.get(t, {}))
    when = dt.datetime.fromtimestamp(ts, ET)
    d0 = when.date()
    pre = when.time() < dt.time(9, 30)
    nxt = [d for d in days if (d >= d0 if pre else d > d0)]
    if not nxt:
        return None
    D = nxt[0]
    i = days.index(D)
    if i < 61:
        return None
    rr = lambda tk, a, b: px[tk][b][1] / px[tk][a][1] - 1
    abn = [rr(t, days[j - 1], days[j]) - rr("SPY", days[j - 1], days[j]) for j in range(i - 60, i)]
    sd = statistics.pstdev(abn) or None
    return {"day": D.isoformat(), "pre": pre or when.time() >= dt.time(16), "abn": rr(t, days[i - 1], D) - rr("SPY", days[i - 1], D),
            "sd": sd, "abn_oc": (px[t][D][1] / px[t][D][0] - 1) - (px["SPY"][D][1] / px["SPY"][D][0] - 1)}


# ---------- questions (v0 = headline only; v1 = + summary) ------------------------------------------------

CATS = {
    "earnings": "quarterly results, guidance, outlook",
    "analyst": "analyst rating change or price target",
    "deal": "merger, acquisition, partnership, big contract or customer win",
    "product": "product launch, business update, operations",
    "legal": "lawsuit, regulator, investigation, recall",
    "capital": "buyback, dividend, stock or debt offering",
    "people": "executive or board change, insider trade",
    "market": "market roundup, macro, sector or list of many stocks",
    "other": "anything else",
}


def questions(name: str) -> dict:
    s = f"{name}'s stock price in the short term"
    return {
        "rel": {"type": "noul", "instructions": f"Is this headline mainly about {name} itself (not a market roundup or a list of many stocks)?"},
        "dir": {"type": "score", "instructions": f"How is this news for {s}?", "criteria": ["bad", "neutral or unclear", "good"]},
        "good": {"type": "noul", "instructions": f"Is this headline good news for {s}?"},
        "bad": {"type": "noul", "instructions": f"Is this headline bad news for {s}?"},
        "mat": {"type": "noul", "instructions": f"Is this news big enough to move {name}'s stock much more than on a normal day?"},
        "cat": {"type": "choice", "instructions": "What kind of news is this?", "criteria": CATS},
    }


def state(meta: dict, t: str, h: dict, variant: str) -> str:
    m = meta[t]
    s = f"Company: {m['name']} (ticker {t}, industry {m.get('industry') or 'n/a'}).\nHeadline: {h['headline']}"
    if variant == "v1" and h.get("summary"):
        s += f"\nSummary: {h['summary'][:400]}"
    return s


def sample_items(conn, per_ticker: int) -> list[dict]:
    meta = json.loads((DATA / "tickers.json").read_text())
    px = price_map(conn, list(meta))
    rnd = random.Random(SEED)
    out = []
    for t in sorted(meta):
        f = DATA / f"{t}.json"
        if not f.exists():
            continue
        seen, items = set(), []
        for h in json.loads(f.read_text()):
            key = re.sub(r"\W+", " ", h["headline"].lower()).strip()
            if not key or key in seen:
                continue
            seen.add(key)
            tg = targets(px, t, h["datetime"])
            if tg and tg["sd"]:
                items.append({"t": t, "ts": h["datetime"], "headline": h["headline"], "summary": h.get("summary") or "",
                              "source": h.get("source"), **tg})
        rnd.shuffle(items)
        out += items[:per_ticker]
    return out


def run(conn, per_ticker: int, variant: str, samples: int | None) -> None:
    import openjev_local as oj
    meta = json.loads((DATA / "tickers.json").read_text())
    items = sample_items(conn, per_ticker)
    tag = variant + (f"_s{samples}" if samples else "")
    out_f = DATA / f"answers_{tag}.jsonl"
    done = set()
    if out_f.exists():
        done = {(r["t"], r["ts"], r["headline"]) for r in map(json.loads, out_f.open())}
    todo = [x for x in items if (x["t"], x["ts"], x["headline"]) not in done]
    print(f"{len(items)} items, {len(todo)} to ask ({tag})", flush=True)
    oj.HARD_STOP_S = 90 * 60
    with oj.Server() as srv, out_f.open("a") as w:
        t0 = time.time()
        for k, x in enumerate(todo):
            body = {"model": oj.MODEL, "state": state(meta, x["t"], x, variant), "questions": questions(meta[x["t"]]["name"])}
            if samples:
                body["samples"] = samples
            r = oj._post("/v1/systemone", body)
            w.write(json.dumps({**x, "a": r.get("answers", {})}) + "\n")
            if k % 100 == 99:
                w.flush()
                print(f"{k + 1}/{len(todo)} {(time.time() - t0) / (k + 1):.2f}s/item peak {srv.sampler.peak_gb:.1f} GB", flush=True)
    print(f"done {len(todo)} in {time.time() - t0:.0f}s", flush=True)


# ---------- grading ---------------------------------------------------------------------------------------

POS = r"\b(beat|beats|tops|raise[sd]?|raising|upgrade[sd]?|record|surge[sd]?|soar|jump|rall(y|ies)|win[s]?|wins|approv|buyback|outperform|strong|boost|expand|partnership|award)"
NEG = r"\b(miss(es|ed)?|cut[s]?|lower(s|ed)?|downgrade[sd]?|plunge|tumble|fall[s]?|drop[s]?|sink|slump|lawsuit|probe|investigat|recall|weak|warn|delay|layoff|halt|fraud|short seller|offering|dilut)"
KW_CAT = [("earnings", r"earnings|results|quarter|q[1-4]\b|guidance|outlook|revenue|eps"),
          ("analyst", r"price target|upgrade|downgrade|rating|initiat|overweight|underweight|outperform|reiterat|maintains"),
          ("deal", r"acqui|merger|to buy|deal|partner|contract|agreement"),
          ("legal", r"lawsuit|class action|sec |probe|investigat|regulat|fda|recall|court"),
          ("capital", r"buyback|repurchase|dividend|offering|notes due|convertible"),
          ("people", r"\bceo\b|\bcfo\b|appoint|resign|steps down|insider|director"),
          ("market", r"stocks to|stock market|dow|s&p 500|nasdaq|top \d|best .* stocks|movers|futures")]


def kw_dir(h: str) -> float:
    h = h.lower()
    return float(len(re.findall(POS, h)) - len(re.findall(NEG, h)))


def kw_cat(h: str) -> str:
    h = h.lower()
    return next((c for c, rx in KW_CAT if re.search(rx, h)), "other")


def probs(a: dict, keys: list[str] | None = None) -> list[float]:
    p = a.get("probabilities") or []
    return [p.get(k, 0.0) for k in keys] if isinstance(p, dict) and keys else list(p.values()) if isinstance(p, dict) else list(p)


def feats(r: dict) -> dict | None:
    a = r["a"]
    try:
        d = probs(a["dir"])
        return {"rel": a["rel"]["noul"], "good": a["good"]["noul"], "bad": a["bad"]["noul"], "mat": a["mat"]["noul"],
                "dir": d[2] - d[0], "flip": (a["good"]["noul"] + 1 - a["bad"]["noul"]) / 2 - 0.5,
                "cat": a["cat"]["choice"]}
    except (KeyError, IndexError, TypeError):
        return None


def rank(xs: list[float]) -> list[float]:
    o = sorted(range(len(xs)), key=lambda i: xs[i])
    r = [0.0] * len(xs)
    i = 0
    while i < len(o):
        j = i
        while j + 1 < len(o) and xs[o[j + 1]] == xs[o[i]]:
            j += 1
        for k in range(i, j + 1):
            r[o[k]] = (i + j) / 2
        i = j + 1
    return r


def spearman(x: list[float], y: list[float]) -> float:
    if len(x) < 10:
        return float("nan")
    rx, ry = rank(x), rank(y)
    mx, my = statistics.fmean(rx), statistics.fmean(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = math.sqrt(sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry))
    return num / den if den else float("nan")


def auc(score: list[float], y: list[bool]) -> float:
    r = rank(score)
    npos = sum(y)
    nneg = len(y) - npos
    if not npos or not nneg:
        return float("nan")
    return (sum(ri for ri, yi in zip(r, y) if yi) - npos * (npos - 1) / 2) / (npos * nneg) - 0  # ranks are 0-based


def boot(rows: list[dict], fn, n: int = 300) -> tuple[float, float, float]:
    """Point estimate + 90 % CI, resampling whole days (news on one day is correlated)."""
    by: dict = {}
    for r in rows:
        by.setdefault(r["day"], []).append(r)
    days = list(by)
    rnd = random.Random(SEED)
    est = fn(rows)
    bs = sorted(v for v in (fn([r for d in rnd.choices(days, k=len(days)) for r in by[d]]) for _ in range(n)) if v == v)
    return est, bs[int(0.05 * len(bs))], bs[int(0.95 * len(bs)) - 1]


def fmt(t: tuple) -> str:
    return f"{t[0]:+.3f} [{t[1]:+.3f}, {t[2]:+.3f}]"


def report(tag: str = "v0") -> None:
    rows = []
    for r in map(json.loads, (DATA / f"answers_{tag}.jsonl").open()):
        f = feats(r)
        if f:
            rows.append({**r, **f, "z": r["abn"] / r["sd"], "kw": kw_dir(r["headline"]), "kwcat": kw_cat(r["headline"]),
                         "big": abs(r["abn"]) > 2 * r["sd"]})
    pre = [r for r in rows if r["pre"]]
    intra = [r for r in rows if not r["pre"]]
    print(f"{tag}: {len(rows)} headlines ({len(pre)} overnight/pre-open, {len(intra)} intraday→next day), "
          f"{len({r['t'] for r in rows})} tickers, {len({r['day'] for r in rows})} days")
    ic = lambda k, tgt="z": (lambda rs: spearman([r[k] for r in rs], [r[tgt] for r in rs]))
    print("\n## Direction: rank corr of signal vs abnormal move (z = abn / 60d sd), 90% CI by day-bootstrap")
    for lab, rs in (("pre-open → same day (reads news)", pre), ("pre-open, rel>0.5", [r for r in pre if r["rel"] > 0.5]),
                    ("intraday → next day (tradable drift)", intra)):
        print(f"- {lab} n={len(rs)}")
        for k in ("dir", "good", "flip", "kw"):
            print(f"    {k:5s} {fmt(boot(rs, ic(k)))}")
    if pre:
        print(f"    open→close (tradable after pre-open news), dir: {fmt(boot(pre, ic('dir', 'abn_oc')))}  kw: {fmt(boot(pre, ic('kw', 'abn_oc')))}")
    # aggregated per ticker-day (Lopez-Lira style)
    agg: dict = {}
    for r in pre:
        if r["rel"] > 0.5:
            agg.setdefault((r["t"], r["day"]), []).append(r)
    td = [{"day": k[1], "dir": statistics.fmean(x["dir"] for x in v), "kw": statistics.fmean(x["kw"] for x in v),
           "z": v[0]["z"], "abn": v[0]["abn"], "n": len(v), "big": v[0]["big"], "mat": max(x["mat"] for x in v), "t": k[0]}
          for k, v in agg.items()]
    if td:
        ls = lambda rs: (statistics.fmean([r["abn"] for r in rs if r["dir"] > 0.3] or [0]) - statistics.fmean([r["abn"] for r in rs if r["dir"] < -0.3] or [0]))
        print(f"- ticker-day (pre-open, relevant) n={len(td)}: dir {fmt(boot(td, ic('dir')))}  kw {fmt(boot(td, ic('kw')))}"
              f"  long-short abn (dir>0.3 vs < -0.3): {fmt(boot(td, ls))}")
        print("\n## Materiality: AUC for |move| > 2σ on the ticker-day (0.5 = coin flip)")
        au = lambda k: (lambda rs: auc([r[k] for r in rs], [r["big"] for r in rs]))
        print(f"  P(material) max {fmt(boot(td, au('mat')))}   news-count baseline {fmt(boot(td, au('n')))}   "
              f"base rate {statistics.fmean(r['big'] for r in td):.3f}")
    print("\n## Pre-open alert: relevant + bad + material (put-seller's 6:30 am flag) → share of days the stock falls > 1σ vs SPY")
    for lab, f in (("openjev rel&bad&mat > .5", lambda r: r["rel"] > .5 and r["bad"] > .5 and r["mat"] > .5),
                   ("openjev rel&bad > .5", lambda r: r["rel"] > .5 and r["bad"] > .5),
                   ("keyword negative (kw < 0)", lambda r: r["kw"] < 0)):
        hit = {(r["t"], r["day"]): r["z"] for r in pre if f(r)}
        allz = {(r["t"], r["day"]): r["z"] for r in pre}
        if hit:
            print(f"  {lab:28s} days {len(hit):4d}  P(z<-1) {statistics.fmean(z < -1 for z in hit.values()):.2f}  "
                  f"(all pre-open days {statistics.fmean(z < -1 for z in allz.values()):.2f})  mean z {statistics.fmean(hit.values()):+.2f}")
    print("\n## Relevance gate: P(rel) vs keyword 'market roundup'")
    mk = [r for r in rows if r["kwcat"] == "market"]
    print(f"  mean P(rel): market-roundup headlines {statistics.fmean([r['rel'] for r in mk] or [0]):.2f}  others {statistics.fmean([r['rel'] for r in rows if r['kwcat'] != 'market'] or [0]):.2f}")
    print("\n## Event type: agreement with keyword rules (where a rule fires) + what moves")
    fired = [r for r in rows if r["kwcat"] != "other"]
    print(f"  agree {sum(r['cat'] == r['kwcat'] for r in fired)}/{len(fired)}")
    for c in CATS:
        rs = [r for r in pre if r["cat"] == c]
        if len(rs) >= 15:
            print(f"  {c:9s} n={len(rs):4d}  P(|z|>2) {statistics.fmean(r['big'] for r in rs):.2f}  mean|z| {statistics.fmean(abs(r['z']) for r in rs):.2f}  dir-IC {spearman([r['dir'] for r in rs], [r['z'] for r in rs]):+.2f}")
    print("\n## By cap tier (0 small … 2 large), pre-open dir IC")
    meta = json.loads((DATA / "tickers.json").read_text())
    for tier in (0, 1, 2):
        rs = [r for r in pre if meta[r["t"]]["tier"] == tier]
        print(f"  tier {tier} n={len(rs)} dir {spearman([r['dir'] for r in rs], [r['z'] for r in rs]):+.3f} kw {spearman([r['kw'] for r in rs], [r['z'] for r in rs]):+.3f}")
    print("\n## Calibration of P(good) on pre-open, relevant: realized share of up-days (abn > 0)")
    rs = [r for r in pre if r["rel"] > 0.5]
    for lo, hi in ((0, .1), (.1, .4), (.4, .6), (.6, .9), (.9, 1.01)):
        b = [r for r in rs if lo <= r["good"] < hi]
        if b:
            print(f"  P(good) {lo:.1f}–{min(hi, 1):.1f}: n={len(b):4d} up-share {statistics.fmean(r['abn'] > 0 for r in b):.2f}")


# ---------- U2: record ↔ headline verification (jev-commit / judge_rails pattern) -----------------------------

HEAD_ACTS = {"upgrade": "firm raises its rating", "downgrade": "firm lowers its rating", "initiate": "firm starts or resumes coverage",
             "pt_raise": "firm raises its price target, rating unchanged", "pt_cut": "firm lowers its price target, rating unchanged",
             "reiterate": "firm keeps rating and target", "other": "not one firm's call on this stock (roundup, list, other news)"}


def rx_head(h: str) -> str:
    h = h.lower()
    for k, rx in (("upgrade", r"upgrade"), ("downgrade", r"downgrade"), ("initiate", r"initiat|reinstat|resum|assum|starts? coverage"),
                  ("pt_raise", r"(target|pt)\b.{0,15}(raised|lifted|boosted|increased|raises)|raises.{0,25}(target|pt)\b"),
                  ("pt_cut", r"(target|pt)\b.{0,15}(lowered|cut|reduced|trimmed|lowers)|(lowers|cuts).{0,25}(target|pt)\b"),
                  ("reiterate", r"reiterat|maintain")):
        if re.search(rx, h):
            return k
    return "other"


def rec_kind(action: str) -> str:
    return {"upgrade": "upgrade", "downgrade": "downgrade", "initialise": "initiate"}.get(action, "pt_or_hold")


def verify_analyst(conn) -> None:
    import openjev_local as oj
    with conn.cursor() as c:
        c.execute("""select ticker, firm, action, from_grade, to_grade, price_target, news_title, event_date
                     from analyst_events where news_title is not null order by event_date""")
        rows = c.fetchall()
    out_f = DATA / "answers_u2.jsonl"
    DATA.mkdir(parents=True, exist_ok=True)
    with oj.Server(), out_f.open("w") as w:
        for t, firm, act, fg, tg, pt, title, d in rows:
            rec = f"{firm} {act}" + (f" from {fg} to {tg}" if fg or tg else "") + (f", price target ${pt}" if pt else "")
            st = f"Database record for {t} on {d}: {rec}.\nNews headline linked to it: {title}"
            qs = {"match": {"type": "noul", "instructions": "Does the headline report this same firm making this same kind of call on this stock?"},
                  "head": {"type": "choice", "instructions": f"Going by the headline only, what did {firm} do?", "criteria": HEAD_ACTS}}
            a = oj._post("/v1/systemone", {"model": oj.MODEL, "state": st, "questions": qs}).get("answers", {})
            w.write(json.dumps({"t": t, "firm": firm, "act": act, "fg": fg, "tg": tg, "pt": str(pt), "title": title, "d": str(d),
                                "match": a.get("match", {}).get("noul"), "head": a.get("head", {}).get("choice"),
                                "rx": rx_head(title)}) + "\n")
    rs = [json.loads(x) for x in out_f.open()]
    fired = [r for r in rs if r["rx"] != "other"]
    print(f"U2: {len(rs)} rows. OpenJev headline action = regex action on {sum(r['head'] == r['rx'] for r in fired)}/{len(fired)} where regex fires")
    flag = [r for r in rs if r["match"] is not None and r["match"] < 0.5]
    print(f"flagged mismatch (P(match) < 0.5): {len(flag)}")
    for r in sorted(flag, key=lambda r: r["match"])[:40]:
        print(f"  {r['match']:.2f} {r['t']:5s} rec={r['act']}/{r['fg']}→{r['tg']} pt={r['pt']} | oj={r['head']} rx={r['rx']} | {r['title'][:90]}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify-analyst", action="store_true")
    ap.add_argument("--fetch", action="store_true")
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--per-ticker", type=int, default=40)
    ap.add_argument("--variant", default="v0")
    ap.add_argument("--samples", type=int, default=None)
    a = ap.parse_args()
    if a.fetch:
        fetch(connect())
    if a.run:
        run(connect(), a.per_ticker, a.variant, a.samples)
    if a.verify_analyst:
        verify_analyst(connect())
    if a.report:
        report(a.variant + (f"_s{a.samples}" if a.samples else ""))
