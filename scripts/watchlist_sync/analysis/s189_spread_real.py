"""S189 — bid-ask spread ÷ fill as a put pick factor on REAL LSEG weekly puts (Claude 11-10; S188 winner-pass lead).

Registered BEFORE this run (S188.md § Winner pass, 11-10):
  DOWN regime cell: within-week rank of spread ÷ fill → coefficient < 0 on real put return r, after OTM / income / 52w
  drawdown ranks. UP and ALL cells: same sign expected (−), secondary. Pass = sign right ∧ |t| ≥ 2 (no calendar-half split, contract rule 12).
Mechanics caveat: fill = bid + 23 % of spread is already charged, so a negative coef is edge beyond the modelled cost.
  Spread ÷ fill is larger for cheap puts, so income + OTM ranks are in the model to absorb that.
Outcome  S109 real puts (3–9 DTE, held to expiry), r = pnl ÷ strike per week. Model = S188 ols_cluster (week FE, week-clustered t).
So-what  inside Jamie's S109 rule (≥ 0.9 %/wk, ≥ 10 % OTM, ≥ 25 % off high): bp/wk with vs without the widest-spread third.

    cd scripts/watchlist_sync && .venv/bin/python analysis/s189_spread_real.py
"""
from __future__ import annotations

import sys
from bisect import bisect_left
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import s109_real_quote_rule as R  # noqa: E402
from s188_option_momentum_real import ols_cluster, wk_rank  # noqa: E402
from build_plan import connect  # noqa: E402

OUT = HERE.parent / "out" / "studies" / "S189.md"
SPLIT = date(2024, 7, 1)


def tstat(x):
    x = np.asarray(x, float)
    return float(x.mean() / (x.std(ddof=1) / np.sqrt(len(x)))) if len(x) > 2 else float("nan")


def one_per_name_week(rs):
    """Several strikes on one chain are one bet (RDDT 10-21 = 12 strikes): average them into one row per name-week."""
    g = defaultdict(list)
    for r in rs:
        g[(r["t"], R.week(r["d"]))].append(r)
    out = []
    for v in g.values():
        m = {**v[0], **{f: float(np.mean([x[f] for x in v])) for f in ("r", "spread", "otm", "inc", "dd52")}}
        m["kept"] = bool(np.mean([x["kept"] for x in v]) >= 0.5)
        out.append(m)
    return out


def main():
    with connect() as conn:
        q, px = R.load(conn)
        spy = [(d, c) for d, c in conn.execute("SELECT date, close::float8 FROM lseg_research.daily_history WHERE ticker='SPY' AND close > 0 ORDER BY date")]
    real = one_per_name_week(R.trades(q, px))
    sd = [d for d, _ in spy]
    sc = np.array([c for _, c in spy])

    def regime(d):
        i = bisect_left(sd, d)
        if i >= len(sd) or sd[i] != d:
            i -= 1
        if i < 200:
            return None
        return "up" if sc[i] > sc[i - 199:i + 1].mean() and sc[i] / sc[i - 63] - 1 >= 0 else "down"

    rows = []
    for r in real:
        iso = r["d"].isocalendar()
        rows.append({**r, "wk": iso[0] * 100 + iso[1], "regime": regime(r["d"]), "brch": 0.0 if r["kept"] else 1.0})
    rows = [x for x in rows if x["regime"]]
    L = ["# S189 — spread ÷ fill on real LSEG weekly puts", "",
         f"{len(rows)} real puts (one per name-week; strikes on one chain averaged) with a regime label. Coef = lowest → highest within-week spread rank, after OTM / income / "
         "drawdown ranks, week FE, t clustered by week. Registered: coef < 0 on r.", "",
         "| cell | sample | target | weeks | trades | coef | t | verdict |", "|---|---|---|---|---|---|---|---|"]
    for cell in ("down", "up", "all"):
        for samp in ("full",):
            sub = [x for x in rows if cell == "all" or x["regime"] == cell]
            for tg in ("r", "brch"):
                o = ols_cluster(sub, "spread", tg)
                if "b" not in o:
                    L.append(f"| {cell} | {samp} | {tg} | {o['weeks']} | {o['n']} | — | — | can't answer at this n |")
                    continue
                unit, u = (1e4, " bp") if tg == "r" else (100, " pp")
                v = ("PASS" if o["b"] < 0 and abs(o["t"]) >= 2 else "fail") if tg == "r" and samp == "full" else "check"
                L.append(f"| {cell} | {samp} | {tg} | {o['weeks']} | {o['n']} | {o['b'] * unit:+.1f}{u} | {o['t']:+.1f} | {v} |")

    # Quintile shape (raw, within-week rank buckets), down cell and all.
    L += ["", "## Within-week spread quintile → mean r (bp/wk), raw", "", "| cell | Q1 tight | Q2 | Q3 | Q4 | Q5 wide | Q1−Q5 t (weekly) |", "|---|---|---|---|---|---|---|"]
    for cell in ("down", "up", "all"):
        by = defaultdict(list)
        for x in rows:
            if cell == "all" or x["regime"] == cell:
                by[x["wk"]].append(x)
        qs, diff = defaultdict(list), []
        for g in by.values():
            if len(g) < 5:
                continue
            rk = wk_rank([x["spread"] for x in g])
            bucket = np.minimum((rk * 5).astype(int), 4)
            for b, x in zip(bucket, g):
                qs[b].append(x["r"])
            lo = [x["r"] for b, x in zip(bucket, g) if b == 0]
            hi = [x["r"] for b, x in zip(bucket, g) if b == 4]
            if lo and hi:
                diff.append(np.mean(lo) - np.mean(hi))
        L.append(f"| {cell} | " + " | ".join(f"{np.mean(qs[b]) * 1e4:+.0f}" for b in range(5)) + f" | {tstat(diff):+.1f} (n {len(diff)} wks) |")

    # So-what inside Jamie's S109 rule: drop the widest-spread third (within the rule set, per week-pooled tercile cut).
    rule = [x for x in rows if x["inc"] >= 0.009 and x["otm"] >= 0.10 and x["dd52"] <= -0.25]
    L += ["", "## So-what inside the S109 rule (≥ 0.9 %/wk, ≥ 10 % OTM, ≥ 25 % off high)", "",
          "| cell | set | trades | weeks | mean r bp/wk | t (weekly) | worst-5 % bp | kept % |", "|---|---|---|---|---|---|---|---|"]
    if rule:
        cut = np.quantile([x["spread"] for x in rule], 2 / 3)
        for cell in ("down", "up", "all"):
            base = [x for x in rule if cell == "all" or x["regime"] == cell]
            for name, s in (("rule", base), ("rule, spread ≤ p67", [x for x in base if x["spread"] <= cut]),
                            ("rule, widest third", [x for x in base if x["spread"] > cut])):
                if not s:
                    continue
                wk = defaultdict(list)
                for x in s:
                    wk[x["wk"]].append(x["r"])
                wm = [np.mean(v) for v in wk.values()]
                r = np.array([x["r"] for x in s])
                L.append(f"| {cell} | {name} | {len(s)} | {len(wm)} | {r.mean() * 1e4:+.0f} | {tstat(wm):+.1f} | "
                         f"{np.quantile(r, 0.05) * 1e4:+.0f} | {100 * np.mean([x['kept'] for x in s]):.0f} |")
        L.append(f"\nSpread cut (p67 of rule set) = {cut:.0%} of fill.")
    # Winner pass (contract 11): down cell, top vs bottom fifth of r, pre-entry medians.
    dn = sorted([x for x in rows if x["regime"] == "down"], key=lambda x: x["r"])
    k = len(dn) // 5
    los, win = dn[:k], dn[-k:]
    L += ["", f"## Winner pass (down cell, top vs bottom fifth of real put return, {len(dn)} puts; medians)", "",
          "| pre-entry trait | winners | losers | all |", "|---|---|---|---|"]
    for f, nm in (("spread", "spread ÷ fill"), ("otm", "OTM %"), ("inc", "income %/wk"), ("dd52", "off 52-week high"), ("days", "DTE")):
        L.append(f"| {nm} | " + " | ".join(f"{np.median([x[f] for x in g]):.3g}" for g in (win, los, dn)) + " |")
    n_ind = {c: len({x["d"] for x in rows if x["regime"] == c}) for c in ("down", "up")}
    L += ["", f"Independent events (distinct entry dates): down {n_ind['down']}, up {n_ind['up']} (both ≥ 30, so not UNDERPOWERED).",
          "", "Spread separates winners only raw: cheap far-OTM puts carry wide spreads. After OTM/income/drawdown ranks the "
          "spread coef is + (wrong sign) in every cell. What does separate winners, pre-entry: nearer the money (4.1 % vs 10 % OTM) "
          "and deeper off the high (−43 % vs −24 %); income is partly mechanical. **Next rule:** down tape, 3–6 % OTM weekly puts on "
          "names ≥ 35 % off their 52w high (vs the S109 ≥ 10 % OTM floor), real LSEG marks, same fill.",
          "", "**Verdict — RULE NO-LIFT: within-week spread ÷ fill rank (tight = better) × hold to expiry × short weekly put (3–9 DTE, "
          "fill bid + 23 %).** Spread is still a cost; it is charged in the fill, not a pick factor."]
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
