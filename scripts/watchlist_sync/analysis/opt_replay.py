"""Option replay engine + paired decision test (Claude, S017–S021; spec research/studies/S017-S021-option-history.md).

replay(): walks a sold put's real daily option bars (optlab.bars) from entry to expiry under one exit rule.
decide(): variant − baseline on the same entries, $ per $10k collateral per week, 90 % CI by expiry-week bootstrap, halves check.

Fill rules (fixed in the spec, not tuned): profit-take on the close; 2× stop on the day's high, filled at 2× premium; expiry
settles at intrinsic from the stock close; every buy-back pays half the Schwab bid-ask spread (median by price bucket from
option_chain_history); a contract with no bar on > 30 % of its trading days is excluded and counted. Capital freed by an
early close earns the Model List's median weekly yield for the remaining days.

    .venv/bin/python analysis/opt_replay.py s017     # writes out/opt/S017.md + optlab.findings row
"""
from __future__ import annotations

import json
import random
import sys
from bisect import bisect_right
from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402

OUT = HERE.parent / "out/opt"
SPREAD_EDGES = [0.1, 0.25, 0.5, 1.0, 2.0, 5.0]  # median half-spread per mid bucket, filled from option_chain_history at load
MAX_MISSING = 0.30
B = 4000


@dataclass
class Entry:
    key: str
    account: str
    ticker: str
    d0: date
    exp: date
    k: float
    prem: float
    qty: float
    occ: str
    earn_in: bool
    dte: int

    @property
    def collateral(self) -> float:
        return self.k * 100 * self.qty


def half_spreads(conn) -> list[float]:
    r = conn.execute("""SELECT width_bucket((bid + ask) / 2, %s::float8[]) b, percentile_cont(0.5) WITHIN GROUP (ORDER BY (ask - bid) / 2)
                        FROM option_chain_history WHERE bid > 0 AND ask > bid AND side = 'put' GROUP BY 1 ORDER BY 1""",
                     (SPREAD_EDGES,)).fetchall()
    return [float(x[1]) for x in r]


def load(conn):
    earn = {}
    with open(HERE.parent / "out/mistakes/trades.csv") as fh:
        import csv
        for r in csv.DictReader(fh):
            earn[f"{r['account']}|{r['ticker']}|{r['d0']}|{r['exp']}|{float(r['k'])}"] = r["earn_in"] == "True"
    ents = [Entry(k, a, t, d0, e, float(s), float(p), float(q), o, earn.get(k, False), (e - d0).days)
            for k, a, t, d0, e, s, p, q, o in conn.execute(
                "SELECT key, account, ticker, d0, expiry, strike, premium, qty, occ FROM optlab.trades WHERE occ IS NOT NULL").fetchall()]
    bars = defaultdict(dict)
    for occ, d, h, c in conn.execute("""SELECT b.occ, b.date, b.h, b.c FROM optlab.bars b
                                        WHERE b.occ IN (SELECT occ FROM optlab.trades WHERE occ IS NOT NULL)""").fetchall():
        bars[occ][d] = (h, c)
    und = defaultdict(dict)
    for t, d, c in conn.execute("""SELECT ticker, date, c FROM optlab.underlying
                                   WHERE ticker IN (SELECT DISTINCT ticker FROM optlab.trades)""").fetchall():
        und[t][d] = c
    return ents, bars, und


RULES = ("hold", "take50", "take75", "stop2x", "close_itm")


def replay(e: Entry, rule: str, bars: dict, und: dict, hs: list[float], freed_wk: float) -> dict | None:
    """→ {pnl $, exit_day, reason} for one sold put, or None if excluded (illiquid / missing stock prices)."""
    days = sorted(d for d in und.get(e.ticker, {}) if e.d0 < d <= e.exp)
    if not days or days[-1] != e.exp and (e.exp - days[-1]).days > 3:
        return None
    b = bars.get(e.occ, {})
    if sum(1 for d in days if d in b) < (1 - MAX_MISSING) * len(days):
        return None
    spread = lambda px: hs[min(bisect_right(SPREAD_EDGES, px), len(hs) - 1)]  # noqa: E731
    mult = 100 * e.qty
    for i, d in enumerate(days):
        if d not in b or d == days[-1]:
            continue
        h, c = b[d]
        exit_px = None
        if rule == "stop2x" and h is not None and h >= 2 * e.prem:
            exit_px, why = 2 * e.prem, "stop"
        elif rule == "take50" and c <= 0.5 * e.prem:
            exit_px, why = c, "take"
        elif rule == "take75" and c <= 0.25 * e.prem:
            exit_px, why = c, "take"
        elif rule == "close_itm" and i == len(days) - 2 and und[e.ticker][d] < e.k:
            exit_px, why = c, "itm"
        if exit_px is not None:
            cost = exit_px + spread(exit_px)
            left = (e.exp - d).days
            freed = e.collateral * freed_wk / 100 * left / 7
            return {"pnl": (e.prem - cost) * mult + freed, "exit": d, "why": why}
    s = und[e.ticker].get(days[-1])
    return {"pnl": (e.prem - max(e.k - s, 0)) * mult, "exit": days[-1], "why": "expiry"}


def cw(e: Entry) -> float:
    """Collateral-weeks in $10k units: what one entry ties up. Ratio unit = Σ $ / Σ cw, so a 1-day trade isn't scaled ×7."""
    return e.collateral / 1e4 * max(e.dte, 1) / 7


def decide(rows: list[tuple[Entry, float, float]]) -> dict:
    """rows = (entry, variant $, baseline $). Unit: $ per $10k collateral per week = Σ(variant − baseline) / Σ collateral-weeks."""
    by_wk = defaultdict(lambda: [0.0, 0.0, 0])
    for e, v, b in rows:
        w = by_wk[e.exp]; w[0] += v - b; w[1] += cw(e); w[2] += 1
    weeks = sorted(by_wk)
    n = len(rows)
    ratio = lambda ws: sum(by_wk[w][0] for w in ws) / max(sum(by_wk[w][1] for w in ws), 1e-9)  # noqa: E731
    est = ratio(weeks)
    rng = random.Random(17)
    boots = sorted(ratio([rng.choice(weeks) for _ in weeks]) for _ in range(B))
    lo, hi = boots[int(0.05 * B)], boots[int(0.95 * B)]
    h1, h2 = ratio(weeks[: len(weeks) // 2]), ratio(weeks[len(weeks) // 2:])
    if len(weeks) < 8 or n < 100:
        verdict = "NOT ENOUGH"
    elif lo > 0 and h1 > 0 and h2 > 0:
        verdict = "PASS"
    elif hi < 0 and h1 < 0 and h2 < 0:
        verdict = "WORSE"  # significantly worse than the baseline in both halves
    else:
        verdict = "FAIL"
    base_wk, var_wk = defaultdict(float), defaultdict(float)
    for e, v, b in rows:
        base_wk[e.exp] += b
        var_wk[e.exp] += v
    return {"est": est, "ci": (lo, hi), "halves": (h1, h2), "weeks": len(weeks), "n": n, "verdict": verdict,
            "dollars": sum(v - b for _, v, b in rows), "worst_before": min(base_wk.values()), "worst_after": min(var_wk.values())}


def interaction(rows, split) -> dict:
    """Does the rule's effect differ between two pre-declared groups? Week-bootstrap of (ratio A − ratio B)."""
    by_wk = defaultdict(lambda: [[0.0, 0.0, 0], [0.0, 0.0, 0]])
    for e, v, b in rows:
        g = by_wk[e.exp][0 if split(e) else 1]; g[0] += v - b; g[1] += cw(e); g[2] += 1
    weeks = sorted(by_wk)
    def diff(ws):
        r = [sum(by_wk[w][j][0] for w in ws) / max(sum(by_wk[w][j][1] for w in ws), 1e-9) for j in (0, 1)]
        return r[0] - r[1]
    d = diff(weeks)
    na, nb = (sum(by_wk[w][j][2] for w in weeks) for j in (0, 1))
    rng = random.Random(23)
    bs = [diff([rng.choice(weeks) for _ in weeks]) for _ in range(B)]
    p = 2 * min(sum(1 for x in bs if x <= 0), sum(1 for x in bs if x >= 0)) / B
    return {"diff": d, "p": min(p, 1.0), "n": (na, nb)}


def s017() -> None:
    conn = connect()
    hs = half_spreads(conn)
    freed_wk = float(conn.execute("SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY weekly_income_pct) FROM model_recs WHERE side = 'put'").fetchone()[0])
    ents, bars, und = load(conn)
    res = {r: {} for r in RULES}
    res0 = {r: {} for r in RULES}  # sensitivity: freed cash earns nothing
    for e in ents:
        for r in RULES:
            x = replay(e, r, bars, und, hs, freed_wk)
            if x:
                res[r][e.key] = x
                res0[r][e.key] = replay(e, r, bars, und, hs, 0.0)
    keys = [e for e in ents if e.key in res["hold"]]
    excluded = len(ents) - len(keys)
    out, cards = [], {}
    strata = {"earnings in window": lambda e: e.earn_in, "DTE ≤ 7 at entry": lambda e: e.dte <= 7}
    out.append(f"# S017 — close early or hold? ({date.today()})\n")
    out.append(f"Entries replayed: {len(keys)} of {len(ents)} sold puts with a contract ({excluded} excluded: no/too few option bars "
               f"(> 30 % days missing) or no stock prices). Freed capital earns {freed_wk:.2f} %/week (Model List median). "
               f"Half-spreads by mid bucket: {', '.join(f'{x:.3f}' for x in hs)}.\n")
    hold_total = sum(res["hold"][e.key]["pnl"] for e in keys)
    out.append(f"Hold baseline: ${hold_total:,.0f} total over these entries.\n")
    out.append("| Rule | Effect $/10k/wk | 90 % CI | halves | weeks · n | $ vs hold | $ vs hold, freed cash idle | worst week before → after | fired | verdict |")
    out.append("|---|---|---|---|---|---|---|---|---|---|")
    for r in RULES[1:]:
        rows = [(e, res[r][e.key]["pnl"], res["hold"][e.key]["pnl"]) for e in keys]
        d = decide(rows)
        fired = sum(1 for e in keys if res[r][e.key]["why"] != "expiry")
        d0 = decide([(e, res0[r][e.key]["pnl"], res0["hold"][e.key]["pnl"]) for e in keys])
        out.append(f"| {r} | {d['est']:+.1f} | {d['ci'][0]:+.1f} … {d['ci'][1]:+.1f} | {d['halves'][0]:+.1f} / {d['halves'][1]:+.1f} | "
                   f"{d['weeks']} · {d['n']} | {d['dollars']:+,.0f} | {d0['dollars']:+,.0f} ({d0['verdict']}) | "
                   f"{d['worst_before']:,.0f} → {d['worst_after']:,.0f} | {fired} | **{d['verdict']}** |")
        d["idle_dollars"], d["idle_verdict"] = d0["dollars"], d0["verdict"]
        inter = {name: interaction(rows, f) for name, f in strata.items()}
        cards[r] = {**d, "fired": fired, "interactions": inter}
    out.append("\nInteraction tests (does the effect differ by group? Holm over 2 strata × 4 rules = 8):")
    flat = sorted(((cards[r]["interactions"][s]["p"], r, s) for r in cards for s in strata))
    m = len(flat)
    for i, (p, r, s) in enumerate(flat):
        x = cards[r]["interactions"][s]
        out.append(f"- {r} × {s}: diff {x['diff']:+.1f} $/10k/wk (n {x['n'][0]} vs {x['n'][1]}), p {p:.3f}, Holm {min(1, p * (m - i)):.3f}")
    out.append("\nNot computed (pre-declared strata needing data not in this join): regime bucket, IV/RV at entry, IV-implied P(ITM). "
               "Daily closes only: the stop fires on the day's high but real intraday paths can stop earlier.")
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "S017.md").write_text("\n".join(out) + "\n")
    best = max(cards.items(), key=lambda kv: kv[1]["est"])
    passed = [r for r, c in cards.items() if c["verdict"] == "PASS"]
    if passed:
        r = max(passed, key=lambda x: cards[x]["est"]); c = cards[r]
        verdict, head = "pass", (f"{r}: {c['est']:+.1f} $/10k/week (CI {c['ci'][0]:+.1f}…{c['ci'][1]:+.1f}); on your trades {c['dollars']:+,.0f} $, "
                                  f"worst week {c['worst_before']:,.0f} → {c['worst_after']:,.0f}")
    else:
        enough = any(c["verdict"] != "NOT ENOUGH" for c in cards.values())
        verdict = "fail" if enough else "not enough"
        worse = "; ".join(f"{r} costs {-c['dollars']:,.0f} $" for r, c in cards.items() if c["verdict"] == "WORSE")
        head = (f"Hold stays: no exit rule reliably beats holding ({len(keys)} puts, {cards['take50']['weeks']} weeks; best {best[0]} "
                f"{best[1]['est']:+.1f} $/10k/week but halves disagree and it needs freed cash re-sold at once)."
                + (f" Avoid: {worse} on your trades." if worse else ""))
    card = {r: {k: v for k, v in c.items() if k != "interactions"} for r, c in cards.items()}
    conn.execute("""INSERT INTO optlab.findings (study, title, verdict, headline, card, updated_at) VALUES ('S017', 'Close early or hold?', %s, %s, %s, now())
                    ON CONFLICT (study) DO UPDATE SET verdict = excluded.verdict, headline = excluded.headline, card = excluded.card, updated_at = now()""",
                 (verdict, head, json.dumps(card, default=str)))
    conn.commit()
    print("\n".join(out))
    print("\n→", verdict, "·", head)


if __name__ == "__main__":
    {"s017": s017}[sys.argv[1] if len(sys.argv) > 1 else "s017"]()
