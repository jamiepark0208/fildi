#!/usr/bin/env python3
"""Peer-group check for universe names without a reviewed mapping (Jamie 10-27: "are you checking your confidence … asking
our existing external APIs and tools like OpenJev to verify mappings are correct?").

Three independent votes per name, each against our peer_groups:
  oj     OpenJev P01 (tier B, 0.85 vs reviewed labels): LSEG business description + 3 reviewed members per group, 2 shuffled reads
  trbc   LSEG TRBC industry → group (research/lseg/universe_review.py TRBC_GROUP; ambiguous industries cast no vote)
  co     price co-movement: 126-day return correlation with each group's equal-weight return (reviewed members only)
Verified = ≥ 2 votes agree (that group becomes primary; member source 'verified' → enters peer norms). Otherwise the name
stays 'auto' (scored, but kept out of the peer norms — fund-score-engine) and lands in out/peer_verify.md for review.

Profiles: research/lseg/peer_profiles.py first. Incremental: names already checked (peer_verify.jsonl) are skipped unless --all.
    .venv/bin/python peer_verify.py [--tickers A,B] [--all] [--apply]
"""
from __future__ import annotations

import argparse
import collections
import json
import random
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402
from openjev_controls import criteria  # noqa: E402

PROFILES = ROOT / "research/openjev/controls/profiles_lseg.json"
OUT_J = ROOT / "research/openjev/controls/peer_verify.jsonl"
OUT_MD = HERE / "out" / "peer_verify.md"
REVIEWED = ("taxonomy", "manual", "verified")
OJ_MIN = 0.40      # OpenJev top probability that counts as a vote
CO_MIN = 0.45      # correlation with the best group that counts as a vote
CO_MARGIN = 0.03   # … and must beat the runner-up by this much
DAYS = 126


def unreviewed(conn) -> list[str]:
    return [r[0] for r in conn.execute("""
        SELECT r.ticker FROM ticker_registry r
        LEFT JOIN peer_group_members m ON m.ticker = r.ticker AND m.group_id = r.primary_peer_group_id AND m.removed_at IS NULL
        WHERE r.is_active AND r.fetch_fundamentals AND COALESCE(m.source, 'none') NOT IN ('taxonomy', 'manual', 'verified')
          AND NOT EXISTS (SELECT 1 FROM peer_group_overrides o WHERE o.ticker = r.ticker) ORDER BY 1""")]


def returns(conn, tickers: list[str]) -> dict[str, dict]:
    """ticker → {date: daily log return}, last DAYS sessions (app prices, LSEG history where the app has none)."""
    out = collections.defaultdict(dict)
    for src in ("SELECT ticker, date, close FROM prices_historical WHERE ticker = ANY(%s) AND date >= current_date - 200 ORDER BY 1, 2",
                "SELECT ticker, date, close FROM lseg_research.daily_history WHERE ticker = ANY(%s) AND date >= current_date - 200 "
                "AND close IS NOT NULL ORDER BY 1, 2"):
        px = collections.defaultdict(list)
        for t, d, c in conn.execute(src, (tickers,)):
            if c and t not in out:
                px[t].append((d, float(c)))
        for t, s in px.items():
            s = s[-(DAYS + 1):]
            out[t] = {s[i][0]: np.log(s[i][1] / s[i - 1][1]) for i in range(1, len(s))}
    return out


def co_vote(r: dict, groups: dict[str, dict]) -> list[tuple[str, float]]:
    res = []
    for g, gr in groups.items():
        ds = [d for d in r if d in gr]
        if len(ds) >= 60:
            res.append((g, float(np.corrcoef([r[d] for d in ds], [gr[d] for d in ds])[0, 1])))
    return sorted(res, key=lambda x: -x[1])


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--tickers")
    p.add_argument("--apply", action="store_true")
    p.add_argument("--all", action="store_true", help="re-check names already in peer_verify.jsonl")
    a = p.parse_args()
    import openjev_local as oj
    conn = connect()
    prof = json.loads(PROFILES.read_text())
    names = dict(conn.execute("SELECT id, name FROM peer_groups").fetchall())
    groups = {g: (n, m) for g, n, m in conn.execute("SELECT id, name, scoring_mode FROM peer_groups")}
    cur = dict(conn.execute("SELECT ticker, primary_peer_group_id FROM ticker_registry"))
    mem = collections.defaultdict(list)
    for g, t in conn.execute("SELECT m.group_id, m.ticker FROM peer_group_members m JOIN ticker_registry r ON r.ticker = m.ticker "
                             "AND r.primary_peer_group_id = m.group_id WHERE m.removed_at IS NULL AND m.source = ANY(%s) ORDER BY 2",
                             (list(REVIEWED),)):
        mem[g].append(t)
    tickers = a.tickers.upper().split(",") if a.tickers else unreviewed(conn)
    prev = {r["t"]: r for r in map(json.loads, OUT_J.open())} if OUT_J.exists() else {}
    tickers = [t for t in tickers if (prof.get(t) or {}).get("description") and (a.all or a.tickers or t not in prev)]
    # group return series from reviewed members (equal-weight mean of daily log returns)
    rets = returns(conn, sorted({t for v in mem.values() for t in v} | set(tickers)))
    gret = {}
    for g, ts in mem.items():
        by = collections.defaultdict(list)
        for t in ts:
            for d, v in rets.get(t, {}).items():
                by[d].append(v)
        gret[g] = {d: float(np.mean(v)) for d, v in by.items() if len(v) >= 3}
    rnd = random.Random(17)
    rows = []
    with oj.Server():
        for t in tickers:
            pf = prof[t]
            st = (f"Company: {pf.get('companyName') or t} ({t}), headquarters {pf.get('country')}, vendor industry: "
                  f"{pf.get('industry')} / {pf.get('activity')}.\nBusiness: {pf['description'][:900]}")
            probs = collections.Counter()
            for _ in range(2):
                order = list(groups)
                rnd.shuffle(order)
                crit = {g: criteria(groups, [g])[g] + (f" — e.g. {', '.join(x for x in mem[g] if x != t)[:60]}" if mem[g] else "")
                        for g in order}
                q = {"g": {"type": "choice", "instructions": "Which peer group should this company's fundamentals be compared with? "
                           "Pick the group whose companies have the most similar business model.", "criteria": crit}}
                ans = oj._post("/v1/systemone", {"model": oj.MODEL, "state": st, "questions": q})["answers"]["g"]
                for g, v in (ans.get("probabilities") or {}).items():
                    probs[g] += v / 2
            top = probs.most_common(3)
            co = co_vote(rets.get(t, {}), {g: s for g, s in gret.items() if s})
            votes = {"oj": top[0][0] if top and top[0][1] >= OJ_MIN else None,
                     "trbc": pf.get("trbc_group"),
                     "co": co[0][0] if co and co[0][1] >= CO_MIN and (len(co) < 2 or co[0][1] - co[1][1] >= CO_MARGIN) else None}
            tally = collections.Counter(v for v in votes.values() if v)
            win, n = tally.most_common(1)[0] if tally else (None, 0)
            row = {"t": t, "name": pf.get("companyName"), "cur": cur.get(t), "votes": votes, "oj_top": top[:2],
                   "co_top": co[:2], "pick": win if n >= 2 else None, "n": n, "activity": pf.get("activity")}
            rows.append(row)
            print(f"{t:6s} cur={str(cur.get(t))[:28]:28s} oj={str(votes['oj'])[:28]:28s} trbc={str(votes['trbc'])[:28]:28s} "
                  f"co={str(votes['co'])[:28]:28s} → {row['pick'] or 'REVIEW'}", flush=True)
    prev.update({r["t"]: r for r in rows})
    OUT_J.write_text("\n".join(json.dumps(r) for r in prev.values()) + "\n")
    ok = [r for r in rows if r["pick"]]
    moved = [r for r in ok if r["pick"] != r["cur"]]
    rev = [r for r in rows if not r["pick"]]
    L = ["# Peer-group check (OpenJev + LSEG TRBC + co-movement)", "",
         f"{len(rows)} names · verified {len(ok)} (≥ 2 of 3 votes agree; {len(moved)} moved) · review {len(rev)}", "",
         "## Moved", "", "| ticker | name | from | to | votes |", "|---|---|---|---|---|"]
    L += [f"| {r['t']} | {r['name']} | {names.get(r['cur'], r['cur'])} | {names[r['pick']]} | "
          f"{', '.join(k for k, v in r['votes'].items() if v == r['pick'])} |" for r in moved]
    L += ["", "## Review (no 2-vote agreement — scored, kept out of peer norms)", "",
          "| ticker | name | current | OpenJev | TRBC | co-movement | LSEG activity |", "|---|---|---|---|---|---|---|"]
    L += [f"| {r['t']} | {r['name']} | {names.get(r['cur'], r['cur'])} | "
          + " | ".join(names.get(r["votes"][k], "—") for k in ("oj", "trbc", "co")) + f" | {r['activity']} |" for r in rev]
    OUT_MD.write_text("\n".join(L) + "\n")
    print(f"verified {len(ok)} (moved {len(moved)}) · review {len(rev)} → {OUT_MD}")
    if a.apply:
        with conn.cursor() as c:
            for r in ok:
                c.execute("UPDATE ticker_registry SET primary_peer_group_id = %s WHERE ticker = %s", (r["pick"], r["t"]))
                c.execute("UPDATE peer_group_members SET removed_at = now() WHERE ticker = %s AND group_id <> %s AND removed_at IS NULL "
                          "AND source IN ('auto', 'verified')", (r["t"], r["pick"]))
                c.execute("""INSERT INTO peer_group_members (group_id, ticker, source) VALUES (%s, %s, 'verified')
                             ON CONFLICT (group_id, ticker) DO UPDATE SET source = 'verified', removed_at = NULL""", (r["pick"], r["t"]))
        conn.commit()
        print(f"applied {len(ok)}")


if __name__ == "__main__":
    main()
