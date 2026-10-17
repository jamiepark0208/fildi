#!/usr/bin/env python3
"""OpenJev control-layer tests (A129 follow-up, Jamie 10-17: OpenJev as data/control layer, not forecaster).

C1 peers: does each ticker sit in the right peer group? Choice over our 49 peer_groups from the FMP business description,
asked twice with shuffled option order (position bias, A129). Graded vs current mapping, the 10 human fixes in
peer_group_overrides, and an FMP-industry majority baseline. Disagreements are the review queue.

    .venv/bin/python openjev_controls.py --peers [--limit N]
    .venv/bin/python openjev_controls.py --peers-report
"""
from __future__ import annotations

import argparse
import collections
import json
import random
import statistics
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402
from openjev_news import env  # noqa: E402

DATA = ROOT / "research/openjev/controls"   # gitignored cache


def fmp_profile(t: str) -> dict:
    url = f"https://financialmodelingprep.com/stable/profile?symbol={t}&apikey={env('FMP_API_KEY')}"
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            a = json.loads(r.read())
        x = a[0] if isinstance(a, list) and a else {}
        return {k: x.get(k) for k in ("companyName", "sector", "industry", "description", "marketCap", "isEtf", "country")}
    except Exception:
        return {}


def load_peers(conn) -> tuple[dict, dict, dict]:
    with conn.cursor() as c:
        c.execute("select id, name, scoring_mode from peer_groups")
        groups = {i: (n, m) for i, n, m in c.fetchall()}
        c.execute("select ticker, group_id from peer_group_members where removed_at is null")
        member = dict(c.fetchall())
        c.execute("select ticker, group_id, previous_group_id from peer_group_overrides")
        fixes = {t: (g, p) for t, g, p in c.fetchall()}
    return groups, member, fixes


def criteria(groups: dict, order: list[str]) -> dict:
    hint = {"pre_revenue_ok": " (incl. pre-profit)", "speculative_pre_revenue": " (pre-revenue / speculative)",
            "speculative_ok": " (incl. pre-revenue)", "speculative_crypto": " (crypto miners, exchanges, treasuries)",
            "chinese": " (China-based)"}
    return {g: groups[g][0] + hint.get(groups[g][1], "") for g in order}


def peers(conn, limit: int | None) -> None:
    import openjev_local as oj
    DATA.mkdir(parents=True, exist_ok=True)
    groups, member, _ = load_peers(conn)
    prof_f = DATA / "profiles.json"
    prof = json.loads(prof_f.read_text()) if prof_f.exists() else {}
    tickers = sorted(member)[:limit] if limit else sorted(member)
    for t in tickers:
        if t not in prof:
            prof[t] = fmp_profile(t)
            time.sleep(0.6)
    prof_f.write_text(json.dumps(prof))
    out_f = DATA / "peers.jsonl"
    done = {json.loads(x)["t"] for x in out_f.open()} if out_f.exists() else set()
    rnd = random.Random(17)
    with oj.Server(), out_f.open("a") as w:
        for t in tickers:
            p = prof.get(t) or {}
            if t in done or not p.get("description"):
                continue
            st = (f"Company: {p.get('companyName') or t} ({t}), country {p.get('country')}, vendor sector/industry: "
                  f"{p.get('sector')} / {p.get('industry')}.\nBusiness: {p['description'][:900]}")
            probs = collections.Counter()
            for _ in range(2):
                order = list(groups)
                rnd.shuffle(order)
                q = {"g": {"type": "choice", "instructions": "Which peer group should this company's fundamentals be compared with? "
                           "Pick the group whose companies have the most similar business model.", "criteria": criteria(groups, order)}}
                a = oj._post("/v1/systemone", {"model": oj.MODEL, "state": st, "questions": q})["answers"]["g"]
                for g, v in (a.get("probabilities") or {}).items():
                    probs[g] += v / 2
            top = probs.most_common(3)
            w.write(json.dumps({"t": t, "cur": member[t], "top": top, "ind": p.get("industry"), "name": p.get("companyName")}) + "\n")
            w.flush()


def peers_report(conn) -> None:
    groups, member, fixes = load_peers(conn)
    rs = [json.loads(x) for x in (DATA / "peers.jsonl").open()]
    n = len(rs)
    top1 = sum(r["top"][0][0] == r["cur"] for r in rs)
    top3 = sum(r["cur"] in [g for g, _ in r["top"]] for r in rs)
    # baseline: modal current group per FMP industry (leave-one-out)
    by_ind = collections.defaultdict(collections.Counter)
    for r in rs:
        by_ind[r["ind"]][r["cur"]] += 1
    base = 0
    for r in rs:
        c = by_ind[r["ind"]].copy()
        c[r["cur"]] -= 1
        base += bool(c) and c.most_common(1)[0][0] == r["cur"] and c.most_common(1)[0][1] > 0
    print(f"C1 peers: {n} tickers. OpenJev top-1 = current group {top1}/{n} ({top1 / n:.0%}), top-3 {top3 / n:.0%}; "
          f"FMP-industry majority baseline {base}/{n} ({base / n:.0%})")
    print("\nHuman fixes (peer_group_overrides): P(fixed group) vs P(old wrong group)")
    for r in rs:
        if r["t"] in fixes:
            g, prev = fixes[r["t"]]
            p = dict(r["top"])
            print(f"  {r['t']:5s} top={r['top'][0][0]} ({r['top'][0][1]:.2f})  fixed={g} {p.get(g, 0):.2f}  old={prev} {p.get(prev, 0):.2f}")
    dis = sorted((r for r in rs if r["top"][0][0] != r["cur"]), key=lambda r: -r["top"][0][1])
    print(f"\nDisagreements: {len(dis)} (≥ 0.8 confident: {sum(r['top'][0][1] >= .8 for r in dis)})")
    for r in dis[:60]:
        p = dict(r["top"])
        print(f"  {r['top'][0][1]:.2f} {r['t']:6s} {str(r['name'])[:28]:28s} cur={r['cur'].split('.')[-1]} ({p.get(r['cur'], 0):.2f}) → "
              f"{r['top'][0][0].split('.')[-1]} | fmp {r['ind']}")


# ---------- C2: why do sources disagree? (field_provenance.divergent) -------------------------------------------

CAUSES = {"units": "one source is off by a scale factor (x100 percent vs fraction, x1000 thousands vs units)",
          "outlier": "one source disagrees while the others agree with each other",
          "definition": "sources define the field differently (e.g. includes short-term investments, different margin basis, bank vs industrial layout)",
          "period": "different periods or a stale value (TTM vs annual vs quarter, old filing)",
          "shares": "share count basis differs (basic vs diluted, share classes, ADR ratio)",
          "unclear": "cannot tell from these numbers"}


def rule_cause(vals: dict[str, float]) -> str | None:
    v = [x for x in vals.values() if x]
    if len(v) < 2:
        return None
    lo, hi = min(abs(x) for x in v), max(abs(x) for x in v)
    r = hi / lo if lo else 0
    if any(abs(r - k) / k < 0.12 for k in (100, 1000)):
        return "units"
    if len(v) >= 3:
        for s, x in vals.items():
            rest = [y for t, y in vals.items() if t != s and y]
            if len(rest) >= 2 and max(rest) and (max(rest) - min(rest)) / max(abs(y) for y in rest) < 0.05 \
                    and abs(x - statistics.fmean(rest)) / abs(statistics.fmean(rest)) > 0.15:
                return "outlier"
    return None


def divergence(conn) -> None:
    import openjev_local as oj
    _, member, _ = load_peers(conn)
    with conn.cursor() as c:
        c.execute("""select p.ticker, p.field, p.winning_source, json_object_agg(s.source, s.value)
                     from field_provenance p join source_fundamentals s on s.ticker = p.ticker and s.field = p.field
                     where p.divergent and s.value is not null group by 1, 2, 3""")
        rows = c.fetchall()
    out_f = DATA / "divergence.jsonl"
    with oj.Server(), out_f.open("w") as w:
        for t, f, win, vals in rows:
            vals = {k: float(v) for k, v in vals.items()}
            srcs = sorted(vals)
            st = (f"Ticker {t} (peer group {member.get(t, 'n/a')}). Field: {f}.\nValues by data source: "
                  + "; ".join(f"{s} = {vals[s]:,.4g}" for s in srcs))
            qs = {"cause": {"type": "choice", "instructions": "Why do the sources disagree?", "criteria": CAUSES},
                  "pick": {"type": "choice", "instructions": f"Which source's value of {f} is most likely correct?",
                           "criteria": {s: f"{s} ({vals[s]:,.4g})" for s in srcs} | {"none": "cannot tell"}}}
            a = oj._post("/v1/systemone", {"model": oj.MODEL, "state": st, "questions": qs})["answers"]
            w.write(json.dumps({"t": t, "f": f, "win": win, "vals": vals, "rule": rule_cause(vals),
                                "cause": a["cause"]["choice"], "cause_p": a["cause"]["confidence"],
                                "pick": a["pick"]["choice"], "pick_p": a["pick"]["confidence"]}) + "\n")
    rs = [json.loads(x) for x in out_f.open()]
    fired = [r for r in rs if r["rule"]]
    print(f"C2: {len(rs)} divergent fields. Rule fires on {len(fired)}; OpenJev cause = rule on "
          f"{sum(r['cause'] == r['rule'] for r in fired)}/{len(fired)}")
    for k in ("units", "outlier"):
        sub = [r for r in fired if r["rule"] == k]
        print(f"  rule {k}: n={len(sub)}  openjev agrees {sum(r['cause'] == k for r in sub)}")
    ol = [r for r in fired if r["rule"] == "outlier"]
    def odd(r):
        m = statistics.median(r["vals"].values())
        return max(r["vals"], key=lambda s: abs(r["vals"][s] - m))
    print(f"  outlier rows: OpenJev picks the odd source {sum(r['pick'] == odd(r) for r in ol)}/{len(ol)} (should be 0)")
    print("  causes on rule-silent rows:", collections.Counter(r["cause"] for r in rs if not r["rule"]).most_common())
    print(f"  OpenJev pick = current winning source on {sum(r['pick'] == r['win'] for r in rs)}/{len(rs)}")
    for r in [r for r in rs if not r["rule"]][:25]:
        print(f"   {r['t']:5s} {r['f']:18s} {r['cause']:10s} pick={r['pick']:8s} win={r['win']:8s} "
              + " ".join(f"{s}={v:,.4g}" for s, v in r["vals"].items()))


# ---------- C3: who thinks what about macro (entity views from headlines) -----------------------------------

ENTITIES = {"Fed / Powell": r"\bpowell\b|\bfed chair|\bwaller\b|\bfomc\b|federal reserve", "JPMorgan / Dimon": r"\bdimon\b|jpmorgan|jp morgan",
            "Goldman Sachs": r"goldman", "Morgan Stanley": r"morgan stanley|mike wilson", "BofA / Hartnett": r"hartnett|bank of america|\bbofa\b",
            "BlackRock / Fink": r"blackrock|\bfink\b", "Bridgewater / Dalio": r"dalio|bridgewater", "Druckenmiller": r"druckenmiller",
            "Paul Tudor Jones": r"tudor jones", "Ackman": r"ackman|pershing square", "Burry": r"\bburry\b", "Cathie Wood": r"cathie wood|\bark invest",
            "Gundlach": r"gundlach|doubleline", "El-Erian": r"el-erian", "Buffett / Berkshire": r"buffett|berkshire", "Citadel / Griffin": r"citadel|ken griffin",
            "Fundstrat / Tom Lee": r"tom lee|fundstrat", "Yardeni": r"yardeni", "UBS": r"\bubs\b", "Wells Fargo": r"wells fargo"}
TOPICS = {"stocks": "stock market outlook", "rates": "bond yields, rates", "fed": "Fed policy, rate cuts or hikes", "inflation": "inflation",
          "growth": "economy, recession, jobs", "ai": "AI boom or bubble", "other": "a company, deal or anything not macro"}


def entities(conn) -> None:
    import re
    import openjev_local as oj
    from openjev_news import DATA as NEWS
    seen, items = set(), []
    for f in NEWS.glob("*.json"):
        if f.name == "tickers.json":
            continue
        for h in json.loads(f.read_text()):
            k = h["headline"].strip().lower()
            if k in seen:
                continue
            seen.add(k)
            text = f"{h['headline']} {h.get('summary') or ''}".lower()
            ents = [e for e, rx in ENTITIES.items() if re.search(rx, text)]
            if ents:
                items.append({**h, "ents": ents})
    out_f = DATA / "entities.jsonl"
    print(f"{len(items)} headlines name a tracked entity", flush=True)
    with oj.Server(), out_f.open("w") as w:
        for h in items:
            for e in h["ents"][:2]:
                st = f"Headline: {h['headline']}\nSummary: {(h.get('summary') or '')[:400]}"
                qs = {"own": {"type": "noul", "instructions": f"Does this report {e}'s own view or forecast about markets or the economy (not just a trade, deal or company news)?"},
                      "topic": {"type": "choice", "instructions": f"What is {e}'s view mainly about?", "criteria": TOPICS},
                      "stance": {"type": "score", "instructions": f"How bullish is {e} on stocks / the economy here?", "criteria": ["bearish", "neutral or mixed", "bullish"]}}
                a = oj._post("/v1/systemone", {"model": oj.MODEL, "state": st, "questions": qs})["answers"]
                pr = list((a["stance"].get("probabilities") or {}).values())
                w.write(json.dumps({"e": e, "ts": h["datetime"], "headline": h["headline"], "own": a["own"]["noul"], "topic": a["topic"]["choice"],
                                    "stance": (pr[2] - pr[0]) if len(pr) == 3 else None}) + "\n")
    rs = [json.loads(x) for x in out_f.open()]
    own = [r for r in rs if r["own"] > 0.5]
    print(f"C3: {len(rs)} entity-headline pairs, {len(own)} judged as the entity's own macro view")
    print("  by entity:", collections.Counter(r["e"] for r in own).most_common())
    rnd = random.Random(17)
    print("\nSample for hand check (own-view yes):")
    for r in rnd.sample(own, min(25, len(own))):
        print(f"  {r['e']:20s} {r['topic']:9s} {r['stance']:+.2f} | {r['headline'][:110]}")
    print("\nSample for hand check (own-view no):")
    for r in rnd.sample([r for r in rs if r["own"] <= 0.5], min(15, len(rs) - len(own))):
        print(f"  {r['e']:20s} own={r['own']:.2f} | {r['headline'][:110]}")


# ---------- C4: fair value placebo — does OpenJev reason or copy the number we show? ---------------------------

FV_BUCKETS = {"well_below": "under 80 % of today's price", "below": "80–95 % of price", "near": "95–105 % of price",
              "above": "105–125 % of price", "well_above": "over 125 % of price"}


def fv_placebo(conn) -> None:
    import math
    import openjev_local as oj
    with conn.cursor() as c:
        c.execute("""with fv as (select distinct on (ticker) ticker, price, fair_value, low, high, mode from fair_value_snapshots
                                 where fair_value > 0 and price > 0 order by ticker, as_of desc)
                     select fv.ticker, fv.price, fv.fair_value, fv.low, fv.high, fv.mode, y.yahoo_target_mean_price,
                            f.fmp_pe_ratio, f.fmp_forward_pe, f.fmp_revenue_growth_yoy, f.fmp_gross_margin, f.fmp_operating_margin
                     from fv join yahoo_fundamentals y using (ticker) left join fmp_fundamentals f using (ticker)
                     where y.yahoo_target_mean_price > 0""")
        rows = c.fetchall()
    rnd = random.Random(17)
    gap = [r for r in rows if abs(math.log(float(r[2]) / float(r[6]))) > math.log(1.4)]
    rest = [r for r in rows if r not in gap]
    pick = rnd.sample(gap, min(40, len(gap))) + rnd.sample(rest, min(40, len(rest)))
    _, member, _ = load_peers(conn)
    f2 = lambda x, s="": "n/a" if x is None else f"{float(x):,.2f}{s}"
    out_f = DATA / "fv_placebo.jsonl"
    with oj.Server(), out_f.open("w") as w:
        for t, px, fv, lo, hi, mode, pt, pe, fpe, g, gm, om in pick:
            px, fv, pt = float(px), float(fv), float(pt)
            base = (f"{t}, peer group {member.get(t, 'n/a')}. Price ${px:,.2f}. P/E {f2(pe)}, forward P/E {f2(fpe)}, revenue growth "
                    f"{f2(g)}, gross margin {f2(gm)}, operating margin {f2(om)}.")
            fake = px * px / fv   # mirror of our FV around the price: same distance, opposite side
            states = {"public": base + f" Analyst mean target ${pt:,.2f}.",
                      "nopt": base,
                      "ours": base + f" Analyst mean target ${pt:,.2f}. Internal model fair value ${fv:,.2f} (range {f2(lo)}–{f2(hi)}, method {mode}).",
                      "fake": base + f" Analyst mean target ${pt:,.2f}. Internal model fair value ${fake:,.2f} (method {mode})."}
            rec = {"t": t, "px": px, "fv": fv, "pt": pt, "fake": fake}
            for k, st in states.items():
                q = {"fv": {"type": "score", "instructions": "Where is this stock's fair value per share most likely?",
                            "criteria": list(FV_BUCKETS.values())}}
                a = oj._post("/v1/systemone", {"model": oj.MODEL, "state": st, "questions": q})["answers"]["fv"]
                rec[k] = a.get("score")
            w.write(json.dumps(rec) + "\n")
    rs = [json.loads(x) for x in out_f.open()]
    from openjev_news import spearman
    lg = lambda a, b: math.log(a / b)
    print(f"C4: {len(rs)} names ({min(40, len(gap))} with |log(FV/PT)| > log 1.4). Answer = expected bucket 0 (well below) … 4 (well above price)")
    for k in ("nopt", "public", "ours", "fake"):
        print(f"  {k:6s} mean {statistics.fmean(r[k] for r in rs):.2f}  corr with street PT/price {spearman([r[k] for r in rs], [lg(r['pt'], r['px']) for r in rs]):+.2f}"
              f"  with our FV/price {spearman([r[k] for r in rs], [lg(r['fv'], r['px']) for r in rs]):+.2f}"
              f"  with fake FV/price {spearman([r[k] for r in rs], [lg(r['fake'], r['px']) for r in rs]):+.2f}")
    d = [r["ours"] - r["fake"] for r in rs]
    up = [x for r, x in zip(rs, d) if r["fv"] > r["px"]]
    print(f"  shift ours − fake (names where our FV > price, so fake < price): mean {statistics.fmean(up):+.2f} buckets (0 = ignores the number)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--fv-placebo", action="store_true")
    ap.add_argument("--entities", action="store_true")
    ap.add_argument("--divergence", action="store_true")
    ap.add_argument("--peers", action="store_true")
    ap.add_argument("--peers-report", action="store_true")
    ap.add_argument("--limit", type=int, default=None)
    a = ap.parse_args()
    if a.peers:
        peers(connect(), a.limit)
    if a.divergence:
        divergence(connect())
    if a.entities:
        entities(connect())
    if a.fv_placebo:
        fv_placebo(connect())
    if a.peers_report:
        peers_report(connect())
